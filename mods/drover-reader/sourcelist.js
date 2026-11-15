// Canonical copy lives in mods/_lib. The list view the Jira and GitHub mods share.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, Popup } from "gpui-base";
import { theme } from "herdr";
import { bySource } from "./store.js";
import { load, edit, openUrl, addToBoard } from "./io.js";
import { age } from "./sources.js";

// view: { title, kind, tags(item), meta(item), items, at, partial, error, loading, empty, input, onRefresh, extra }
// Optional (GitHub only): token(ctx, cx) renders an input token chip, onTokenClick(event, cx), inputRight (elements after the input),
// menu {open, content, onKey(e, cx), onOutside(e, cx)}: a popup under the input. Focus stays in the input; its keys reach onKey
// through a wrapper (Up/Down/Enter/Esc), and a press outside the wrapper calls onOutside. Jira passes none.
export function sourceList(v) {
  const t = theme();
  const tasks = load();
  const icon = (id, text, action) => div().id(id).h(22).px(6).flex_none().flex().items_center().rounded(5)
    .text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground))
    .on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(text);
  const status = v.loading ? "Loading…" : v.at ? `Updated ${age(v.at)} ago${v.partial ? " · partial: more results exist" : ""}` : "Never loaded";
  const rows = v.items ?? [];
  const input = Input.new(v.input).h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12)
    .when(Boolean(v.token), (el) => el.token(v.token))
    .when(Boolean(v.onTokenClick), (el) => el.on_token_click(v.onTokenClick));
  const field = v.menu
    ? div().id("filter-field").flex_1().min_w(0).on_key_down(v.menu.onKey).on_mouse_down_out(v.menu.onOutside)
      .child(Popup.new("filter-menu-popup", input.w_full()).anchor("top_left").when(v.menu.open, (el) => el.content(v.menu.content)))
    : input.flex_1();
  return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground).text_size(12.5)
    .child(h_flex().h(36).px(10).gap(8).items_center().border_b_1().border_color(t.border)
      .child(div().text_size(13).font_semibold().child(v.title))
      .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(status))
      .child(icon("refresh", "↻ Refresh", v.onRefresh)))
    .child(h_flex().p(8).gap(6).items_center()
      .child(field)
      .children(v.inputRight ?? [])
      .children(v.extra ?? []))
    .when(Boolean(v.error), (el) => el.child(div().mx(8).mb(6).p(8).rounded(7).bg(t.raised).text_size(12).text_color(t.blocked)
      .child(v.at ? `${v.error} Showing the last good list.` : v.error)))
    .child(rows.length === 0
      ? div().p(12).text_color(t.dim).child(v.loading ? "Loading…" : v.at ? v.empty : "")
      : v_flex().id("rows").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(8).children(rows.map((item) => {
        const card = bySource(tasks, v.kind, item.id, item.url);
        return h_flex().id(`i-${item.id}`).min_h(40).px(8).py(4).gap(8).items_center().rounded(7).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click(() => openUrl(item.url))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().child(item.title))
            .child(div().truncate().text_size(10.5).text_color(t.dim).child([item.key, ...v.meta(item), age(item.updated)].filter(Boolean).join(" · "))))
          .child(card ? icon(`c-${item.id}`, `✓ ${card.id}`, () => edit(card.id)) : icon(`a-${item.id}`, "+ Board", () => addToBoard(v.kind, item, v.tags(item))));
      })));
}
