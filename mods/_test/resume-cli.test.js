// T-MWLGPS2QJQL S2: `drover resume <R-…|T-…> [--cancel]` puts one op on the inbox and lists itself in the usage.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../drover-tasks/bin/drover");
let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "cres-")); mkdirSync(join(home, "data/drover-inbox"), { recursive: true }); writeFileSync(join(home, "shared.json"), "{}"); });
const cli = (args) => new Promise((resolve) => execFile("bash", [CLI, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, HC_TERMINAL_ID: "t7", DROVER_RESUME_WAIT: "1" } }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
const queued = () => readdirSync(join(home, "data/drover-inbox")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(home, "data/drover-inbox", f), "utf8")));

test("the usage lists resume", async () => {
  const r = await cli([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /drover resume <R-…\|T-…>/);
});
test("resume <R-…> and <T-…> queue op resume with the ref; --cancel sets cancel", async () => {
  await cli(["resume", "R-ABC123"]); await cli(["resume", "T-XYZ9"]); await cli(["resume", "--cancel", "R-ABC123"]);
  assert.deepEqual(queued().map((c) => [c.op, c.ref, c.cancel === true]).sort(), [["resume", "R-ABC123", false], ["resume", "R-ABC123", true], ["resume", "T-XYZ9", false]]);
  assert.ok(queued().every((c) => c.recover === false || c.cancel === true || c.recover === undefined));
});
test("a bad or missing ref is the usage (exit 2), nothing queued", async () => {
  for (const a of [["resume"], ["resume", "nope"], ["resume", "R-1", "extra"], ["resume", "--cancel"]]) assert.equal((await cli(a)).code, 2, a.join(" "));
  assert.equal(queued().length, 0);
});

test("resume --recover queues recover:true; the usage names --recover", async () => {
  await cli(["resume", "R-ABC123", "--recover"]);
  assert.deepEqual(queued().map((c) => [c.op, c.ref, c.recover === true, c.cancel === true]), [["resume", "R-ABC123", true, false]]);
  assert.match((await cli([])).stderr, /--recover/);
  assert.equal((await cli(["resume", "R-1", "--recover", "--cancel"])).code, 2, "one of the two");
});
