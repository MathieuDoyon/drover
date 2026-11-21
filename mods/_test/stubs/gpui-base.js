import { el } from "./el.js";
export const v_flex = el, h_flex = el, Input = { new: (state) => { globalThis.__rec?.inputs?.push(state); return el(); } }, Textarea = { new: (state) => { globalThis.__rec?.textareas?.push(state); return el(); } }, Select = { new: el }, Combobox = { new: el }, Popup = { new: el }, Popover = { new: (id) => el().id(id) }, Switch = { new: el }, Tabs = { new: (id) => el().id(id) }, Tab = { new: (id) => el().id(id) }, ScrollHandle = { new: () => ({ scroll_to_item(i) { globalThis.__scrolls?.push(i); } }) };
class State {
  set_masked(m) { this.masked = m; }
  constructor(o) { this.o = o; this.v = o?.value ?? ""; this.handlers = {}; }
  static new(o) { return new this(o); }
  value() { return this.v; }
  set_value(v) { this.v = v; this.sel = { start: v.length, end: v.length }; } // like the host: a new value puts the cursor at the end
  on(name, fn) { this.handlers[name] = fn; }
  set_auto_grow(min, max) { this.autoGrow = [min, max]; }
  focus() { this.focused = (this.focused ?? 0) + 1; }
  set_selected_range(r) { this.sel = r; }
  // Selection-aware insert (TextareaState.replace): the selected range is replaced, the cursor lands after the text.
  replace(text) { const { start, end } = this.sel ?? { start: this.v.length, end: this.v.length }; this.v = this.v.slice(0, start) + text + this.v.slice(end); this.sel = { start: start + text.length, end: start + text.length }; }
}
export class InputState extends State {}
export class TextareaState extends State {}
// TextView.markdown records { id, md, onLink } in __rec.md; chain methods are no-ops (on_link_click keeps the handler).
export const TextView = {
  markdown: (id, md) => {
    const entry = { id, md, onLink: null };
    globalThis.__rec?.md?.push(entry);
    const self = new Proxy(() => self, { get: (_t, k) => (k === "then" ? undefined : k === "on_link_click" ? (fn) => { entry.onLink = fn; return self; } : () => self), apply: () => self });
    return self;
  },
};
