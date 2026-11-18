// T-MWMKWXEHKUC: a reply is never visible empty or half-written. Consumer: hidden temp + mv -f (fallback: plain write). CLI: an empty result is not ready.
// No sleeps or tick counts: the empty window is held open by a gate (conv/10-testing.md).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync, chmodSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const IO = await import("../_lib/io.js");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "../drover-tasks/bin/drover");

let home, inbox;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "irepl-")); inbox = join(home, "data/drover-inbox"); mkdirSync(inbox, { recursive: true }); });

// ---- CLI side: a bin dir whose `sleep` logs each poll, so the test knows the CLI looked at the empty file.
const stubBin = () => {
  const bin = join(home, "bin"); mkdirSync(bin);
  const log = join(home, "polls.log");
  writeFileSync(join(bin, "sleep"), `#!/bin/sh\necho x >> '${log}'\nexec /bin/sleep 0.01\n`); chmodSync(join(bin, "sleep"), 0o755);
  return { bin, polls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0) };
};
const runCli = (bin) => {
  let done = false;
  const p = new Promise((resolve) => execFile("bash", [CLI, "archive", "T-X"], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, PATH: `${bin}:${process.env.PATH}` } }, (e, stdout) => { done = true; resolve({ code: e ? 1 : 0, stdout }); }));
  return { p, done: () => done };
};
const request = () => until(() => readdirSync(inbox).find((n) => n.endsWith(".json")), "the CLI queued its request");

test("1. CLI: a result that exists but is empty is not an answer; the reply written after it is printed whole", async () => {
  const { bin, polls } = stubBin();
  const cli = runCli(bin);
  const result = join(inbox, (await request()).replace(/\.json$/, ".result"));
  writeFileSync(result, ""); // the consumer's writeFile: created empty first
  const seen = polls();
  await until(() => polls() >= seen + 2 || cli.done(), "the CLI polled the empty file at least twice (or already gave up on it)");
  writeFileSync(result, "ok: T-X archived");
  const r = await cli.p;
  assert.equal(r.stdout, "ok: T-X archived\n");
  assert.equal(r.code, 0);
  assert.equal(existsSync(result), false, "the CLI removes the result it printed");
});

test("2. CLI: a result that stays empty is never printed or deleted; the CLI reports queued", async () => {
  const { bin } = stubBin();
  const cli = runCli(bin);
  const result = join(inbox, (await request()).replace(/\.json$/, ".result"));
  writeFileSync(result, "");
  const r = await cli.p;
  assert.match(r.stdout, /^queued: /);
  assert.equal(existsSync(result), true, "the empty result is left for its writer");
});

// ---- consumer side
let host, writes, execs, mvMode;
beforeEach(() => {
  writes = []; execs = []; mvMode = "real";
  host = globalThis.__host = { ownMv: true, appHome: home, props: {}, notified: [], state: {}, agents: [], terminals: [], watchFolder: () => new Promise(() => {}) };
  host.fsGuard = (op, path) => {
    if (op === "writeFile") writes.push(path);
    if (op === "unlink" && mvMode === "unlink-denied" && path.endsWith(".tmp")) throw new Error("denied");
  };
  host.exec = (cmd, args) => new Promise((resolve, reject) => {
    execs.push([cmd, ...args]);
    if (cmd === "mv" && (mvMode === "exit1" || mvMode === "unlink-denied")) return resolve({ code: 1, stdout: "", stderr: "mv: failed" });
    if (cmd === "mv" && mvMode === "throw") return reject(new Error("spawn failed"));
    execFile(cmd, args, { encoding: "utf8" }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }));
  });
});
const startLoop = () => { const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) }; IO.watchInbox(cx); };
const ask = async (name) => {
  writeFileSync(join(inbox, `${name}.json`), JSON.stringify({ op: "protocol", ttlMs: 60000 }));
  startLoop();
  return until(() => existsSync(join(inbox, `${name}.result`)) && readFileSync(join(inbox, `${name}.result`), "utf8"), `answer ${name}`);
};
const leftovers = () => readdirSync(inbox).filter((n) => n.endsWith(".tmp"));

test("3. consumer: the reply is staged in a hidden unique temp and moved into place with mv -f; nothing writes the .result itself", async () => {
  const reply = await ask("c1");
  assert.match(reply, /^ok: protocol \d+$/);
  assert.deepEqual(writes.filter((p) => p.endsWith(".result")), [], "no direct write of the .result");
  const tmp = writes.find((p) => p.endsWith(".tmp"));
  assert.match(tmp, /\/\.c1\.[a-z0-9]+\.tmp$/);
  assert.deepEqual(execs.find((e) => e[0] === "mv"), ["mv", "-f", tmp, join(inbox, "c1.result")]);
  assert.deepEqual(leftovers(), []);
});

test("3b. consumer: while the temp is still being written (created empty) nothing is at .result and mv has not run; release publishes the whole text", async () => {
  let release, held;
  const gate = new Promise((r) => { release = r; });
  const atTmp = new Promise((r) => { held = r; });
  host.fsGuard = (op, path) => {
    if (op !== "writeFile" || !path.endsWith(".tmp")) return;
    writeFileSync(path, ""); // the file exists, empty, exactly as fs.writeFile leaves it mid-write
    held(path);
    return gate;
  };
  writeFileSync(join(inbox, "c3.json"), JSON.stringify({ op: "protocol", ttlMs: 60000 }));
  startLoop();
  const tmp = await atTmp;
  assert.equal(readFileSync(tmp, "utf8"), "");
  assert.equal(existsSync(join(inbox, "c3.result")), false, "no .result while the reply is half-written");
  assert.deepEqual(execs.filter((e) => e[0] === "mv"), [], "no mv before the write finished");
  release();
  assert.match(await until(() => existsSync(join(inbox, "c3.result")) && readFileSync(join(inbox, "c3.result"), "utf8"), "published"), /^ok: protocol \d+$/);
  assert.deepEqual(leftovers(), []);
});

for (const mode of ["exit1", "throw", "unlink-denied"]) {
  test(`4. consumer: mv ${mode}: the whole reply is still delivered${mode === "unlink-denied" ? "" : " and the temp is removed"}`, async () => {
    mvMode = mode;
    const reply = await ask("c2");
    assert.match(reply, /^ok: protocol \d+$/);
    if (mode !== "unlink-denied") assert.deepEqual(leftovers(), []);
  });
}
