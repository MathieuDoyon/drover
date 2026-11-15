// Drover Config: a dialog to change what the Drover mods let you set. Left: the mods. Right: one row per setting.
// Writes ONLY the shared key "drover.config" ({ "<mod>": { "<key>": value } }), and only the values you changed.
// An invalid value is explained under its row and never written. Open it from the Drover menu (drover-tabs).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { shared, setShared, theme, props, closeOverlay } from "herdr";
import { SCHEMA, validate } from "./config-schema.js";
import { KEY, isOverride, setOverride, resetOverride, resolve } from "./config.js";
import { modSettings, readKeys, setShortcut, workFolderOffers, moveWorkFolder } from "./io.js";
import { confirmText, moveSummary } from "./workfolder.js";
import { SHORTCUTS, status as keyStatus } from "./keys.js";
import { toggle } from "./ui.js";
import { createModel } from "./model.js";
import { parseQuery } from "./query.js";

const model = createModel({ SCHEMA, validate, isOverride, setOverride, resetOverride, resolve, parseQuery });


// One extra line under a setting, keyed "<mod>/<key>".
const HINTS = {
  "drover-wakeups/min_repeat_minutes": "Applies to wakeups made in the app, in the Room, and with drover wake every ...: the drover CLI uses the same value.",
  "drover-wakeups/expiry_hours": "Also the limit for wakeups made with the drover CLI.",
  "drover-tasks/enabled": "The sidebar shortcut (cmd-alt-b) still toggles the (empty) Tasks column.",
};

const SHORTCUTS_NOTICE = "Keys live in Herdr's keys.json. A switch adds or removes only Drover's binding, after backing the file up (keys.json.bak-<time>). A key bound to something else is never overridden.";

const current = () => {
  const s = shared(KEY);
  return s !== null && typeof s === "object" && !Array.isArray(s) ? s : {};
};
const SHORTCUTS_TAB = "@shortcuts"; // a left-list entry that is not in the config SCHEMA: it edits keys.json, not drover.config
const idOf = (mod, key) => `${mod}/${key}`;

export default class DroverConfig extends View {
  init(_props, cx) {
    this.cx = cx;
    this.keyState = new Map(); // shortcut id -> { state, message } read from keys.json
    this.keyErrors = new Map(); // shortcut id -> why the last switch was refused
    this.loadKeys();
    this.mod = model.mods({})[0]?.mod;
    this.inherited = new Map(); // mod -> its mod.json `settings` (the layer under the override); loaded below
    this.synced = new Map(); // "<mod>/<key>" -> the text last put in the field; a field whose text differs holds a draft
    this.errors = new Map(); // "<mod>/<key>" -> message shown under the row
    this.inputs = new Map(); // "<mod>/<key>" -> InputState; created here once, never in render
    this.offers = []; // existing <repo>/.drover folders that can be moved into the work folder (project mode only)
    this.confirm = null; // the project id whose move waits for the explicit Move click
    this.moveMsg = new Map(); // project id -> result or error text
    this.loadOffers();
    for (const f of SCHEMA) {
      if (f.type === "boolean" || f.type === "enum") continue; // an enum is picked with buttons, not typed
      const id = idOf(f.mod, f.key);
      const input = InputState.new({ placeholder: f.type === "list" ? (f.of ? f.of.join(", ") : "a, b, c") : "" });
      const row = model.rows(current(), f.mod).find((r) => r.key === f.key);
      input.set_value(row.text);
      this.synced.set(id, row.text);
      this.inputs.set(id, input);
      // Enter or leaving the field saves. An unchanged text is not a change (no override made by just focusing).
      // An untouched field (text equal to what was last synced) never saves, even if the stored value moved on.
      const save = (_e, cx) => {
        if (this.dirty(id)) return this.commit(f.mod, f.key, input.value(), cx);
        if (this.errors.delete(id)) cx.notify(); // back to the stored text: the old message no longer applies
      };
      input.on("submit", save);
      input.on("blur", save);
    }
    cx.spawn(async (cx) => {
      for (const { mod } of model.mods({})) this.inherited.set(mod, await modSettings(mod));
      cx.notify();
    });
  }

  // What could be moved: read on open and whenever the work folder setting changes. Reading never moves anything.
  async loadOffers() {
    this.offers = await workFolderOffers().catch(() => []);
    this.cx.notify();
  }

  // Two steps, never automatic: the button only asks; the Move click inside the confirm row does it.
  async moveOffer(o) {
    this.confirm = null;
    this.moveMsg.set(o.id, "Moving…");
    this.cx.notify();
    const r = await moveWorkFolder(o.from, o.to);
    this.moveMsg.set(o.id, r.error ? `Not moved: ${r.error}` : moveSummary(r));
    await this.loadOffers();
  }

  offerRow(t, o) {
    const btn = (id, label, action, solid) => div().id(id).h(26).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .when(solid, (el) => el.bg(t.raised)).border_1().border_color(t.border).hover((s) => s.bg(t.hover)).on_click(action).child(label);
    const msg = this.moveMsg.get(o.id);
    return v_flex().id(`offer-${o.id}`).px(16).py(12).gap(6).border_b_1().border_color(t.border)
      .child(div().text_size(13).font_medium().child(`Move existing .drover files here (${o.name})`))
      .child(div().text_size(12).text_color(t.muted).child(this.confirm === o.id ? confirmText(o) : `${o.count} item${o.count === 1 ? "" : "s"} in ${o.from} can move to ${o.to}. Nothing moves until you confirm.`))
      .when(Boolean(msg), (el) => el.child(div().text_size(12).text_color(t.dim).child(msg)))
      .child(h_flex().gap(8)
        .when(this.confirm !== o.id, (el) => el.child(btn(`move-${o.id}`, "Move…", (_e, cx) => { this.confirm = o.id; cx.notify(); }, false)))
        .when(this.confirm === o.id, (el) => el.child(btn(`move-confirm-${o.id}`, "Move", () => { this.moveOffer(o); }, true))
          .child(btn(`move-cancel-${o.id}`, "Cancel", (_e, cx) => { this.confirm = null; cx.notify(); }, false))));
  }

  // keys.json is the truth: read on open, on selecting Shortcuts and after every write.
  async loadKeys() {
    const text = await readKeys().catch(() => null);
    for (const sc of SHORTCUTS) this.keyState.set(sc.id, keyStatus(text, sc));
    this.cx.notify();
  }

  async flip(sc) {
    const on = Boolean(this.keyState.get(sc.id)?.installed);
    const r = await setShortcut(sc, !on).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (r.ok) this.keyErrors.delete(sc.id); else this.keyErrors.set(sc.id, r.error);
    await this.loadKeys();
  }

  shortcutRow(t, sc) {
    const st = this.keyState.get(sc.id);
    const message = this.keyErrors.get(sc.id) ?? (st?.message ?? "");
    return h_flex().id(`row-sc-${sc.id}`).px(16).py(12).gap(16).items_start().border_b_1().border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(13).font_medium().child(sc.title))
        .child(div().text_size(12).text_color(t.muted).child(sc.description))
        .child(div().text_size(11).text_color(t.dim).child(`Key: ${sc.key} · ${sc.section === "global" ? "all layouts" : `layout ${sc.section.split(":")[1]}`} · ${st ? st.state === "on" ? "On" : "Off" : "Reading keys.json…"}`))
        .when(Boolean(message), (el) => el.child(div().text_size(12).text_color(t.blocked).child(message))))
      .child(h_flex().gap(8).items_center().flex_none().child(toggle(t, `sw-sc-${sc.id}`, Boolean(st?.installed), () => { this.flip(sc); })));
  }

  rowOf(mod, key) {
    return model.rows(current(), mod, this.inherited.get(mod)).find((r) => r.key === key);
  }

  dirty(id) {
    const input = this.inputs.get(id);
    return Boolean(input) && input.value() !== this.synced.get(id);
  }

  // Clean fields follow the stored value (another dialog copy saved, or the mod.json layer arrived); drafts are kept.
  refresh() {
    for (const [id, input] of this.inputs) {
      if (this.dirty(id)) continue;
      const [mod, key] = id.split("/");
      const text = this.rowOf(mod, key).text;
      if (text !== this.synced.get(id)) { input.set_value(text); this.synced.set(id, text); }
    }
  }

  // Validate, then write. An invalid draft only sets the message.
  commit(mod, key, raw, cx) {
    const id = idOf(mod, key);
    const row = this.rowOf(mod, key);
    if (typeof raw === "string" && raw.trim() === row.text) { this.errors.delete(id); this.sync(mod, key); return cx.notify(); }
    const r = model.set(current(), mod, key, raw);
    if (!r.ok) { this.errors.set(id, r.error); return cx.notify(); }
    setShared(KEY, r.shared);
    this.errors.delete(id);
    this.sync(mod, key);
    if (mod === "drover-config") this.loadOffers();
    cx.notify();
  }

  // Put the stored value back in the field (after a save, which normalises it, or a reset).
  sync(mod, key) {
    const id = idOf(mod, key), input = this.inputs.get(id);
    if (!input) return;
    const text = this.rowOf(mod, key).text;
    input.set_value(text);
    this.synced.set(id, text);
  }

  // The -/+ buttons: from the draft when it is a number, else from the value in force.
  step(mod, key, dir, cx) {
    const id = idOf(mod, key), row = this.rowOf(mod, key);
    const draft = this.dirty(id) ? this.inputs.get(id).value() : row.text;
    this.commit(mod, key, String(model.stepFrom(mod, key, draft, row.value, dir)), cx);
  }

  reset(mod, key, cx) {
    setShared(KEY, model.reset(current(), mod, key));
    this.errors.delete(idOf(mod, key));
    this.sync(mod, key);
    if (mod === "drover-config") this.loadOffers();
    cx.notify();
  }

  resetAll(mod, cx) {
    setShared(KEY, model.resetAll(current(), mod));
    for (const f of SCHEMA.filter((x) => x.mod === mod)) { this.errors.delete(idOf(mod, f.key)); this.sync(mod, f.key); }
    if (mod === "drover-config") this.loadOffers();
    cx.notify();
  }

  control(t, r) {
    const id = idOf(r.mod, r.key);
    if (r.type === "boolean") {
      // toggle() repaints after its action, so commit gets a cx that does nothing.
      return toggle(t, `sw-${id}`, r.value, () => this.commit(r.mod, r.key, !r.value, { notify() {} }));
    }
    if (r.type === "enum") {
      return h_flex().gap(4).items_center().children(r.enum.map((opt) => div().id(`opt-${id}-${opt}`).h(28).px(12).flex().items_center().rounded(7).border_1().border_color(t.input).text_size(12).cursor_pointer()
        .when(opt === r.value, (el) => el.bg(t.foreground).text_color(t.background)).when(opt !== r.value, (el) => el.bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { if (opt !== r.value) this.commit(r.mod, r.key, opt, cx); }).child(opt)));
    }
    const input = this.inputs.get(id);
    const field = (w) => Input.new(input).w(w).h(28).px(8).rounded(7).border_1().border_color(this.errors.has(id) ? t.blocked : t.input).bg(t.background).text_size(12);
    if (r.type === "int") {
      const btn = (sign, dir) => div().id(`${dir > 0 ? "inc" : "dec"}-${id}`).size(28).flex_none().flex().items_center().justify_center().rounded(7)
        .border_1().border_color(t.input).bg(t.raised).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.step(r.mod, r.key, dir, cx)).child(sign);
      return h_flex().gap(4).items_center().child(btn("-", -1)).child(field(72)).child(btn("+", 1));
    }
    return field(300);
  }

  settingRow(t, r) {
    const id = idOf(r.mod, r.key), error = this.errors.get(id);
    const reset = r.changed
      ? div().id(`reset-${id}`).h(24).px(8).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.reset(r.mod, r.key, cx)).child("Reset")
      : div().w(48); // keeps the control column from shifting
    return h_flex().id(`row-${id}`).px(16).py(12).gap(16).items_start().border_b_1().border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(6).items_center()
          .child(div().size(7).flex_none().rounded(4).when(r.changed, (el) => el.bg(t.accent)))
          .child(div().text_size(13).font_medium().child(r.title))
          .when(!r.live, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("applies when the screen reopens"))))
        .children(String(r.description).split("\n").map((line) => div().text_size(12).text_color(t.muted).child(line))) // one text row per line: an enum lists one line per choice
        .when(Boolean(HINTS[id]), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(HINTS[id])))
        .child(div().text_size(11).text_color(t.dim).child(`Default: ${r.defaultText === "" ? "empty" : r.defaultText}${r.inheritedText === null ? "" : ` · mod.json: ${r.inheritedText}`}`))
        .when(Boolean(error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(error))))
      .child(h_flex().gap(8).items_center().flex_none().child(this.control(t, r)).child(reset));
  }

  render(_cx) {
    const t = theme();
    this.refresh();
    const sh = current();
    const mods = model.mods(sh);
    const cur = mods.find((m) => m.mod === this.mod) ?? mods[0];
    const shortcuts = this.mod === SHORTCUTS_TAB;
    const rows = shortcuts ? [] : model.rows(sh, cur.mod, this.inherited.get(cur.mod));
    const side = v_flex().id("cfg-mods").w(200).flex_none().h_full().p(8).gap(2).border_r_1().border_color(t.border).overflow_y_scrollbar()
      .children(mods.map((m) => h_flex().id(`mod-${m.mod}`).h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer().text_size(13)
        .bg(!shortcuts && m.mod === cur.mod ? t.selected : t.popover).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.mod = m.mod; cx.notify(); })
        .child(div().flex_1().truncate().child(m.title))
        .when(m.changed > 0, (el) => el.child(h_flex().gap(4).items_center().text_size(11).text_color(t.muted)
          .child(div().size(6).rounded(3).bg(t.accent)).child(String(m.changed)))))
        .concat([h_flex().id("mod-shortcuts").h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer().text_size(13)
          .bg(shortcuts ? t.selected : t.popover).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.mod = SHORTCUTS_TAB; this.loadKeys(); cx.notify(); })
          .child(div().flex_1().truncate().child("Shortcuts"))]));
    const head = h_flex().px(16).h(48).flex_none().gap(8).items_center().border_b_1().border_color(t.border)
      .child(div().flex_1().text_size(15).font_medium().child(shortcuts ? "Shortcuts" : `${cur.title} settings`))
      .when(!shortcuts && cur.changed > 0, (el) => el.child(div().id("reset-all").h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.border)
        .text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.resetAll(cur.mod, cx)).child(`Reset all (${cur.changed})`)))
      .child(div().id("close").h(26).px(10).flex().items_center().rounded(6).bg(t.raised).text_size(12).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(() => closeOverlay(props().overlay)).child("Close"));
    return h_flex().size_full().bg(t.popover).text_color(t.foreground)
      .child(side)
      .child(v_flex().flex_1().min_w(0).h_full()
        .child(head)
        .when(shortcuts, (el) => el.child(div().px(16).py(8).flex_none().text_size(11.5).text_color(t.dim).child(SHORTCUTS_NOTICE)))
        .child(v_flex().id("cfg-rows").flex_1().min_h(0).overflow_y_scrollbar()
          .children(shortcuts ? SHORTCUTS.map((sc) => this.shortcutRow(t, sc)) : [...rows.map((r) => this.settingRow(t, r)), ...(cur.mod === "drover-config" ? this.offers.map((o) => this.offerRow(t, o)) : [])])));
  }
}
