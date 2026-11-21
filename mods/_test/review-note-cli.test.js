// `drover` usage and docs name the structured review note kind and its text format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const BIN = new URL("../drover-tasks/bin/drover", import.meta.url).pathname;

test("usage lists the review kind and its format", () => {
  const r = spawnSync(BIN, [], { encoding: "utf8" });
  const text = `${r.stdout}${r.stderr}`;
  assert.match(text, /--kind decision\|log\|blocker\|pr\|handoff\|review/);
  assert.match(text, /head=<sha> verdict=pass\|adverse report=<abs path>/);
});

test("docs/agents.md lists the review kind", () => {
  const doc = fs.readFileSync(new URL("../../docs/agents.md", import.meta.url), "utf8");
  assert.match(doc, /--kind decision\\\|log\\\|blocker\\\|pr\\\|handoff\\\|review/);
});
