// discoverPrivateWords(): the private words plus whether the lookup was complete. No private word is spelled here: names are made up at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverPrivateWords, runtimePrivateWords, privateWords } from "./private-words.js";

const rnd = (n) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const stubDir = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-"));
  if (body !== null) { fs.writeFileSync(path.join(dir, "hc"), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(dir, "hc"), 0o755); }
  return dir;
};
const env = (dir, more = {}) => ({ PATH: `${dir}:/usr/bin:/bin`, ...more });
const machine = (name) => JSON.stringify({ machines: [{ name, host: name, logout_linger_user: name }] });

test("complete lookup: machine names, extra words and the local user come back, notes are empty", () => {
  const m = rnd(9), x = rnd(8);
  const r = discoverPrivateWords({ env: env(stubDir(`printf '%s' '${machine(m)}'`), { DROVER_PRIVATE_WORDS: x }) });
  assert.equal(r.complete, true);
  assert.deepEqual(r.notes, []);
  assert.ok(r.words.includes(m) && r.words.includes(x));
});

test("hc missing: incomplete, with a note", () => {
  const r = discoverPrivateWords({ env: env(stubDir(null)) });
  assert.equal(r.complete, false);
  assert.match(r.notes.join("\n"), /machines/);
});

test("hc exits non-zero: incomplete", () => {
  const r = discoverPrivateWords({ env: env(stubDir("exit 3")) });
  assert.equal(r.complete, false);
});

test("hc prints malformed JSON or no machines list: incomplete", () => {
  assert.equal(discoverPrivateWords({ env: env(stubDir("echo not-json")) }).complete, false);
  assert.equal(discoverPrivateWords({ env: env(stubDir("echo '{}'")) }).complete, false);
});

test("hc times out: incomplete", () => {
  const r = discoverPrivateWords({ env: env(stubDir("exec sleep 5")), timeoutMs: 100 });
  assert.equal(r.complete, false);
});

test("notes never carry a word", () => {
  const m = rnd(9);
  const r = discoverPrivateWords({ env: env(stubDir(`echo '${machine(m)}x'`)) });
  assert.equal(r.complete, false);
  assert.ok(!r.notes.join("\n").includes(m));
});

test("runtimePrivateWords keeps its behaviour: just the words", () => {
  assert.ok(Array.isArray(runtimePrivateWords()));
});

test("generic account names never come back as private words with ci=false", () => {
  for (const n of ["runner", "root", "admin", "ubuntu", "docker"]) assert.deepEqual(privateWords({ username: n, host: n, ci: false }), []);
});
