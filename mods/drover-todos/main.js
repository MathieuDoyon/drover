// Drover Todos: capture, edit, search, archive and restore local tasks.
// As a pane or tab: the list. As a dialog (props.edit): the editor the other drover mods open.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Select, Combobox, Popup, Switch, TextView, Popover } from "gpui-base";
import { props, closeOverlay, theme, appHome, exec, notify, shared, setShared, agents, terminals, run as hostRun } from "herdr";
import * as fs from "fs/promises";
import { COLUMNS, PRIORITY_LABEL, STATUS_ICON, filterProjects, nextIndex, add, update, patchField, parentChoices, filterParents, parentLabel, applyCommand, matches, sorted, imageName, appendImage, imageLines, staleImages, canCreate, isSubmitKey, allTags, toggleTag, newTag, runnerChoices, agentChoices, canCreateAgent, startHint, claim, release, packDraft, unpackDraft, normAssignee, assigneeText } from "./store.js";
import { WAKE_KEY, addWake, setEnabled, isOpen, until, summary } from "./wake.js";
import { linkedRun, pastRuns, taskRuns, wakeLabel, runSummary, taskWakes, contextRows, carryContext, noteAuthor } from "./taskrun.js";
import { section, toggle } from "./ui.js";
import { openCommand, liveStatuses } from "./runs.js";
import { routeSend, liveAgent, subIssues, foldNotes, ago, initialOf, mix, noteRef, subtaskPrefill } from "./notesend.js";
import { age } from "./sources.js";
import { bind, cfg, isEnabled, whenLoaded, load as loadCfg, ready as cfgReady } from "./config.js";
import { gated } from "./ui.js";
import { load, save, edit, loadProjects, loadConfig, launch, sendToAgent, loadRuns, loadWakes, loadContext, jiraSite, mergeContext, openUrl, HEARTBEAT_MS, startOptions, beatCreateGuard, clearCreateGuard, modSettings, loadMerged, watchRemote, retryRemote, remoteSend, remoteReload, remoteWriteState } from "./io.js";
import { controlState, fieldState, statusLine, editOps, addOp, archiveOp, moveOp, outcomeText, applied, offTip } from "./remote-write-ui.js";
import { remoteCardRows, machineOf } from "./remote.js";
import { Proof } from "./proof.js";

const I = (name) => `mods/drover-todos/icons/${name}.svg`;
const pad = (n) => String(n).padStart(2, "0");
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const RELOAD_WAIT_MS = 8000; // an editor never waits longer than this for a board reload (the reader's own read deadline is 10 s)
const COLUMN_NAME = Object.fromEntries(COLUMNS);

const chip = (t, text, color) =>
  div().px(6).h(18).flex_none().flex().items_center().rounded(5).border_1().border_color(color ?? t.border)
    .text_size(10.5).text_color(color ?? t.muted).child(text);

// A keycap box (⌘, ↵) drawn in the colour of the button it sits in. id (optional) names it for tests.
const keycap = (t, name, ready, id) => div().size(22).flex_none().flex().items_center().justify_center().rounded(5).border_1().border_color(ready ? t.solid_foreground : t.dim)
  .when(Boolean(id), (el) => el.id(id))
  .child(svg(I(name)).size(12).text_color(ready ? t.solid_foreground : t.dim));

const PRIORITY_COLOR = (t) => ({ P0: t.blocked, P1: t.done, P2: t.muted, P3: t.dim });

const button = (t, id, text, primary, action) =>
  h_flex().id(id).h(30).px(12).items_center().rounded(7).cursor_pointer()
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5)
    .hover((s) => s.opacity(0.88)).on_click(action).child(text);

export class Editor {
  constructor(cx) {
    const p = props();
    // A card of a project on another machine (T-MWHVWR8TIJB) uses this same dialog: no local task behind it, the writes go to the remote writer.
    // fixedRemote: an existing card of a remote project (its baseline moves with each saved edit). A create is routed from the project picked NOW (get remote()).
    this.fixedRemote = p.remoteCard && !p.remoteCard.new ? p.remoteCard : null;
    const rc = p.remoteCard ?? null;
    this.picking = false; // the remote card: a property pick saves at once, ONE in flight; it counts as submitting (close, expand, Save, archive wait)
    this.msg = "";
    this.task = p.edit && !this.remote ? load().find((x) => x.id === p.edit) : null;
    const t = rc ? { title: rc.title ?? "", desc: rc.desc ?? "", priority: rc.priority ?? "P2", tags: [...(rc.tags ?? [])], column: rc.column ?? p.column, project: rc.project } : this.task ?? { title: "", desc: "", priority: "P2", tags: [], column: p.column };
    this.priority = t.priority;
    this.column = t.column;
    this.project = t.project ?? null;
    this.parent = this.task?.parent ?? (this.fixedRemote ? this.fixedRemote.parent ?? null : p.parent ?? null); // edit: the stored parent; create: the sub-issue preset (props.parent)
    this.base = { title: t.title, desc: t.desc ?? "" }; // edit: the text the editor last saw stored; only a field that differs from it is the person's edit
    this.moreOpen = false; // edit: header "…" menu
    this.confirmArchive = false;
    this.labels = [...(rc ? t.tags : this.task?.tags ?? [])];
    this.large = p.large === true;
    this.mode = "manual"; // create only: "manual" | "agent" (both drafts stay on toggle)
    const last = shared("drover.agents.last")?.runner;
    this.runner = last?.kind === "agent" && last.id !== "drover" ? last.id : "claude"; // agent mode: who creates the cards
    this.assignee = normAssignee((this.task ?? this.fixedRemote)?.assignee); // { kind, id }: saved on the card; Create also starts it with it
    this.seenAssignee = this.assignee ? `${this.assignee.kind}:${this.assignee.id}` : ""; // the stored assignee this editor last saw
    this.launch = launch; // injectable for tests
    this.remoteSender = remoteSend; // injectable for tests
    this.remoteReload = remoteReload; // injectable for tests
    this.sendToAgent = sendToAgent; // injectable for tests
    this.subsOpen = true; // edit: Sub-issues section expanded
    this.folds = new Set(); // edit: expanded "› N activities" groups, by index of their first note
    this.collapsed = new Set(); // edit: collapsed note cards, by note id (in memory, this dialog session)
    this.hoverId = null; // edit: the note card under the pointer
    this.noteMenu = null; // edit: note id whose "…" menu is open
    this.editNote = null; // edit: { id, state } inline editor of one note
    this.confirmDel = null; // edit: note id asking "Delete this note?"
    this.sendPick = undefined; // composer picker: undefined = the default (live agent / assignee), "none", or {kind, id}
    this.sending = false;
    this.noteError = null;
    this.labelSearch = InputState.new({ placeholder: "Search or create a label" });
    this.labelSearch.on("change", (_e, cx) => { this.hi = 0; cx.notify(); });
    this.error = null;
    this.another = false;
    this.menu = null;
    this.projSearch = InputState.new({ placeholder: "No project" });
    this.projSearch.on("change", (_e, cx) => { this.hi = 0; cx.notify(); });
    this.parentSearch = InputState.new({ placeholder: "Search for a parent" });
    this.parentSearch.on("change", (_e, cx) => { this.hi = 0; cx.notify(); });
    this.hi = 0;
    this.menuFocus = cx.focus_handle();
    this.trigger = { status: cx.focus_handle(), priority: cx.focus_handle(), labels: cx.focus_handle(), assignee: cx.focus_handle(), agent: cx.focus_handle(), project: cx.focus_handle(), parent: cx.focus_handle(), send: cx.focus_handle() };
    const d = unpackDraft(p.draft); // expand/shrink reopen: the draft comes back (a remote card carries it too)
    if (d && this.task) this.pasted = d.pasted;
    else if (d) {
      Object.assign(this, { mode: d.mode, labels: d.labels, assignee: d.assignee, another: d.another, pasted: d.pasted });
      if (rc) this.parent = d.parent ?? null;
      for (const k of ["column", "priority", "runner", "project"]) if (k in d) this[k] = d[k];
    }
    this.title = InputState.new({ placeholder: this.task ? "What needs doing?" : "Task title", value: d?.title ?? t.title });
    this.title.on("submit", (_e, cx) => this.submitKey(cx)); // ⌘↵ also reaches the root key handler: one create, not two
    this.title.on("change", (_e, cx) => { cx.notify(); this.autosave(cx); });
    this.title.on("blur", (_e, cx) => this.flushInBackground(cx));
    this.desc = TextareaState.new({ placeholder: this.task ? "Details, links, acceptance…" : "Add description...", value: d?.desc ?? t.desc, rows: 5 });
    if (this.task) this.desc.set_auto_grow?.(4, 400); // edit: grows with the text (400 rows is no practical cap); the thread stays the only scroll
    this.editing = false; // edit: read mode (rendered) until the pencil
    this.desc.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.desc.on("change", (_e, cx) => this.autosave(cx));
    this.desc.on("blur", (_e, cx) => this.flushInBackground(cx));
    // The textarea may take Cmd+Enter itself and emit submit with secondary: handle both, once per press.
    this.desc.on("submit", (e, cx) => { if (e.secondary) this.submitKey(cx); });
    this.prompt = TextareaState.new({ placeholder: 'Tell the agent what to do, e.g. "Create a P1 bug card to fix the login redirect, in the Alpha project"', value: d?.prompt ?? "", rows: 5 });
    this.prompt.on("change", (_e, cx) => cx.notify());
    this.prompt.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.prompt.on("submit", (e, cx) => { if (e.secondary && !this.task) this.submitKey(cx); });
    this.note = TextareaState.new({ placeholder: "Leave a comment…", value: d?.note ?? "", rows: 3 });
    this.note.on("change", (_e, cx) => cx.notify()); // the send button follows the text
    this.note.on("submit", (e, cx) => { if (e.secondary) this.noteKey(cx); });
    this.wakeWhen = InputState.new({ placeholder: "15m", value: "15m" });
    this.wakeText = InputState.new({ placeholder: "Message to the agent" });
    this.wakeText.on("submit", (_e, cx) => this.addWakeup(cx));
    this.srcUrl = InputState.new({ placeholder: "https://github.com/owner/repo/issues/1 or https://site/browse/KEY-1" });
    this.srcUrl.on("submit", (_e, cx) => this.startLink(cx));
    this.linking = false; this.linkError = null;
    this.adding = false;
    this.historyOpen = false;
    this.runHistoryOpen = false;
    this.wakeError = null;
    this.title.focus();
    cx.timer.after(300, () => this.title.focus());
    if (rc || loadProjects().some((x) => x.remote)) watchRemote(cx, () => !this.closing || this.leaving); // `leaving`: a close/expand flush in progress still needs its reads (the next request's rev) // this dialog drives the probe and the result polling for its own writes
    this.ctx = null; // issue + pull requests, refreshed while the editor is open
    this.ctxRun = undefined; // the linked run id the last refresh used
    // The dialog is never gated by the screen switch, but it reads the screen's settings (shared + mod.json) before it fixes its timer.
    if (this.task) {
      const every = (cx) => cx.timer.every?.(cfg("drover-todos", "context_refresh_seconds") * 1000, (cx) => this.refreshContext(cx));
      if (typeof cx.spawn === "function") cx.spawn(async (cx) => { await loadCfg("drover-todos"); every(cx); }); // the spawned cx outlives the await; the init cx does not
      else every(cx);
    }
  }

  // Source card and pull requests: a failed refresh keeps the last good data and adds an error row. No run is fine.
  refreshContext(cx) {
    if (!this.task || this.closing || this.ctxLoading || !cx.spawn) return;
    const stored = load().find((x) => x.id === this.task.id) ?? this.task;
    const run = linkedRun(stored, loadRuns());
    this.ctxRun = run?.id ?? null;
    this.ctxLoading = true;
    const gen = this.ctxGen ?? 0;
    cx.spawn(async (cx) => {
      try {
        const next = await loadContext(run, stored);
        if (gen !== (this.ctxGen ?? 0)) return;
        this.ctx = { ...mergeContext(carryContext(this.ctx ?? undefined, run?.id ?? null), next), run: run?.id ?? null };
      } catch (e) {
        if (gen !== (this.ctxGen ?? 0)) return;
        this.ctx = { ...mergeContext(carryContext(this.ctx ?? undefined, run?.id ?? null), { at: Date.now(), issue: null, prs: null, errors: [`Pull requests: ${e?.message ?? e}`] }), run: run?.id ?? null };
      } finally { if (gen === (this.ctxGen ?? 0)) this.ctxLoading = false; cx.notify(); }
    });
  }

  // Wakeups save at once (not part of Save), like notes and properties.
  // Source section: link a pasted issue URL to the card, or unlink it (the same op as `drover link`).
  async linkIssue(cx, url = this.srcUrl.value()) {
    if (!this.task || this.closing) return false;
    const jiraSiteName = await jiraSite().catch(() => "");
    const r = applyCommand(load(), { op: "link", id: this.task.id, url, by: "you", jiraSite: jiraSiteName });
    this.linkError = r.error ?? null;
    if (!r.error) {
      save(r); this.srcUrl.set_value(""); this.linking = false;
      this.ctx = null; this.ctxRun = undefined; this.ctxLoading = false; this.ctxGen = (this.ctxGen ?? 0) + 1; // the next render reads the new source; an old in-flight read is dropped
    }
    cx.notify();
    return !r.error;
  }
  // Event handlers enter here: an event cx expires across an await, so the async work runs on the spawn's own context.
  startLink(cx, url = this.srcUrl.value()) { return cx.spawn((acx) => this.linkIssue(acx, url)); }
  unlinkIssue(cx) { return this.linkIssue(cx, "none"); }

  toggleWake(id, cx) {
    const w = loadWakes().find((x) => x.id === id);
    if (!w) return;
    setShared(WAKE_KEY, setEnabled(loadWakes(), id, w.enabled === false));
    cx.notify();
  }

  // A wakeup aimed at this task: the host resolves it to the task's agent when it fires.
  addWakeup(cx) {
    if (!this.task || this.closing) return false;
    const r = addWake(loadWakes(), { target: this.task.id, when: this.wakeWhen.value(), text: this.wakeText.value() });
    this.wakeError = r.error ?? null;
    if (!r.error) { setShared(WAKE_KEY, r.list); this.wakeText.set_value(""); this.adding = false; }
    cx.notify();
    return !r.error;
  }

  // Paste with no text: save the clipboard image under the app folder, link it in the description.
  pasteImage(cx) {
    if (this.remote || this.submitting || this.closing) return; // a remote card takes no image: nothing is saved on this machine
    const prev = this.pending;
    let done;
    this.pending = new Promise((r) => (done = r));
    this.busy = (this.busy ?? 0) + 1;
    // The event cx dies at the first await: the async work runs in cx.spawn with its AsyncContext.
    cx.spawn(async (acx) => {
      try { await prev; await this.savePastedImage(acx); } finally { this.busy--; done(); }
    });
  }

  async savePastedImage(cx) {
    const dir = `${appHome()}/drover-tasks/images`;
    const file = `${dir}/${imageName(Date.now())}`;
    try {
      await fs.mkdir(dir, { recursive: true });
      // ponytail: macOS only. The host image API (feedbackPasteImage) throws outside the feedback frame. The path goes in argv, not in the script.
      const r = await exec("osascript", ["-e", "on run argv", "-e", "set f to open for access POSIX file (item 1 of argv) with write permission",
        "-e", "try", "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f", "-e", "on error m", "-e", "close access f",
        "-e", "error m", "-e", "end try", "-e", "end run", file]);
      if (r.code !== 0) { await fs.unlink(file).catch(() => {}); throw new Error("The clipboard has no image"); }
      const box = this.mode === "agent" ? this.prompt : this.desc;
      (this.pasted ??= []).push(file);
      if (this.task) box.replace(`![image](<${file}>)`); // edit: at the cursor, or over the selection
      else {
        const text = appendImage(box.value(), file); // create modal and agent prompt: at the end
        box.set_value(text);
        box.set_selected_range({ start: text.length, end: text.length });
      }
      box.focus();
    } catch (e) {
      notify({ title: "Image not pasted", body: String(e.message ?? e), level: "error" });
    }
    cx.notify();
  }

  fields() {
    return { title: this.title.value(), desc: this.desc.value(), tags: this.labels, priority: this.priority, column: this.column, project: this.project, assignee: this.assignee, ...(!this.task && this.parent ? { parent: this.parent } : {}) };
  }

  // Saved tags plus the draft's own: a new tag stays pickable (and removable) before the task exists.
  labelChoices() { return this.remote ? allTags([{ tags: this.remoteChoices().tags }, { tags: this.labels }]) : allTags([...load(), { tags: this.labels }]); }

  // Edit: a label pick saves at once as a tags patch. Create: it only changes the draft.
  toggleLabel(tag, cx) {
    const next = toggleTag(this.labels, tag);
    if (this.fixedRemote) this.setProp("tags", next, cx);
    else if (this.task && cx) this.patch("tags", next, cx);
    else this.labels = next;
  }

  // A property pick. Edit: a one-field patch on the stored task. Create: the draft changes.
  setProp(field, value, cx) {
    if (this.fixedRemote) return this.remotePick(field, value, cx); // a remote card: a pick saves at once, like the local editor
    if (field === "project" && this.submitting && !this.task) return false; // a Create is in flight moves a card: the project is where it is
    if (this.task) return this.patch(field, value, cx);
    const key = { status: "column", priority: "priority", assignee: "assignee", project: "project", tags: "labels", parent: "parent" }[field];
    this[key] = value;
    return true;
  }

  // Create "<text>": a new tag joins the picked ones and the search clears.
  createLabel(cx) {
    const tag = newTag(this.labelSearch.value(), this.labelChoices());
    if (!tag) return;
    if (!this.labels.includes(tag)) this.toggleLabel(tag, cx);
    this.labelSearch.set_value("");
    cx.notify();
  }

  // Autosave (edit only): title/description save as field patches 500 ms after the last keystroke. A newer keystroke
  // bumps saveGen, so an older timer finds a stale generation and does nothing.
  autosave(cx) {
    if ((!this.task && !this.fixedRemote) || this.closing) return; // a remote card autosaves its text the same way (one edit request per flush)
    this.closeForced = false; // new typing: a Close tries to send it again before it discards anything
    const gen = this.saveGen = (this.saveGen ?? 0) + 1;
    cx.timer.after(this.saveDelay ?? 500, (acx) => (gen === this.saveGen ? this.flushSave(acx) : undefined));
  }

  // An event handler's cx dies at the first await: the flush runs in a spawn with its own live context.
  flushInBackground(cx) {
    if (this.task || this.fixedRemote) cx.spawn((acx) => this.flushSave(acx));
  }

  // Write the pending title/description now (waits for pastes in flight; cancels the timer). Resolves true when the
  // stored task has the text. A failed save sets this.error and keeps the text in the fields. Flushes run one at a time.
  flushSave(cx) {
    this.saveGen = (this.saveGen ?? 0) + 1;
    if (!this.task && !this.fixedRemote) return Promise.resolve(true);
    const run = async () => {
      if (!this.task) return this.flushRemoteText(cx); // a remote card: one inbox edit with the changed text
      await this.pending;
      const id = this.task.id;
      const stored = load().find((x) => x.id === id);
      if (!stored) { this.error = `Task ${id} not found`; cx.notify(); return false; }
      // Only a field the person edited (it differs from the baseline) is patched: an untouched one never overwrites a concurrent edit.
      let list = load(), changed = false;
      const wrote = {};
      for (const [field, value] of [["title", this.title.value()], ["desc", this.desc.value()]]) {
        if (String(value).trim() === String(this.base[field]).trim()) continue;
        const r = patchField(list, id, field, value);
        if (r.error) { this.error = r.error; cx.notify(); return false; }
        list = r.tasks; changed = true; wrote[field] = value;
      }
      if (changed) save({ tasks: list });
      Object.assign(this.base, wrote);
      this.error = null;
      cx.notify();
      return true;
    };
    return (this.flushing = (this.flushing ?? Promise.resolve()).then(run, run));
  }

  // Remote flush: ONE inbox edit with only the changed title and/or description, ifRev = the baseline rev (rebased after every saved request), through the
  // same one-request-at-a-time lock as the sidebar picks: it waits for a pick in flight (bounded), and the rows are off while it saves. Stale or refused:
  // the banner shows, the typed text is KEPT, the rev and the other rows come from the remote's reloaded card, and the next autosave retries.
  // Resolves true when the text is saved, unchanged, or sent with an unknown outcome (the writer reconciles it); false = stay open like a failed local save.
  flushRemoteText(cx) {
    const card = this.fixedRemote;
    if (!card) return Promise.resolve(true);
    if (!editOps(card, { title: this.title.value(), desc: this.desc.value() }).length) { this.textDeferred = false; this.closeForced = false; return Promise.resolve(true); } // nothing typed
    this.textOps = (this.textOps ?? 0) + 1; // the rows are off from the moment a flush is queued
    const tok = { started: false, cancelled: false, done: false };
    const run = this.runExclusive(() => { if (tok.cancelled) return true; tok.started = true; return this.flushRemoteNow(cx); })
      .finally(() => { tok.done = true; this.textOps--; if (!this.closing || this.leaving) cx.notify?.(); if (tok.cancelled) this.retryDeferredText(cx); }); // a closed view's context is not used; a cancelled flush is replaced by a fresh one
    // The wait to ENTER the serializer is bounded: past the bound the flush is cancelled (it will not run later) and reported as deferred, so Close is never
    // trapped behind a request that does not settle. A flush that has started is already bounded by the writer's and the reload's own deadlines.
    const bound = new Promise((resolve) => cx?.timer?.after?.(this.reloadWaitMs ?? RELOAD_WAIT_MS, () => {
      if (tok.started || tok.done) return;
      tok.cancelled = true; this.textDeferred = true; resolve(false);
    }));
    return Promise.race([run, bound]);
  }
  // Runs in its turn: sends what differs NOW (so text typed while an earlier request was in flight is sent too), until the input equals the acknowledged card.
  async flushRemoteNow(cx) {
    for (let i = 0; i < 10; i++) {
      const base = this.fixedRemote;
      if (!base) return true;
      const op = editOps(base, { title: this.title.value(), desc: this.desc.value() })[0];
      if (!op) { this.textDeferred = false; this.closeForced = false; this.error = null; return true; }
      this.textDeferred = false;
      const w = this.wstate(op.op);
      if (!w.on) { this.msg = w.tip; this.textDeferred = true; return false; } // never sent: a later op retries it
      const last = await this.remoteSender(base.project, op, cx);
      if (last.status === "saved") {
        this.reloadFailed = false;
        const next = await this.settleSaved(base, op, base.project, cx);
        this.adopt(next);
        this.msg = this.reloadFailed ? `saved, but could not reload ${this.rname()}: reopen the card` : ""; this.error = null;
        continue; // the input may have changed while the request was in flight
      }
      this.msg = outcomeText(last);
      this.reloadFailed = false;
      await this.reloadBounded(base.project, cx); // stale or refused: the remote's card gives the rev and the rows; the typed text stays
      const fresh = loadMerged().tasks.find((x) => x.id === base.id && x.project === base.project);
      if (fresh) { this.adopt({ ...fresh }); this.rowsFrom(this.fixedRemote); }
      if (this.reloadFailed) this.msg += ` · could not reload ${this.rname()}: reopen the card`;
      return false;
    }
    return false; // still typing faster than it saves: stay open
  }

  // Notes save at once: the note goes to the stored task, the editor fields stay as typed.
  addNote(cx) {
    if (!this.task || this.closing) return false;
    const r = applyCommand(load(), { op: "note", id: this.task.id, text: this.note.value(), by: "you" });
    if (r.error) { this.error = r.error; cx.notify(); return false; }
    save(r);
    this.error = null;
    this.note.set_value("");
    cx.notify();
    return true;
  }

  // A property edit saves at once as a one-field patch on the stored task (never the whole form).
  patch(field, value, cx) {
    if (!this.task || this.closing) return false;
    if (!this.commit(patchField(load(), this.task.id, field, value), cx)) return false;
    const mirror = { status: "column", priority: "priority", assignee: "assignee", project: "project", tags: "labels", parent: "parent" }[field];
    if (mirror) this[mirror] = value;
    this.error = null;
    cx.notify();
    return true;
  }

  // The pencil: read mode -> edit mode (title Input + description Textarea). Edit mode -> flush, then back to the rendered saved text.
  // A failed save stays in edit mode with the error. Blocks close and new pastes while the flush waits for the accepted ones.
  toggleEdit(cx) {
    if (!this.task || this.closing || this.submitting) return;
    if (!this.editing) { this.editing = true; this.title.focus(); cx.notify(); return; }
    this.submitting = true;
    cx.spawn(async (acx) => {
      try { if (await this.flushSave(acx)) this.editing = false; } finally { this.submitting = false; acx.notify(); }
    });
  }

  toggleMore(cx) { this.moreOpen = !this.moreOpen; this.confirmArchive = false; cx.notify(); }
  setMore(open, cx) { this.moreOpen = open; this.confirmArchive = false; cx.notify(); } // Popover: outside press / Esc / trigger press
  askArchive(cx) { this.confirmArchive = true; cx.notify(); }
  cancelArchive(cx) { this.confirmArchive = false; this.moreOpen = false; cx.notify(); }

  // Archive/Restore (after the header menu's confirm): flush the text, flip the flag, close. The stored description decides which pasted files stay.
  archive(cx) {
    if (!this.task || this.closing || this.submitting) return;
    this.closing = true;
    cx.spawn(async (acx) => {
      if (!(await this.flushSave(acx))) { this.closing = false; acx.notify(); return; }
      const stored = load().find((x) => x.id === this.task.id);
      if (stored && this.commit(update(load(), this.task.id, { archived: !stored.archived }), acx)) await this.finish();
      else { this.closing = false; acx.notify(); }
    });
  }

  // Saves a valid result and returns true. The caller then runs finish().
  commit(result, cx) {
    if (result.error) { this.error = result.error; cx.notify(); return false; }
    if (save(result) === null) { this.error = "Not saved: that project belongs to another machine"; cx.notify(); return false; } // the ownership guard refused: the draft stays
    return true;
  }

  // Delete this session's pasted files that no saved task links (archived too), then close.
  // The linked run's squad rows, as the Run section shows them.
  runRows() {
    const all = loadRuns();
    const stored = load().find((x) => x.id === this.task?.id) ?? this.task;
    const r = stored && linkedRun(stored, all);
    if (!r) return [];
    const live = liveStatuses(agents(), terminals());
    const alive = new Set(terminals().map((x) => x.address));
    return runSummary(r, live, alive, Date.now(), all).rows;
  }

  // Jump to a squad member: a tabbed agent gets the focus, a parked worker is peeked. A gone one is not clickable.
  // Like close(): flush unsaved text first (a failed save stays open with its error), jump, then close the dialog.
  openMember(m, cx) {
    if (!m.focusable || !this.task || this.closing || this.submitting) return;
    this.closing = true;
    cx.spawn(async (acx) => {
      if (!(await this.flushSave(acx))) { this.closing = false; acx.notify(); return; }
      hostRun(openCommand(m), { terminal: m.address });
      await this.finish();
    });
  }

  // Delete first: closeOverlay may drop the view and cancel its spawned work.
  async finish() {
    await this.pending;
    const descs = load().map((t) => t.desc ?? "");
    for (const f of staleImages(this.pasted ?? [], descs, appHome())) await fs.unlink(f).catch(() => {});
    closeOverlay(props().overlay);
  }

  // ⤢ / ⤡: reopen the create modal bigger or smaller with the whole draft. No finish(): the pasted files stay, the new modal owns them.
  // Wait for a paste in flight so its link is in the draft. Open first, close last: closeOverlay may cancel this view's work.
  expand(cx) {
    if (this.fixedRemote && !this.closing && !this.pickBusy()) { // a remote card reopens as the same remote card, bigger or smaller, with the whole draft; text is flushed first
      this.closing = true;
      cx.spawn(async (acx) => {
        this.leaving = true;
        const flushed = await this.flushSave(acx);
        this.leaving = false;
        if (!flushed) { this.closing = false; acx.notify(); return; }
        const draft = packDraft({ title: this.title.value(), desc: this.desc.value(), note: this.note.value(), priority: this.priority, column: this.column, labels: this.labels, assignee: this.assignee, parent: this.parent, project: this.project });
        edit(this.fixedRemote.id, this.column, draft, !this.large, null, this.fixedRemote);
        closeOverlay(props().overlay);
      });
      return;
    }
    if (this.remote || this.closing || this.submitting) return; // a create on a remote project does not travel through the local reopen
    this.closing = true;
    cx.spawn(async (acx) => {
      await this.pending;
      if (this.task && !(await this.flushSave(acx))) { this.closing = false; acx.notify(); return; }
      // Edit: carry what the flush left stored, so the reopened editor (baseline = stored) sees no phantom edit.
      const stored = this.task && load().find((x) => x.id === this.task.id);
      const draft = packDraft({ ...this.fields(), ...(stored ? { title: stored.title, desc: stored.desc ?? "" } : {}), note: this.note.value(), prompt: this.prompt.value(), mode: this.mode, labels: this.labels, assignee: this.assignee, runner: this.runner, another: this.another, pasted: this.pasted ?? [] });
      edit(this.task?.id ?? null, this.column, draft, !this.large, this.task ? null : this.parent);
      closeOverlay(props().overlay);
    });
  }

  // Open the parent's dialog. Wait for a paste in flight, flush the text (a failed save stays here with its error), then go.
  // Open first, then delete this session's unreferenced pasted files, close last (closeOverlay may cancel this view's work).
  // id null: open the create modal as a sub-issue of this task instead (the "+" of Sub-issues).
  openParent(id, cx) {
    if (!this.task || this.closing || this.submitting || this.navigating) return;
    this.navigating = true;
    cx.spawn(async (acx) => {
      await this.pending;
      if (!(await this.flushSave(acx))) { this.navigating = false; acx.notify(); return; }
      this.closing = true;
      if (id) edit(id, load().find((x) => x.id === id)?.column, null, this.large);
      else edit(null, "todo", null, this.large, this.task.id);
      const descs = load().map((t) => t.desc ?? "");
      for (const f of staleImages(this.pasted ?? [], descs, appHome())) await fs.unlink(f).catch(() => {});
      closeOverlay(props().overlay);
    });
  }

  addSubIssue(cx) { this.openParent(null, cx); }

  // One close action only: a second click during the close does nothing. Edit: flush first; a failed save stays open with the error.
  close(cx) {
    if (this.closing || this.submitting) return; // never blocked by a pick in flight: the writer keeps reconciling it
    this.closing = true;
    cx.spawn(async (acx) => {
      this.leaving = true;
      const flushed = !(this.task || this.fixedRemote) || (this.fixedRemote && this.closeForced) || (await this.flushSave(acx)); // forced: the second Close does not wait for anything
      this.leaving = false;
      if (!flushed) {
        // A text that could not be sent (an outcome is unknown) is not a saved text: stay open and say so; a second close discards it.
        if (!(this.fixedRemote && this.textDeferred && this.closeForced)) {
          this.closing = false;
          if (this.fixedRemote && this.textDeferred) { this.closeForced = true; this.msg = `Not sent yet: waiting for ${this.rname()}. Close again to discard your last edit.`; }
          acx.notify(); return;
        }
      }
      await this.finish();
    });
  }

  // Create another: clear the text, keep status/priority/project, stay open. The session's pasted files stay listed: finish() keeps the ones a saved task links.
  clear(cx) {
    this.title.set_value("");
    this.desc.set_value("");
    this.error = null;
    this.title.focus();
    cx.notify();
  }

  // The the remote card this dialog works on: an existing one, or a new one when the CURRENT project pick is bound to another machine (else null: local).
  get remote() {
    if (this.fixedRemote) return this.fixedRemote;
    if (this.task) return null;
    const b = this.project && loadProjects().find((x) => x.id === this.project && x.remote);
    return b ? { new: true, id: "", title: "", desc: "", column: this.column, priority: this.priority, tags: this.labels, notes: [], project: b.id, remote: { machine: b.remote.machine } } : null;
  }
  get card() { return this.remote; }
  set card(v) { if (this.fixedRemote) this.fixedRemote = v; }

  // ── a remote card: Save / Create go through the writer. Each op is sent after the one before it was saved (a save re-reads the board: the next op carries the new rev).
  rname() { return this.remote?.remote?.machine || "the remote machine"; } // the machine this card or project is bound to, for the messages
  gstate() { return controlState(remoteWriteState(this.card.project)); } // freshness and writes only: for the banner, never for a control
  wstate(op) { return controlState(remoteWriteState(this.card.project), op); } // op: the card op the control sends (the exec transport gates each op); none: freshness and writes only
  fstate() { return fieldState(remoteWriteState(this.card.project)); } // { on, tip }: priority, labels, assignee, parent, project
  // The options of the field pickers: ONLY what the remote's board carries (its assignees, its same-project cards, its tags, this machine's bound projects).
  remoteChoices() {
    const c = this.card, none = { assignees: [], parents: [], projects: [], tags: [] };
    if (!c) return none;
    const m = loadMerged(), picks = m.remotes.find((r) => r.localId === c.project)?.picks ?? { assignees: [], projects: [], tags: [] };
    const same = m.tasks.filter((x) => x.remote && x.project === c.project);
    if (picks.loading && !this.picksAsked) { this.picksAsked = true; void this.remoteReload(c.project); } // the cache has no lists yet (older mod copy): read them
    if (!picks.loading) this.picksAsked = false;
    return {
      loading: Boolean(picks.loading),
      assignees: picks.assignees,
      parents: c.new ? [] : parentChoices(same, c.id),
      projects: loadProjects().filter((p) => p.remote?.machine === c.remote?.machine && picks.projects.some((x) => x.id === p.remote.projectId)),
      tags: picks.tags,
    };
  }
  remoteOps() {
    const c = this.card, title = this.title.value(), desc = this.desc.value(), fs = this.fstate().on;
    if (c.new) return [addOp({ title, desc, column: this.column, priority: this.priority, tags: this.labels, ...(fs && this.assignee ? { assignee: this.assignee } : {}) })]; // an assignment only: nothing starts
    return editOps(c, { note: this.note.value() }); // an existing card: Save is the NOTE composer's button; text autosaves and every pick saves at once
  }
  // ── a remote card's property picks (status, priority, labels, assignee, parent, project) save at once, ONE inbox request each, with ifRev = the
  // editor's baseline rev. One pick in flight at a time: the rows are disabled ("saving…") until it settles, and close, Escape, expand, archive and Save
  // wait like for a Save. After every outcome the rows come from the remote's card (reloaded), so a stale or refused pick shows the remote's value.
  // Title, description and notes keep the Save button (the local editor autosaves its text; a request per pause is not worth it here).
  // ONE remote operation in flight per editor: a text flush, a pick and a note/archive all run through this chain. An op builds its request (rev, changed
  // fields) only when its turn starts, after its predecessor settled and the baseline was rebased; a wait never lets two overlap.
  runExclusive(fn) {
    const p = (this.opTail ?? Promise.resolve()).then(fn);
    this.opTail = p.then(() => {}, () => {});
    return p;
  }
  inflight() { return this.picking || this.submitting || this.textOps > 0; }
  pickBusy() { return this.picking || this.submitting; } // a pick or a Save is in flight (a text flush is queued behind it, not refused)
  inflightTip() { return "saving…"; }
  remotePick(field, value, cx) {
    const key = { status: "column", priority: "priority", assignee: "assignee", project: "project", tags: "labels", parent: "parent" }[field];
    if (!key || this.closing || this.inflight()) return false;
    if (field === "status" ? !this.wstate("move").on : !this.fstate().on) return false; // the control is dead: it says why
    this[key] = value;
    this.startPick(); this.msg = "Sending…"; cx.notify();
    cx.spawn(async (acx) => {
      try { await this.runExclusive(() => this.sendRemotePick(field, value, acx)); }
      catch (e) { if (this.closing) return; this.msg = this.error = `Not saved: ${String(e?.message ?? e).split("\n")[0]}`; if (this.fixedRemote) this.rowsFrom(this.fixedRemote); }
      finally { this.endPick(); this.retryDeferredText(acx); if (!this.closing) acx.notify(); }
    });
    return true;
  }
  // A text flush that was deferred behind an unknown outcome is tried again when the outcome is settled.
  // After a serializer op settles: a text draft that was DEFERRED or CANCELLED before it was ever sent (textDeferred) gets a FRESH flush; a cancelled one is
  // never revived. A text request that was sent and came back stale, refused or in error is never re-sent by itself: the text stays, the banner shows, and the
  // next keystroke (or the blur/close flush after one) is the retry.
  retryDeferredText(cx) {
    const card = this.fixedRemote;
    if (!card || this.closing || this.textOps > 0 || !this.textDeferred) return; // ONLY a draft that was deferred or cancelled before it was ever sent
    if (!editOps(card, { title: this.title.value(), desc: this.desc.value() }).length) return;
    void this.flushSave(cx);
  }
  startPick() { this.picking = true; this.pickDone = new Promise((r) => (this.pickRelease = r)); }
  endPick() { this.picking = false; this.pickRelease?.(); }
  rowsFrom(card) { // the pickers show this card's values
    Object.assign(this, { priority: card.priority ?? "P2", labels: [...(card.tags ?? [])], assignee: normAssignee(card.assignee), parent: card.parent ?? null, column: card.column, project: card.project });
  }
  // The card the remote has now becomes the baseline. An input the person did not touch (still equal to the OLD baseline text) follows the incoming text,
  // so a property reload never turns it into an edit; an edited one is kept.
  adopt(card) {
    const old = this.fixedRemote;
    if (old && card && card.id === old.id) {
      if (this.title.value().trim() === String(old.title ?? "").trim() && card.title !== old.title) this.title.set_value(card.title);
      if (this.desc.value() === (old.desc ?? "") && (card.desc ?? "") !== (old.desc ?? "")) this.desc.set_value(card.desc ?? "");
    }
    this.fixedRemote = card;
  }
  // A reload of the remote's board, bounded: past RELOAD_WAIT_MS the wait ends (the lock is released) and `reloadFailed` says so. The read itself goes on
  // in the reader and its answer is used by the next render.
  async reloadBounded(localId, acx) {
    let timer = false;
    const fin = await new Promise((resolve) => {
      Promise.resolve(this.remoteReload(localId)).then(() => resolve(true), () => resolve(true));
      acx?.timer?.after?.(this.reloadWaitMs ?? RELOAD_WAIT_MS, () => { timer = true; resolve(false); });
    });
    if (!fin && timer) this.reloadFailed = true;
    return fin;
  }
  // One request for one pick; rows and baseline end up as the remote's card says.
  async sendRemotePick(field, value, acx) {
    const card = this.fixedRemote;
    if (!card) return;
    const rev = Number.isSafeInteger(card.rev) && card.rev > 0 ? card.rev : 0;
    let op = null, destLocal = card.project;
    if (field === "status") { const mv = moveOp(card, value); op = mv && { ...mv, ifRev: rev }; }
    else if (field === "project") {
      const dest = loadProjects().find((x) => x.id === value)?.remote;
      if (dest && dest.machine === card.remote?.machine && value !== card.project) { op = editOps(card, { project: dest.projectId })[0]; destLocal = value; }
    } else op = editOps(card, { [field]: value })[0];
    if (!op) { this.rowsFrom(card); return; }
    const last = await this.remoteSender(card.project, op, acx);
    if (this.closing) return; // closed while it was in flight: the writer reconciles it, nothing is shown
    this.msg = outcomeText(last);
    if (last.status === "saved") {
      this.reloadFailed = false;
      const next = await this.settleSaved(card, op, destLocal, acx);
      if (this.closing) return; // closed meanwhile
      if (this.reloadFailed) this.msg = `saved, but could not reload ${this.rname()}: reopen the card`;
      this.adopt(next);
      this.rowsFrom(next);
      return;
    }
    await this.revertTo(card, acx);
  }
  // Not saved (stale, refused or error): reload and show the remote's card.
  async revertTo(card, acx) {
    this.reloadFailed = false;
    await this.reloadBounded(card.project, acx);
    if (this.closing) return;
    if (this.reloadFailed) this.msg = `${this.msg ? this.msg + " · " : ""}could not reload ${this.rname()}: reopen the card`;
    const fresh = loadMerged().tasks.find((x) => x.id === card.id && x.project === card.project);
    this.adopt(fresh ? { ...fresh } : card);
    this.rowsFrom(this.fixedRemote);
  }
  remoteSave(cx) {
    if (this.closing) return;
    if (this.inflight()) { if (!this.submitting) this.msg = "Saving a change…"; return cx.notify(); }
    const w = this.gstate();
    if (!w.on) { this.msg = w.tip; return cx.notify(); }
    const ops = this.remoteOps();
    if (!ops.length || ops.some((o) => !o)) { this.msg = this.card.new ? "A title is required" : "Nothing to save"; return cx.notify(); }
    const opOff = ops.map((o) => this.wstate(o.op)).find((c) => !c.on); // each op of the save has its own gate on the exec transport
    if (opOff) { this.msg = opOff.tip; return cx.notify(); }
    this.remoteRun(cx, ops, Boolean(this.card.new), this.card);
  }
  remoteArchive(cx) {
    const op = archiveOp(this.card);
    if (!op || this.pickBusy() || this.closing || !this.wstate("archive").on) return;
    cx.spawn(async (acx) => { // typed text is flushed first, as local does
      if (!(await this.flushSave(acx))) return;
      if (!this.closing && !this.pickBusy()) this.remoteRun(acx, [archiveOp(this.card)], true, this.card);
    });
  }
  // `target` is the card the submission was made for, read once when it started: nothing below reads this.card / this.remote again (the pick may move meanwhile).
  remoteRun(cx, ops, closeOnSaved, target) {
    this.submitting = true; this.msg = "Sending…"; this.error = null; cx.notify();
    const stay = this.another;
    const sub = { title: this.title.value(), desc: this.desc.value() }; // what was submitted: Create another clears the draft only if it is still this
    const destLocal = this.project; // where a project change in this Save lands (a local binding id)
    cx.spawn((acx) => this.runExclusive(async () => {
      let last = null, card = target, failed = null;
      if (!target.new && this.fixedRemote && ops[0]?.op === "note") { card = this.fixedRemote; ops = this.remoteOps(); } // a note is built when its turn starts: the rev after any earlier request
      try {
        for (const op of ops) {
          last = await this.remoteSender(card.project, op, acx);
          if (last.status !== "saved") break;
          card = await this.settleSaved(card, op, destLocal, acx); // a saved edit becomes the baseline (a move: the card on the destination board)
          if (this.fixedRemote) this.adopt(card);
        }
      } catch (e) { failed = e; } finally { this.submitting = false; } // the frozen picker always unfreezes
      if (failed) { this.msg = this.error = `Not saved: ${String(failed?.message ?? failed).split("\n")[0]}`; return acx.notify(); }
      this.msg = outcomeText(last);
      if (last?.status === "stale" && this.fixedRemote) { // the draft stays; the baseline rev follows the reloaded card so the next Save is not stale again
        await this.reloadBounded(card.project, acx);
        const fresh = loadMerged().tasks.find((x) => x.id === card.id && x.project === card.project);
        if (fresh && this.fixedRemote) this.fixedRemote = { ...this.fixedRemote, rev: fresh.rev };
      }
      if (last?.status === "saved") {
        if (closeOnSaved && !stay) { this.closing = true; return this.finish(); }
        if (card.new) { if (this.title.value() === sub.title && this.desc.value() === sub.desc) this.clear(acx); } else this.note.set_value?.("");
      }
      acx.notify();
    }).finally(() => this.retryDeferredText(acx)));
  }
  // An op of this editor was saved on the remote: the card as it is now. A project move reads the destination board and sits on the card there; any other
  // op takes the new rev from the re-read board (our own save moved it).
  async settleSaved(card, op, destLocal, acx) {
    let next = applied(card, op);
    const same = (x, project) => x.id === next.id && x.project === project;
    if (op.op === "edit" && op.project !== undefined) {
      next = { ...next, project: destLocal };
      await this.reloadBounded(card.project, acx);
      await this.reloadBounded(destLocal, acx);
      const there = loadMerged().tasks.find((x) => same(x, destLocal));
      if (there) next = there;
    } else if (!next.new) {
      const fresh = loadMerged().tasks.find((x) => same(x, next.project));
      if (fresh) next = { ...next, rev: fresh.rev };
    }
    return next;
  }

  // Both drafts stay; the other mode's field takes the focus.
  toggleMode(cx) {
    if (this.remote) return; // Switch to Agent needs a local agent: off for a remote project
    if (this.submitting || this.closing) return;
    this.mode = this.mode === "agent" ? "manual" : "agent";
    this.menu = null;
    (this.mode === "agent" ? this.prompt : this.title).focus();
    cx.notify();
  }

  // The footer button: a blank title (or prompt) does nothing (no error).
  onCreate(cx) {
    if (this.remote) return this.remoteSave(cx);
    if (this.mode === "agent" ? canCreateAgent(this.prompt.value()) : canCreate(this.title.value())) this.submit(cx);
  }

  // Agent mode: no card from the editor. A one-shot agent run makes the card(s) from the prompt.
  // Stay open until launch ends (a closed overlay cancels the spawn); an error stays on screen.
  submitAgent(cx) {
    if (this.submitting || this.closing || !canCreateAgent(this.prompt.value())) return;
    const stay = this.another;
    this.submitting = true;
    this.starting = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (acx) => { try {
      await this.pending;
      const request = this.prompt.value(); // after a pending paste: the final text
      if (!canCreateAgent(request)) { this.submitting = false; this.starting = false; acx.notify(); return; }
      const run = await this.launch(null, { kind: "agent", id: this.runner }, { project: this.project, create: request });
      this.starting = false;
      if (run?.error) { this.error = run.error; this.submitting = false; acx.notify(); return; }
      this.pasted = (this.pasted ?? []).filter((f) => !request.includes(f)); // the agent may read these: keep them
      if (stay) { this.submitting = false; this.prompt.set_value(""); this.prompt.focus(); acx.notify(); } else { this.closing = true; await this.finish(); }
    } catch (e) { this.error = `Not saved: ${String(e?.message ?? e).split("\n")[0]}`; } finally { if (!this.closing) { this.submitting = false; this.starting = false; } acx.notify(); } });
  }

  // Cmd+Enter in the note composer adds the note; it never reaches the root handler, so it never saves.
  onNoteKey(e, cx) {
    if (!isSubmitKey(e)) return;
    cx.stop_propagation();
    this.noteKey(cx);
  }

  // The key and the textarea's submit event may both fire for one press. The second one finds the composer already
  // cleared by the first successful send: only that (empty composer, within 150 ms of a sent note) is dropped.
  // Changed text is always a new attempt, and a failed or empty attempt records nothing.
  noteReady() { return this.note.value().trim().length > 0; }

  noteKey(cx) {
    if (!this.noteReady()) return; // the send button is disabled when empty: so is the key
    if (!this.note.value().trim() && Date.now() - (this.noteSentAt ?? -Infinity) < 150) return;
    if (this.sendNote(cx)) this.noteSentAt = Date.now();
  }

  aliveSet() { return new Set(terminals().map((x) => x.address)); }

  // The live agent a note would reach (task.agent, else the linked run's leader), or null.
  liveTarget() {
    const stored = load().find((x) => x.id === this.task?.id) ?? this.task;
    return stored ? liveAgent(stored, loadRuns(), this.aliveSet()) : null;
  }

  // What a send does: "none" (save only), a {kind, id} to start, or {kind: "live"} (a live agent gets it).
  // Default: a live agent (it gets the note whatever the assignee), else the card's assignee, else Don't start.
  sendChoice() {
    if (this.sendPick !== undefined) return this.sendPick;
    return this.liveTarget() ? { kind: "live" } : this.assignee ?? "none";
  }

  // Name of the live recipient: its name in the linked run, else its address.
  liveName() {
    const to = this.liveTarget();
    const stored = load().find((x) => x.id === this.task?.id) ?? this.task;
    return to ? taskRuns(stored, loadRuns()).flatMap((r) => r.terminals ?? []).find((m) => m.address === to)?.name ?? to : null;
  }

  // The picker's choices. A live agent: send to it, or just save. Otherwise the assignee first, then the rest, then Don't start.
  sendOptions(t = {}) {
    const cur = this.sendChoice();
    const is = (c) => (cur === "none" ? c === "none" : c !== "none" && cur?.kind === c.kind && cur?.id === c.id);
    const mk = (key, text, choice, glyph) => ({ key, glyph, color: t.muted, text, current: is(choice), on: (cx) => this.pickSend(key, cx), choice });
    const none = mk("none", this.liveTarget() ? "Don't send" : "Don't start", "none", "–");
    if (this.liveTarget()) return [mk("live", `Send to ${this.liveName()}`, { kind: "live" }, "●"), none];
    const all = runnerChoices(loadConfig()).filter((c) => !(c.kind === "agent" && c.id === "drover"))
      .map((c) => mk(`${c.kind}-${c.id}`, c.name, { kind: c.kind, id: c.id }, c.kind === "squad" ? "◈" : "●"));
    const first = this.assignee ? all.filter((o) => o.choice.kind === this.assignee.kind && o.choice.id === this.assignee.id) : [];
    return [...first, ...all.filter((o) => !first.includes(o)), none];
  }

  pickSend(key, cx) {
    const o = this.sendOptions().find((x) => x.key === key);
    if (o) this.sendPick = o.choice;
    cx.notify();
  }

  // Start the chosen runner on the card with the note. Flush the typed title/description (and pastes in flight) first, then
  // claim the card (shared: a second start or the queue sees "claiming"), launch from the reloaded task, release on failure.
  async startWithNote(choice, task, note, cx) {
    await this.pending;
    if (!(await this.flushSave(cx))) throw new Error(`The title or description is not saved: ${this.error ?? "unknown error"}`);
    const c = claim(load(), task.id, undefined, undefined, this.aliveSet());
    if (c.error) throw new Error(c.error);
    save(c);
    const run = await this.launch(c.task, choice, { ...(await startOptions()), note }).catch((e) => ({ error: String(e?.message ?? e) }));
    if (run?.error) save(release(load(), task.id, c.prev));
    else { this.assignee = normAssignee(load().find((x) => x.id === task.id)?.assignee); cx?.notify?.(); } // launch() may have made the squad the assignee: show it
    return run;
  }

  toggleFold(index, cx) {
    if (!this.folds.delete(index)) this.folds.add(index);
    cx.notify();
  }

  // ── note card actions. Every one targets the note by its stable id, against the stored task.
  hoverNote(id, hovered, cx) {
    if (hovered) this.hoverId = id;
    else if (this.hoverId === id) this.hoverId = null;
    cx.notify();
  }

  toggleCollapse(id, cx) {
    if (!this.collapsed.delete(id)) this.collapsed.add(id);
    cx.notify();
  }

  setNoteMenu(id, open, cx) {
    if (open) this.noteMenu = id;
    else if (this.noteMenu === id) this.noteMenu = null;
    cx.notify();
  }

  storedNote(id) { return (load().find((x) => x.id === this.task?.id)?.notes ?? []).find((n) => n.id === id) ?? null; }

  copyNote(id, cx) {
    const n = this.storedNote(id);
    this.noteMenu = null;
    if (n) cx.write_to_clipboard(n.text);
    cx.notify();
  }

  copyNoteId(id, cx) {
    const n = this.storedNote(id);
    this.noteMenu = null;
    if (n) cx.write_to_clipboard(noteRef(this.task, n));
    cx.notify();
  }

  // The create modal opens on top of this dialog (nothing is closed): parent = this task, description = quoted note + its reference.
  subtaskFromNote(id, cx) {
    const n = this.storedNote(id);
    this.noteMenu = null;
    if (n) { const f = subtaskPrefill(this.task, n); edit(null, "todo", packDraft({ desc: f.desc }), false, f.parent); }
    cx.notify();
  }

  startEditNote(id, cx) {
    const n = this.storedNote(id);
    this.noteMenu = null;
    if (!n) return cx.notify();
    const state = TextareaState.new({ placeholder: "Edit note…", value: n.text, rows: 3 });
    state.set_auto_grow?.(3, 400);
    state.on("submit", (e, acx) => { if (e.secondary) this.saveEditNote(acx); });
    state.focus?.();
    this.editNote = { id, state };
    this.confirmDel = null;
    cx.notify();
  }

  cancelEditNote(cx) { this.editNote = null; cx.notify(); }

  // Save by note id against the stored task. An empty text or an unknown note keeps the editor open with the error.
  saveEditNote(cx) {
    if (!this.editNote || !this.task) return false;
    const r = applyCommand(load(), { op: "note-edit", id: this.task.id, noteId: this.editNote.id, text: this.editNote.state.value(), now: Date.now() });
    if (r.error) { this.error = r.error; cx.notify(); return false; }
    save(r);
    this.error = null;
    this.editNote = null;
    cx.notify();
    return true;
  }

  onEditNoteKey(e, cx) {
    if (e.key === "escape") { this.cancelEditNote(cx); cx.stop_propagation(); }
    else if (isSubmitKey(e)) { this.saveEditNote(cx); cx.stop_propagation(); }
  }

  askDeleteNote(id, cx) { this.confirmDel = id; this.noteMenu = null; cx.notify(); }
  cancelDeleteNote(cx) { this.confirmDel = null; cx.notify(); }

  deleteNote(id, cx) {
    if (!this.task) return false;
    const r = applyCommand(load(), { op: "note-rm", id: this.task.id, noteId: id });
    if (r.error) { this.error = r.error; cx.notify(); return false; }
    save(r);
    this.error = null;
    this.confirmDel = null;
    if (this.editNote?.id === id) this.editNote = null;
    this.collapsed.delete(id);
    cx.notify();
    return true;
  }

  toggleSubs(cx) { this.subsOpen = !this.subsOpen; cx.notify(); }

  // Send: the note is saved first, then routed (routeSend). Don't start saves only. A launch/send error stays inline; the note stays saved.
  // Returns true when the attempt was accepted.
  sendNote(cx) {
    if (!this.task || this.closing || this.sending || this.submitting) return false;
    const choice = this.sendChoice();
    if (choice === "none") {
      const ok = this.addNote(cx);
      if (ok) { this.noteError = null; this.sendPick = undefined; }
      return ok;
    }
    const text = this.note.value().trim();
    if (!text) return this.addNote(cx);
    const stored = load().find((x) => x.id === this.task.id) ?? this.task;
    this.sending = true;
    this.submitting = true; // like a create in flight: close, expand, archive and open-child wait until the send ends
    this.noteError = null;
    cx.notify();
    cx.spawn(async (acx) => {
      let r;
      try {
        r = await routeSend({ task: stored, runs: loadRuns(), alive: this.aliveSet(), choice, text, deps: {
          saveNote: async () => { if (!this.addNote(acx)) throw new Error(this.error); },
          hcSend: (address, body) => this.sendToAgent(address, body),
          launch: (c, task, note) => this.startWithNote(c, task, note, acx),
        } });
      } finally { this.sending = false; this.submitting = false; }
      if (r.error) this.noteError = this.error ? null : `Note saved. ${r.error}`;
      else this.sendPick = undefined;
      acx.notify();
    });
    return true;
  }

  // Edit dialog keys: Esc closes the open menu or confirm first, then the dialog (the text is already saved or flushed); ⌘↵ as submitKey.
  editKey(e, cx) {
    if (e.key === "escape") {
      if (this.menu) { this.menu = null; cx.notify(); }
      else if (this.noteMenu) { this.noteMenu = null; cx.notify(); }
      else if (this.confirmDel) { this.confirmDel = null; cx.notify(); }
      else if (this.editNote) this.cancelEditNote(cx);
      else if (this.moreOpen) { this.moreOpen = false; this.confirmArchive = false; cx.notify(); }
      else if (this.editing) this.toggleEdit(cx); // Esc leaves edit mode (flushing) first; a second Esc closes
      else this.close(cx);
      cx.stop_propagation();
    } else this.onSubmitKey(e, cx);
  }

  onSubmitKey(e, cx) {
    if (!isSubmitKey(e)) return;
    cx.stop_propagation();
    this.submitKey(cx);
  }

  // A key press may reach both the textarea's submit event and the root key handler: one create per 150 ms.
  submitKey(cx) {
    const now = Date.now();
    if (now - (this.keyAt ?? 0) < 150) return;
    this.keyAt = now;
    if (this.task) return this.editing ? this.toggleEdit(cx) : void this.flushInBackground(cx); // edit: ⌘↵ leaves edit mode (flush); nothing to Save
    this.submit(cx);
  }

  submit(cx) {
    if (this.submitting || this.closing) return;
    if (this.remote) return this.remoteSave(cx);
    if (this.mode === "agent") return this.submitAgent(cx);
    const stay = this.another;
    const assignee = this.assignee;
    const snap = this.fields(); // the target (project, column, labels, priority…) as of the press; only the text is read again after a paste wait
    const commitNow = (cx) => {
      const f = { ...snap, title: this.title.value(), desc: this.desc.value() };
      let r = add(load(), f);
      // An assignee: save the card already claimed, in the same save, so the queue cannot start it while we launch.
      if (assignee && !r.error) { const c = claim(r.tasks, r.task.id); r = c; this.prev = c.prev; }
      this.created = r.task;
      return this.commit(r, cx);
    };
    if (!this.busy && !assignee) {
      if (!commitNow(cx)) return;
      if (stay) this.clear(cx); else { this.closing = true; cx.spawn(() => this.finish()); }
      return;
    }
    this.submitting = true;
    this.starting = Boolean(assignee);
    cx.notify();
    cx.spawn(async (acx) => { try {
      await this.pending;
      if (!commitNow(acx)) { this.submitting = false; this.starting = false; acx.notify(); return; }
      // The card exists now. A failed launch leaves it in Ready and launch() notifies the error: nothing more to do here.
      // Stay open until launch ends: a closed overlay cancels the spawn.
      if (assignee) {
        const opts = await startOptions();
        const run = await this.launch(this.created, assignee, opts);
        // launch() stays silent when it reports to a coordinator (the CLI gets the error): show it here, as the Picker does.
        if (run?.error && opts.reportTo) notify({ title: `${this.created.id} not started`, body: run.error, level: "error" });
        if (run?.error) save(release(load(), this.created.id, this.prev));
        this.starting = false;
      }
      if (stay) { this.submitting = false; this.clear(acx); } else { this.closing = true; await this.finish(); }
    } catch (e) {
      const line = String(e?.message ?? e).split("\n")[0];
      this.error = this.created ? `${this.created.id} created, but: ${line}` : `Not saved: ${line}`;
    } finally { if (!this.closing) { this.submitting = false; this.starting = false; } acx.notify(); } });
  }

  // Edit: another writer (a CLI/queue/Picker start) can change the stored assignee under the open dialog. Adopt it when the stored value
  // moved since the editor last saw it; an assignee this editor holds that differs from the stored one (a pick that did not save) stays.
  adoptAssignee() {
    if (!this.task || this.fixedRemote || this.closing) return;
    const stored = normAssignee(load().find((x) => x.id === this.task.id)?.assignee);
    const key = stored ? `${stored.kind}:${stored.id}` : "";
    if (this.seenAssignee === key) return;
    this.seenAssignee = key;
    this.assignee = stored;
  }

  render(cx) {
    const t = theme();
    this.adoptAssignee();
    const field = (el) => el.px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground);
    const projects = loadProjects(); // remote-bound ones too: a create there goes to the machine's inbox, never into a local card
    const projLabel = (p) => (p.remote ? `${p.name} · ${p.remote.machine}` : p.name);
    // Why a project cannot be picked (undefined: it can). Create: a remote one needs its writes. Edit: no inbox op moves a card between machines or projects.
    const projTip = (p) => {
      if (this.submitting && !this.task) return "creating…"; // the target of a Create in flight does not move
      if (this.fixedRemote) {
        if (p.id === this.fixedRemote.project) return undefined; // where the card is now: always pickable (a revert)
        if (!p.id) return "a remote card needs a project";
        if (p.remote?.machine !== this.fixedRemote.remote?.machine) return "move between machines comes later";
        if (RC.loading) return `loading ${this.rname()}'s lists, try again`; // a cache with no lists is not "not a project on the remote"
        const f = this.fstate();
        if (!f.on) return f.tip;
        return RC.projects.some((x) => x.id === p.id) ? undefined : `not a project on ${p.remote.machine}`;
      }
      if (this.task) return p.remote ? "move between machines comes later" : undefined;
      if (p.remote) { const c = controlState(remoteWriteState(p.id), "add"); return c.on ? undefined : c.tip; } // where to CREATE the card: an add
      return undefined;
    };
    const prio = PRIORITY_COLOR(t);
    const RC = this.remote ? this.remoteChoices() : null; // a remote card: the pickers read the remote's data only
    const assigneeChoices = RC ? RC.assignees : runnerChoices(loadConfig());
    // Lazy: a menu's item list is built only for the menu that is open (and once per render); a closed menu costs nothing (T-MWL7FAABO29).
    const itemDefs = {
      status: () => COLUMNS.map(([id, name]) => ({ key: id, glyph: STATUS_ICON[id].icon, color: t[STATUS_ICON[id].tone], text: name, current: id === this.column, on: (cx) => this.setProp("status", id, cx) })),
      priority: () => Object.keys(PRIORITY_LABEL).map((p) => ({ key: p, glyph: "●", color: prio[p], text: PRIORITY_LABEL[p], current: p === this.priority, on: (cx) => this.setProp("priority", p, cx) })),
      labels: () => [...(newTag(this.labelSearch.value(), this.labelChoices()) ? [{ key: "new", glyph: "+", color: t.accent, text: `Create "${this.labelSearch.value().trim()}"`, current: false, on: (cx) => this.createLabel(cx) }] : []),
        ...this.labelChoices().filter((g) => g.includes(this.labelSearch.value().trim().replace(/^#/, "").toLowerCase()))
          .map((g) => ({ key: g, glyph: "#", color: t.muted, text: g, current: this.labels.includes(g), on: (cx) => this.toggleLabel(g, cx) }))],
      assignee: () => [{ key: "none", glyph: "–", color: t.muted, text: "No assignee", current: !this.assignee, on: (cx) => this.setProp("assignee", null, cx) },
        ...assigneeChoices.map((c) => ({ key: `${c.kind}-${c.id}`, glyph: c.kind === "squad" ? "◈" : "●", color: t.muted, text: c.name,
          current: this.assignee?.kind === c.kind && this.assignee.id === c.id, on: (cx) => this.setProp("assignee", { kind: c.kind, id: c.id }, cx) }))],
      agent: () => agentChoices(loadConfig()).map((c) => ({ key: c.id, glyph: "●", color: t.muted, text: c.name, current: c.id === this.runner, on: () => (this.runner = c.id) })),
      parent: () => [{ key: "none", glyph: "–", color: t.muted, text: "Clear parent", current: !this.parent, on: (cx) => this.setProp("parent", null, cx) },
        ...filterParents(RC ? RC.parents : this.task ? parentChoices(load(), this.task.id) : [], this.parentSearch.value()).map((p) => ({ key: p.id, glyph: "↑", color: t.muted, text: parentLabel(p), hint: p.id, current: p.id === this.parent, on: (cx) => this.setProp("parent", p.id, cx) }))],
      send: () => this.sendOptions(t),
      project: () => [{ id: null, name: "No project" }, ...filterProjects(projects, this.projSearch.value())]
        .map((p) => ({ key: p.id ?? "none", glyph: p.id ? "◆" : "–", color: t.muted, text: projLabel(p), current: p.id === this.project, disabled: projTip(p), on: (cx) => this.setProp("project", p.id, cx) })),
    };
    const built = {};
    const items = (name) => (built[name] ??= itemDefs[name]());
    const setOpen = (name, open, cx) => {
      this.menu = open ? name : this.menu === name ? null : this.menu;
      if (open) this.hi = Math.max(0, items(name).findIndex((i) => i.current));
      // The list takes the keyboard when a click opens it (base does it only for keys). Closed: back to the title field, so Esc still reaches the editor.
      const search = { project: this.projSearch, labels: this.labelSearch, parent: this.parentSearch }[name];
      if (open) {
        (search ?? this.menuFocus).focus();
        // Popover moves the keyboard to its destination when the content appears (after this call): the search takes it back.
        if (search) cx.timer?.after?.(60, () => search.focus());
      }
      else { search?.set_value(""); this.title.focus(); }
      cx.notify();
    };
    // The labels list is multi-select: a pick keeps it open.
    const pick = (name, item, cx) => { if (item.disabled) return; item.on(cx); if (name === "labels") cx.notify(); else setOpen(name, false, cx); };
    const onKey = (name) => (e, cx) => {
      const n = items(name).length;
      if (e.key === "escape") return setOpen(name, false, cx), cx.stop_propagation();
      if (e.key === "up" || e.key === "down") this.hi = nextIndex(this.hi, n, e.key);
      else if (e.key === "enter" && items(name)[this.hi]) return pick(name, items(name)[this.hi], cx), cx.stop_propagation();
      else return;
      cx.notify(); cx.stop_propagation();
    };
    // Popup paints above the dialog, so an open menu never moves the rows. The content runs the highlight.
    const list = (name) => v_flex().id(`menu-${name}`).w(240).max_h(280).p(4).gap(1).rounded(8)
      .border_1().border_color(t.input).bg(t.popover).track_focus(this.menuFocus).on_key_down(onKey(name))
      .when(name === "project" || name === "labels" || name === "parent", (el) => el.child(h_flex().h(30).px(8).gap(6).items_center().mb(2).border_b_1().border_color(t.input)
        .child(svg(I("search")).size(13).text_color(t.dim))
        .child(Input.new({ project: this.projSearch, labels: this.labelSearch, parent: this.parentSearch }[name]).flex_1().h(26))))
      .child(v_flex().id(`items-${name}`).gap(1).overflow_y_scrollbar().children(items(name).map((it, i) =>
        h_flex().id(`${name}-${it.key}`).h(28).px(8).gap(8).items_center().rounded(6)
          .text_size(12).text_color(t.foreground).role("list_box_option").aria_selected(it.current)
          .when(i === this.hi, (el) => el.aria_active_descendant().bg(t.selected))
          .when(!it.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => pick(name, it, cx)))
          .when(Boolean(it.disabled), (el) => el.opacity(0.5).tooltip(it.disabled))
          .child(div().w(14).text_color(it.color).child(it.glyph))
          .child(div().flex_1().min_w(0).truncate().child(it.text))
          .when(Boolean(it.hint), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(it.hint)))
          .child(it.current ? svg(I("check")).size(12).text_color(t.accent) : div().w(12)))));
    const popover = (name, trigger, anchor, open, gap) => Popover.new(`pop-${name}`).anchor(anchor).open(open)
      .on_open_change((v, cx) => setOpen(name, v, cx))
      .track_focus(this.menuFocus) // opening focus goes to the list's key handler (Up/Down/Enter); Labels/Project then hand it to their search (setOpen)
      .trigger(trigger)
      .content(open ? list(name)[gap](4) : div()); // a closed menu builds no row (the host interrupted a render that built them all)
    const row = (name, text, glyph, color, valueText, Root = Select, icon = null, side = false, sideIcon = null) => {
      const open = this.menu === name;
      // Create modal: the trigger is a pill chip (icon + text), no label column.
      const pillTrigger = icon && h_flex().id(`trig-${name}`).h(28).px(10).gap(6).items_center().flex_none().rounded_full()
        .border_1().border_color(open ? t.accent : t.input).cursor_pointer().text_size(12.5).text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .child(svg(I(icon)).size(14).text_color(color))
        .child(div().max_w(160).truncate().child(valueText));
      // Edit sidebar: a flat value (icon + text), the dropdown trigger itself; a hover tint, no box.
      const flatIcon = side && sideIcon ? svg(I(sideIcon)).size(14).flex_none().text_color(color) : null;
      const flatTrigger = side && h_flex().id(`trig-${name}`).h(28).flex_1().min_w(0).px(6).gap(6).items_center().rounded(6).cursor_pointer()
        .when(open, (el) => el.bg(t.hover)).text_size(13).text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .child(flatIcon ?? div().w(14).flex_none().text_color(color).child(glyph))
        .child(div().flex_1().min_w(0).truncate().child(valueText));
      const trigger = pillTrigger || flatTrigger || h_flex().id(`trig-${name}`).h(28).w(side ? 176 : 240).px(9).gap(8).items_center().rounded(6)
        .border_1().border_color(open ? t.accent : t.input).bg(t.raised).cursor_pointer().text_size(12).text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .child(div().w(14).text_color(color).child(glyph))
        .child(div().flex_1().truncate().child(valueText))
        .child(svg(I("chevron-down")).size(12).text_color(t.dim));
      // Popover owns the press, Escape and the outside press (on_open_change). top_* pins the surface's top edge under the trigger
      // (bottom_* would grow it upward over the trigger); mt is the gap. Same as the board's menus.
      const select = popover(name, trigger, side ? "top_right" : "top_left", open, "mt");
      if (icon) return select;
      if (side) return h_flex().id(`prop-${name}`).h(28).gap(4).items_center()
        .child(div().w(62).flex_none().text_size(13).text_color(t.dim).child(text))
        .child(div().flex_1().min_w(0).child(select)); // min_w(0): a long value truncates in the column instead of widening it (and moving the popover)
      return h_flex().h(34).items_center().gap(10)
        .child(div().w(70).text_size(11.5).text_color(t.dim).child(text))
        .child(select);
    };
    const curRunner = this.assignee && (assigneeChoices.find((c) => c.kind === this.assignee.kind && c.id === this.assignee.id) ?? (RC ? { kind: this.assignee.kind, id: this.assignee.id, name: this.assignee.id } : undefined));
    const curAgent = agentChoices(loadConfig()).find((c) => c.id === this.runner)?.name ?? this.runner;
    const curProject = projects.find((p) => p.id === this.project);
    const agentMode = !this.task && this.mode === "agent" && !this.remote; // a remote pick has no agent mode
    const images = this.remote ? [] : imageLines((agentMode ? this.prompt : this.desc).value(), appHome()); // no image is resolved on this machine for a remote card
    const archived = this.task?.archived;
    const cardBg = mix(t.popover, t.background, 0.30), cardBorder = mix(t.popover, t.border, 0.30); // a touch darker than the dialog, a soft edge
    const avatar = (id, name, size = 22) => div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded_full().bg(t.raised).border_1().border_color(t.border)
      .text_size(size < 20 ? 9.5 : 10.5).text_color(t.muted).child(initialOf(name));
    const curParent = this.task && this.parent ? load().find((x) => x.id === this.parent) ?? null : null; // a deleted parent reads as none
    const R = this.remote, w = R ? this.gstate() : null; // w: the banner (freshness, writes, clock). Each control below uses its own op's gate.
    const wArchive = R ? this.wstate("archive") : null, wSend = R ? this.wstate(R.new ? "add" : "note") : null, wMove = R ? this.wstate("move") : null, wEdit = R ? this.wstate("edit") : null;
    const fsr = R ? (!R.new && this.inflight() ? { on: false, tip: this.inflightTip() } : this.fstate()) : null; // the field controls: on only when the remote's probe said protocol 3
    // A control that cannot work for a remote card stays visible, dimmed, with the reason as its tooltip.
    const off = (name, icon, text, tip = offTip(R?.remote?.machine)) => h_flex().id(`trig-${name}`).h(28).px(10).gap(6).items_center().flex_none().rounded_full().border_1().border_color(t.input)
      .opacity(0.5).text_size(12.5).text_color(t.dim).tooltip(tip).child(svg(I(icon)).size(14).text_color(t.dim)).child(div().max_w(160).truncate().child(text));
    // Sidebar rows that cannot change here: visible, dimmed, the reason as the tooltip. Machine is read-only information, not dimmed.
    const sideRow = (name, label, value, tip, dim = true) => h_flex().id(`prop-${name}`).h(28).gap(4).items_center().tooltip(tip).when(dim, (el) => el.opacity(0.5))
      .child(div().w(62).flex_none().text_size(13).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).px(6).truncate().text_size(13).text_color(dim ? t.dim : t.foreground).child(value));
    // The create chip row: where the picked project lives (read-only).
    const machinePill = (where) => h_flex().id("trig-machine").h(28).px(10).gap(6).items_center().flex_none().rounded_full().border_1().border_color(t.input)
      .tooltip("where this card lives").text_size(12.5).text_color(t.muted).child(div().max_w(160).truncate().child(where));
    const machineRow = (where) => sideRow("machine", "Machine", where, "where this card lives", false);
    if (R && !R.new) {
      if (this.fixedRemote && !this.submitting) { // the board poll is the truth for the thread: a note sent from here shows once the board was re-read
        const fresh = loadMerged().tasks.find((x) => x.id === this.fixedRemote.id && x.project === this.fixedRemote.project);
        if (fresh && Array.isArray(fresh.notes)) this.fixedRemote = { ...this.fixedRemote, notes: fresh.notes };
      }
      const rows = remoteCardRows(this.remote);
      const lock = this.inflight(), lockTip = this.inflightTip(); // a pick or a Save is in flight: the property rows are off
      const parentCard = this.parent ? loadMerged().tasks.find((x) => x.id === this.parent && x.project === R.project) : null;
      const curParentText = this.parent ? (parentCard ? parentLabel(parentCard) : this.parent) : "No parent";
      const ro = remoteWriteState(R.project);
      const roText = [w.on ? (!R.new && !wEdit.on ? `text and fields: ${wEdit.tip}` : null) : statusLine(ro), this.msg || null].filter(Boolean).join(" · "); // nothing while writes are on and there is nothing to report
      const rnote = (n, i) => v_flex().id(`remote-note-${i}`).flex_none().gap(8).p(12).rounded(10).border_1().border_color(cardBorder).bg(cardBg)
        .child(h_flex().flex_none().h(24).gap(8).items_center()
          .child(avatar(`note-avatar-${i}`, n.by))
          .child(div().text_size(13).font_medium().truncate().child(n.by))
          .child(div().id(`note-time-${i}`).text_size(12).text_color(t.dim).tooltip(n.at ? stamp(n.at) : "").child(ago(n.at, Date.now())))
          .child(div().flex_1())
          .when(Boolean(n.kind), (el) => el.child(div().id(`note-kind-${i}`).px(7).h(18).flex().items_center().rounded_full().border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(n.kind)))
          .child(h_flex().id(`note-copy-${i}`).size(24).items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Copy text")
            .on_click((_e, cx) => cx.write_to_clipboard(n.text)).child(svg(I("copy")).size(14).text_color(t.muted))))
        .child(div().text_size(13).line_height(1.55).child(n.text)); // plain text: nothing from the remote is resolved here
      const noteReadyR = this.note.value().trim().length > 0 || this.remoteOps().length > 0;
      return v_flex().id("editor").size_full().bg(t.popover).text_color(t.foreground)
        .on_key_down((e, cx) => { if (e.key === "escape") { if (this.menu) { this.menu = null; cx.notify(); } else this.close(cx); cx.stop_propagation(); } else this.onSubmitKey(e, cx); })
        .child(h_flex().px(24).pt(20).items_center().gap(6).text_size(14)
          .child(div().text_color(t.dim).child("Drover"))
          .child(svg(I("chevron-right")).size(14).text_color(t.dim))
          .child(h_flex().id("copy-id").px(6).py(2).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              cx.write_to_clipboard(R.id);
              this.copied = true; cx.notify();
              cx.timer.after(1500, (cx) => { this.copied = false; cx.notify(); });
            })
            .child(R.id)
            .child(div().text_size(11).font_weight(400).text_color(this.copied ? t.done : t.dim).child(this.copied ? "Copied" : "⧉ Copy")))
          .child(div().flex_1())
          .child(h_flex().id("ed-expand").size(28).items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.expand(cx)).child(svg(I(this.large ? "minimize-2" : "maximize-2")).size(16).text_color(t.muted)))
          .child(h_flex().id("ed-close").size(28).items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.close(cx)).child(svg(I("x")).size(16).text_color(t.muted))))
        .when(Boolean(roText), (el) => el.child(div().id("remote-ro").px(24).pt(4).text_size(12).text_color(w.on ? t.muted : t.blocked).child(roText)))
        .child(h_flex().id("body-row").flex_1().min_h(0)
          .child(v_flex().id("main-col").h_full().flex_1().min_w(0).min_h(0).px(24).pt(16).pb(12).gap(10)
            .child(v_flex().id("thread").flex_1().min_h(0).overflow_y_scrollbar().gap(14)
              .child(R && !R.new && !wEdit.on ? div().id("title-text").h(40).flex_none().text_size(22).font_semibold().child(this.title.value()) : Input.new(this.title).h(40).flex_none().text_size(22).font_semibold()) // edit not supported: read-only text
              .child(v_flex().id("desc-block").flex_none().w_full().child(R && !R.new && !wEdit.on
                ? div().id("desc-view").text_size(14).line_height(1.6).text_color(this.desc.value().trim() ? t.foreground : t.dim).child(this.desc.value().trim() ? this.desc.value() : "No description")
                : Textarea.new(this.desc).text_size(14)))
              .child(h_flex().id("activity-header").flex_none().h(28).gap(8).items_center().child(div().text_size(13).font_medium().child("Activity"))
                .when(rows.notes.length > 0, (el) => el.child(div().text_size(12).text_color(t.muted).child(String(rows.notes.length)))))
              .child(v_flex().id("notes").flex_none().gap(10).children(foldNotes(rows.notes).map((item) => {
                if (item.type === "note") return rnote(item.note, item.index);
                const first = item.notes[0].index, open = this.folds.has(first);
                return v_flex().id(`fold-group-${first}`).flex_none().gap(10)
                  .child(h_flex().id(`fold-${first}`).h(30).px(12).items_center().rounded(8).bg(t.raised).cursor_pointer().text_size(12).text_color(t.muted)
                    .hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.toggleFold(first, cx)).child(open ? `▾ ${item.count} activities` : item.label))
                  .children(open ? item.notes.map((n) => rnote(n, n.index)) : []);
              }))))
            .child(v_flex().id("composer").flex_none()
              .child(v_flex().id("remote-note-new").gap(4).p(8).rounded(10).border_1().border_color(t.input).bg(t.background)
                .child(Textarea.new(this.note).h(64).text_size(13).border_0())
                .child(h_flex().items_center().gap(8).child(div().flex_1())
                  .child(wArchive.on && !this.submitting ? button(t, "remote-archive", "Archive", false, (_e, cx) => this.remoteArchive(cx))
                    : div().id("remote-archive").h(30).px(12).flex().items_center().rounded(7).border_1().border_color(t.input).text_color(t.dim).text_size(12.5).opacity(0.5).tooltip(wArchive.tip ?? "Sending…").child("Archive"))
                  .child(h_flex().id("ed-create").h(32).px(14).gap(8).items_center().rounded(8).cursor_pointer()
                    .bg(wSend.on && !this.submitting ? t.solid : t.raised).text_color(wSend.on && !this.submitting ? t.solid_foreground : t.dim).text_size(13).font_medium()
                    .when(!wSend.on, (el) => el.tooltip(wSend.tip))
                    .when(wSend.on, (el) => el.on_click((_e, cx) => this.onCreate(cx)))
                    .child("Send").child(keycap(t, "command", noteReadyR)).child(keycap(t, "corner-down-left", noteReadyR)))))))
          .child(v_flex().id("ed-sidebar").w(240).flex_none().h_full().border_l_1().border_color(t.border).p(12).gap(2).overflow_y_scrollbar()
            .child(section(t, "Properties"))
            .child(lock || (R && !wMove.on) ? sideRow("status", "Status", COLUMN_NAME[this.column], lock ? lockTip : wMove.tip) : row("status", "Status", "", t[STATUS_ICON[this.column]?.tone], COLUMN_NAME[this.column], Select, null, true, "circle"))
            .child(fsr.on ? row("priority", "Priority", "", prio[this.priority], `${this.priority} ${PRIORITY_LABEL[this.priority]}`, Select, null, true, "signal")
              : sideRow("priority", "Priority", `${this.priority} ${PRIORITY_LABEL[this.priority]}`, fsr.tip))
            .child(fsr.on ? row("assignee", "Assignee", "", t.muted, curRunner?.name ?? "No assignee", Select, null, true, "user")
              : sideRow("assignee", "Assignee", curRunner?.name ?? rows.agentText ?? "No assignee", fsr.tip))
            .child(fsr.on ? row("labels", "Labels", "", t.muted, this.labels.length ? this.labels.join(", ") : "Add label", Combobox, null, true, "tag")
              : sideRow("labels", "Labels", this.labels.length ? this.labels.join(", ") : "No labels", fsr.tip))
            .child(lock ? sideRow("project", "Project", curProject ? projLabel(curProject) : "project", lockTip) : row("project", "Project", "", t.muted, curProject ? projLabel(curProject) : "project", Combobox, null, true, "folder"))
            .child(machineRow(R.remote?.machine || "another machine"))
            .child(fsr.on ? row("parent", "Parent", "↑", t.muted, curParentText, Combobox, null, true)
              : sideRow("parent", "Parent", curParentText, fsr.tip))
            .child(section(t, "Run"))
            .child(div().id("remote-run-off").text_size(12).text_color(t.dim).child(`Run: ${offTip(R?.remote?.machine)}`))
            .child(section(t, "Wakeups"))
            .child(div().id("remote-wake-off").text_size(12).text_color(t.dim).child(`Wakeups: ${offTip(R?.remote?.machine)}`))));
    }
    if (!this.task) {
      const ready = R ? wSend.on && !this.submitting && (!R.new || canCreate(this.title.value())) : agentMode ? canCreateAgent(this.prompt.value()) : canCreate(this.title.value());
      const knob = div().size(16).flex_none().rounded_full().bg(t.foreground).when(this.another, (el) => el.ml(14));
      return v_flex().id("editor").size_full().bg(t.popover).text_color(t.foreground)
        .on_key_down((e, cx) => {
          if (e.key === "escape") { if (this.menu) { this.menu = null; cx.notify(); } else this.close(cx); cx.stop_propagation(); }
          else this.onSubmitKey(e, cx);
        })
        .child(h_flex().px(24).pt(20).items_center().gap(6).text_size(14)
          .child(div().text_color(t.dim).child("Drover"))
          .child(svg(I("chevron-right")).size(14).text_color(t.dim))
          .child(div().flex_1().text_color(t.foreground).child(R && !R.new ? R.id : agentMode ? "Create with agent" : "Create manually"))
          .when(!R, (el) => el.child(h_flex().id("ed-expand").size(28).items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.expand(cx)).child(svg(I(this.large ? "minimize-2" : "maximize-2")).size(16).text_color(t.muted))))
          .child(h_flex().id("ed-close").size(28).items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.close(cx)).child(svg(I("x")).size(16).text_color(t.muted))))
        .child(v_flex().flex_1().min_h(0).px(24).pt(16).pb(12).gap(10)
          .when(agentMode, (el) => el.child(row("agent", "Created by", "●", t.muted, curAgent)))
          .when(!agentMode, (el) => el.child(Input.new(this.title).h(36).text_size(20).font_semibold()))
          .child(Textarea.new(agentMode ? this.prompt : this.desc).flex_1().min_h(0).text_size(14))
          .when(images.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).children(images.map((p) =>
            div().rounded(6).overflow_hidden().border_1().border_color(t.input).child(image(p).h(64).max_w(160))))))
          .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
          .when(Boolean(R) && (!w.on || Boolean(this.msg)), (el) => el.child(div().id("remote-ro").text_size(12).text_color(w.on ? t.muted : t.blocked).child([w.on ? null : statusLine(remoteWriteState(R.project)), this.msg || null].filter(Boolean).join(" · "))))
          .when(Boolean(R) && !R.new, (el) => el.children(remoteCardRows(R).notes.map((n, i) => v_flex().id(`remote-note-${i}`).p(10).gap(4).rounded(8).border_1().border_color(t.border)
            .child(div().text_size(11.5).text_color(t.dim).child(`${n.by}${n.kind ? ` · ${n.kind}` : ""}${n.at ? ` · ${stamp(n.at)}` : ""}`))
            .child(div().text_size(13).child(n.text)))))
          .when(Boolean(R) && !R.new, (el) => el.child(v_flex().id("remote-note-new").p(8).rounded(8).border_1().border_color(t.input).bg(t.background).child(Textarea.new(this.note).h(64).text_size(13).border_0())))
          .when(Boolean(curRunner) && !agentMode && !this.task && !R, (el) => el.child(div().text_size(12).text_color(t.muted).child(startHint(curRunner.name))))
          .when(agentMode, (el) => el.child(h_flex().gap(8).items_center().child(row("project", "Project", "", t.muted, curProject ? projLabel(curProject) : "No project", Combobox, "folder"))))
          .when(!agentMode, (el) => el.child(h_flex().gap(8).items_center()
            .child(row("status", "Status", "", t[STATUS_ICON[this.column]?.tone], COLUMN_NAME[this.column], Select, "circle"))
            .child(R && !R.new ? off("priority", "signal", `${this.priority} ${PRIORITY_LABEL[this.priority]}`) : row("priority", "Priority", "", prio[this.priority], `${this.priority} ${PRIORITY_LABEL[this.priority]}`, Select, "signal"))
            .child(R && !fsr.on ? off("assignee", "user", "Assignee", fsr.tip) : row("assignee", "Assignee", "", t.muted, curRunner?.name ?? "Assignee", Select, "user"))
            .child(R && !R.new ? off("labels", "tag", this.labels.length ? this.labels.join(", ") : "Add label") : row("labels", "Labels", "", t.muted, this.labels.length ? this.labels.join(", ") : "Add label", Combobox, "tag"))
            .child(row("project", "Project", "", t.muted, curProject ? projLabel(curProject) : "No project", Combobox, "folder"))
            .child(machinePill(R ? R.remote?.machine || "another machine" : machineOf(projects, this.project))))))
        .child(div().w_full().h(1).flex_none().bg(t.border))
        .child(h_flex().px(24).h(60).flex_none().items_center().gap(14)
          .child(R ? h_flex().id("ed-attach").size(28).items_center().justify_center().rounded(6).opacity(0.5).tooltip(offTip(R?.remote?.machine)).child(svg(I("paperclip")).size(16).text_color(t.dim))
            : h_flex().id("ed-attach").size(28).items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { this.pasteImage(cx); this.desc.focus(); }).child(svg(I("paperclip")).size(16).text_color(t.muted)))
          .child(R ? h_flex().id("ed-mode").h(28).px(10).items_center().rounded(6).bg(t.accent).opacity(0.5).text_size(12.5).text_color(t.solid_foreground).tooltip(offTip(R?.remote?.machine)).child("⇄ Switch to Agent")
            : h_flex().id("ed-mode").h(28).px(10).items_center().rounded(6).cursor_pointer().bg(t.accent).opacity(0.9).text_size(12.5).text_color(t.solid_foreground)
              .hover((s) => s.opacity(1)).on_click((_e, cx) => this.toggleMode(cx)).child(agentMode ? "⇄ Switch to Manual" : "⇄ Switch to Agent"))
          .child(div().flex_1())
          .when(Boolean(R) && !R.new, (el) => el.child(R && wArchive.on && !this.submitting
            ? button(t, "remote-archive", "Archive", false, (_e, cx) => this.remoteArchive(cx))
            : div().id("remote-archive").h(30).px(12).flex().items_center().rounded(7).border_1().border_color(t.input).text_color(t.dim).text_size(12.5).opacity(0.5).tooltip(wArchive?.tip ?? "Sending…").child("Archive")))
          .when(!R || R.new, (el) => el.child(h_flex().gap(8).items_center()
            .child(Switch.new("create-another").w(34).h(20).p(2).flex_none().items_center().rounded_full().cursor_pointer()
              .bg(this.another ? t.solid : t.raised).border_1().border_color(this.another ? t.solid : t.input)
              .checked(this.another).on_change((v, cx) => { this.another = v; cx.notify(); }).child(knob))
            .child(div().text_size(13).text_color(t.muted).child("Create another"))))
          .child(h_flex().id("ed-create").h(32).px(14).gap(8).items_center().rounded(8).cursor_pointer()
            .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim).text_size(13).font_medium()
            .when(Boolean(R) && !wSend.on, (el) => el.tooltip(wSend.tip))
            .when(!R || wSend.on, (el) => el.on_click((_e, cx) => this.onCreate(cx)))
            .child(this.starting ? "Starting…" : agentMode ? "Create" : R && !R.new ? "Save" : "Create task").child(keycap(t, "command", ready)).child(keycap(t, "corner-down-left", ready))));
    }
    // Edit: the create shell. Text on the left, a fixed empty sidebar slot on the right (properties arrive there).
    const notes = [...(load().find((x) => x.id === this.task.id)?.notes ?? [])]; // oldest first, like a thread
    const iconBtn = (id, icon, action) => h_flex().id(id).size(28).items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(action).child(svg(I(icon)).size(16).text_color(t.muted));
    const moreMenu = () => v_flex().id("ed-more-menu").gap(6).p(8).rounded(8).bg(t.raised).border_1().border_color(t.input)
      .child(this.confirmArchive
        ? v_flex().id("archive-confirm").gap(6)
          .child(div().text_size(12).child(`${archived ? "Restore" : "Archive"} this task?`))
          .child(h_flex().gap(6)
            .child(button(t, "archive-yes", archived ? "Restore" : "Archive", true, (_e, cx) => this.archive(cx)))
            .child(button(t, "archive-no", "Cancel", false, (_e, cx) => this.cancelArchive(cx))))
        : button(t, "ed-archive", archived ? "Restore" : "Archive", false, (_e, cx) => this.askArchive(cx)));
    const noteReady = this.noteReady();
    const now = Date.now();
    const allRuns = loadRuns();
    const live = liveStatuses(agents(), terminals());
    const alive = new Set(terminals().map((x) => x.address));
    const stored = load().find((x) => x.id === this.task.id) ?? this.task; // task.run changes under the open editor
    const current = linkedRun(stored, allRuns);
    if (this.ctxRun === undefined || this.ctxRun !== (current?.id ?? null)) this.refreshContext(cx); // first open, or the run link changed
    const ctx = contextRows(this.ctx, now);
    const prColor = { Open: t.done, Draft: t.muted, Merged: t.accent, Closed: t.blocked };
    const past = pastRuns(stored, allRuns);
    const wakes = taskWakes(stored, allRuns, loadWakes());
    const openWakes = wakes.filter(isOpen), endedWakes = wakes.filter((w) => !isOpen(w));
    const statusColor = { blocked: t.blocked, working: t.working, stopped: t.idle, ended: t.dim, done: t.done, idle: t.idle, gone: t.dim };
    const runBlock = (r, full) => {
      const s = runSummary(r, live, alive, now, allRuns);
      return v_flex().id(`run-r-${r.id}`).gap(2)
        .child(h_flex().gap(6).items_center().text_size(12)
          .child(div().size(7).rounded(4).flex_none().bg(statusColor[s.status] ?? t.idle))
          .child(div().flex_1().truncate().child(s.runner))
          .child(div().text_size(11).text_color(statusColor[s.status] ?? t.muted).child(s.status))
          .child(div().text_size(11).text_color(t.dim).child(s.durationText)))
        .when(Boolean(s.branch), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(s.branch)))
        .when(full, (el) => el.children(s.rows.map((m) => h_flex().id(`run-m-${m.address}`).gap(6).items_center().pl(m.depth * 10).text_size(11.5)
          .when(m.dim, (x) => x.opacity(0.5))
          .when(m.focusable, (x) => x.cursor_pointer().rounded(4).hover((y) => y.bg(t.hover)).on_click((_e, cx) => this.openMember(m, cx)))
          .child(div().size(6).rounded(3).flex_none().bg(statusColor[m.status] ?? t.idle))
          .child(div().flex_1().truncate().child(m.name))
          .child(div().text_size(10.5).text_color(t.dim).child(m.durationText)))));
    };
    const wakeRow = (w) => h_flex().id(`w-${w.id}`).py(4).gap(6).items_start()
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12).truncate().text_color(isOpen(w) ? t.foreground : t.muted).child(w.text))
        .child(div().text_size(10.5).text_color(t.dim).truncate().child([wakeLabel(w, stored, allRuns)].concat(w.status === "scheduled"
          ? [summary(w), until(w.due)] : [`${w.status} ${age(w.at ?? w.created)} ago`]).concat(w.reason ? [w.reason] : []).join(" · "))))
      .when(w.status === "scheduled", (el) => el.child(toggle(t, `on-${w.id}`, w.enabled !== false, () => this.toggleWake(w.id, { notify() {} }))));
    const wakeField = (s) => Input.new(s).h(26).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12);
    const sourceSections = [
      ...(!stored.source ? [section(t, "Source", undefined, div().id("src-link").px(4).text_size(12).text_color(t.muted).cursor_pointer()
          .on_click((_e, cx) => { this.linking = !this.linking; this.linkError = null; cx.notify(); }).child(this.linking ? "×" : "Link issue")),
        ...(this.linking ? [v_flex().id("src-add").gap(6).pb(6)
          .child(wakeField(this.srcUrl))
          .child(button(t, "src-submit", "Link", false, (_e, cx) => this.startLink(cx)))
          .when(Boolean(this.linkError), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.linkError)))] : [])] : []),
      ...(stored.source ? [section(t, "Source", undefined, div().id("src-unlink").px(4).text_size(12).text_color(t.muted).cursor_pointer()
          .on_click((_e, cx) => this.startLink(cx, "none")).child("Unlink")),
        ...(ctx.issue ? [h_flex().id("src-card").gap(6).items_center().px(8).py(6).rounded(8).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => openUrl(ctx.issue.url))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(11).text_color(t.dim).truncate().child(ctx.issue.key))
            .child(div().text_size(12).truncate().child(ctx.issue.title)))
          .child(chip(t, ctx.issue.status, ctx.issue.category === "done" ? t.done : t.muted))]
          : [div().text_size(12).text_color(t.dim).truncate().child(ctx.errors.length ? "Source unavailable" : "Loading…")]),
        ...(ctx.issue?.parent ? [section(t, "Parent"), h_flex().id("jira-parent-card").gap(6).items_center().px(8).py(6).rounded(8).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => openUrl(ctx.issue.parent.url))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(11).text_color(t.dim).truncate().child(ctx.issue.parent.key))
            .child(div().text_size(12).truncate().child(ctx.issue.parent.title)))
          .when(Boolean(ctx.issue.parent.status), (el) => el.child(chip(t, ctx.issue.parent.status, ctx.issue.parent.category === "done" ? t.done : t.muted)))] : [])] : []),
      ...(ctx.prs.length || stored.source || current ? [section(t, "Pull requests", ctx.prs.length)] : []),
      ...ctx.prs.slice(0, cfg("drover-todos", "pr_cap")).map((p) => h_flex().id(`pr-${p.number}`).gap(6).items_start().py(3).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => openUrl(p.url))
        .child(chip(t, p.state, prColor[p.state]))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12).truncate().child(p.title))
          .child(div().text_size(10.5).text_color(t.dim).truncate().child([p.label, p.age].filter(Boolean).join(" · "))))),
      ...ctx.errors.map((e, i) => div().id(`ctx-err-${i}`).text_size(11).text_color(t.blocked).child(ctx.stale ? `${e} (showing earlier data)` : e)),
    ];
    const runWakeSections = [
      ...sourceSections,
      section(t, "Run"),
      ...(current ? [runBlock(current, true)] : [div().text_size(12).text_color(t.dim).child("No active run")]),
      ...(past.length ? [h_flex().id("run-history").mt(4).px(8).py(6).gap(6).items_center().rounded(8).bg(t.raised).text_size(12).text_color(t.muted).cursor_pointer()
        .on_click((_e, cx) => { this.runHistoryOpen = !this.runHistoryOpen; cx.notify(); })
        .child(this.runHistoryOpen ? "▾" : "›").child(`Run history · ${past.length}`)] : []),
      ...(this.runHistoryOpen ? past.slice(0, cfg("drover-todos", "run_history_cap")).map((r) => runBlock(r, false)) : []),
      section(t, "Wakeups", openWakes.length, div().id("wake-plus").px(4).text_size(16).text_color(t.muted).cursor_pointer()
        .on_click((_e, cx) => { this.adding = !this.adding; cx.notify(); }).child(this.adding ? "×" : "+")),
      ...(this.adding ? [v_flex().id("wake-add").gap(6).pb(6)
        .child(h_flex().gap(6).child(wakeField(this.wakeWhen).w(60)).child(wakeField(this.wakeText).flex_1()))
        .child(button(t, "wake-submit", "Add wakeup", false, (_e, cx) => this.addWakeup(cx)))
        .when(Boolean(this.wakeError), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.wakeError)))] : []),
      ...openWakes.slice(0, cfg("drover-todos", "wake_cap")).map(wakeRow),
      ...(endedWakes.length ? [h_flex().id("wake-history").mt(4).px(8).py(6).gap(6).items_center().rounded(8).bg(t.raised).text_size(12).text_color(t.muted).cursor_pointer()
        .on_click((_e, cx) => { this.historyOpen = !this.historyOpen; cx.notify(); })
        .child(this.historyOpen ? "▾" : "›").child(`Wakeup history · ${endedWakes.length}`)] : []),
      ...(this.historyOpen ? endedWakes.slice(0, cfg("drover-todos", "wake_cap")).map(wakeRow) : []),
      ...(wakes.length === 0 ? [div().text_size(12).text_color(t.dim).child("No wakeups for this task.")] : []),
    ];
    const subs = subIssues(stored, load());
    const pickChoice = this.sendChoice(), liveNow = Boolean(this.liveTarget());
    const pickName = pickChoice !== "none" && pickChoice.kind !== "live" ? (runnerChoices(loadConfig()).find((c) => c.kind === pickChoice.kind && c.id === pickChoice.id)?.name ?? pickChoice.id) : null;
    const sendOpen = this.menu === "send";
    const sendTrigger = h_flex().id("send-picker").h(28).px(6).gap(6).items_center().flex_none().rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
      .when(sendOpen, (el) => el.bg(t.hover)).hover((x) => x.bg(t.hover))
      .when(pickChoice !== "none", (el) => el.child(avatar("send-avatar", pickName ?? this.liveName() ?? "Agent", 18)))
      .child(div().child(pickChoice === "none" ? (liveNow ? "Don't send" : "Don't start") : pickChoice.kind === "live" ? `Will send to ${this.liveName()}` : "Will start when sent"))
      .when(Boolean(pickName), (el) => el.child(div().text_color(t.foreground).child(pickName)))
      .child(svg(I("chevron-down")).size(12).text_color(t.dim));
    const sendPicker = popover("send", sendTrigger, "bottom_left", sendOpen, "mb"); // opens upward: the composer is at the bottom
    return v_flex().id("editor").size_full().bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => this.editKey(e, cx))
      .child(h_flex().px(24).pt(20).items_center().gap(6).text_size(14)
        .child(div().text_color(t.dim).child("Drover"))
        .child(svg(I("chevron-right")).size(14).text_color(t.dim))
        .when(Boolean(this.parent), (el) => el
          .child(curParent && !curParent.archived
            ? div().id("crumb-parent").px(6).py(2).rounded(6).cursor_pointer().text_color(t.accent).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.openParent(curParent.id, cx)).child(curParent.id)
            : div().id("crumb-parent-dim").px(6).py(2).text_color(t.dim).child(this.parent)) // missing or archived: shown, not a link
          .child(svg(I("chevron-right")).size(14).text_color(t.dim)))
        .child(h_flex().id("copy-id").px(6).py(2).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            cx.write_to_clipboard(this.task.id);
            this.copied = true; cx.notify();
            cx.timer.after(1500, (cx) => { this.copied = false; cx.notify(); });
          })
          .child(this.task.id)
          .child(div().text_size(11).font_weight(400).text_color(this.copied ? t.done : t.dim).child(this.copied ? "Copied" : "⧉ Copy")))
        .child(div().flex_1())
        .child(Popover.new("pop-ed-more").anchor("top_right").open(this.moreOpen)
          .on_open_change((v, cx) => this.setMore(v, cx))
          .trigger(iconBtn("ed-more", "ellipsis", () => {}))
          .content(this.moreOpen ? moreMenu().mt(4) : div()))
        .child(iconBtn("ed-expand", this.large ? "minimize-2" : "maximize-2", (_e, cx) => this.expand(cx)))
        .child(iconBtn("ed-close", "x", (_e, cx) => this.close(cx))))
      .child(h_flex().id("body-row").flex_1().min_h(0)
        .child(v_flex().id("main-col").h_full().flex_1().min_w(0).min_h(0).px(24).pt(16).pb(12).gap(10)
          .child(v_flex().id("thread").flex_1().min_h(0).overflow_y_scrollbar().gap(14)
          .child(h_flex().id("title-row").flex_none().w_full().gap(6).items_center()
            .child(this.editing
              ? Input.new(this.title).h(40).flex_1().min_w(0).text_size(22).font_semibold()
              : div().id("title-text").flex_1().min_w(0).text_size(22).font_semibold().child(this.title.value()))
            .child(iconBtn("ed-pencil", "pencil", (_e, cx) => this.toggleEdit(cx))))
          .child(this.editing
            ? v_flex().id("desc-block").flex_none().w_full().child(Textarea.new(this.desc).text_size(14))
            : v_flex().id("desc-block").flex_none().w_full()
              .child(this.desc.value().trim()
                ? div().id("desc-view").text_size(14).line_height(1.6).child(TextView.markdown("desc-md", this.desc.value()).selectable().on_link_click((url) => openUrl(url)))
                : div().id("desc-empty").text_size(14).text_color(t.dim).cursor_pointer().on_click((_e, cx) => { this.toggleEdit(cx); this.desc.focus(); }).child("Add a description…")))
          .when(images.length > 0, (el) => el.child(h_flex().flex_none().flex_wrap().gap(6).children(images.map((p) =>
            div().rounded(6).overflow_hidden().border_1().border_color(t.input).child(image(p).h(64).max_w(160))))))
          .child(subs
            ? v_flex().id("sub-issues").flex_none().gap(8).pt(6)
              .child(h_flex().id("sub-header").h(28).gap(8).items_center()
                .child(h_flex().id("sub-toggle").gap(6).items_center().cursor_pointer().on_click((_e, cx) => this.toggleSubs(cx))
                  .child(div().w(12).text_color(t.dim).child(this.subsOpen ? "▾" : "›"))
                  .child(div().text_size(13).font_medium().child("Sub-issues"))
                  .child(div().id("sub-progress").text_size(12).text_color(t.muted).child(subs.progress)))
                .child(div().flex_1())
                .child(iconBtn("sub-add", "plus", (_e, cx) => this.addSubIssue(cx))))
              .when(this.subsOpen, (el) => el.child(v_flex().id("sub-list").rounded(10).border_1().border_color(t.border).overflow_hidden()
                .children(subs.rows.map((c, i) => h_flex().id(`sub-row-${c.id}`).h(36).px(10).gap(8).items_center().cursor_pointer()
                  .when(i > 0, (x) => x.border_t_1().border_color(t.border))
                  .hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.openParent(c.id, cx))
                  .child(svg(I("signal")).size(13).flex_none().text_color(prio[c.priority] ?? t.muted))
                  .child(div().w(14).flex_none().text_color(t[STATUS_ICON[c.column]?.tone] ?? t.muted).child(STATUS_ICON[c.column]?.icon ?? "○"))
                  .child(div().flex_none().text_size(12).text_color(t.dim).child(c.id))
                  .child(div().flex_1().min_w(0).truncate().text_size(13).child(c.title))
                  .when(Boolean(c.assignee), (x) => x.child(avatar(`sub-avatar-${c.id}`, assigneeText(c.assignee, loadConfig()), 20)))))))
            : h_flex().id("add-subissue").flex_none().h(28).px(2).items_center().cursor_pointer().text_size(13).text_color(t.muted)
              .hover((x) => x.text_color(t.foreground)).on_click((_e, cx) => this.addSubIssue(cx)).child("+ Add sub-issue"))
          .child(div().id("activity-divider").flex_none().w_full().h(1).mt(4).bg(t.border))
          .child(h_flex().id("activity-header").flex_none().h(28).gap(8).items_center()
            .child(div().text_size(13).font_medium().child("Activity"))
            .when(notes.length > 0, (el) => el.child(div().text_size(12).text_color(t.muted).child(String(notes.length)))))
          .child(v_flex().id("notes").flex_none().gap(10).children(foldNotes(notes).map((item) => {
            const card = (n, i) => {
              const col = this.collapsed.has(n.id), editing = this.editNote?.id === n.id, asking = this.confirmDel === n.id;
              const shown = (this.hoverId === n.id || this.noteMenu === n.id);
              const act = (id, icon, action, color) => h_flex().id(id).size(24).items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
                .on_click(action).child(svg(I(icon)).size(14).text_color(color ?? t.muted));
              const item = (id, icon, text, action, color) => h_flex().id(id).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(12.5).text_color(color ?? t.foreground)
                .hover((s) => s.bg(t.hover)).on_click(action)
                .child(svg(I(icon)).size(14).flex_none().text_color(color ?? t.muted)).child(div().flex_1().child(text));
              const divider = (id) => div().id(id).h(1).my(3).bg(t.border);
              const menu = () => v_flex().id(`note-menu-${n.id}`).w(220).p(4).rounded(8).border_1().border_color(t.input).bg(t.popover)
                .child(item("nm-edit", "pencil", "Edit", (_e, cx) => this.startEditNote(n.id, cx)))
                .child(divider("nm-div-1"))
                .child(item("nm-copy", "copy", "Copy", (_e, cx) => this.copyNote(n.id, cx)))
                .child(item("nm-copy-id", "hash", "Copy note ID", (_e, cx) => this.copyNoteId(n.id, cx)))
                .child(item("nm-subtask", "list-plus", "Create sub-task from here", (_e, cx) => this.subtaskFromNote(n.id, cx)))
                .child(divider("nm-div-2"))
                .child(item("nm-delete", "trash-2", "Delete", (_e, cx) => this.askDeleteNote(n.id, cx), t.blocked));
              const more = Popover.new(`pop-note-${n.id}`).anchor("top_right").open(this.noteMenu === n.id)
                .on_open_change((v, cx) => this.setNoteMenu(n.id, v, cx))
                .trigger(act(`note-more-${n.id}`, "ellipsis", () => {}))
                .content(this.noteMenu === n.id ? menu().mt(4) : div());
              const first = String(n.text ?? "").split("\n")[0];
              return v_flex().id(`note-${i}`).flex_none().gap(8).p(12).rounded(10).border_1().border_color(cardBorder).bg(cardBg)
                .on_hover((h, cx) => this.hoverNote(n.id, h, cx))
                .child(h_flex().id(`note-head-${n.id}`).flex_none().h(24).gap(8).items_center() // 24 = the action buttons' height: hovering adds them without growing the row
                  .child(avatar(`note-avatar-${i}`, noteAuthor(n.by, this.task, allRuns)))
                  .child(div().text_size(13).font_medium().truncate().child(noteAuthor(n.by, this.task, allRuns)))
                  .child(div().id(`note-time-${i}`).text_size(12).text_color(t.dim).tooltip(stamp(n.at)).child(ago(n.at, now)))
                  .when(Boolean(n.edited), (el) => el.child(div().id(`note-edited-${n.id}`).text_size(12).text_color(t.dim).tooltip(stamp(n.edited)).child("edited")))
                  .child(div().flex_1())
                  .when(Boolean(n.kind), (el) => el.child(div().id(`note-kind-${i}`).px(7).h(18).flex().items_center().rounded_full().border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(n.kind)))
                  .when(shown, (el) => el.child(h_flex().id(`note-actions-${n.id}`).gap(2).items_center()
                    .child(act(`note-collapse-${n.id}`, col ? "chevron-right" : "chevron-down", (_e, cx) => this.toggleCollapse(n.id, cx)))
                    .child(more))))
                .child(editing
                  ? v_flex().id(`note-edit-${n.id}`).gap(8).on_key_down((e, cx) => this.onEditNoteKey(e, cx))
                    .child(v_flex().p(8).rounded(8).border_1().border_color(t.input).bg(t.background).child(Textarea.new(this.editNote.state).text_size(13).border_0()))
                    .child(h_flex().gap(8).items_center().child(div().flex_1())
                      .child(button(t, `note-edit-cancel-${n.id}`, "Cancel", false, (_e, cx) => this.cancelEditNote(cx)))
                      .child(button(t, `note-edit-save-${n.id}`, "Save", true, (_e, cx) => this.saveEditNote(cx))))
                  : col
                    ? div().id(`note-line-${n.id}`).text_size(13).text_color(t.muted).truncate().child(first)
                    : div().text_size(13).line_height(1.55).child(TextView.markdown(`note-md-${i}`, n.text).selectable().on_link_click((url) => openUrl(url))))
                .when(asking, (el) => el.child(h_flex().id(`note-del-confirm-${n.id}`).gap(8).items_center()
                  .child(div().text_size(12.5).child("Delete this note?")).child(div().flex_1())
                  .child(button(t, `note-del-no-${n.id}`, "Cancel", false, (_e, cx) => this.cancelDeleteNote(cx)))
                  .child(button(t, `note-del-yes-${n.id}`, "Delete", true, (_e, cx) => this.deleteNote(n.id, cx)).bg(t.blocked))));
            };
            if (item.type === "note") return card(item.note, item.index);
            const first = item.notes[0].index, open = this.folds.has(first);
            return v_flex().id(`fold-group-${first}`).flex_none().gap(10)
              .child(h_flex().id(`fold-${first}`).h(30).px(12).items_center().rounded(8).bg(t.raised).cursor_pointer().text_size(12).text_color(t.muted)
                .hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.toggleFold(first, cx)).child(open ? `▾ ${item.count} activities` : item.label))
              .children(open ? item.notes.map((n) => card(n, n.index)) : []);
          }))))
          .child(v_flex().id("composer").flex_none().on_key_down((e, cx) => this.onNoteKey(e, cx))
            .when(Boolean(this.noteError), (el) => el.child(div().id("note-error").pb(6).text_size(12).text_color(t.blocked).child(this.noteError)))
            .child(v_flex().id("composer-box").gap(4).p(8).rounded(10).border_1().border_color(t.input).bg(t.background)
              .child(Textarea.new(this.note).h(64).text_size(13).border_0())
              .child(h_flex().items_center()
                .child(sendPicker)
                .child(div().flex_1())
                .child(h_flex().id("note-add").h(30).px(10).gap(6).items_center().rounded(8).text_size(12.5).font_medium()
                  .bg(noteReady ? t.solid : t.raised).text_color(noteReady ? t.solid_foreground : t.dim)
                  .when(noteReady && !this.sending, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.sendNote(cx)))
                  .child(this.sending ? "Sending…" : "Send").child(keycap(t, "command", noteReady, "note-kc-command")).child(keycap(t, "corner-down-left", noteReady, "note-kc-corner-down-left")))))))
        .child(v_flex().id("ed-sidebar").w(240).flex_none().h_full().border_l_1().border_color(t.border).p(12).gap(2).overflow_y_scrollbar()
          .child(section(t, "Properties"))
          .child(row("status", "Status", "", t[STATUS_ICON[this.column]?.tone], COLUMN_NAME[this.column], Select, null, true, "circle"))
          .child(row("priority", "Priority", "", prio[this.priority], `${this.priority} ${PRIORITY_LABEL[this.priority]}`, Select, null, true, "signal"))
          .child(row("assignee", "Assignee", "", t.muted, curRunner?.name ?? "No assignee", Select, null, true, "user"))
          .child(row("labels", "Labels", "", t.muted, this.labels.length ? this.labels.join(", ") : "Add label", Combobox, null, true, "tag"))
          .child(row("project", "Project", "", t.muted, curProject ? projLabel(curProject) : "No project", Combobox, null, true, "folder"))
          .child(machineRow(machineOf(projects, this.project)))
          .child(row("parent", "Parent", "↑", t.muted, curParent ? parentLabel(curParent) : "No parent", Combobox, null, true))
          .when(Boolean(curParent), (el) => el.child(h_flex().id("parent-open").px(8).py(4).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).text_size(11.5).text_color(t.accent)
            .on_click((_e, cx) => this.openParent(curParent.id, cx)).child(`Open ${curParent.id}`)))
          .children(runWakeSections)))
      .when(Boolean(this.error), (el) => el.child(div().px(24).pb(8).text_size(12).text_color(t.blocked).child(this.error)));
  }
}

export default class Todos extends View {
  init(_props, cx) {
    if (props()?.overlay && props().proof) { // the proof dialog (B3a): loads here, once, never in render
      bind({ shared, modSettings });
      this.proof = new Proof(cx);
      return;
    }
    if (props()?.overlay && "edit" in props()) {
      bind({ shared, modSettings });
      this.editor = new Editor(cx);
      // A Create dialog keeps the new-task key's guard alive (no repaint) while it is open; close() below clears it.
      if (props().edit == null) { const overlay = props().overlay; cx.timer.every?.(HEARTBEAT_MS, () => beatCreateGuard(overlay)); this.createOverlay = overlay; }
      return;
    }
    bind({ shared, modSettings });
    whenLoaded("drover-todos", cx);
    this.archived = false;
    this.query = "";
    this.search = InputState.new({ placeholder: "Search: words, #tag, p1" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
  }

  // The host's final call when the overlay goes (Esc, Close, Create, click outside): free the new-task key.
  async close(_cx) {
    this.proof?.close();
    if (this.createOverlay) clearCreateGuard(this.createOverlay);
  }

  render(cx) {
    if (this.proof) return this.proof.render(cx);
    if (this.editor) return this.editor.render(cx); // the task editor dialog is not the Todos screen: it opens from Board, Tasks and the CLI even when the list is off
    const t = theme();
    { const g = gated("drover-todos"); if (g) return g; }
    if (!this.remoteOn) { this.remoteOn = true; watchRemote(cx, () => isEnabled("drover-todos")); }
    const merged = loadMerged();
    const all = merged.tasks;
    const scoped = all.filter((x) => x.archived === this.archived);
    const shown = sorted(scoped.filter((x) => matches(x, this.query)));
    const tab = (id, text, on) => div().id(id).px(9).h(24).flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .on_click((_e, cx) => { this.archived = id === "f-archived"; cx.notify(); }).child(text);
    const empty = scoped.length === 0
      ? (this.archived ? "Nothing archived." : "No tasks yet. Add one with + New.")
      : "No task matches this search.";
    return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().p(8).gap(6).items_center().border_b_1().border_color(t.border)
        .child(Input.new(this.search).flex_1().h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
        .child(tab("f-active", `Active ${all.filter((x) => !x.archived).length}`, !this.archived))
        .child(tab("f-archived", `Archived ${all.filter((x) => x.archived).length}`, this.archived))
        .child(button(t, "new", "+ New", true, () => edit(null))))
      .children(merged.remotes.filter((r) => r.banner).map((r) => h_flex().id(`banner-${r.localId}`).mx(8).mt(6).px(10).min_h(30).gap(8).items_center().rounded(7).bg(t.hover).text_size(12)
        .text_color(r.state === "never" ? t.muted : t.blocked)
        .child(div().flex_1().min_w(0).truncate().child(`${r.name}: ${r.banner}`))
        .child(div().id(`retry-${r.localId}`).h(22).px(9).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
          .on_click((_e, cx) => { cx.stop_propagation(); retryRemote(r.machine, r.projectId, cx); }).child("Retry"))))
      .child(shown.length === 0
        ? div().p(16).text_color(t.dim).child(empty)
        : v_flex().id("list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2).children(shown.map((x) =>
          h_flex().id(`row-${x.id}`).min_h(34).px(8).gap(8).items_center().rounded(7).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click(() => edit(x.id, undefined, undefined, undefined, undefined, x.remote ? x : undefined))
            .when(Boolean(x.remote) && merged.remotes.some((r) => r.localId === x.project && r.state !== "fresh"), (el) => el.opacity(0.55))
            .when(Boolean(x.remote), (el) => el.child(chip(t, x.remote.machine, t.accent)))
            .child(chip(t, x.priority, PRIORITY_COLOR(t)[x.priority]))
            .child(div().flex_1().min_w(0).truncate().child(x.title))
            .children(x.tags.slice(0, 3).map((tag) => div().flex_none().text_size(11.5).text_color(t.accent).child(`#${tag}`)))
            .child(div().flex_none().w(78).text_right().text_size(11.5).text_color(t.muted).child(COLUMN_NAME[x.column]))
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(x.id)))));
  }
}
