// install.sh never runs the node test stage (a slow, minutes-long step that belongs to CI and to hand runs), and an old caller that still sets DROVER_SKIP_TESTS is harmless.
// Disposable repo copy and Herdr home; a `node` shim that records and fails any `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIN, fixture, run } from "./install-fixture.js";

const shimFor = (root) => {
  const dir = mkdtempSync(join(root, "node-shim-"));
  const marker = join(dir, "called");
  const real = process.execPath;
  writeFileSync(join(dir, "node"), `#!/bin/sh\nif [ "$1" = "--test" ]; then echo "$*" > "${marker}"; exit 99; fi\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return { dir, marker };
};

test("install.sh does not run node --test, with no skip variable set", () => {
  const { root, repo, home } = fixture();
  const { dir, marker } = shimFor(root);
  const r = run(repo, home, { DROVER_SKIP_TESTS: undefined, PATH: `${dir}:${BIN}:${process.env.PATH}` });
  assert.equal(existsSync(marker), false, "install.sh ran node --test");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readlinkSync(join(home, "mods", "drover-tasks")), join(repo, "mods", "drover-tasks"));
});

test("an old caller that still sets DROVER_SKIP_TESTS=1 installs the same way", () => {
  const { root, repo, home } = fixture();
  const { dir, marker } = shimFor(root);
  const r = run(repo, home, { DROVER_SKIP_TESTS: "1", PATH: `${dir}:${BIN}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(marker), false);
  assert.doesNotMatch(r.stdout + r.stderr, /DROVER_SKIP_TESTS|node tests/);
});
