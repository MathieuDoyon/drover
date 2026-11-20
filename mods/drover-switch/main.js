// Drover Switch: the page tabs on top of the `drover` column: "Room + Tasks" | "Needs you N". The selected tab is READ from layout()
// (needsnav.pageOf); a click runs showPage. No state of its own: Herdr keeps shown/hidden as a click.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, theme, layout } from "herdr";
import { startNeeds } from "./io.js";
import { pageOf, runPage } from "./needsnav.js";

export default class Switch extends View {
  init(_props, cx) {
    this.cache = startNeeds(cx); // own cache and timer; the count is the page's list length
  }

  render() {
    const t = theme();
    const page = pageOf(layout());
    const n = this.cache.get().counts.needs;
    // Segmented tabs: one rounded track (an h_flex row) with two plain h_flex segments as its direct children. Selected = raised background + full text;
    // the other = muted, hover shows a background. No Tabs/Tab wrapper: the base ones are unstyled and stacked the segments in a column.
    const seg = (id, page_, text, badge) => {
      const on = page === page_;
      return h_flex().id(`seg-${id}`).h(24).px(12).gap(6).items_center().justify_center().rounded(6).cursor_pointer().text_size(12).role("tab").aria_selected(on)
        .text_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.bg(t.canvas ?? t.background))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => runPage(run, page_))
        .child(text)
        .when(badge > 0, (el) => el.child(div().id("needs-badge").px(6).h(16).items_center().justify_center().rounded_full().bg(t.blocked).text_size(10).text_color("#ffffff").child(String(badge))));
    };
    return h_flex().id("switch-root").size_full().px(8).items_center().bg(t.chrome)
      .child(h_flex().id("switch-pill").role("tab_list").p(3).gap(2).items_center().rounded(8).bg(t.hover)
        .child(seg("room", "room", "Room + Tasks", 0))
        .child(seg("needs", "needs", "Needs you", n)));
  }
}
