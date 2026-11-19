// The Drover soul's Retro section must keep its staleness + contradiction rules (plain string guard against wording drift).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOUL = readFileSync(new URL("../drover-agents/souls/drover.md", import.meta.url), "utf8");
const m = SOUL.match(/^## Retro \(lessons\)\n([\s\S]*?)(?=^## )/m);
const RETRO = m ? m[1] : "";
const flat = RETRO.replace(/\s+/g, " ");

test("retro section exists", () => {
  assert.ok(RETRO.length > 200);
});

test("staleness pass runs stale --days 90 once per applicable scope flag", () => {
  assert.match(flat, /stale --days 90 <scope>/);
  for (const f of ["--org <slug>", "--project <id>", "--agent <id>"]) assert.ok(flat.includes(f), f);
  assert.match(flat, /once per applicable scope/);
  assert.match(flat, /Staleness alone is never a reason to remove/);
});

test("only the person's explicit confirm changes a date", () => {
  assert.match(flat, /only the person's explicit `confirm` for that item runs `drover-lessons confirm/i);
  assert.match(flat, /never runs `confirm`/);
  assert.match(flat, /`stale` is never followed by an automatic confirm/);
  assert.match(flat, /`edit` clears `confirmed`/);
});

test("skip, silence and later write nothing", () => {
  assert.match(flat, /skip, silence or "later" writes nothing/i);
});

test("contradiction pass: proposed, never auto-applied, contradicted first", () => {
  assert.match(flat, /contradicts L-nn/);
  assert.match(flat, /never auto-applied/);
  assert.match(flat, /contradicted or corrected first/);
});

test("plan file records ids and counts only for the stale pass", () => {
  assert.match(flat, /stale: 4 listed, 1 confirmed L-03/);
});
