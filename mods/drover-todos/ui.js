// Small view pieces shared by the Room and the task editor.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { openOverlay, theme } from "herdr";
import { gate } from "./config.js";

// The New wakeup dialog of drover-wakeups, aimed at `target` (a task id or terminal): its terminal fields are hidden.
export const openNewWakeup = (target) => openOverlay({ mod: "drover-wakeups", kind: "dialog", modal: true, width: 540, props: { wakeEdit: null, wakeTarget: target } });

// A section heading: title, optional count badge, optional element on the right.
export const section = (t, title, count, extra) => h_flex().pt(18).pb(6).gap(6).items_center()
  .child(div().text_size(13).font_medium().child(title))
  .when(count != null, (el) => el.child(div().px(5).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(String(count))))
  .child(div().flex_1()).when(Boolean(extra), (el) => el.child(extra));

export const toggle = (t, id, on, action) => div().id(id).w(30).h(17).flex_none().rounded(9).p(2).cursor_pointer()
  .bg(on ? t.foreground : t.input).flex().when(on, (el) => el.justify_end())
  .on_click((_e, cx) => { action(); cx.notify(); })
  .child(div().size(13).rounded(7).bg(on ? t.background : t.muted));

// What a switched-off screen renders (see isEnabled in config.js): one line and a hint, nothing that reads data.
export const DISABLED_TEXT = "Disabled in Drover Config";
export const DISABLED_HINT = "Turn it on in Config (Drover ▾ > Config).";
// What a screen returns when it is not on, else null: the stub when off, an empty neutral view while its settings are still loading.
export const gated = (mod, t = theme()) => { const g = gate(mod); return g === "on" ? null : g === "off" ? disabledStub(t) : div(); };
export const disabledStub = (t = theme()) => v_flex().id("disabled").size_full().p(16).gap(4).items_start().bg(t.surface ?? t.background).text_color(t.foreground)
  .child(div().text_size(13).font_medium().child(DISABLED_TEXT))
  .child(div().text_size(12).text_color(t.dim).child(DISABLED_HINT));
