// Canonical copy lives in mods/_lib. The filter menu popup and the token chip the GitHub and Jira views share.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { nextIndex } from "./tokenmenu.js";

// `view` is the screen: hi (highlighted row, -1 none), skipSubmit, menuNow(cx) -> {open, items}, pick(item, cx), dismiss(cx).
// Returns {open, content, onKey, onOutside} for sourceList's `menu`.
export function menuView(view, t, cx) {
  const m = view.menuNow(cx);
  const onKey = (e, cx) => {
    view.skipSubmit = false; // a pending skip belongs to the previous key only
    const m = view.menuNow(cx);
    if (!m.open) return;
    const n = m.items.length;
    if (e.key === "escape") { view.dismiss(cx); return cx.stop_propagation(); }
    if (e.key === "up" || e.key === "down") {
      view.hi = view.hi < 0 ? (e.key === "up" ? n - 1 : 0) : nextIndex(view.hi, n, e.key);
      cx.notify();
      return cx.stop_propagation();
    }
    // Enter picks only a highlighted item; otherwise it falls through to the input's submit.
    if (e.key === "enter" && m.items[view.hi]) { view.pick(m.items[view.hi], cx); view.skipSubmit = true; return cx.stop_propagation(); }
  };
  const content = v_flex().id("filter-menu").w(260).max_h(300).p(4).gap(1).mt(4).rounded(8).border_1().border_color(t.input).bg(t.popover)
    .child(v_flex().id("filter-menu-items").gap(1).overflow_y_scrollbar().children(m.items.map((it, i) =>
      h_flex().id(`fm-${it.id}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .text_size(12).text_color(t.foreground).role("list_box_option")
        .when(i === view.hi, (el) => el.aria_active_descendant().bg(t.selected))
        .hover((s) => s.bg(t.hover))
        // Pick on press, before the input loses focus; a click would arrive after the blur.
        .on_mouse_down("left", (_e, cx) => { view.pick(it, cx); cx.stop_propagation(); })
        // People rows: a plain circle with the login's initial. The host drew nothing for a remote Avatar image, so
        // none is used; it.avatar stays in the item data for a follow-up that caches avatars locally.
        .child(it.avatar
          ? div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded_full().bg(t.raised).text_size(9).text_color(t.muted)
            .child(it.label.slice(0, 1).toUpperCase())
          : div().w(14).text_color(t.muted).child(it.glyph))
        .child(div().flex_1().min_w(0).truncate().child(it.label))
        .when(Boolean(it.hint), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(it.hint))))));
  return { open: m.open, content, onKey, onOutside: (_e, cx) => view.dismiss(cx) };
}

// The input token chip: sourceList's `token`.
export const tokenChip = (t) => (ctx) => div().h(20).px(6).flex().items_center().rounded(5).bg(t.raised).border_1().border_color(ctx.selected ? t.foreground : t.border)
  .text_size(11.5).child(ctx.token.label);
