#!/usr/bin/env python3
"""A stub agent that comes up late, for the E2E's orders scenarios (#277).

It stands in for a provider, or for the agent proxy a worker calls: the
Anthropic Messages shape (POST /v1/messages) and the OpenAI one (POST
/chat/completions), each answered with a one-word completion. What it does
is a word in a file the test writes, read every 0.2 s:

    down     not listening at all: a worker's probe is refused
             (URLError … Connection refused) — the proxy replaced in the
             same rollout, not up yet (#273)
    up       listening, answering
    credit   listening, answering 402 Payment Required: an error a restart
             cannot help

Usage: python3 tests/agent-late.py <port> <state-file>
Each probe that reaches it is appended to <state-file>.calls.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
STATE = sys.argv[2]


def mode():
    try:
        with open(STATE) as f:
            return f.read().strip() or "down"
    except OSError:
        return "down"


class Agent(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("content-length", "0") or 0)
        self.rfile.read(n)
        with open(STATE + ".calls", "a") as f:
            f.write(f"{int(time.time())} {mode()} {self.path}\n")
        if mode() == "credit":
            return self._json(402, {"type": "error", "error": {"type": "billing_error", "message": "Your credit balance is too low"}})
        if self.path.endswith("/v1/messages"):
            return self._json(200, {"type": "message", "role": "assistant", "model": "stub-1", "content": [{"type": "text", "text": "OK"}]})
        if self.path.endswith("/chat/completions"):
            return self._json(200, {"model": "stub-1", "choices": [{"message": {"content": "OK"}, "finish_reason": "stop"}]})
        return self._json(404, {"error": "POST /v1/messages or /chat/completions"})


def main():
    server = None
    while True:
        want = mode() != "down"
        if want and server is None:
            try:
                server = ThreadingHTTPServer(("127.0.0.1", PORT), Agent)
            except OSError:
                time.sleep(0.2)
                continue
            threading.Thread(target=server.serve_forever, daemon=True).start()
        elif not want and server is not None:
            server.shutdown()
            server.server_close()
            server = None
        time.sleep(0.2)


if __name__ == "__main__":
    os.makedirs(os.path.dirname(os.path.abspath(STATE)), exist_ok=True)
    main()
