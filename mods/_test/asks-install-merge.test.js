// T-MWPK6KYSFZV (B4a part B): the pure core of `drover asks-hook install` — what is written, how a file is parsed/refused, what is planned, the exact diff, the shared target resolver. No fs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lib, BIN } from "./asks-install-helper.js";
const { wantedFor, parseConfig, planInstall, planUninstall, render, unifiedDiff, resolveTargets, holdsEvents, Refuse, MATCHERS, timeoutFor } = lib;
const L = "/app/mods/drover-tasks/bin/drover-asks-hook";
const asks = await import("../drover-tasks/bin/asks-lib.mjs");

// the spike table (spike-T-MWO2HGDSXX1.md), verbatim rows: matcher and timeout per event
const SPIKE = {
  claude: { PermissionRequest: [undefined, 5, "set"], Notification: ["permission_prompt|elicitation_dialog", 5, "set"], PreToolUse: ["AskUserQuestion|ExitPlanMode", 5, "set"], PostToolUse: [undefined, 5, "clear"], UserPromptSubmit: [undefined, 5, "clear"], Stop: [undefined, 5, "clear"], SessionEnd: [undefined, 1, "clear"] },
  codex: { PermissionRequest: [undefined, 5, "set"], PostToolUse: [undefined, 5, "clear"], UserPromptSubmit: [undefined, 5, "clear"], Stop: [undefined, 5, "clear"] },
};

test("the wanted entries equal the spike table, built from KNOWN_EVENTS/EVENT_ACTION", () => {
  for (const cli of ["claude", "codex"]) {
    const w = wantedFor(cli, L);
    assert.deepEqual(Object.keys(w), asks.KNOWN_EVENTS[cli]);
    assert.deepEqual(Object.keys(w), Object.keys(SPIKE[cli]));
    for (const [ev, [matcher, timeout, action]] of Object.entries(SPIKE[cli])) {
      assert.equal(w[ev].matcher, matcher, `${cli} ${ev} matcher`);
      assert.deepEqual(w[ev].hooks, [{ type: "command", command: `'${L}' ${action}`, timeout }]);
    }
  }
  assert.equal(timeoutFor("claude", "SessionEnd"), 1);
  assert.equal(Object.keys(wantedFor("claude", L)).length, 7);
  assert.equal(Object.keys(wantedFor("codex", L)).length, 4);
});
test("a launcher path with a quote, newline, NUL or a relative path is refused", () => {
  for (const bad of ["/a/b'c", "/a/b\nc", "/a/b\0c", "rel/path", ""]) assert.throws(() => wantedFor("claude", bad), Refuse);
});
test("install code holds no answer literal (never decides a prompt)", () => {
  const src = readFileSync(`${BIN}/drover-asks-install.mjs`, "utf8");
  for (const w of ["hookSpecificOutput", "behavior", '"allow"', '"deny"']) assert.ok(!src.includes(w), w);
  assert.ok(!/decision/.test(src.replace(/state unclear[^\n]*/g, "")), "decision");
});

test("parseConfig refuses what it cannot round-trip or safely touch", () => {
  const bad = { "invalid json": "{", bom: "﻿{}", "array root": "[]\n", "hooks string": '{"hooks":"x"}\n', "event object": '{"hooks":{"Stop":{}}}\n', "group without hooks": '{"hooks":{"Stop":[{}]}}\n',
    "wrong spacing": '{"a":1}\n', "duplicate keys": '{\n  "a": 1,\n  "a": 2\n}\n', "proto": '{\n  "__proto__": {}\n}\n', "comments": '{\n  // x\n}\n' };
  for (const [name, text] of Object.entries(bad)) assert.throws(() => parseConfig(text), Refuse, name);
});
test("parseConfig keeps indent (2/4/tab) and trailing newline", () => {
  for (const [ind, nl] of [["  ", true], ["    ", true], ["\t", false], ["  ", false]]) {
    const text = render({ a: 1, hooks: {} }, ind, nl);
    const p = parseConfig(text);
    assert.equal(p.indent, ind); assert.equal(p.nl, nl);
    assert.equal(render(p.root, p.indent, p.nl), text);
  }
  assert.equal(parseConfig("{}").indent, "  ");
});

const base = () => ({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine", timeout: 3 }] }], Other: [] } });
test("install plan appends ours LAST, keeps order and every other key", () => {
  const w = wantedFor("claude", L);
  const pl = planInstall(base(), "claude", w);
  assert.deepEqual(Object.keys(pl.next), ["theme", "hooks"]);
  assert.equal(pl.next.hooks.Stop.length, 2);
  assert.equal(pl.next.hooks.Stop[0].hooks[0].command, "echo mine");
  assert.equal(pl.next.hooks.Stop[1].hooks[0].command, `'${L}' clear`);
  assert.deepEqual(pl.adds, asks.KNOWN_EVENTS.claude);
  assert.deepEqual(pl.created.events.sort(), asks.KNOWN_EVENTS.claude.filter((e) => e !== "Stop").sort());
  assert.equal(pl.created.hooks, false);
  const empty = planInstall({}, "claude", w);
  assert.equal(empty.created.hooks, true);
});
test("install plan is idempotent and keeps a differing entry of ours untouched (KEPT)", () => {
  const w = wantedFor("codex", L);
  const once = planInstall({}, "codex", w).next;
  const again = planInstall(once, "codex", w);
  assert.deepEqual(again.adds, []); assert.equal(again.same.length, 4); assert.deepEqual(again.next, once);
  const edited = structuredClone(once); edited.hooks.Stop[0].hooks[0].timeout = 99;
  const pl = planInstall(edited, "codex", w);
  assert.equal(pl.kept.length, 1); assert.equal(pl.kept[0].event, "Stop"); assert.deepEqual(pl.next.hooks.Stop, edited.hooks.Stop);
  assert.ok(holdsEvents(once, "codex", w, asks.KNOWN_EVENTS.codex));
  assert.ok(!holdsEvents(edited, "codex", w, ["Stop"]));
});
test("uninstall removes only deep-equal entries; emptied containers only when we created them", () => {
  const w = wantedFor("claude", L);
  const root = base();
  const inst = planInstall(root, "claude", w);
  const un = planUninstall(inst.next, "claude", w, inst.created);
  assert.deepEqual(un.next, root);
  assert.equal(un.removed.length, 7);
  // without a record (hand-installed): emptied event arrays stay, nothing else is invented
  const handless = planUninstall(inst.next, "claude", w);
  assert.deepEqual(handless.next.hooks.Notification, []);
  // an owner hook added into our own group is kept
  const mixed = structuredClone(inst.next); mixed.hooks.Stop[1].hooks.push({ type: "command", command: "echo owner" });
  const m = planUninstall(mixed, "claude", w, inst.created);
  assert.deepEqual(m.next.hooks.Stop[1].hooks, [{ type: "command", command: "echo owner" }]);
  // an edited entry of ours is KEPT with a reason
  const edited = structuredClone(inst.next); edited.hooks.PostToolUse[0].hooks[0].timeout = 77;
  const e = planUninstall(edited, "claude", w, inst.created);
  assert.equal(e.kept.length, 1); assert.equal(e.next.hooks.PostToolUse.length, 1);
});

test("unifiedDiff: exact text, 3 lines of context, new file against /dev/null", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "x", "x"), "");
  assert.equal(unifiedDiff("", "{}\n", "/dev/null", "f"), "--- /dev/null\n+++ f\n@@ -0,0 +1,1 @@\n+{}\n");
  const a = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", b = "1\n2\n3\n4\nX\n6\n7\n8\n9\n10\n";
  assert.equal(unifiedDiff(a, b, "f", "f"), "--- f\n+++ f\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+X\n 6\n 7\n 8\n");
  const claude = render({ hooks: {} }, "  ", true);
  const d = unifiedDiff(claude, render(planInstall({ hooks: {} }, "codex", wantedFor("codex", L)).next, "  ", true), "s.json", "s.json");
  assert.match(d, /^--- s\.json\n\+\+\+ s\.json\n@@ /);
  assert.match(d, /\+ {4}"PermissionRequest": \[/);
});

test("resolveTargets: flag, then DROVER_*, then the CLI's config dir, then HOME", () => {
  const h = "/h";
  assert.deepEqual(resolveTargets({}, {}, h), { claude: "/h/.claude/settings.json", codex: "/h/.codex/hooks.json" });
  assert.equal(resolveTargets({}, { CLAUDE_CONFIG_DIR: "/c" }, h).claude, "/c/settings.json");
  assert.equal(resolveTargets({}, { CODEX_HOME: "/x" }, h).codex, "/x/hooks.json");
  assert.equal(resolveTargets({}, { CLAUDE_CONFIG_DIR: "/c", DROVER_CLAUDE_SETTINGS: "/d.json" }, h).claude, "/d.json");
  assert.equal(resolveTargets({ claudeSettings: "/f.json" }, { CLAUDE_CONFIG_DIR: "/c", DROVER_CLAUDE_SETTINGS: "/d.json" }, h).claude, "/f.json");
  assert.equal(resolveTargets({ codexHooks: "/f.json" }, { CODEX_HOME: "/x", DROVER_CODEX_HOOKS: "/d.json" }, h).codex, "/f.json");
  assert.equal(resolveTargets({}, { HOME: "/e" }).claude, "/e/.claude/settings.json");
});

test("surgical uninstall never drops an owner's own empty group or empty event (review 1, Medium 5; class: everything not ours survives)", () => {
  const w = wantedFor("claude", L);
  const owners = [
    { hooks: { Stop: [{ matcher: "owner-template", hooks: [] }], Other: [{ matcher: "x", hooks: [] }] } },
    { hooks: { PostToolUse: [{ hooks: [] }, { matcher: "m", hooks: [{ type: "command", command: "echo a" }] }] } },
    { model: "x", hooks: { SessionEnd: [], Notification: [{ matcher: "permission_prompt|elicitation_dialog", hooks: [] }] } },
    { hooks: { Stop: [{ hooks: [], note: "keep" }] } },
  ];
  for (const root of owners) {
    const inst = planInstall(root, "claude", w);
    const un = planUninstall(inst.next, "claude", w, inst.created);
    assert.deepEqual(un.next, root, JSON.stringify(root));
  }
});
