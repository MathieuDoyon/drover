// Probe for machines-fixture-children.test.js (not a test file itself: the runner only picks *.test.js). Run in its own `node --test`:
// it spawns a tracked sh with a descendant, records both pids, then throws. The fixture's afterEach must reap both.
import { test } from "node:test";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnTracked } from "../machines-install-fixture.js";
import { until } from "../../stubs/until.js";

test("probe: throws after spawning a tracked child", async () => {
  const dir = process.env.PROBE_DIR;
  const child = spawnTracked("/bin/sh", ["-c", `sleep 1000 & echo $! > "${join(dir, "grand")}"; : > "${join(dir, "started")}"; while :; do sleep 1; done`], { stdio: "ignore" });
  writeFileSync(join(dir, "parent"), String(child.pid));
  await until(() => existsSync(join(dir, "started")), "the probe child started");
  throw new Error("probe: deliberate failure after spawning");
});
