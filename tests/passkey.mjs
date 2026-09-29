#!/usr/bin/env node
// A passkey for tests/e2e-worker.sh (#257, #271): the software authenticator of
// worker/test/soft-authenticator.mjs, kept in a file between two commands,
// answering the options the local pool hands a browser. A test double: the
// key is made here, lives in the state file the run owns, and never leaves it.
//
//   node tests/passkey.mjs register <state.json> <origin> [label]  < options.json   → the body of POST /auth/passkeys
//   node tests/passkey.mjs assert   <state.json> <origin>          < options.json   → the form fields of POST /auth/confirm/<id>
//   node tests/passkey.mjs assert   <state.json> <origin> json     < options.json   → the same fields as JSON: an act's `assertion` (#271)
//
// <options.json> is what the pool answered (POST /auth/passkeys/challenge,
// POST /auth/confirm/<id>/challenge, or POST /auth/passkeys/assert):
// {publicKey: {challenge, rp | rpId, …}}.
// <origin> is the page's origin as the Worker sees it — under wrangler dev,
// the first route's (https://omarchy-pool.org), which is what the pool checks.
import { readFileSync, writeFileSync } from "node:fs";
import { assert, createAuthenticator, loadAuthenticator, register, saveAuthenticator } from "../worker/test/soft-authenticator.mjs";

const [cmd, statePath, origin, fourth] = process.argv.slice(2);
if (!["register", "assert"].includes(cmd) || !statePath || !/^https?:\/\/[^/]+$/.test(origin ?? "") || (cmd === "assert" && fourth !== undefined && fourth !== "json")) {
  console.error("usage: passkey.mjs register <state.json> <origin> [label] < options.json, or assert <state.json> <origin> [json] < options.json");
  process.exit(2);
}
const o = JSON.parse(readFileSync(0, "utf8")).publicKey;
if (!o || typeof o.challenge !== "string") {
  console.error(`the pool's answer carries no challenge: ${JSON.stringify(o)}`);
  process.exit(1);
}
if (cmd === "register") {
  const a = await createAuthenticator();
  const body = await register(a, { challenge: o.challenge, origin, rpId: o.rp.id });
  writeFileSync(statePath, JSON.stringify(await saveAuthenticator(a)), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ label: fourth ?? "e2e key", ...body }) + "\n");
} else {
  const a = await loadAuthenticator(JSON.parse(readFileSync(statePath, "utf8")));
  const fields = await assert(a, { challenge: o.challenge, origin, rpId: o.rpId });
  writeFileSync(statePath, JSON.stringify(await saveAuthenticator(a)), { mode: 0o600 });
  process.stdout.write((fourth === "json" ? JSON.stringify(fields) : new URLSearchParams(fields).toString()) + "\n");
}
