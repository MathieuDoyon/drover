// Run line (T-MWO2HFSB34T): `drover line`. The checks run BEFORE anything is written, so a rejected secret never reaches the inbox directory.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../drover-tasks/bin/drover");
const FAKE = String.fromCharCode(103, 104, 112, 95) + "a1B2".repeat(6); // char codes: no secret-shaped literal in the file
const HOMEPATH = "/" + ["Us", "ers"].join("") + "/x/y";
let home, inbox;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cline-"));
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(home, "shared.json"), "{}");
});
// DROVER_WRITE_WAIT=0 and no consumer: a valid line is queued and the CLI exits at once.
const cli = (args, env = {}) => new Promise((resolve) => execFile("bash", [CLI, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, HC_TERMINAL_ID: "t7", ...env } }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
const files = () => readdirSync(inbox);
const queued = () => files().filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(inbox, f), "utf8")));

test("a valid line queues one request: op, id, normalised text, progress, the sender's terminal", async () => {
  const r = await cli(["line", "T-ABC1", "reading", "the  code", "--progress", "20"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^queued: /);
  assert.deepEqual(queued(), [{ op: "line", id: "T-ABC1", text: "reading the code", progress: 20, by: "t7", ttlMs: 300000 }]);
});

test("without --progress the request carries no progress; --progress may come first; 0 and 100 are valid", async () => {
  assert.equal((await cli(["line", "T-ABC1", "just text"])).code, 0);
  assert.equal((await cli(["line", "T-ABC1", "--progress", "0", "at zero"])).code, 0);
  assert.equal((await cli(["line", "T-ABC1", "done", "--progress", "100"])).code, 0);
  const q = queued().sort((a, b) => a.text.localeCompare(b.text));
  assert.deepEqual(q.map((c) => [c.text, c.progress]), [["at zero", 0], ["done", 100], ["just text", undefined]]);
  assert.equal("progress" in q.find((c) => c.text === "just text"), false);
});

test("usage errors: no card, a bad card id, no text, a dangling --progress exit 2 and write nothing", async () => {
  for (const args of [["line"], ["line", "T-ABC1"], ["line", "nope", "x"], ["line", "T-ABC1", "--progress"], ["line", "T-ABC1", "--progress", "5"]]) {
    const r = await cli(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stderr, /usage:/);
  }
  assert.deepEqual(files(), []);
});

test("usage lists the line command", async () => {
  assert.match((await cli([])).stderr, /drover line <T-…> "<text/);
});

test("over 40 characters, control characters, a bad progress are refused before sending: exit 2, the rule in stderr, no file", async () => {
  for (const [args, re] of [
    [["line", "T-ABC1", "x".repeat(41)], /40/],
    [["line", "T-ABC1", "a\nb"], /control|newline/],
    [["line", "T-ABC1", "ok", "--progress", "150"], /progress/],
    [["line", "T-ABC1", "ok", "--progress", "1.5"], /progress/],
    [["line", "T-ABC1", "ok", "--progress", "abc"], /progress/],
  ]) {
    const r = await cli(args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.stderr, re);
  }
  assert.deepEqual(files(), []);
});

test("a fake secret or a home path leaves ZERO files in the inbox dir with no consumer running, and the value is not echoed", async () => {
  for (const text of [FAKE, "see " + FAKE, HOMEPATH]) {
    const r = await cli(["line", "T-ABC1", text]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /github-token|home-path/);
    assert.ok(!(r.stdout + r.stderr).includes(FAKE) && !(r.stdout + r.stderr).includes(HOMEPATH), "the value was echoed");
  }
  assert.deepEqual(files(), [], "nothing was written, not even a temp file");
  // a valid line still queues after the refusals
  assert.equal((await cli(["line", "T-ABC1", "fine"])).code, 0);
  assert.equal(queued().length, 1);
});

test("DROVER_NODE is honoured: an unusable node refuses the line (nothing is sent unchecked)", async () => {
  const r = await cli(["line", "T-ABC1", "fine"], { DROVER_NODE: join(home, "no-such-node") });
  assert.notEqual(r.code, 0);
  assert.deepEqual(files(), []);
});

test("progress goes on the wire as the normalised number: 007 is 7, valid JSON", async () => {
  assert.equal((await cli(["line", "T-ABC1", "x", "--progress", "007"])).code, 0);
  assert.equal(queued()[0].progress, 7);
});

test("--progress supplied but empty is refused (exit 2, zero inbox files); absent stays valid and sends no progress", async () => {
  for (const args of [["line", "T-ABC1", "x", "--progress", ""], ["line", "T-ABC1", "--progress", "", "x"]]) {
    const r = await cli(args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.stderr, /progress/);
  }
  assert.deepEqual(files(), []);
  assert.equal((await cli(["line", "T-ABC1", "x"])).code, 0);
  assert.equal("progress" in queued()[0], false);
});
