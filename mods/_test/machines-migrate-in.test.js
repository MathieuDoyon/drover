// A3b J2 (T-MWO2UYPADZC): `drover machines migrate-in <machine> [--json]`, tests written first (red). A fake rt: no hc, no machine.
import { test } from "node:test";
import assert from "node:assert/strict";

const { main } = await import("../drover-tasks/bin/drover-machines.mjs");
const { HEADLESS } = await import("../_lib/remote-exec.js");
const CLI = await import("../drover-tasks/bin/drover-machines.mjs");
test("the CLI and the transport name the same headless launcher", () => assert.equal(CLI.HEADLESS, HEADLESS));

function run(argv, reply) {
  const calls = [];
  let out = "", err = "";
  const runtime = { exec: async (machine, args, o) => { calls.push({ machine, args, o }); return reply(args); } };
  return main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; }, runtime }).then((code) => ({ code, out, err, calls }));
}
const okReply = () => ({ code: 0, stdout: JSON.stringify({ ok: true, copied: { tasks: 3, projects: 1, agents: 2, squads: 0 }, skipped: { tasks: 1, projects: 0, agents: 0, squads: 0 } }), stderr: "" });

test("migrate-in runs the headless verb over exec with the old shared.json under the remote home, no payload", async () => {
  const r = await run(["migrate-in", "box"], okReply);
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].machine, "box");
  assert.deepEqual(r.calls[0].args, [HEADLESS, "migrate-in", "--from", ".config/herdr-app/shared.json"]);
  assert.ok(!r.calls[0].o?.stdin);
  assert.match(r.out, /copied/);
  assert.match(r.out, /tasks 3/);
  assert.match(r.out, /skipped/);
});

test("migrate-in --json prints the counts as one JSON line", async () => {
  const r = await run(["migrate-in", "box", "--json"], okReply);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(j.machine, "box");
  assert.equal(j.copied.tasks, 3);
  assert.equal(j.skipped.tasks, 1);
});

test("migrate-in: a refusal is exit 1 with a fixed message, never the raw stderr", async () => {
  const r = await run(["migrate-in", "box"], () => ({ code: 1, stdout: JSON.stringify({ ok: false, code: "bad-source", error: "the source file does not exist" }), stderr: "raw-stderr-text" }));
  assert.equal(r.code, 1);
  assert.match(r.err, /bad-source/);
  assert.doesNotMatch(r.err + r.out, /raw-stderr-text/);
});

test("migrate-in: no node (69), a dead link or an unreadable answer are exit 1", async () => {
  for (const reply of [{ code: 69, stdout: "", stderr: "x" }, { code: 255, stdout: "", stderr: "x" }, { code: 0, stdout: "nope", stderr: "" }]) {
    const r = await run(["migrate-in", "box"], () => reply);
    assert.equal(r.code, 1, JSON.stringify(reply));
    assert.ok(r.err.length > 0);
  }
});

test("migrate-in needs exactly one machine; unknown flags are usage (exit 2); USAGE lists it", async () => {
  assert.equal((await run(["migrate-in"], okReply)).code, 2);
  assert.equal((await run(["migrate-in", "a", "b"], okReply)).code, 2);
  assert.equal((await run(["migrate-in", "a", "--from", "x"], okReply)).code, 2);
  const h = await run(["--help"], okReply);
  assert.match(h.out, /migrate-in <machine>/);
});
