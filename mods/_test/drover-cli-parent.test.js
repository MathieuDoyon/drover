// T-MWO3AW7QXPA: `drover task <id>` prints the parent card.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../drover-tasks/bin/drover");
let home;
const task = (id, title, extra = {}) => ({ id, column: "todo", title, priority: "P2", tags: [], ...extra });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cpar-"));
  mkdirSync(join(home, "data/drover-inbox"), { recursive: true });
  writeFileSync(join(home, "shared.json"), JSON.stringify({ "drover.tasks": [
    task("T-P1", "The parent card"), task("T-ARCH", "Old parent", { archived: true }),
    task("T-K1", "kid", { parent: "T-P1" }), task("T-K2", "kid of archived", { parent: "T-ARCH" }),
    task("T-K3", "kid of deleted", { parent: "T-GONE" }), task("T-S1", "solo"),
  ] }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const cli = (args) => new Promise((resolve) => execFile("bash", [CLI, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, DROVER_WRITE_WAIT: "0" } }, (e, stdout, stderr) => resolve({ code: e ? 1 : 0, stdout, stderr })));

test("task prints 'parent: <id> <title>'", async () => assert.match((await cli(["task", "T-K1"])).stdout, /^parent: T-P1 The parent card$/m));
test("an archived parent still shows its title", async () => assert.match((await cli(["task", "T-K2"])).stdout, /^parent: T-ARCH Old parent$/m));
test("a deleted parent shows (not found)", async () => assert.match((await cli(["task", "T-K3"])).stdout, /^parent: T-GONE \(not found\)$/m));
test("a card with no parent prints no parent line", async () => assert.doesNotMatch((await cli(["task", "T-S1"])).stdout, /parent:/));
