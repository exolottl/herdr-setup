// Factory: a side workflow, so it floats. cmd-shift-f (or "Factory board" in the palette) toggles a wide
// window over the work; drag it by its title bar, it reopens where it was dropped. Nothing is dimmed or blocked.
//
// Left: a new task (text, attached images and files, repo, base branch, Build now), the builders working on
// tasks (click one for its screen, pause / play / interrupt / instruct / open / end), your open PRs, the team.
// Right: the PR you clicked: status, checks, review, description and its diff, so GitHub can stay closed.
//
// Each task gets a folder, data/factory/tasks/<id>/ under ~/.config/herdr-app (task.md, attachments/);
// `factory-task` starts a builder in its own worktree and branch and hands it the folder. The team's own
// sessions are never used.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { terminals, agents, theme, run, exec, hc, checking, window, appHome, pickFiles, props, closeOverlay } from "herdr";

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
// Removes builders, worktrees and branches whose PR is merged or closed; `--end <t>` stops one and clears it.
const FACTORY_CLEAN = "/Users/pranav/.local/bin/factory-clean";
const GH = "/opt/homebrew/bin/gh";
const GH_EVERY = 120_000;
// Task folders sit under the app's home so image() can show attachment thumbnails (it reads only there).
const TASKS_REL = "data/factory/tasks";
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i;
// ponytail: diffs past this many lines are cut, with a link to GitHub; a virtual list if big diffs matter.
const DIFF_MAX = 2000;

const color = (t, status) => ({ working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[status] ?? t.unknown);
const hhmm = () => new Date().toTimeString().slice(0, 5);
const firstLine = (r) => (r.stderr || r.stdout || "").trim().split("\n")[0] || `exit ${r.code}`;
const newId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
// A window is dragged by any press its mod doesn't stop: everything but the title bar stops it.
const still = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

export default class Factory extends View {
  init(_props, cx) {
    this.prs = null; // null until the first fetch
    this.ghAt = "";
    this.error = "";
    this.sent = ""; // last action's result line
    this.repo = REPOS.includes(localStorage.getItem("factory.repo")) ? localStorage.getItem("factory.repo") : REPOS[0];
    try { this.bases = JSON.parse(localStorage.getItem("factory.bases") ?? "{}"); } catch { this.bases = {}; }
    this.input = TextareaState.new({ placeholder: "Describe the task: what, why, anything a builder should know…", rows: 5 });
    this.tasks = `${appHome()}/${TASKS_REL}`;
    this.draft = { id: newId(), files: [] }; // the task being written: its folder id and its attachments
    // The builder whose row is expanded, its last screen lines, and the box that instructs it.
    this.sel = null;
    this.tail = [];
    this.note = "";
    this.reply = InputState.new({ placeholder: "Instruct this builder, Enter sends…" });
    this.reply.on("submit", (_e, cx) => this.instruct(cx));
    // The PR shown on the right: { repo, number } and what gh said about it.
    this.pr = null;
    this.prView = null;
    this.showTeam = false;
    this.handle = cx.focus_handle();
    if (checking()) return;
    // ponytail: polls the selected builder's screen every 3s, only while one is expanded.
    cx.timer.every(3000, (cx) => { if (this.sel && window()?.visible !== false) this.readTail(cx); });
    this.refreshPrs(cx);
    // ponytail: gh every 2 min while the window is open (closing it ends this copy and its timers).
    cx.timer.every(GH_EVERY, (cx) => { if (window()?.visible !== false) this.refreshPrs(cx); });
  }

  close() {
    this.input?.release();
    this.reply?.release();
  }

  hide() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  base(repo) {
    return BASES[repo].includes(this.bases[repo]) ? this.bases[repo] : BASES[repo][0];
  }

  // ---- new task ----

  start(cx) {
    const text = this.input.value().trim();
    if (!text) { this.sent = "Write the task first."; cx.notify(); return; }
    const repo = this.repo;
    const base = this.base(repo);
    const dir = `${this.tasks}/${this.draft.id}`;
    this.sent = `Starting a builder in ${repo} → ${base}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(FACTORY_TASK, ["--task-dir", dir, repo, base, text], { timeout: 120_000 })
        .catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) {
        this.input.set_value("");
        this.draft = { id: newId(), files: [] };
        this.sent = `Started ${r.stdout.trim()} in ${repo} → ${base} ✓`;
      } else {
        this.sent = `Not started: ${firstLine(r)}`;
      }
      cx.notify();
    });
  }

  // Copy files into the draft task's attachments/ folder. Same-named files get a number.
  attach(paths, cx) {
    if (!paths?.length) return;
    const dir = `${this.tasks}/${this.draft.id}/attachments`;
    cx.spawn(async (cx) => {
      await exec("/bin/mkdir", ["-p", dir]);
      for (const path of paths) {
        let name = path.split("/").pop();
        for (let n = 2; this.draft.files.some((f) => f.name === name); n++) name = name.replace(/(\.[^.]*)?$/, `-${n}$1`);
        const r = await exec("/bin/cp", ["-R", path, `${dir}/${name}`]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code !== 0) { this.sent = `Not attached: ${name}: ${firstLine(r)}`; continue; }
        this.draft.files.push({ name, rel: `${TASKS_REL}/${this.draft.id}/attachments/${name}`, isImage: IMAGE.test(name) });
      }
      cx.notify();
    });
  }

  detach(name, cx) {
    const dir = `${this.tasks}/${this.draft.id}/attachments`;
    this.draft.files = this.draft.files.filter((f) => f.name !== name);
    cx.spawn(async () => { await exec("/bin/rm", ["-rf", `${dir}/${name}`]); });
    cx.notify();
  }

  // ---- builders ----

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
        .filter((l) => l.trim() && !/^\s*(❯|⏵⏵|\? for shortcuts)/.test(l)).slice(-12);
      cx.notify();
    });
  }

  // hc calls against one builder, then a line saying what happened.
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

  end(address, cx) {
    this.sent = "Ending builder…";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(FACTORY_CLEAN, ["--end", address], { timeout: 120_000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.sent = r.code === 0 ? r.stdout.trim().split("\n").join(" · ") || "Ended." : `Not ended: ${firstLine(r)}`;
      cx.notify();
    });
  }

  // ---- PRs ----

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

  // Show a PR on the right: what gh says about it, and its diff.
  preview(repo, number, cx) {
    this.pr = { repo, number };
    this.prView = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const R = `revspot/${repo}`;
      const fail = (e) => ({ code: 1, stdout: "", stderr: String(e) });
      const [info, diff] = await Promise.all([
        exec(GH, ["pr", "view", String(number), "-R", R, "--json",
          "title,body,state,isDraft,url,baseRefName,headRefName,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,mergeable,commits"],
          { timeout: 30_000 }).catch(fail),
        exec(GH, ["pr", "diff", String(number), "-R", R], { timeout: 60_000 }).catch(fail),
      ]);
      if (this.pr?.number !== number || this.pr?.repo !== repo) return; // another PR was picked meanwhile
      if (info.code !== 0) { this.prView = { error: firstLine(info) }; cx.notify(); return; }
      const lines = diff.code === 0 ? diff.stdout.split("\n") : [];
      this.prView = { ...JSON.parse(info.stdout), diff: lines.slice(0, DIFF_MAX), diffCut: lines.length > DIFF_MAX };
      cx.notify();
    });
  }

  // A builder's pr label is a github.com/revspot/<repo>/pull/<n> link.
  previewUrl(url, cx) {
    const m = /github\.com\/revspot\/([^/]+)\/pull\/(\d+)/.exec(url ?? "");
    if (m) this.preview(m[1], Number(m[2]), cx); else if (url) exec("open", [url]);
  }

  markReady(cx) {
    const { repo, number } = this.pr;
    cx.spawn(async (cx) => {
      const r = await exec(GH, ["pr", "ready", String(number), "-R", `revspot/${repo}`]).catch((e) => ({ code: 1, stderr: String(e) }));
      this.sent = r.code === 0 ? `${repo}#${number} is ready for review ✓` : `Not marked ready: ${firstLine(r)}`;
      this.preview(repo, number, cx);
    });
  }

  // ---- drawing ----

  row(t, id, dot, main, detail, onClick, selected) {
    return still(h_flex().id(id).gap(8).px(6).py(4).rounded(5).items_center()
      .when(!!selected, (el) => el.bg(t.selected))
      .when(!!onClick, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .child(div().size(7).rounded(4).bg(dot).flex_none())
      .child(div().flex_none().text_color(t.foreground).child(main))
      .child(div().flex_1().text_color(t.dim).truncate().child(detail)));
  }

  section(t, title, rows, empty, extra) {
    return v_flex().gap(2)
      .child(h_flex().justify_between().pb(2)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(title.toUpperCase()))
        .when(!!extra, (el) => el.child(extra)))
      .children(rows.length ? rows : empty ? [div().px(6).text_color(t.dim).child(empty)] : []);
  }

  button(t, id, text, onClick, tone, solid) {
    return still(h_flex().id(id).px(10).py(4).rounded(6).border_1().cursor_pointer().flex_none()
      .border_color(solid ? t.solid : tone ?? t.border).bg(solid ? t.solid : t.background)
      .text_color(solid ? t.solid_foreground : tone ?? t.foreground)
      .hover((s) => s.opacity(0.85)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(text));
  }

  chip(t, id, text, on, onClick) {
    return still(h_flex().id(id).px(8).py(2).rounded(10).border_1().cursor_pointer()
      .border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.border_color(t.accent)).on_click(onClick).child(text));
  }

  intake(t) {
    return v_flex().gap(8)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child("NEW TASK"))
      .child(Textarea.new(this.input).h(120).px(10).py(8).rounded(8).border_1().border_color(t.input)
        .bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .children(this.draft.files.map((f) => h_flex().id(`att-${f.name}`).gap(6).pl(4).pr(8).py(3).rounded(8)
          .border_1().border_color(t.border).bg(t.background).items_center()
          .child(f.isImage ? image(f.rel).w(28).h(28).rounded(4).flex_none()
            : div().w(28).h(28).rounded(4).bg(t.raised).flex_none().flex().items_center().justify_center().child("📄"))
          .child(div().max_w(160).truncate().text_color(t.foreground).child(f.name))
          .child(still(div().id(`detach-${f.name}`).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.blocked))
            .on_click((_e, cx) => this.detach(f.name, cx)).child("×")))))
        .child(still(div().id("attach").text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => cx.spawn(async (cx) => this.attach(await pickFiles({ prompt: "Attach to this task", multiple: true }), cx)))
          .child("+ Attach")))
        .child(div().text_color(t.dim).child("or drop files here")))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().w(40).text_color(t.dim).child("in"))
        .children(REPOS.map((repo) => this.chip(t, `repo-${repo}`, repo, repo === this.repo,
          (_e, cx) => { this.repo = repo; localStorage.setItem("factory.repo", repo); cx.notify(); }))))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().w(40).text_color(t.dim).child("PR to"))
        .children(BASES[this.repo].map((base) => this.chip(t, `base-${base}`, base, base === this.base(this.repo), (_e, cx) => {
          this.bases = { ...this.bases, [this.repo]: base };
          localStorage.setItem("factory.bases", JSON.stringify(this.bases));
          cx.notify();
        }))))
      .child(h_flex().gap(10).items_center()
        .child(this.button(t, "build", "Build now", (cx) => this.start(cx), null, true))
        .child(div().flex_1().text_color(t.dim).text_size(11.5).child(
          `Branches off ${this.base(this.repo)}; one-commit draft PR into ${this.base(this.repo)}.`)))
      .when(!!this.sent, (el) => el.child(div().text_color(/^(Not|Cleanup failed)/.test(this.sent) ? t.blocked : t.dim).child(this.sent)));
  }

  builders(t, all, paneOf) {
    // A builder that stopped to ask sets an `ask` label; one waiting on a backend builder sets `waiting`;
    // the board sets `paused` on pause and clears it on play.
    const state = (b) => b.labels.ask ? `needs you: ${b.labels.ask}`
      : b.labels.paused ? "paused"
      : b.labels.waiting ? `waiting for ${b.labels.waiting}`
      : b.labels.pr ? `${b.status ?? "?"} · PR open` : `${b.status ?? "?"} · ${b.labels.branch ?? ""}`;
    const panel = (b) => {
      const a = b.address;
      return v_flex().gap(6).ml(15).mb(6).p(8).rounded(6).bg(t.background).border_1().border_color(t.border)
        .child(v_flex().gap(1).text_size(11.5).text_color(t.muted).children(
          this.tail.length ? this.tail.map((l, i) => div().id(`tail-${i}`).truncate().child(l))
            : [div().text_color(t.dim).child("Reading its screen…")]))
        .child(h_flex().gap(6).flex_wrap()
          .child(b.labels.paused
            ? this.button(t, `play-${a}`, "▶ Play", (cx) => this.act(cx, a, "Resumed",
                ["label", a, "paused="], ["send", a, "Continue where you left off."]), t.accent)
            : this.button(t, `pause-${a}`, "❚❚ Pause", (cx) => this.act(cx, a, "Paused",
                ["interrupt", a], ["label", a, "paused=1"])))
          .child(this.button(t, `int-${a}`, "Interrupt", (cx) => this.act(cx, a, "Interrupted", ["interrupt", a]), t.blocked))
          // Its Factory tab when it has one (builders started by factory-task do); else a peek.
          .child(this.button(t, `open-${a}`, "Open", () => paneOf.get(a)
            ? run("pane.focus", { pane: paneOf.get(a) }) : run("terminal.peek", { terminal: a })))
          .when(!!b.labels.pr, (el) => el.child(this.button(t, `prb-${a}`, "View PR", (cx) => this.previewUrl(b.labels.pr, cx))))
          .child(this.button(t, `endb-${a}`, "End", (cx) => this.end(a, cx))))
        .child(Input.new(this.reply).h(30).px(9).rounded(6).border_1().border_color(t.input).bg(t.popover)
          .text_size(12.5).text_color(t.foreground))
        .when(!!this.note, (el) => el.child(div().text_color(this.note.includes("failed") ? t.blocked : t.dim).child(this.note)));
    };
    if (this.sel && !all.some((x) => x.address === this.sel)) this.sel = null; // it ended
    return all.filter((x) => x.labels?.factory)
      .sort((a, b) => (b.labels.ask ? 1 : 0) - (a.labels.ask ? 1 : 0))
      .flatMap((b) => [
        this.row(t, `task-${b.address}`, b.labels.ask ? t.blocked : b.labels.paused ? t.dim : color(t, b.status),
          `${this.sel === b.address ? "▾" : "▸"} ${b.labels.task ?? b.name}`,
          `${b.labels.repo ?? "?"} → ${b.labels.base ?? "?"} · ${state(b)}`,
          (_e, cx) => this.select(b.address, cx)),
        ...(this.sel === b.address ? [panel(b)] : []),
      ]);
  }

  // The right column: the selected PR, or a hint.
  previewPane(t) {
    if (!this.pr) {
      return v_flex().size_full().items_center().justify_center().gap(6).text_color(t.dim)
        .child(div().text_size(14).child("No PR selected"))
        .child(div().child("Click a PR on the left, or View PR on a builder, to read it here."));
    }
    const { repo, number } = this.pr;
    const v = this.prView;
    const head = h_flex().gap(10).items_center()
      .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).truncate()
        .child(v?.title ?? `${repo}#${number}`))
      .when(!!v && !v.error && v.isDraft && v.state === "OPEN",
        (el) => el.child(this.button(t, "ready", "Ready for review", (cx) => this.markReady(cx))))
      .child(this.button(t, "gh", "GitHub ↗", () => exec("open", [v?.url ?? `https://github.com/revspot/${repo}/pull/${number}`])))
      .child(this.button(t, "unpick", "×", (cx) => { this.pr = null; this.prView = null; cx.notify(); }));
    if (!v) return v_flex().size_full().gap(12).child(head).child(div().text_color(t.dim).child("Loading the PR and its diff…"));
    if (v.error) return v_flex().size_full().gap(12).child(head).child(div().text_color(t.blocked).child(v.error));

    const checks = v.statusCheckRollup ?? [];
    const failed = checks.filter((c) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(c.conclusion || c.state));
    const pending = checks.filter((c) => !failed.includes(c) && (c.status ? c.status !== "COMPLETED" : c.state === "PENDING"));
    const pill = (text, tone) => div().px(8).py(2).rounded(10).border_1().border_color(tone).text_color(tone).text_size(11.5).child(text);
    const n = v.commits?.length;
    const facts = h_flex().gap(8).flex_wrap().items_center()
      .child(pill(v.state === "OPEN" ? (v.isDraft ? "draft" : "open") : v.state.toLowerCase(),
        v.state === "MERGED" ? t.accent : v.isDraft ? t.dim : t.done))
      .child(div().text_color(t.muted).child(`${repo}#${number} · ${v.headRefName} → ${v.baseRefName} · ${n ?? "?"} commit${n === 1 ? "" : "s"}`))
      .child(div().text_color(t.done).child(`+${v.additions}`))
      .child(div().text_color(t.blocked).child(`−${v.deletions}`))
      .child(div().text_color(t.muted).child(`${v.changedFiles} file${v.changedFiles === 1 ? "" : "s"}`))
      .when(checks.length > 0, (el) => el.child(pill(
        failed.length ? `checks: ${failed.length} failing` : pending.length ? `checks: ${pending.length} running` : `checks: ${checks.length} passed`,
        failed.length ? t.blocked : pending.length ? t.working : t.done)))
      .when(!!v.reviewDecision, (el) => el.child(pill(v.reviewDecision.toLowerCase().replace(/_/g, " "),
        v.reviewDecision === "APPROVED" ? t.done : v.reviewDecision === "CHANGES_REQUESTED" ? t.blocked : t.muted)))
      .when(v.mergeable === "CONFLICTING", (el) => el.child(pill("conflicts", t.blocked)));

    const diffLine = (l, i) => {
      if (l.startsWith("diff --git")) {
        const file = l.replace(/^diff --git a\/\S+ b\//, "");
        return div().id(`d-${i}`).mt(i ? 10 : 0).px(8).py(4).bg(t.raised).font_semibold().text_color(t.foreground).child(file);
      }
      const tone = /^(\+\+\+|---|index |new file|deleted file|similarity|rename )/.test(l) ? t.dim
        : l.startsWith("+") ? t.done : l.startsWith("-") ? t.blocked : l.startsWith("@@") ? t.accent : t.muted;
      return div().id(`d-${i}`).px(8).whitespace_nowrap().text_color(tone).child(l || " ");
    };
    return v_flex().size_full().gap(12)
      .child(head)
      .child(facts)
      .child(v_flex().flex_1().min_h(0).gap(12).overflow_y_scrollbar()
        .when(!!v.body?.trim(), (el) => el.child(v_flex().p(12).rounded(8).bg(t.background).border_1().border_color(t.border)
          .child(TextView.markdown(`body-${repo}-${number}`, v.body).text_size(12.8).text_color(t.foreground))))
        .child(v_flex().rounded(8).bg(t.background).border_1().border_color(t.border).py(6).text_size(12)
          .font_family("JetBrains Mono").overflow_x_scrollbar()
          .children(v.diff.length ? v.diff.map(diffLine) : [div().px(8).text_color(t.dim).child("No diff.")])
          .when(v.diffCut, (el) => el.child(div().px(8).pt(8).text_color(t.dim)
            .child(`Diff cut at ${DIFF_MAX} lines; GitHub ↗ has the rest.`)))));
  }

  render() {
    const t = theme();
    const all = terminals().filter((x) => x.state === "live");
    const paneOf = new Map(agents().map((a) => [a.address, a.pane]));
    const builders = this.builders(t, all, paneOf);
    const prs = (this.prs ?? []).map((p) =>
      this.row(t, `pr-${p.repo}-${p.number}`, p.isDraft ? t.dim : t.accent, `${p.repo}#${p.number}`,
        `${p.isDraft ? "draft · " : ""}${p.title} · ${p.headRefName} → ${p.baseRefName}`,
        (_e, cx) => this.preview(p.repo, p.number, cx), this.pr?.repo === p.repo && this.pr?.number === p.number));
    const team = all.filter((x) => TEAM.includes(x.name)).sort((a, b) => TEAM.indexOf(a.name) - TEAM.indexOf(b.name))
      .map((a) => this.row(t, `team-${a.address}`, color(t, a.status), a.name, `${a.status ?? "?"} · ${a.address}`,
        paneOf.get(a.address) && (() => run("pane.focus", { pane: paneOf.get(a.address) }))));
    const busy = all.filter((x) => TEAM.includes(x.name) && x.status === "working").length;

    // The title bar is the drag handle; everything else stops presses so it doesn't move the window.
    const bar = h_flex().h(40).flex_none().px(16).items_center().gap(12).border_b(1).border_color(t.border).cursor_move()
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Factory"))
      .child(div().flex_1().text_color(t.dim).text_size(11.5).child("drag here to move · ⌘⇧F or Esc to hide"))
      .child(still(div().id("refresh").text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.refreshPrs(cx)).child(`PRs ${this.ghAt || "…"} · refresh`)))
      .child(this.button(t, "hide", "×", () => this.hide()));

    const left = still(v_flex().w(460).flex_none().h_full().p(16).gap(18).border_r(1).border_color(t.border).overflow_y_scrollbar()
      .child(this.intake(t))
      .child(this.section(t, "Builders", builders, "No tasks in flight."))
      .child(this.section(t, "Your open PRs", prs, this.prs === null ? "Loading…" : "None open."))
      .child(this.section(t, `Team · ${busy} working`, this.showTeam ? team : [], "",
        still(div().id("team-toggle").text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.showTeam = !this.showTeam; cx.notify(); }).child(this.showTeam ? "hide" : "show"))))
      .when(!!this.error, (el) => el.child(div().text_color(t.blocked).child(this.error))));

    return v_flex().id("factory-root").size_full().bg(t.popover).text_size(12.5)
      .track_focus(this.handle).on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.hide(); } })
      .on_drop((e, cx) => this.attach(e.paths, cx))
      .child(bar)
      .child(h_flex().flex_1().min_h(0)
        .child(left)
        .child(still(v_flex().flex_1().min_w(0).h_full().p(16).child(this.previewPane(t)))));
  }
}
