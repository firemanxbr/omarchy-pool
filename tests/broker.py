#!/usr/bin/env python3
"""factory/bin/broker — a task's agent sidecar — against a fake agent and a
fake GitHub: the Anthropic Messages shape in, the agent's answer out (who
really answered, for the probe); the probe on /health; an agent failure as a
502 the client (agent.py's anthropic path) understands; agent.py end to end
through it; GitHub read-only with the token added here. No pool path (#346):
the builder relay of the legacy sets is gone, so /pool/... is a 404 whatever
the method, nothing reaches the pool, and a worker token in the environment
changes nothing. And an agent sidecar (#336): one task's for its whole life,
its calls, tokens and wall time capped, what it spent written to
BROKER_USAGE_FILE at start and after every completion.
Run: python3 tests/broker.py"""
import json
import os
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.machinery import SourceFileLoader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "factory", "bin"))

# ---------------------------------------------------------------- fakes --
seen = []
github_seen = []
pool_seen = []


def fake_complete(system, user, max_tokens=4000, timeout=300):
    seen.append({"system": system, "user": user, "max_tokens": max_tokens})
    if user == "boom":
        raise SystemExit("claude-code: You've hit your limit")
    return "OK from the fake", "claude-sonnet-5"


class FakePool(BaseHTTPRequestHandler):
    """A pool the broker must never call (#346): anything that reaches it is recorded, and fails the test."""

    def log_message(self, *a):
        pass

    def _any(self):
        pool_seen.append({"method": self.command, "path": self.path})
        self.send_response(500)
        self.send_header("content-length", "0")
        self.end_headers()

    do_GET = do_POST = do_PUT = _any


class FakeGitHub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        github_seen.append({"path": self.path, "auth": self.headers.get("authorization"), "accept": self.headers.get("accept"), "ua": self.headers.get("user-agent")})
        data = json.dumps({"tag_name": "v1.2.3", "path": self.path}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}"


pool_url = serve(FakePool)
github_url = serve(FakeGitHub)
# A worker token in the environment (an older release's broker held one) opens no pool path.
os.environ.update({"OMARCHY_API": pool_url, "OMARCHY_WORKER_TOKEN": "omw_THE_WORKERS", "GITHUB_TOKEN": "github_pat_THE_HOSTS", "BROKER_AGENT_CALLS": "3"})
broker = SourceFileLoader("broker", os.path.join(ROOT, "factory", "bin", "broker")).load_module()
broker.GITHUB = github_url
# The broker's agent module is faked; a second, untouched copy is the client
# a task runs (draft-pkgbuild imports it), speaking HTTP to its sidecar.
broker.agent.complete = fake_complete
broker.agent.available = lambda: True
broker.agent.provider = lambda: ("claude-code", broker.agent.PROVIDERS["claude-code"])
broker.agent.probe = lambda timeout=90: (True, {"provider": "claude-code", "model": "claude-sonnet-5", "ms": 3})
agent = SourceFileLoader("agent_client", os.path.join(ROOT, "factory", "bin", "agent.py")).load_module()
base = serve(broker.Handler)


def call(method, path, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"content-type": "application/json"} if data is not None and raw is None else {}
    h.update(headers or {})
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, (json.loads(r.read() or b"null") if r.headers.get("content-type", "").startswith("application/json") else r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


# ------------------------------------------------------------- the agent --
# 1. The Messages shape, as agent.py's anthropic path sends it — and who really answered.
status, out = call("POST", "/v1/messages", {"model": "claude-sonnet-5", "max_tokens": 32000, "system": "You audit.", "messages": [{"role": "user", "content": "the PKGBUILD"}]}, {"x-api-key": "via-broker"})
assert status == 200 and out["content"][0]["text"] == "OK from the fake" and out["model"] == "claude-sonnet-5", out
assert out["agent"] == "claude-code/claude-sonnet-5", out
assert seen[-1] == {"system": "You audit.", "user": "the PKGBUILD", "max_tokens": 32000}, seen[-1]

# 2. The probe says who the agent is — and nothing of a pool or a task: there is no pool path.
status, out = call("GET", "/health")
assert status == 200 and out["ok"] is True and out["agent"] == "claude-code/claude-sonnet-5", out
assert "pool" not in out and "task" not in out, out

# 3. A failing agent is a 502 with the reason.
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "boom"}]})
assert status == 502 and "hit your limit" in out["error"]["message"], out

# 4. agent.py end to end, the way a task is configured — and its probe names the agent behind the sidecar.
os.environ.update({"FACTORY_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "via-broker", "ANTHROPIC_BASE_URL": base})
text, model = agent.complete("You draft.", "a PKGBUILD please", max_tokens=100)
assert (text, model) == ("OK from the fake", "claude-sonnet-5"), (text, model)
ok, detail = agent.probe()
assert ok and detail["agent"] == "claude-code/claude-sonnet-5" and detail["provider"] == "anthropic", detail

# ---------------------------------------------------------------- GitHub --
# 5. Read-only, the token added here, the query kept.
status, out = call("GET", "/github/repos/o/r/releases/latest?per_page=1")
assert status == 200 and out["tag_name"] == "v1.2.3" and out["path"] == "/repos/o/r/releases/latest?per_page=1", out
assert github_seen[-1]["auth"] == "Bearer github_pat_THE_HOSTS" and github_seen[-1]["accept"] == "application/vnd.github+json", github_seen[-1]
# GitHub wants a request to say who it is: never urllib's default agent.
assert github_seen[-1]["ua"].startswith("omarchy-broker/"), github_seen[-1]

# ------------------------------------------------------------- no pool --
# 6. The builder relay is gone (#346): every /pool/... is a 404, whatever the method, with the worker token in the environment —
#    the claim, the held task's calls, an order's answer — and nothing reaches the pool.
for method, path, body in [("GET", "/pool/factory/workers/self", None), ("POST", "/pool/factory/claim", {"arch": "aarch64"}),
                           ("POST", "/pool/factory/tasks/41/heartbeat", {}), ("POST", "/pool/factory/tasks/41/complete", {}),
                           ("PUT", "/pool/factory/tasks/41/artifacts/build.log", None), ("POST", "/pool/factory/workers/self/orders/wo_" + "1" * 32, {"outcome": "accepted"})]:
    status, out = call(method, path, body, raw=b"log" if method == "PUT" else None)
    assert status == 404, (method, path, status, out)
assert pool_seen == [], pool_seen
assert not hasattr(broker, "POOL_ROUTES") and not hasattr(broker, "HELD"), "the relay's code is gone"

# 7. Without the worker token: the same agent and GitHub.
del os.environ["OMARCHY_WORKER_TOKEN"]
assert call("GET", "/health")[0] == 200
assert call("GET", "/github/repos/o/r")[0] == 200

# 8. An agent sidecar (#336): no worker token, one task's; its caps are the process's, its usage in a file.
import tempfile  # noqa: E402

usage_dir = tempfile.mkdtemp()
usage = os.path.join(usage_dir, "usage.json")
os.environ.update({"BROKER_USAGE_FILE": usage, "BROKER_AGENT_TOKENS": "10", "BROKER_AGENT_WALL_SECONDS": "3600"})
broker.AGENT_CALLS = 3
broker.SPENT = broker.Spent()
broker.SPENT.write()
assert json.load(open(usage)) == {"calls": 0, "tokens": 0}, "a sidecar that made no call says 0"
# The provider's own count when it gives one; four characters a token when it does not.
real_complete = broker.agent.complete


def counted(system, user, max_tokens=4000, timeout=300):
    broker.agent.USAGE["tokens"] += 4
    return real_complete(system, user, max_tokens, timeout)


broker.agent.complete = counted
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "draft"}]})
assert status == 200, out
assert json.load(open(usage)) == {"calls": 1, "tokens": 4}, json.load(open(usage))
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "again"}]})
assert status == 200 and json.load(open(usage))["tokens"] == 8
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "a third"}]})
assert status == 200 and json.load(open(usage)) == {"calls": 3, "tokens": 12}
# Past the token cap (10) and the call cap (3): every completion is a 429, and nothing more is spent.
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "one more"}]})
assert status == 429 and "completions" in out["error"]["message"], out
broker.AGENT_CALLS = 100
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "one more"}]})
assert status == 429 and "tokens" in out["error"]["message"], out
assert json.load(open(usage)) == {"calls": 3, "tokens": 12}
# Its /health is liveness only: the task container reaches it, so no completion goes through it.
probes = []
real_probe = broker.agent.probe
broker.agent.probe = lambda timeout=90: probes.append(1) or real_probe(timeout)
for _ in range(5):
    status, out = call("GET", "/health")
    assert status == 200 and out["ok"] is True and out["agent"].startswith("claude-code/"), out
assert probes == [] and json.load(open(usage)) == {"calls": 3, "tokens": 12}, "a sidecar's /health made a model call"
broker.agent.probe = real_probe
# Past its wall time.
broker.SPENT = broker.Spent()
broker.SPENT.started -= 3601
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "late"}]})
assert status == 429 and "3600 s" in out["error"]["message"], out
# One call cannot overshoot the token cap: the answer's max_tokens is clamped to what is left, and a
# prompt larger than what is left is refused before it is sent.
broker.agent.complete = real_complete
os.environ["BROKER_AGENT_TOKENS"] = "100"
broker.SPENT = broker.Spent()
broker.SPENT.tokens = 90
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 32000, "messages": [{"role": "user", "content": "short"}]})
assert status == 200 and seen[-1]["max_tokens"] == 10, (status, seen[-1])
broker.SPENT = broker.Spent()
broker.SPENT.tokens = 90
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "x" * 400}]})
assert status == 429 and "more than this task's agent sidecar has left" in out["error"]["message"], out
assert broker.SPENT.calls == 0, "a refused prompt is no call"
# A provider that counts nothing: about four characters a token.
broker.agent.complete = real_complete
broker.SPENT = broker.Spent()
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "system": "s" * 40, "messages": [{"role": "user", "content": "u" * 40}]})
assert status == 200 and json.load(open(usage))["tokens"] == (40 + 40 + len("OK from the fake")) // 4, json.load(open(usage))
assert pool_seen == [], pool_seen
print("broker: ok")
