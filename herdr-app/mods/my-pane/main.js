// Batcomputer pane header: a mono readout. Props from the app: { pane, terminal }.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home } from "herdr";

const MONO = "JetBrains Mono";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div().id(id).p(3).rounded(3).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.accent))
      .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
      .child(svg(`mods/my-pane/${icon}.svg`).size(13));
  }

  render() {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = (((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell").toUpperCase();
    const pane = p.pane;
    const on = Boolean(p.focused);
    const st = p.status;
    const sep = () => div().flex_none().text_color(t.dim).child("//");
    const status = st === "working" ? ["WORKING", t.working] : st === "blocked" ? ["ALERT · NEEDS YOU", t.blocked] : st === "done" ? ["DONE", t.done] : st === "idle" ? ["IDLE", t.dim] : null;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .pr(8)
      .gap(8)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(on ? `${t.accent}55` : t.border)
      .font_family(MONO)
      .text_size(10.5)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .child(div().flex_none().w(3).h_full().bg(on ? t.accent : t.dim).opacity(on ? 1 : 0.35))
      .child(div().flex_none().ml(4).text_color(t.dim).child(`[${String(props()?.terminal ?? "").toUpperCase()}]`))
      .when(Boolean(icon(p.program, 13, t.dim)), (el) => el.child(icon(p.program, 13, on ? t.accent : t.dim)))
      .child(div().flex_none().truncate().max_w(240).font_semibold().text_color(on ? t.accent : t.foreground).child(name))
      .child(sep())
      .child(div().flex_1().truncate().text_color(t.muted).child(folder(p.cwd)))
      .when(Boolean(status), (el) => el.child(h_flex().flex_none().gap(5).items_center()
        .when(st === "working", (s) => s.child(div().size(5).rounded_full().bg(t.working).loop("opacity", { from: 0.2, to: 1, period: 1000 })))
        .when(st === "blocked", (s) => s.child(div().size(5).rounded_full().bg(t.blocked).loop("opacity", { from: 0.2, to: 1, period: 400 })))
        .when(st === "done", (s) => s.child(div().size(5).rounded_full().bg(t.done)))
        .child(div().text_color(status[1]).font_semibold().child(status[0]))))
      .when(this.hovered, (el) => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
