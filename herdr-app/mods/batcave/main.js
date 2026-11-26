import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, window, agents, props } from "herdr";

const MONO = "JetBrains Mono";
const pad = (n) => String(n).padStart(2, "0");

export default class Batcave extends View {
  init(_props, cx) {
    this.footer = Boolean(props()?.footer);
    this.now = new Date();
    if (this.footer) cx.timer.every(1000, (cx) => { this.now = new Date(); cx.notify(); });
  }

  header(t) {
    const mac = window()?.platform === "macos";
    return h_flex().size_full().pl(mac ? 76 : 14).pr(10).gap(8).items_center().bg(`${t.chrome}a0`)
      .child(svg("mods/batcave/bat.svg").w(40).h(16).text_color(t.accent))
      .child(div().font_family(MONO).text_size(11.5).font_semibold().text_color(t.accent).child("BATCOMPUTER"));
  }

  render() {
    const t = theme();
    if (!this.footer) return this.header(t);

    const list = agents();
    const working = list.filter((a) => a.status === "working").length;
    const blocked = list.filter((a) => a.status === "blocked").length;
    const d = this.now;
    const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit" }).toUpperCase();
    const tick = { working: t.working, blocked: t.blocked, done: t.done };

    return v_flex().size_full().bg(`${t.chrome}b0`).border_t(1).border_color(t.border).px(12).pt(8).pb(8).gap(5).font_family(MONO).text_size(10.5)
      .child(h_flex().items_center().gap(6)
        .child(div().size(6).rounded_full().bg(blocked ? t.blocked : t.accent).loop("opacity", { from: 0.2, to: 1, period: blocked ? 500 : 1800 }))
        .child(div().text_color(blocked ? t.blocked : t.dim).child(blocked ? "ALFRED // YOU ARE NEEDED" : "SUIT SYSTEMS ONLINE"))
        .child(div().flex_1())
        .child(div().id("settings").size(20).flex().items_center().justify_center().rounded(5).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.accent)).on_click(() => run("app.settings"))
          .child(svg("mods/batcave/settings.svg").size(13))))
      .child(h_flex().justify_between().items_end()
        .child(div().text_size(21).font_semibold().text_color(t.accent).child(clock))
        .child(div().text_color(t.muted).child(date)))
      .child(h_flex().justify_between().items_center()
        .child(div().text_color(t.dim).child("AGENTS"))
        .child(div().text_color(working ? t.accent : t.muted).child(`${working} ACTIVE / ${list.length}`)))
      .child(h_flex().gap(3).children(list.length ? list.map((a) => div().w(12).h(3).rounded(1).bg(tick[a.status] ?? t.dim)) : [div().w(12).h(3).rounded(1).bg(t.dim)]));
  }
}
