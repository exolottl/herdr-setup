// Factory board: new tasks, the builders working on them, the team, and your open PRs.
// Opens as an overlay with cmd-shift-f or "Factory board" in the palette; again (or Esc) closes it.
// "New task": type a requirement, pick the repo, Enter runs `factory-task`. That starts a separate builder
// agent in its own worktree and branch, which implements, tests and opens a draft PR into beta.
// The team's own sessions (jason, dick, ...) are never sent anything from here.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { terminals, agents, theme, run, exec, hc, checking, window } from "herdr";

// The roster in ~/.config/herdr-core/team.md.
const TEAM = ["jason", "dick", "dick-admin", "bruce", "tim", "tim-harness", "barbara"];
// Repos a task can go to; the first is the default.
const REPOS = ["launchpad-frontend", "admin-frontend", "revspot-backend", "spot-harness"];
// Branches a PR can target in each repo (what origin has); the builder branches off the same one, so the
// PR holds only its own commit. Retargeting a PR afterwards on GitHub drags in the other branch's commits.
const BASES = {
  "launchpad-frontend": ["beta", "dev", "staging", "main"],
  "admin-frontend": ["beta", "dev", "staging", "main"],
  "revspot-backend": ["beta", "dev", "staging", "master"],
  "spot-harness": ["beta", "staging", "main", "master"],
};
const FACTORY_TASK = "/Users/pranav/.local/bin/factory-task";
// Removes builders, worktrees and branches whose PR is merged or closed; `--end <t>` stops one safely.
const FACTORY_CLEAN = "/Users/pranav/.local/bin/factory-clean";
const GH = "/opt/homebrew/bin/gh";
const GH_EVERY = 120_000;

const color = (t, status) => ({ working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[status] ?? t.unknown);
const hhmm = () => new Date().toTimeString().slice(0, 5);
const firstLine = (r) => (r.stderr || r.stdout || "").trim().split("\n")[0] || `exit ${r.code}`;

export default class Factory extends View {
  init(_props, cx) {
    this.prs = null; // null until the first fetch
    this.ghAt = "";
    this.error = "";
    this.repo = REPOS.includes(localStorage.getItem("factory.repo")) ? localStorage.getItem("factory.repo") : REPOS[0];
    this.sent = ""; // last start's result line
    try { this.bases = JSON.parse(localStorage.getItem("factory.bases") ?? "{}"); } catch { this.bases = {}; }
    this.input = InputState.new({ placeholder: "Describe a task, Enter starts a builder…" });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.input.focus();
    // The builder whose row is expanded, its last screen lines, and the box that instructs it.
    this.sel = null;
    this.tail = [];
    this.note = "";
    this.reply = InputState.new({ placeholder: "Instruct this builder, Enter sends…" });
    this.reply.on("submit", (_e, cx) => this.instruct(cx));
    if (checking()) return;
    // ponytail: polls the selected builder's screen every 3s, only while one is expanded.
    cx.timer.every(3000, (cx) => { if (this.sel && window()?.visible !== false) this.readTail(cx); });
    this.refreshPrs(cx);
    // ponytail: polls gh every 2 min while open; it's an overlay, so it only runs while shown.
    cx.timer.every(GH_EVERY, (cx) => { if (window()?.visible !== false) this.refreshPrs(cx); });
  }

  start(cx) {
    const text = this.input.value().trim();
    if (!text) return;
    const repo = this.repo;
    const base = this.base(repo);
    this.sent = `Starting a builder in ${repo} → ${base}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(FACTORY_TASK, [repo, base, text], { timeout: 120_000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) {
        this.input.set_value("");
        this.sent = `Started ${r.stdout.trim()} in ${repo} → ${base} ✓`;
      } else {
        this.sent = `Not started: ${firstLine(r)}`;
      }
      cx.notify();
    });
  }

  close() {
    this.input?.release();
    this.reply?.release();
  }

  select(address, cx) {
    this.sel = this.sel === address ? null : address;
    this.tail = [];
    this.note = "";
    if (this.sel) { this.reply.focus(); this.readTail(cx); }
    cx.notify();
  }

  readTail(cx) {
    const address = this.sel;
    cx.spawn(async (cx) => {
      const r = await hc(["read", address, "--lines", "40"]).catch(() => null);
      if (!r || this.sel !== address) return;
      // Claude's screen has frame and prompt rows; keep the last lines that say something.
      this.tail = r.stdout.split("\n").map((l) => l.replace(/[│╭╮╰╯─]+/g, "").trimEnd())
        .filter((l) => l.trim() && !/^\s*(❯|⏵⏵|\? for shortcuts)/.test(l)).slice(-10);
      cx.notify();
    });
  }

  // One hc call against the selected builder, then a line saying what happened.
  act(cx, address, label, ...calls) {
    this.note = `${label}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      for (const args of calls) {
        const r = await hc(args).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code !== 0) { this.note = `${label} failed: ${firstLine(r)}`; cx.notify(); return; }
      }
      this.note = `${label} ✓`;
      this.readTail(cx);
      cx.notify();
    });
  }

  instruct(cx) {
    const text = this.reply.value().trim();
    if (!text || !this.sel) return;
    this.reply.set_value("");
    this.act(cx, this.sel, "Sent", ["send", this.sel, text]);
  }

  base(repo) {
    return BASES[repo].includes(this.bases[repo]) ? this.bases[repo] : BASES[repo][0];
  }

  end(address, cx) {
    this.sent = "Ending builder…";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(FACTORY_CLEAN, ["--end", address], { timeout: 120_000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.sent = r.code === 0 ? r.stdout.trim().split("\n").join(" · ") || "Ended." : `Not ended: ${firstLine(r)}`;
      cx.notify();
    });
  }

  refreshPrs(cx) {
    cx.spawn(async (cx) => {
      try {
        // Tidy up after merged or closed factory PRs first, so the lists below are current.
        const swept = await exec(FACTORY_CLEAN, [], { timeout: 300_000 }).catch((e) => ({ code: 1, stderr: String(e) }));
        if (swept.code !== 0) this.sent = `Cleanup failed: ${firstLine(swept)}`;
        else if (swept.stdout.trim()) this.sent = `Cleaned up: ${swept.stdout.trim().split("\n").join(" · ")}`;
        const prs = [];
        for (const repo of REPOS) {
          const r = await exec(GH, ["pr", "list", "-R", `revspot/${repo}`, "--author", "@me", "--state", "open",
            "--json", "number,title,isDraft,url,headRefName,baseRefName"], { timeout: 30_000 });
          if (r.code !== 0) throw new Error(firstLine(r));
          for (const p of JSON.parse(r.stdout || "[]")) prs.push({ ...p, repo });
        }
        this.prs = prs;
        this.ghAt = hhmm();
        this.error = "";
      } catch (e) {
        this.error = `gh: ${e.message ?? e}`;
      }
      cx.notify();
    });
  }

  row(t, id, dot, main, detail, onClick, extra) {
    return h_flex().id(id).gap(8).px(6).py(3).rounded(4).items_center()
      .when(!!onClick, (el) => el.hover((s) => s.bg(t.hover)).on_click(onClick))
      .child(div().size(7).rounded(4).bg(dot))
      .child(div().flex_none().text_color(t.foreground).child(main))
      .child(div().flex_1().text_color(t.dim).truncate().child(detail))
      .when(!!extra, (el) => el.children(extra));
  }

  link(t, id, text, onClick) {
    return div().id(id).flex_none().text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(text);
  }

  section(t, title, rows, empty) {
    return v_flex().gap(2)
      .child(div().text_size(11).font_semibold().text_color(t.muted).pb(2).child(title.toUpperCase()))
      .children(rows.length ? rows : [div().px(6).text_color(t.dim).child(empty)]);
  }

  render() {
    const t = theme();
    const all = terminals().filter((x) => x.state === "live");
    const paneOf = new Map(agents().map((a) => [a.address, a.pane]));
    const focus = (address) => paneOf.get(address) && (() => run("pane.focus", { pane: paneOf.get(address) }));

    // Click a builder to expand it: its last screen lines, pause / play / interrupt, and a box to instruct it.
    // A builder that stopped to ask sets an `ask` label; one waiting on a backend builder sets `waiting`;
    // the board sets `paused` on pause and clears it on play.
    const state = (b) => b.labels.ask ? `needs you: ${b.labels.ask}`
      : b.labels.paused ? "paused"
      : b.labels.waiting ? `waiting for ${b.labels.waiting}`
      : b.labels.pr ? `${b.status ?? "?"} · PR open` : `${b.status ?? "?"} · ${b.labels.branch ?? ""}`;
    const button = (id, text, onClick, tone) => h_flex().id(id).px(9).py(3).rounded(6).border_1().cursor_pointer()
      .border_color(tone ?? t.border).text_color(tone ?? t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(text);
    const panel = (b) => {
      const a = b.address;
      return v_flex().gap(6).ml(15).mb(6).p(8).rounded(6).bg(t.background).border_1().border_color(t.border)
        .child(v_flex().gap(1).text_size(11.5).text_color(t.muted).children(
          this.tail.length ? this.tail.map((l, i) => div().id(`tail-${i}`).truncate().child(l))
            : [div().text_color(t.dim).child("Reading its screen…")]))
        .child(h_flex().gap(6).flex_wrap()
          .child(b.labels.paused
            ? button(`play-${a}`, "▶ Play", (cx) => this.act(cx, a, "Resumed",
                ["label", a, "paused="], ["send", a, "Continue where you left off."]), t.accent)
            : button(`pause-${a}`, "❚❚ Pause", (cx) => this.act(cx, a, "Paused",
                ["interrupt", a], ["label", a, "paused=1"])))
          .child(button(`int-${a}`, "Interrupt", (cx) => this.act(cx, a, "Interrupted", ["interrupt", a]), t.blocked))
          // Its Factory tab when it has one (builders started by factory-task do); else a peek over this tab.
          .child(button(`open-${a}`, "Open", () => paneOf.get(a)
            ? run("pane.focus", { pane: paneOf.get(a) }) : run("terminal.peek", { terminal: a })))
          .when(!!b.labels.pr, (el) => el.child(button(`prb-${a}`, "PR", () => exec("open", [b.labels.pr]))))
          .child(button(`endb-${a}`, "End", (cx) => this.end(a, cx))))
        .child(Input.new(this.reply).h(30).px(9).rounded(6).border_1().border_color(t.input).bg(t.popover)
          .text_size(12.5).text_color(t.foreground))
        .when(!!this.note, (el) => el.child(div().text_color(this.note.includes("failed") ? t.blocked : t.dim).child(this.note)));
    };
    const builders = all.filter((x) => x.labels?.factory)
      .sort((a, b) => (b.labels.ask ? 1 : 0) - (a.labels.ask ? 1 : 0))
      .flatMap((b) => [
        this.row(t, `task-${b.address}`, b.labels.ask ? t.blocked : b.labels.paused ? t.dim : color(t, b.status),
          `${this.sel === b.address ? "▾" : "▸"} ${b.labels.task ?? b.name}`,
          `${b.labels.repo ?? "?"} → ${b.labels.base ?? "?"} · ${state(b)}`,
          (_e, cx) => this.select(b.address, cx)),
        ...(this.sel === b.address ? [panel(b)] : []),
      ]);
    if (this.sel && !all.some((x) => x.address === this.sel)) this.sel = null; // it ended

    const team = all.filter((x) => TEAM.includes(x.name)).sort((a, b) => TEAM.indexOf(a.name) - TEAM.indexOf(b.name))
      .map((a) => this.row(t, `team-${a.address}`, color(t, a.status), a.name, `${a.status ?? "?"} · ${a.address}`, focus(a.address)));

    const prs = (this.prs ?? []).map((p) =>
      this.row(t, `pr-${p.repo}-${p.number}`, p.isDraft ? t.dim : t.accent, `${p.repo}#${p.number}`,
        `${p.isDraft ? "draft · " : ""}${p.title} · ${p.headRefName} → ${p.baseRefName}`,
        () => exec("open", [p.url])));

    const chip = (repo) => h_flex().id(`repo-${repo}`).px(8).py(2).rounded(10).border_1().cursor_pointer()
      .border_color(repo === this.repo ? t.accent : t.border)
      .text_color(repo === this.repo ? t.foreground : t.muted)
      .hover((s) => s.border_color(t.accent))
      .on_click((_e, cx) => { this.repo = repo; localStorage.setItem("factory.repo", repo); this.input.focus(); cx.notify(); })
      .child(repo);
    const baseChip = (base) => h_flex().id(`base-${base}`).px(8).py(2).rounded(10).border_1().cursor_pointer()
      .border_color(base === this.base(this.repo) ? t.accent : t.border)
      .text_color(base === this.base(this.repo) ? t.foreground : t.muted)
      .hover((s) => s.border_color(t.accent))
      .on_click((_e, cx) => {
        this.bases = { ...this.bases, [this.repo]: base };
        localStorage.setItem("factory.bases", JSON.stringify(this.bases));
        this.input.focus();
        cx.notify();
      })
      .child(base);
    const intake = v_flex().gap(6)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child("NEW TASK"))
      .child(Input.new(this.input).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background)
        .text_size(12.8).text_color(t.foreground))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().w(36).text_color(t.dim).child("in"))
        .children(REPOS.map(chip)))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().w(36).text_color(t.dim).child("PR to"))
        .children(BASES[this.repo].map(baseChip)))
      .child(div().text_color(t.dim).child(
        `A new builder branches off ${this.base(this.repo)} and opens a one-commit draft PR into ${this.base(this.repo)}.`))
      .when(!!this.sent, (el) => el.child(div().text_color(this.sent.startsWith("Not") ? t.blocked : t.dim).child(this.sent)));

    return v_flex().size_full().max_h(680).p(14).gap(14).bg(t.popover).text_size(12.5).overflow_y_scrollbar()
      .child(h_flex().gap(12).justify_between()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Factory"))
        .child(div().id("refresh").text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.refreshPrs(cx)).child(`PRs ${this.ghAt || "…"} · refresh`)))
      .child(intake)
      .child(this.section(t, "Builders", builders, "No tasks in flight."))
      .child(this.section(t, "Your open PRs", prs, this.prs === null ? "Loading…" : "None open."))
      .child(this.section(t, "Team", team, "No team agents running (hc-team starts them)."))
      .when(!!this.error, (el) => el.child(div().text_color(t.blocked).child(this.error)));
  }
}
