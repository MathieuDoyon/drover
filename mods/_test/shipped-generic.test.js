// Everything `drover machines install` ships, and the headless-board guide, is generic: no machine, owner or OS-specific names (card T-MWO2HE4FPJK).
// Generic patterns plus this user's and host's names and the linked machines, all read at run time (see private-words.js): this file spells no name.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GENERIC_LEAKS, wholeWord, runtimePrivateWords } from "./private-words.js";

const mods = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(mods, "..");
const { SHIPPED } = await import("../_lib/machines.js");
const words = runtimePrivateWords();
const hits = (file) => {
  const text = fs.readFileSync(file, "utf8");
  return [...(GENERIC_LEAKS.test(text) ? [`${path.relative(root, file)}: generic leak ${GENERIC_LEAKS.exec(text)[0]}`] : []), ...words.filter((w) => wholeWord(text, w)).map(() => `${path.relative(root, file)}: a private word (user, host or machine name)`)];
};

test("every shipped file is free of machine, owner and OS-specific names (canonical copy and the drover-tasks copy)", () => {
  const bad = [];
  for (const rel of SHIPPED) {
    const copy = path.join(mods, "drover-tasks", rel);
    assert.ok(fs.existsSync(copy), `${rel} is shipped from drover-tasks`);
    bad.push(...hits(copy));
    if (!rel.startsWith("bin/")) bad.push(...hits(path.join(mods, "_lib", rel)));
  }
  assert.deepEqual(bad, []);
});

test("the headless-board guide is free of those names too", () => {
  assert.deepEqual(hits(path.join(root, "docs/guides/headless-board.md")), []);
});
