#!/usr/bin/env python3
"""factory/bin/broker against a fake agent and a fake pool: the Anthropic
Messages shape in, the agent's answer out (who really answered, for the
probe); the probe on /health; an agent failure as a 502 the client
(agent.py's anthropic path) understands; agent.py end to end through it;
GitHub read-only with the token added here; and the pool's calls for one
task at a time — the worker's token added here, the job token never handed
on, another task's id refused, complete releasing the hold; and the orders
of #277: an answer passes only for an order seen delivered — in a claim's
answer or a 426's —, between tasks, once; the claim says the broker exits
with its builder (pair restart), and it does once the builder accepted a
restart and the pool took the answer — not when the pool refused it. And
a stop (#277, part 2): the pool's 409 with "stop" on the held task's
heartbeat releases the hold for a builder that declared stop-task, then a
fence refuses claims and answers for STOP_FENCE_SECONDS — and for as long
as a call of the stopped task is still in flight here, an upload the
stopped builder's shell is inside; the task is never taken up again
(STOPPED, and adopt() refuses a view with stop_order, read past the edge
cache); a builder from before #277, or from its first part (orders but no
stop-task), keeps its hold. And an agent sidecar (#336): one task's for its
whole life, its calls, tokens and wall time capped, what it spent written
to BROKER_USAGE_FILE at start and after every completion.
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
pool_seen = []
ORDER_RESTART = "wo_" + "1" * 32
ORDER_RECHECK = "wo_" + "2" * 32
ORDER_DRAIN = "wo_" + "3" * 32
ORDER_OUTDATED = "wo_" + "4" * 32  # rides a 426
ORDER_GONE = "wo_" + "5" * 32  # closed at the pool before its answer came
HEARTBEATS = {}  # path → (status, body): the pool's answer to a heartbeat, where a test sets one (#277)
SLOW = threading.Event()  # an upload the fake pool answers only once it is set: a builder's shell inside its curl when the stop comes (#277)


def fake_complete(system, user, max_tokens=4000, timeout=300):
    seen.append({"system": system, "user": user, "max_tokens": max_tokens})
    if user == "boom":
        raise SystemExit("claude-code: You've hit your limit")
    return "OK from the fake", "claude-sonnet-5"


class FakePool(BaseHTTPRequestHandler):
    """The pool as the broker sees it: every call recorded with its
    authorization header; claim hands out a task and a job token."""

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass

    def record(self):
        n = int(self.headers.get("content-length", "0") or 0)
        body = self.rfile.read(n) if n else b""
        pool_seen.append({"method": self.command, "path": self.path, "auth": self.headers.get("authorization"), "body": body, "type": self.headers.get("content-type"), "ua": self.headers.get("user-agent"), "takes": self.headers.get("x-omarchy-broker-takes")})
        return body

    def do_GET(self):  # noqa: N802
        self.record()
        path = self.path.split("?", 1)[0]
        if path == "/api/v1/factory/workers/self":
            return self._json(200, {"id": "w9", "arch": "aarch64", "trust": "community", "owner": "alice", "mode": "dedicated"})
        if path == "/api/v1/factory/tasks/43":  # leased to this worker: a broker that restarted takes it up again
            return self._json(200, {"task": {"id": 43, "status": "leased", "lease_owner": "w9", "lease_expires_at": "2099-01-01T00:30:00Z", "stop_order": None}})
        if path == "/api/v1/factory/tasks/44":  # somebody else's lease
            return self._json(200, {"task": {"id": 44, "status": "leased", "lease_owner": "w2", "lease_expires_at": "2099-01-01T00:30:00Z"}})
        if path == "/api/v1/factory/tasks/53":  # leased to this worker, and being stopped by the pool (#277): never taken up again
            return self._json(200, {"task": {"id": 53, "status": "leased", "lease_owner": "w9", "lease_expires_at": "2099-01-01T00:30:00Z", "stop_order": "wo_" + "9" * 32}})
        if path == "/api/v1/factory/tasks/51":  # back in the queue
            return self._json(200, {"task": {"id": 51, "status": "queued", "lease_owner": None, "stop_order": None}})
        return self._json(404, {"error": "no"})

    def do_POST(self):  # noqa: N802
        body = self.record()
        if self.path.startswith("/api/v1/factory/workers/self/orders/"):
            if self.path.endswith(ORDER_GONE):
                return self._json(409, {"error": "closed meanwhile"})
            return self._json(200, {"order": self.path.rsplit("/", 1)[1], "state": json.loads(body).get("outcome")})
        if self.path == "/api/v1/factory/claim":
            if json.loads(body).get("arch") == "outdated":
                return self._json(426, {"error": "this worker runs v1.0.0; the pool is at v1.0.3", "latest": "v1.0.3", "orders": [
                    {"id": ORDER_OUTDATED, "kind": "recheck-agent", "reason": "stale", "issued_by": "pool:community", "unless_agent_ok": False, "notice": False}]})
            if json.loads(body).get("arch") == "gone":
                return self._json(200, {"task": None, "orders": [
                    {"id": ORDER_GONE, "kind": "restart", "reason": "not ready", "issued_by": "pool:community", "unless_agent_ok": True, "notice": False}]})
            if json.loads(body).get("arch") == "orders":
                return self._json(200, {"task": None, "orders": [
                    {"id": ORDER_RESTART, "kind": "restart", "reason": "not ready", "issued_by": "pool:community", "unless_agent_ok": True, "notice": False},
                    {"id": ORDER_RECHECK, "kind": "recheck-agent", "reason": "stale", "issued_by": "m1", "unless_agent_ok": False, "notice": False},
                    {"id": ORDER_DRAIN, "kind": "drain", "reason": "disk", "issued_by": "m1", "unless_agent_ok": False, "notice": True}]})
            if json.loads(body).get("arch") in ("t51", "t52"):  # #277: a task a stop takes back, claimed by a builder that declared stop-task (t51), or not (t52)
                task = int(json.loads(body)["arch"][1:])
                return self._json(200, {"task": {"id": task, "name": "stopped", "arch": "aarch64", "pkgbuild_ref": "x"}, "token": "omj.SECRET", "lease_expires_at": "2099-01-01T00:30:00Z"})
            if json.loads(body).get("arch") == "nothing":
                self.send_response(204)
                self.send_header("content-length", "0")
                self.end_headers()
                return None
            return self._json(200, {"task": {"id": 41, "name": "mine", "arch": "aarch64", "pkgbuild_ref": "draft:https://x@latest"}, "token": "omj.SECRET", "token_expires_at": "2099-01-01T00:00:00Z",
                                    "lease_expires_at": "2099-01-01T00:30:00Z", "upload": "/api/v1/factory/tasks/41/artifacts/<filename>"})
        if self.path == "/api/v1/factory/tasks/41/heartbeat":
            return self._json(200, {"task": 41, "lease_expires_at": "2099-01-01T01:00:00Z", "token": "omj.SECRET2", "token_expires_at": "x"})
        if self.path in HEARTBEATS:  # #277: what the pool answers a stopped task's heartbeat, as a test sets it
            code, answer = HEARTBEATS[self.path]
            return self._json(code, answer)
        if self.path == "/api/v1/factory/tasks/43/heartbeat":
            return self._json(200, {"task": 43, "lease_expires_at": "2099-01-01T01:00:00Z", "token": "omj.SECRET3"})
        if self.path == "/api/v1/factory/tasks/41/complete":
            return self._json(200, {"task": 41, "status": "staged"})
        if self.path.startswith("/api/v1/factory/tasks/41/artifacts/big.bin/multipart"):
            return self._json(200, {"upload_id": "u1"})
        return self._json(404, {"error": "no"})

    def do_PUT(self):  # noqa: N802
        body = self.record()
        if self.path == "/api/v1/factory/tasks/51/artifacts/slow.pkg.tar.zst":  # a large upload: answered once SLOW is set, refused as the pool refuses a stopped task's
            SLOW.wait(20)
            return self._json(409, {"error": "task 51 was stopped from its worker's page", "stop": True, "state": "stopping"})
        if self.path == "/api/v1/factory/tasks/41/artifacts/build.log":
            if b"omw_" in body:
                return self._json(422, {"error": "build.log carries what looks like a pool token", "kind": "a pool token", "line": 1})
            return self._json(201, {"key": "staging/alice/mine/41/build.log", "size": len(body)})
        return self._json(404, {"error": "no"})


class FakeGitHub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        pool_seen.append({"method": "GET", "path": "github:" + self.path, "auth": self.headers.get("authorization"), "accept": self.headers.get("accept")})
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
os.environ.update({"OMARCHY_API": pool_url, "OMARCHY_WORKER_TOKEN": "omw_THE_WORKERS", "GITHUB_TOKEN": "github_pat_THE_HOSTS", "BROKER_AGENT_CALLS": "3"})
broker = SourceFileLoader("broker", os.path.join(ROOT, "factory", "bin", "broker")).load_module()
broker.GITHUB = github_url
# The broker's agent module is faked; a second, untouched copy is the client
# a builder runs (draft-pkgbuild imports it), speaking HTTP to the broker.
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

# 2. The probe says who the agent is, whether the pool path is on, and what is held.
status, out = call("GET", "/health")
assert status == 200 and out["ok"] is True and out["agent"] == "claude-code/claude-sonnet-5" and out["pool"] is True and out["task"] is None, out

# 3. A failing agent is a 502 with the reason.
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "boom"}]})
assert status == 502 and "hit your limit" in out["error"]["message"], out

# 4. agent.py end to end, the way a builder is configured — and its probe names the agent behind the broker.
os.environ.update({"FACTORY_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "via-broker", "ANTHROPIC_BASE_URL": base})
text, model = agent.complete("You draft.", "a PKGBUILD please", max_tokens=100)
assert (text, model) == ("OK from the fake", "claude-sonnet-5"), (text, model)
ok, detail = agent.probe()
assert ok and detail["agent"] == "claude-code/claude-sonnet-5" and detail["provider"] == "anthropic", detail

# ---------------------------------------------------------------- GitHub --
# 5. Read-only, the token added here, the query kept.
status, out = call("GET", "/github/repos/o/r/releases/latest?per_page=1")
assert status == 200 and out["tag_name"] == "v1.2.3" and out["path"] == "/repos/o/r/releases/latest?per_page=1", out
assert pool_seen[-1]["auth"] == "Bearer github_pat_THE_HOSTS" and pool_seen[-1]["accept"] == "application/vnd.github+json", pool_seen[-1]

# ------------------------------------------------------------------ pool --
# 6. Who am I: the worker's token added here.
status, out = call("GET", "/pool/factory/workers/self")
assert status == 200 and out["id"] == "w9", out
assert pool_seen[-1]["auth"] == "Bearer omw_THE_WORKERS", pool_seen[-1]
# Cloudflare fronts the pool: a request that does not say who it is (urllib's default agent) is a 403 "error code: 1010".
assert pool_seen[-1]["ua"].startswith("omarchy-broker/"), pool_seen[-1]

# 7. Nothing else passes: not another route, not the wrong method.
status, out = call("GET", "/pool/factory")
assert status == 403 and "passes only" in out["error"], out
status, out = call("POST", "/pool/factory/workers/self", {})
assert status == 403, out
status, out = call("POST", "/pool/factory/tasks/41/heartbeat", {})
assert status == 403 and "none held" in out["error"], out

# 8. A claim: 204 passes as 204; a task is held, and the job token never reaches the builder.
status, out = call("POST", "/pool/factory/claim", {"arch": "nothing"})
assert status == 204, (status, out)
status, out = call("POST", "/pool/factory/claim", {"arch": "aarch64", "agent": "claude-code/claude-sonnet-5"})
assert status == 200 and out["task"]["id"] == 41 and out["upload"], out
assert "token" not in out and "token_expires_at" not in out, out
assert json.loads(pool_seen[-1]["body"])["arch"] == "aarch64" and pool_seen[-1]["auth"] == "Bearer omw_THE_WORKERS"
status, out = call("GET", "/health")
assert out["task"] == 41, out

# 9. While held: no second claim; the held task's calls pass, another task's do not.
status, out = call("POST", "/pool/factory/claim", {"arch": "aarch64"})
assert status == 409 and "holds task 41" in out["error"], out
status, out = call("POST", "/pool/factory/tasks/42/heartbeat", {})
assert status == 403 and "(41)" in out["error"], out
status, out = call("POST", "/pool/factory/tasks/41/heartbeat", {})
assert status == 200 and "token" not in out, out
status, out = call("PUT", "/pool/factory/tasks/41/artifacts/build.log", raw=b"==> Making package\n", headers={"content-type": "application/octet-stream"})
assert status == 201 and out["size"] == 19, out
assert pool_seen[-1]["type"] == "application/octet-stream" and pool_seen[-1]["body"] == b"==> Making package\n", pool_seen[-1]
status, out = call("PUT", "/pool/factory/tasks/42/artifacts/build.log", raw=b"x", headers={"content-type": "application/octet-stream"})
assert status == 403, out
# The pool's refusal comes back as the pool said it (the leak check, 422).
status, out = call("PUT", "/pool/factory/tasks/41/artifacts/build.log", raw=b"OMARCHY_WORKER_TOKEN=omw_LEAKED", headers={"content-type": "application/octet-stream"})
assert status == 422 and out["kind"] == "a pool token", out
status, out = call("POST", "/pool/factory/tasks/41/artifacts/big.bin/multipart?action=create", {})
assert status == 200 and out["upload_id"] == "u1", out
assert pool_seen[-1]["path"].endswith("/multipart?action=create"), pool_seen[-1]

# 10. The agent, per task: at most BROKER_AGENT_CALLS (3 here) — then 429 until the task is released.
for i in range(3):
    status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": f"draft {i}"}]})
    assert status == 200, (i, out)
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "one more"}]})
assert status == 429 and out["error"]["type"] == "rate_limit_error", out

# 11. Complete releases the hold: a new claim is possible, the old task's id is not.
status, out = call("POST", "/pool/factory/tasks/41/complete", {"sha256": "x", "filename": "mine-1-1-aarch64.pkg.tar.zst"})
assert status == 200 and out["status"] == "staged", out
assert call("GET", "/health")[1]["task"] is None
status, out = call("POST", "/pool/factory/tasks/41/heartbeat", {})
assert status == 403, out
status, out = call("POST", "/v1/messages", {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": "free again"}]})
assert status == 200, out

# 12. A broker that restarted mid-build holds nothing; the builder's next call
#     names its task, and the pool says whose lease it is: ours is adopted,
#     a stranger's is not.
status, out = call("POST", "/pool/factory/tasks/44/heartbeat", {})
assert status == 403 and "none held" in out["error"], out
status, out = call("POST", "/pool/factory/tasks/43/heartbeat", {})
assert status == 200 and out["task"] == 43 and "token" not in out, out
assert call("GET", "/health")[1]["task"] == 43
status, out = call("POST", "/pool/factory/tasks/44/heartbeat", {})
assert status == 403 and "(43)" in out["error"], out
broker.HELD.release()

# ---------------------------------------------------------------- orders (#277) --
# 13. An answer for an order this broker never saw delivered: refused before the pool hears of it.
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_RECHECK}", {"instance": "a" * 32, "outcome": "done", "code": "probed"})
assert status == 403 and "saw delivered" in out["error"], out
# 14. A claim the pool answers with orders: passed on; the claim said the broker exits with its builder — its own header, never the builder's.
status, out = call("POST", "/pool/factory/claim", {"arch": "orders"}, {"x-omarchy-broker-takes": "something-else"})
assert status == 200 and [o["kind"] for o in out["orders"]] == ["restart", "recheck-agent", "drain"], out
assert pool_seen[-1]["takes"] == "pair-restart", pool_seen[-1]
assert call("GET", "/health")[1]["task"] is None
# 15. The re-check's answer passes, with the worker's token added here — once.
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_RECHECK}", {"instance": "a" * 32, "outcome": "done", "code": "probed"})
assert status == 200 and out["state"] == "done", out
assert pool_seen[-1]["auth"] == "Bearer omw_THE_WORKERS", pool_seen[-1]
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_RECHECK}", {"instance": "a" * 32, "outcome": "done", "code": "probed"})
assert status == 409 and "answered already" in out["error"], out
# 16. A notice is never answered.
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_DRAIN}", {"instance": "a" * 32, "outcome": "done"})
assert status == 403, out
# 17. While a task is held no answer passes — a recipe runs only inside a held task — and the worker's own id still does (the updater reads it).
status, out = call("POST", "/pool/factory/claim", {"arch": "aarch64"})
assert status == 200 and out["task"]["id"] == 41, out
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_RESTART}", {"instance": "a" * 32, "outcome": "accepted", "code": "exiting"})
assert status == 403 and "between tasks" in out["error"], out
assert call("GET", "/pool/factory/workers/self")[0] == 200
broker.HELD.release()
# 18. Pair restart: a restart refused (its agent answered) leaves the broker up; one accepted, and taken by the pool, takes it down with the builder.
exits = []
broker.pair_restart = lambda: exits.append(75)
broker.threading = type("Now", (), {"Timer": staticmethod(lambda secs, f: type("T", (), {"start": staticmethod(f)})())})
status, out = call("POST", "/pool/factory/claim", {"arch": "orders"})
assert status == 200, out
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_RESTART}", {"instance": "a" * 32, "outcome": "refused", "code": "agent-ok"})
assert status == 200 and exits == [], (out, exits)
status, out = call("POST", "/pool/factory/claim", {"arch": "orders"})
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_RESTART}", {"instance": "a" * 32, "outcome": "accepted", "code": "exiting"})
assert status == 409, "an id answers once, whichever claim delivered it again"
broker.DELIVERED.answered.clear()
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_RESTART}", {"instance": "a" * 32, "outcome": "accepted", "code": "exiting"})
assert status == 200 and exits == [75], (out, exits)
# 18b. An accepted restart the pool does not take (closed meanwhile: 409) leaves the broker up: the builder's restart was not the pool's order any more.
exits.clear()
status, out = call("POST", "/pool/factory/claim", {"arch": "gone"})
assert status == 200 and out["orders"][0]["id"] == ORDER_GONE, out
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_GONE}", {"instance": "a" * 32, "outcome": "accepted", "code": "exiting"})
assert status == 409 and exits == [], (status, out, exits)
# 18c. A 426 carries the orders waiting for an outdated builder: passed on as the pool said it, and the broker saw them delivered — their answer passes.
status, out = call("POST", "/pool/factory/claim", {"arch": "outdated"})
assert status == 426 and out["orders"][0]["id"] == ORDER_OUTDATED, (status, out)
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_OUTDATED}", {"instance": "a" * 32, "outcome": "done", "code": "probed"})
assert status == 200 and out["state"] == "done", out

# ---------------------------------------------------------------- a stop (#277, part 2) --
import time  # noqa: E402

broker.STOP_FENCE_SECONDS = 2  # 30 in production
broker.threading = threading
broker.DELIVERED.answered.clear()
STOP = (409, {"error": "task 51 was stopped from its worker's page", "stop": True, "state": "stopping"})

# 20. A stopped task releases the hold, for a builder that declared stop-task (it stops on the pool's word): the 409 goes to it unchanged,
#     the hold goes, and for the fence no claim and no order's answer passes.
STOPS = ["drain", "recheck-agent", "restart", "stop-task"]
status, out = call("POST", "/pool/factory/claim", {"arch": "t51", "orders": STOPS})
assert status == 200 and out["task"]["id"] == 51 and broker.HELD.stops is True, out
HEARTBEATS["/api/v1/factory/tasks/51/heartbeat"] = (503, {"error": "internal"})
assert call("POST", "/pool/factory/tasks/51/heartbeat", {})[0] == 503 and call("GET", "/health")[1]["task"] == 51, "a 503 leaves the hold"
HEARTBEATS["/api/v1/factory/tasks/51/heartbeat"] = (409, {"error": "task 51 is leased by w2; the lease is not yours"})
assert call("POST", "/pool/factory/tasks/51/heartbeat", {})[0] == 409 and call("GET", "/health")[1]["task"] == 51, "a 409 without stop (a pool from before #277) leaves the hold"
HEARTBEATS["/api/v1/factory/tasks/51/heartbeat"] = STOP
status, out = call("POST", "/pool/factory/tasks/51/heartbeat", {})
assert status == 409 and out == STOP[1], (status, out)
assert call("GET", "/health")[1]["task"] is None
status, out = call("POST", "/pool/factory/claim", {"arch": "aarch64", "orders": ["drain"]})
assert status == 409 and "task 51 was stopped; the next builder claims from" in out["error"], out
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_RECHECK}", {"instance": "a" * 32, "outcome": "done", "code": "probed"})
assert status == 403 and "was stopped" in out["error"], out
# 21. …and it is never taken up again: a recipe's heartbeat, upload or fail for it, in the seconds before its container dies, is refused
#     here — the pool is not even asked — and the broker still holds nothing.
seen_before = len(pool_seen)
for method, path, body in [("POST", "/pool/factory/tasks/51/heartbeat", {}), ("PUT", "/pool/factory/tasks/51/artifacts/build.log", None), ("POST", "/pool/factory/tasks/51/fail", {"error": "x"})]:
    status, out = call(method, path, body, raw=b"late" if body is None else None, headers={"content-type": "application/octet-stream"} if body is None else None)
    assert status == 403 and "task 51 was stopped by the pool; this broker does not take it up again" == out["error"], (path, status, out)
assert len(pool_seen) == seen_before, pool_seen[seen_before:]
assert call("GET", "/health")[1]["task"] is None
# After the fence, a claim passes and a new task is held.
time.sleep(2.1)
status, out = call("POST", "/pool/factory/claim", {"arch": "aarch64", "orders": ["drain"]})
assert status == 200 and out["task"]["id"] == 41, out
broker.HELD.release()
# 22. The stopped task's entry ends at the fenced lease's end; a claim answer that hands it out again clears it, and its heartbeats pass.
assert broker.STOPPED.holds(51)
status, out = call("POST", "/pool/factory/claim", {"arch": "t51", "orders": ["drain"]})
assert status == 200 and out["task"]["id"] == 51 and not broker.STOPPED.holds(51), out
HEARTBEATS["/api/v1/factory/tasks/51/heartbeat"] = (200, {"task": 51, "lease_expires_at": "2099-01-01T01:00:00Z", "token": "omj.S"})
status, out = call("POST", "/pool/factory/tasks/51/heartbeat", {})
assert status == 200 and "token" not in out, out
broker.HELD.release()
broker.STOPPED.add(51, time.time() - 1)
assert not broker.STOPPED.holds(51), "its time has passed"
time.sleep(2.1)

# 23. A builder from before #277 (its claim declared no orders), or from its first part (orders, but not stop-task: it builds a stopped
#     task on), keeps building after the stop: the broker keeps its hold, so its recipe cannot claim — the same 409 forwarded, "holds
#     task 52" until its own report passes or the lease ends.
HEARTBEATS["/api/v1/factory/tasks/52/heartbeat"] = (409, {"error": "stopped", "stop": True, "state": "stopping"})
for claimed in ({"arch": "t52"}, {"arch": "t52", "orders": ["drain", "recheck-agent", "restart"]}):
    status, out = call("POST", "/pool/factory/claim", claimed)
    assert status == 200 and out["task"]["id"] == 52 and broker.HELD.stops is False, (claimed, out)
    status, out = call("POST", "/pool/factory/tasks/52/heartbeat", {})
    assert status == 409 and out["stop"] is True and call("GET", "/health")[1]["task"] == 52, (claimed, status, out)
    status, out = call("POST", "/pool/factory/claim", {"arch": "aarch64", "orders": STOPS})
    assert status == 409 and "holds task 52" in out["error"], (claimed, out)
    broker.HELD.release()
assert not broker.STOPPED.holds(52), "never let go on the stop: not the broker's to fence"

# 24. A broker started fresh (its STOPPED gone: a pair restart, a crash) whose builder names a task the pool is stopping: the view, read past
#     its edge cache, carries stop_order — not adopted, a pinned call is refused, and a claim passes. Without stop_order: adopted, as before.
broker.STOPPED.until.clear()
seen_before = len(pool_seen)
status, out = call("POST", "/pool/factory/tasks/53/heartbeat", {})
assert status == 403 and "none held" in out["error"] and call("GET", "/health")[1]["task"] is None, (status, out)
view = [p for p in pool_seen[seen_before:] if p["path"].startswith("/api/v1/factory/tasks/53")]
assert view and "?fresh=" in view[0]["path"], view
status, out = call("POST", "/pool/factory/claim", {"arch": "aarch64", "orders": ["drain"]})
assert status == 200 and out["task"]["id"] == 41, out
broker.HELD.release()
status, out = call("POST", "/pool/factory/tasks/43/heartbeat", {})
assert status == 200 and out["task"] == 43, out
broker.HELD.release()

# 25. A stop that comes while the stopped builder's shell is inside an upload through here: bash runs the stop's trap only once that curl
#     returns, and the builder lives on until then. The fence stands while the upload is in flight — past STOP_FENCE_SECONDS — and runs
#     STOP_FENCE_SECONDS from its return; only then does a claim pass.
SLOW.clear()
HEARTBEATS["/api/v1/factory/tasks/51/heartbeat"] = STOP
status, out = call("POST", "/pool/factory/claim", {"arch": "t51", "orders": STOPS})
assert status == 200 and out["task"]["id"] == 51 and broker.HELD.stops is True, out
uploaded = {}
upload = threading.Thread(target=lambda: uploaded.update(r=call("PUT", "/pool/factory/tasks/51/artifacts/slow.pkg.tar.zst", raw=b"a large package", headers={"content-type": "application/octet-stream"})))
upload.start()
for _ in range(100):
    if broker.INFLIGHT.of(51):
        break
    time.sleep(0.05)
assert broker.INFLIGHT.of(51) == 1, "the upload is in flight"
status, out = call("POST", "/pool/factory/tasks/51/heartbeat", {})
assert status == 409 and out == STOP[1] and call("GET", "/health")[1]["task"] is None, (status, out)
time.sleep(2.1)  # past STOP_FENCE_SECONDS: a fence on a timer alone would open the claim door here, the builder still alive
status, out = call("POST", "/pool/factory/claim", {"arch": "aarch64", "orders": STOPS})
assert status == 409 and "task 51 was stopped; a call of it is still in flight here" in out["error"], out
status, out = call("POST", f"/pool/factory/workers/self/orders/{ORDER_RECHECK}", {"instance": "a" * 32, "outcome": "done", "code": "probed"})
assert status == 403 and "still in flight" in out["error"], out
SLOW.set()
upload.join(10)
assert uploaded["r"][0] == 409 and broker.INFLIGHT.of(51) == 0, uploaded
status, out = call("POST", "/pool/factory/claim", {"arch": "aarch64", "orders": STOPS})
assert status == 409 and "task 51 was stopped; the next builder claims from" in out["error"], "the fence runs from the upload's return"
time.sleep(2.1)
status, out = call("POST", "/pool/factory/claim", {"arch": "aarch64", "orders": STOPS})
assert status == 200 and out["task"]["id"] == 41, out
broker.HELD.release()

# 19. Without a worker token the pool path is off; the agent and GitHub stay.
del os.environ["OMARCHY_WORKER_TOKEN"]
status, out = call("GET", "/pool/factory/workers/self")
assert status == 503 and "no worker token" in out["error"], out
assert call("GET", "/health")[1]["pool"] is False
assert call("GET", "/github/repos/o/r")[0] == 200

# 20. An agent sidecar (#336): no worker token, one task's; its caps are the process's, its usage in a file.
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
print("broker: ok")
