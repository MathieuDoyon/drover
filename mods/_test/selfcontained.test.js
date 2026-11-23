// A mod copied alone into another Herdr home must run: every shared file is next to it, byte-equal to _lib, and tracked by git.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mods = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const copies = fs.readFileSync(path.join(mods, "_lib/copies.txt"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const dirs = fs.readdirSync(mods, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("drover-")).map((d) => d.name);
const git = (args) => { try { return execFileSync("git", args, { cwd: mods, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const inGit = git(["rev-parse", "--is-inside-work-tree"])?.trim() === "true";

test("the copy list matches install.sh", () => {
  assert.ok(copies.length >= 14);
  assert.match(fs.readFileSync(path.join(mods, "install.sh"), "utf8"), /_lib\/copies\.txt/);
});

test("install.sh refreshes the copies and runs no node tests", () => {
  const sh = fs.readFileSync(path.join(mods, "install.sh"), "utf8");
  assert.ok(sh.includes("done < _lib/copies.txt"), "the shared copies are made");
  assert.ok(sh.includes("query.js drover-config/query.js"), "the query.js copy is made");
  assert.ok(!sh.includes("node --test"), "install.sh must not run the node tests (CI and hand runs do)");
});

test("install.sh never overwrites a managed copy in place: it publishes through a captured link and a rename, and keeps a lock", () => {
  const sh = fs.readFileSync(path.join(mods, "install.sh"), "utf8");
  assert.doesNotMatch(sh, /sync_file\(\)/, "the old overwrite-in-place helper is back");
  assert.doesNotMatch(sh, /install -m 644 drover-github/, "query.js is copied outside the safe rule");
  for (const needle of ['ln "$key" "$aside"', 'mv -f "$st/snap" "$key"', "mkdir \"$lock\"", "sync_managed drover-github/query.js drover-config/query.js"]) assert.ok(sh.includes(needle), `install.sh lost: ${needle}`);
});

for (const dir of dirs) {
  const files = dir === "drover-config" ? [...copies.map((f) => [f, path.join(mods, "_lib", f)]), ["query.js", path.join(mods, "drover-github/query.js")]] : copies.map((f) => [f, path.join(mods, "_lib", f)]);
  test(`${dir}: shared files are present and byte-equal`, () => {
    for (const [f, src] of files) {
      const p = path.join(mods, dir, f);
      assert.ok(fs.existsSync(p), `${dir}/${f} is missing`);
      assert.ok(fs.readFileSync(p).equals(fs.readFileSync(src)), `${dir}/${f} differs from its source`);
    }
  });
  test(`${dir}: main.js imports resolve inside the mod`, () => {
    const main = fs.readFileSync(path.join(mods, dir, "main.js"), "utf8");
    for (const m of main.matchAll(/from\s+["'](\.\/[^"']+)["']/g)) {
      assert.ok(fs.existsSync(path.join(mods, dir, m[1])), `${dir}/main.js imports ${m[1]}, not in the mod folder`);
    }
  });
  test(`${dir}: shared files are tracked, not ignored`, { skip: !inGit }, () => {
    const tracked = new Set(git(["ls-files", dir]).split("\n"));
    for (const [f] of files) assert.ok(tracked.has(`${dir}/${f}`), `${dir}/${f} is not tracked by git`);
  });
}
