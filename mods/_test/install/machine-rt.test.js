// The fake remote runner's exec (mods/_test/install/stubs/machine-rt.js): async, but one call behaves like the spawnSync it replaced.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
const RT = await import(new URL("./stubs/machine-rt.js", import.meta.url).href);

const made = [];
afterEach(() => { for (const m of made.splice(0)) RT.rmMachine(m); });
const rt = (opts) => { const m = RT.makeMachine(opts); made.push(m); return { m, rt: RT.makeRuntime(m) }; };
const script = (m, name, body) => { const f = join(m.bin, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); };

test("exec delivers stdin, runs in the fake home with the fake env, and returns stdout", async () => {
  const { m, rt: r } = rt();
  const out = await r.exec("m1", ["sh", "-c", 'cat; printf "|%s|%s" "$PWD" "$HOME"'], { stdin: "héllo\nworld" });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, `héllo\nworld|${m.home}|${m.home}`);
  assert.equal(out.stderr, "");
});

test("exec returns a non-zero exit code with stdout and stderr, and records it on the call", async () => {
  const { m, rt: r } = rt();
  script(m, "fail3", 'echo out; echo err >&2; exit 3');
  const out = await r.exec("m1", ["fail3"]);
  assert.deepEqual(out, { code: 3, stdout: "out\n", stderr: "err\n" });
  assert.equal(r.calls[0].code, 3);
});

test("exec of a program that is not on the fake PATH is code 127 with the message, not a throw", async () => {
  const { rt: r } = rt();
  const out = await r.exec("m1", ["definitely-not-a-tool"]);
  assert.equal(out.code, 127);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /ENOENT/);
  assert.equal(r.calls[0].code, 127);
});

// A child that exits without reading its stdin is a race (EPIPE or not, depending on the OS and the pipe size). The old spawnSync runner reported the EPIPE as an
// error on some platforms (macOS), which exec turned into 127, and not on others (Linux): an intentional contract change makes both agree. The result is the
// child's own status and output; 127 is only for a spawn that itself fails.
test("exec of a child that exits without reading its stdin returns the child's own result, for a full pipe, a tiny stdin and an empty stdin (20 times each)", async () => {
  const { rt: r } = rt();
  for (const [label, stdin] of [["8 MiB", "x".repeat(8 << 20)], ["tiny", "hi"], ["empty", ""]]) {
    for (let i = 0; i < 20; i++) {
      const out = await r.exec("m1", ["sh", "-c", "echo out; echo err >&2; exit 4"], { stdin });
      assert.deepEqual(out, { code: 4, stdout: "out\n", stderr: "err\n" }, `${label}, run ${i}`);
    }
  }
});

test("exec of a child that reads all of a 1 MiB stdin returns its own exit code and output", async () => {
  const { rt: r } = rt();
  const out = await r.exec("m1", ["sh", "-c", "wc -c; exit 5"], { stdin: "x".repeat(1 << 20) });
  assert.equal(out.code, 5);
  assert.equal(out.stdout.trim(), String(1 << 20));
});

test("exec stays async: an `after` hook is awaited and a kill is still thrown before the chosen call", async () => {
  const m = RT.makeMachine(); made.push(m);
  const seen = [];
  const r = RT.makeRuntime(m, { after: async (c) => { await new Promise((res) => setImmediate(res)); seen.push(c.n); } });
  await r.exec("m1", ["true"]);
  assert.deepEqual(seen, [1], "the hook finished before exec returned");
  const k = RT.makeRuntime(m, { kill: 2 });
  await k.exec("m1", ["true"]);
  await assert.rejects(k.exec("m1", ["true"]), /killed before call 2/);
});
