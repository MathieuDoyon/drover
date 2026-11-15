// Edit dialog S7: send routing for a note, sub-issue rows + progress, folding of system notes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeSend, liveAgent, taggedText, launchPrompt, subIssues, foldNotes } from "../_lib/notesend.js";

const task = (over = {}) => ({ id: "T-1", title: "t", agent: null, run: null, ...over });
const RUN = { id: "R1", task: "T-1", terminals: [{ address: "t5", role: "Wrangler" }, { address: "t9", role: "leader" }] };
const mk = (over = {}) => {
  const calls = [];
  const deps = {
    saveNote: async (t) => { calls.push(["save", t]); },
    hcSend: async (a, t) => { calls.push(["send", a, t]); },
    launch: async (c, tk, p) => { calls.push(["launch", c, tk.id, p]); return {}; },
    ...over,
  };
  return { calls, deps };
};
const go = (o) => routeSend({ task: task(), runs: [], alive: new Set(), choice: { kind: "agent", id: "claude" }, text: "hi", ...o });

test("a live task.agent gets the note by hc send, tagged as from the person; nothing is launched", async () => {
  const { calls, deps } = mk();
  const r = await go({ task: task({ agent: "t3" }), alive: new Set(["t3"]), deps });
  assert.deepEqual(calls.map((c) => c[0]), ["save", "send"]);
  assert.equal(calls[1][1], "t3");
  assert.match(calls[1][2], /from the person/i);
  assert.match(calls[1][2], /hi$/);
  assert.deepEqual(r, { sent: "t3" });
});

test("no task.agent: the live leader of the linked run gets it", async () => {
  const { calls, deps } = mk();
  await go({ task: task({ run: "R1" }), runs: [RUN], alive: new Set(["t5", "t9"]), deps });
  assert.deepEqual(calls[1].slice(0, 2), ["send", "t9"]);
});

test("a dead agent and a dead leader: the choice is launched with the note in the prompt", async () => {
  const { calls, deps } = mk();
  const r = await go({ task: task({ agent: "t3", run: "R1" }), runs: [RUN], alive: new Set(["t5"]), choice: { kind: "squad", id: "s1" }, deps });
  assert.deepEqual(calls.map((c) => c[0]), ["save", "launch"]);
  assert.deepEqual(calls[1].slice(1, 3), [{ kind: "squad", id: "s1" }, "T-1"]);
  assert.match(calls[1][3], /hi/);
  assert.deepEqual(r, { started: true });
});

test("Don't start (choice 'none') only saves the note, even with no live agent", async () => {
  const { calls, deps } = mk();
  const r = await go({ choice: "none", deps });
  assert.deepEqual(calls.map((c) => c[0]), ["save"]);
  assert.deepEqual(r, { saved: true });
});

test("Don't start only saves, even when an agent is live (the card says 'just saves the note')", async () => {
  const { calls, deps } = mk();
  const r = await go({ task: task({ agent: "t3" }), alive: new Set(["t3"]), choice: "none", deps });
  assert.deepEqual(calls.map((c) => c[0]), ["save"]);
  assert.deepEqual(r, { saved: true });
});

test("a launch error keeps the note and returns {error}", async () => {
  const { calls, deps } = mk({ launch: async () => { throw new Error("no squad"); } });
  const r = await go({ deps });
  assert.deepEqual(calls.map((c) => c[0]), ["save"]);
  assert.equal(r.error, "no squad");
});

test("launch() returning {error} (io.launch style) also counts as an error", async () => {
  const { deps } = mk({ launch: async () => ({ error: "boom" }) });
  assert.equal((await go({ deps })).error, "boom");
});

test("an hc send failure keeps the note and returns {error}", async () => {
  const { calls, deps } = mk({ hcSend: async () => { throw new Error("gone"); } });
  const r = await go({ task: task({ agent: "t3" }), alive: new Set(["t3"]), deps });
  assert.equal(r.error, "gone");
  assert.deepEqual(calls.map((c) => c[0]), ["save"]);
});

test("the note is saved before anything else, and a save failure stops everything", async () => {
  const { calls, deps } = mk({ saveNote: async () => { throw new Error("disk"); } });
  const r = await go({ deps });
  assert.equal(r.error, "disk");
  assert.deepEqual(calls, []);
});

test("an empty note does nothing", async () => {
  const { calls, deps } = mk();
  assert.deepEqual(await go({ text: "  ", deps }), { empty: true });
  assert.deepEqual(calls, []);
});

test("liveAgent / taggedText / launchPrompt", () => {
  assert.equal(liveAgent(task(), [], new Set(["t3"])), null);
  assert.equal(liveAgent(task({ agent: "t3" }), [], new Set(["t3"])), "t3");
  assert.equal(liveAgent(task({ run: "R1" }), [{ ...RUN, terminals: [{ address: "t5" }, { address: "t6" }] }], new Set(["t6"])), "t6"); // no leader role: the last terminal
  assert.equal(liveAgent(task({ run: "R1" }), [{ ...RUN, task: "T-X" }], new Set(["t9"])), null);
  assert.match(taggedText("x"), /^\[Note from the person\]/);
  assert.match(launchPrompt("do it"), /do it$/);
});

const T = (id, over = {}) => ({ id, parent: "T-1", column: "todo", archived: false, ...over });

test("subIssues: children of the task, progress done/total, none -> null", () => {
  const tasks = [task(), T("T-2", { column: "done" }), T("T-3"), T("T-4", { parent: "T-9" })];
  const s = subIssues(tasks[0], tasks);
  assert.deepEqual(s.rows.map((x) => x.id), ["T-2", "T-3"]);
  assert.equal(s.progress, "1/2");
  assert.deepEqual([s.done, s.total], [1, 2]);
  assert.equal(subIssues(tasks[2], tasks), null);
});

test("subIssues ignores archived children", () => {
  const tasks = [task(), T("T-2", { archived: true }), T("T-3")];
  assert.equal(subIssues(tasks[0], tasks).progress, "0/1");
});

const N = (at, by, kind, text = "x") => ({ at, by, text, ...(kind ? { kind } : {}) });

test("foldNotes folds 2+ consecutive log/system notes into one group; a lone one stays", () => {
  const out = foldNotes([N(1, "you"), N(2, "t5", "log"), N(3, "t5", "log"), N(4, "t5", "decision"), N(5, "t5", "log"), N(6, "you")]);
  assert.deepEqual(out.map((x) => x.type), ["note", "fold", "note", "note", "note"]);
  assert.equal(out[1].count, 2);
  assert.equal(out[1].label, "› 2 activities");
  assert.deepEqual(out[1].notes.map((n) => n.at), [2, 3]);
  assert.equal(out[3].note.kind, "log");
});

test("foldNotes keeps the original index of each note", () => {
  const out = foldNotes([N(1, "you"), N(2, "a", "log"), N(3, "a", "log")]);
  assert.equal(out[0].index, 0);
  assert.deepEqual(out[1].notes.map((n) => n.index), [1, 2]);
});

test("foldNotes of nothing is empty", () => assert.deepEqual(foldNotes([]), []));

import { ago, initialOf } from "../_lib/notesend.js";

test("ago: relative time with 'ago', 'just now' under a minute", () => {
  const now = 10 * 86400000;
  assert.equal(ago(now - 6 * 86400000, now), "6d ago");
  assert.equal(ago(now - 3 * 3600000, now), "3h ago");
  assert.equal(ago(now - 5000, now), "just now");
  assert.equal(ago(null, now), "");
});

test("initialOf: first letter, upper case; empty -> ?", () => {
  assert.equal(initialOf("you"), "Y");
  assert.equal(initialOf("Wrangler (leader)"), "W");
  assert.equal(initialOf(""), "?");
});

import { mix } from "../_lib/notesend.js";

test("mix: blends two #rrggbb colors by a fraction; the ends return the inputs", () => {
  assert.equal(mix("#000000", "#ffffff", 0), "#000000");
  assert.equal(mix("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mix("#202020", "#000000", 0.5), "#101010");
  assert.equal(mix("#102030", "#102030", 0.4), "#102030");
});

test("mix: a color it cannot read comes back as the first input", () => {
  assert.equal(mix("red", "#000000", 0.5), "red");
  assert.equal(mix("#fff", "#000", 0.5), "#fff");
});
