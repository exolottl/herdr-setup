// PRDs: a floating window (cmd-shift-r, or "PRD writer" in the palette) where a rough idea becomes a PRD.
// "Write PRD" starts a `planner` agent (Sonnet, ~/.config/herdr-core/templates/planner.md) in its own tab
// in a PRDs space. It reads the repos, asks what the code can't answer, and writes PRD.md.
// Left: a new idea (text, attachments, the repos it touches) and every PRD so far.
// Right: the selected PRD, rendered and refreshed as the planner writes it; the planner's questions and a
// box to answer; and Build, which hands the PRD to the Factory (one builder per repo, `factory-task`).
//
// Each PRD is a folder, data/prd/<id>/ under ~/.config/herdr-app: idea.md, attachments/, PRD.md.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { terminals, agents, theme, run, exec, hc, checking, window, appHome, pickFiles, props, closeOverlay } from "herdr";

const REPOS = ["launchpad-frontend", "admin-frontend", "revspot-backend", "spot-harness"];
const BASES = {
  "launchpad-frontend": ["beta", "dev", "staging", "main"],
  "admin-frontend": ["beta", "dev", "staging", "main"],
  "revspot-backend": ["beta", "dev", "staging", "master"],
  "spot-harness": ["beta", "staging", "main", "master"],
};
const HC = "/Users/pranav/.local/bin/hc";
const HERDR_APP = "/Users/pranav/.local/bin/herdr-app";
const FACTORY_TASK = "/Users/pranav/.local/bin/factory-task";
const PRD_REL = "data/prd"; // under the app's home, so image() can show attachment thumbnails
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i;

const firstLine = (r) => (r.stderr || r.stdout || "").trim().split("\n")[0] || `exit ${r.code}`;
const newId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20).replace(/-$/, "") || "prd";
const fail = (e) => ({ code: 1, stdout: "", stderr: String(e) });
// A window is dragged by any press its mod doesn't stop: everything but the title bar stops it.
const still = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

export default class Prd extends View {
  init(_props, cx) {
    this.home = `${appHome()}/${PRD_REL}`;
    this.prds = null; // [{ id, title, ready }], newest first; null until read
    this.cur = null; // selected PRD id
    this.text = ""; // its PRD.md
    this.tail = []; // its planner's last screen lines
    this.note = "";
    this.input = TextareaState.new({ placeholder: "The idea, roughly: what, who it's for, why now…", rows: 6 });
    this.draft = { id: newId(), files: [] };
    try { this.touch = new Set(JSON.parse(localStorage.getItem("prd.repos") ?? "[]")); } catch { this.touch = new Set(); }
    this.reply = InputState.new({ placeholder: "Answer the planner or ask for a change, Enter sends…" });
    this.reply.on("submit", (_e, cx) => this.send(cx));
    this.buildRepos = new Set();
    try { this.bases = JSON.parse(localStorage.getItem("factory.bases") ?? "{}"); } catch { this.bases = {}; }
    this.handle = cx.focus_handle();
    if (checking()) return;
    this.load(cx);
    // ponytail: rereads the selected PRD and its planner's screen every 3s while the window is open.
    cx.timer.every(3000, (cx) => { if (this.cur && window()?.visible !== false) this.refresh(cx); });
  }

  close() {
    this.input?.release();
    this.reply?.release();
  }

  hide() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  dir(id) { return `${this.home}/${id}`; }
  base(repo) { return BASES[repo].includes(this.bases[repo]) ? this.bases[repo] : BASES[repo][0]; }

  // Every PRD folder: its id, the idea's first line, and whether PRD.md exists yet.
  load(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("/bin/sh", ["-c",
        'cd "$1" 2>/dev/null || exit 0; for d in */; do d=${d%/}; [ -f "$d/idea.md" ] || continue; ' +
        'printf "%s\\t%s\\t%s\\n" "$d" "$([ -f "$d/PRD.md" ] && echo 1)" "$(head -n1 "$d/idea.md")"; done', "sh", this.home]).catch(fail);
      this.prds = r.stdout.split("\n").filter(Boolean).map((l) => {
        const [id, ready, title] = l.split("\t");
        return { id, ready: !!ready, title: title || id };
      }).sort((a, b) => b.id.localeCompare(a.id));
      cx.notify();
    });
  }

  pick(id, cx) {
    this.cur = id;
    this.text = "";
    this.tail = [];
    this.note = "";
    this.buildRepos = new Set();
    this.refresh(cx);
    cx.notify();
  }

  planner(id) {
    return terminals().find((x) => x.state === "live" && x.labels?.prddir === this.dir(id));
  }

  refresh(cx) {
    const id = this.cur;
    const p = this.planner(id);
    cx.spawn(async (cx) => {
      const [doc, screen] = await Promise.all([
        exec("/bin/cat", [`${this.dir(id)}/PRD.md`]).catch(fail),
        p ? hc(["read", p.address, "--lines", "60"]).catch(() => null) : null,
      ]);
      if (this.cur !== id) return;
      this.text = doc.code === 0 ? doc.stdout : "";
      // Claude's screen has frame and prompt rows; keep the last lines that say something.
      this.tail = screen ? screen.stdout.split("\n").map((l) => l.replace(/[│╭╮╰╯─]+/g, "").trimEnd())
        .filter((l) => l.trim() && !/^\s*(❯|⏵⏵|\? for shortcuts)/.test(l)).slice(-14) : [];
      if (this.text && !this.prds?.find((x) => x.id === id)?.ready) this.load(cx);
      cx.notify();
    });
  }

  // ---- a new idea ----

  attach(paths, cx) {
    if (!paths?.length) return;
    const dir = `${this.dir(this.draft.id)}/attachments`;
    cx.spawn(async (cx) => {
      await exec("/bin/mkdir", ["-p", dir]);
      for (const path of paths) {
        let name = path.split("/").pop();
        for (let n = 2; this.draft.files.some((f) => f.name === name); n++) name = name.replace(/(\.[^.]*)?$/, `-${n}$1`);
        const r = await exec("/bin/cp", ["-R", path, `${dir}/${name}`]).catch(fail);
        if (r.code !== 0) { this.note = `Not attached: ${name}: ${firstLine(r)}`; continue; }
        this.draft.files.push({ name, path: `${dir}/${name}`, rel: `${PRD_REL}/${this.draft.id}/attachments/${name}`, isImage: IMAGE.test(name) });
      }
      cx.notify();
    });
  }

  detach(name, cx) {
    const f = this.draft.files.find((x) => x.name === name);
    this.draft.files = this.draft.files.filter((x) => x.name !== name);
    if (f) exec("/bin/rm", ["-rf", f.path]);
    cx.notify();
  }

  start(cx) {
    const text = this.input.value().trim();
    if (!text) { this.note = "Write the idea first."; cx.notify(); return; }
    const { id, files } = this.draft;
    const dir = this.dir(id);
    const s = slug(text.split("\n")[0]);
    const repos = [...this.touch];
    const msg = `Idea from Pranav:\n${text}\n\nRepos it touches: ${repos.length ? repos.join(", ") : "not said; work it out from the idea"}.\n` +
      `Task folder: ${dir}. Write PRD.md there.` +
      (files.length ? `\nAttachments (read every one first):\n${files.map((f) => `- ${f.path}`).join("\n")}` : "");
    this.note = "Starting a planner…";
    cx.notify();
    cx.spawn(async (cx) => {
      const w = await exec("/bin/sh", ["-c", 'mkdir -p "$1" && printf "%s\\n" "$2" > "$1/idea.md"', "sh", dir, text]).catch(fail);
      if (w.code !== 0) { this.note = `Not started: ${firstLine(w)}`; cx.notify(); return; }
      const r = await exec(HC, ["run", "--bg", "--no-parent", "--name", `prd-${s}-${id.slice(-4)}`, "--cwd", dir,
        "--label", "prd=1", "--label", `prddir=${dir}`, "--label", "herdr.space=spprd", "--label", `herdr.tab=tbprd-${id}`,
        "planner", msg], { timeout: 60_000 }).catch(fail);
      if (r.code !== 0) { this.note = `Not started: ${firstLine(r)}`; cx.notify(); return; }
      this.input.set_value("");
      this.draft = { id: newId(), files: [] };
      this.note = "";
      this.load(cx);
      this.pick(id, cx);
      // Name its tab and the space once the window has them.
      exec("/bin/sh", ["-c", `for i in 1 2 3 4 5; do "$0" do tab.rename --id "$1" --name "$2" >/dev/null 2>&1 && break; sleep 1; done; ` +
        `"$0" do space.rename --id spprd --name PRDs >/dev/null 2>&1`, HERDR_APP, `tbprd-${id}`, `prd · ${s}`]);
    });
  }

  // ---- the selected PRD ----

  send(cx) {
    const text = this.reply.value().trim();
    const p = this.cur && this.planner(this.cur);
    if (!text || !p) return;
    this.reply.set_value("");
    cx.spawn(async (cx) => {
      const r = await hc(["send", p.address, text]).catch(fail);
      this.note = r.code === 0 ? "Sent ✓" : `Not sent: ${firstLine(r)}`;
      cx.notify();
    });
  }

  // Restart a planner on a PRD whose planner ended, to keep changing it.
  resume(cx) {
    const id = this.cur;
    const dir = this.dir(id);
    cx.spawn(async (cx) => {
      const r = await exec(HC, ["run", "--bg", "--no-parent", "--name", `prd-${id}`, "--cwd", dir,
        "--label", "prd=1", "--label", `prddir=${dir}`, "--label", "herdr.space=spprd", "--label", `herdr.tab=tbprd-${id}`,
        "planner", `Resume the PRD in ${dir}: read idea.md, attachments/ and PRD.md there, then wait for Pranav's changes.`],
        { timeout: 60_000 }).catch(fail);
      this.note = r.code === 0 ? "Planner started ✓" : `Not started: ${firstLine(r)}`;
      cx.notify();
    });
  }

  // One factory builder per chosen repo, backend first, each told to build its part of PRD.md.
  build(cx) {
    const id = this.cur;
    const repos = [...this.buildRepos].sort((a, b) => (b === "revspot-backend") - (a === "revspot-backend"));
    if (!repos.length) { this.note = "Pick the repos to build in."; cx.notify(); return; }
    const prd = `${this.dir(id)}/PRD.md`;
    this.note = `Starting ${repos.length} builder${repos.length > 1 ? "s" : ""}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      const out = [];
      for (const repo of repos) {
        // Each builder gets its own task folder, so their task.md files don't overwrite each other.
        const r = await exec(FACTORY_TASK, ["--task-dir", `${this.dir(id)}/build-${repo}`, repo, this.base(repo),
          `Build the ${repo} part of the PRD at ${prd}. Read the whole PRD first; follow its contract and acceptance criteria.` +
          (repos.length > 1 ? ` Other builders are doing ${repos.filter((x) => x !== repo).join(", ")} from the same PRD: don't start a backend builder; link their PRs in yours if they exist.` : "")],
          { timeout: 120_000 }).catch(fail);
        out.push(r.code === 0 ? `${repo} → ${this.base(repo)} ✓` : `${repo}: ${firstLine(r)}`);
      }
      this.note = `Factory: ${out.join(" · ")}`;
      cx.notify();
    });
  }

  // ---- drawing ----

  button(t, id, text, onClick, solid) {
    return still(h_flex().id(id).px(10).py(4).rounded(6).border_1().cursor_pointer().flex_none()
      .border_color(solid ? t.solid : t.border).bg(solid ? t.solid : t.background)
      .text_color(solid ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(text));
  }

  chip(t, id, text, on, onClick) {
    return still(h_flex().id(id).px(8).py(2).rounded(10).border_1().cursor_pointer()
      .border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.border_color(t.accent)).on_click(onClick).child(text));
  }

  label(t, text) { return div().text_size(11).font_semibold().text_color(t.muted).child(text); }

  intake(t) {
    return v_flex().gap(8)
      .child(this.label(t, "NEW PRD"))
      .child(Textarea.new(this.input).h(140).px(10).py(8).rounded(8).border_1().border_color(t.input)
        .bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .children(this.draft.files.map((f) => h_flex().id(`att-${f.name}`).gap(6).pl(4).pr(8).py(3).rounded(8)
          .border_1().border_color(t.border).bg(t.background).items_center()
          .child(f.isImage ? image(f.rel).w(28).h(28).rounded(4).flex_none()
            : div().w(28).h(28).rounded(4).bg(t.raised).flex_none().flex().items_center().justify_center().child("📄"))
          .child(div().max_w(140).truncate().text_color(t.foreground).child(f.name))
          .child(still(div().id(`detach-${f.name}`).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.blocked))
            .on_click((_e, cx) => this.detach(f.name, cx)).child("×")))))
        .child(still(div().id("attach").text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => cx.spawn(async (cx) => this.attach(await pickFiles({ prompt: "Attach to this PRD", multiple: true }), cx)))
          .child("+ Attach")))
        .child(div().text_color(t.dim).child("or drop files here")))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().text_color(t.dim).child("touches"))
        .children(REPOS.map((repo) => this.chip(t, `touch-${repo}`, repo, this.touch.has(repo), (_e, cx) => {
          this.touch.has(repo) ? this.touch.delete(repo) : this.touch.add(repo);
          localStorage.setItem("prd.repos", JSON.stringify([...this.touch]));
          cx.notify();
        }))))
      .child(h_flex().gap(10).items_center()
        .child(this.button(t, "start", "Write PRD", (cx) => this.start(cx), true))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).text_size(11.5).child("A Sonnet planner reads the code and asks you what it can't tell.")));
  }

  listView(t) {
    const rows = (this.prds ?? []).map((p) => {
      const pl = this.planner(p.id);
      const state = pl?.labels?.ask ? "needs you" : pl ? (pl.status === "working" ? "writing" : "planner open") : p.ready ? "ready" : "no PRD yet";
      const dot = pl?.labels?.ask ? t.blocked : pl?.status === "working" ? t.working : p.ready ? t.done : t.dim;
      return still(h_flex().id(`p-${p.id}`).gap(8).px(6).py(5).rounded(5).items_center().cursor_pointer()
        .when(this.cur === p.id, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.pick(p.id, cx))
        .child(div().size(7).rounded(4).bg(dot).flex_none())
        .child(div().flex_1().truncate().text_color(t.foreground).child(p.title))
        .child(div().flex_none().text_color(t.dim).text_size(11.5).child(state)));
    });
    return v_flex().gap(2).child(this.label(t, "PRDS").pb(2))
      .children(rows.length ? rows : [div().px(6).text_color(t.dim).child(this.prds === null ? "Loading…" : "None yet.")]);
  }

  detail(t, paneOf) {
    if (!this.cur) {
      return v_flex().size_full().items_center().justify_center().gap(6).text_color(t.dim)
        .child(div().text_size(14).child("No PRD selected"))
        .child(div().child("Write an idea on the left, or pick a PRD to read it here."));
    }
    const id = this.cur;
    const p = this.prds?.find((x) => x.id === id);
    const pl = this.planner(id);
    const head = h_flex().gap(10).items_center()
      .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).truncate().child(p?.title ?? id))
      .child(pl ? this.button(t, "tab", "Open planner", () => paneOf.get(pl.address)
          ? run("pane.focus", { pane: paneOf.get(pl.address) }) : run("terminal.peek", { terminal: pl.address }))
        : this.button(t, "resume", "Resume planner", (cx) => this.resume(cx)))
      .when(!!this.text, (el) => el.child(this.button(t, "edit", "Open file", () => exec("open", ["-t", `${this.dir(id)}/PRD.md`]))))
      .when(!!pl, (el) => el.child(this.button(t, "endp", "End planner", (cx) => cx.spawn(async (cx) => {
        const r = await hc(["kill", pl.address]).catch(fail);
        this.note = r.code === 0 ? "Planner ended; the PRD stays." : `Not ended: ${firstLine(r)}`;
        cx.notify();
      }))));

    // The planner's latest screen (its questions) and the box to answer it.
    const talk = pl && v_flex().gap(6).p(10).rounded(8).bg(t.background).border_1()
      .border_color(pl.labels?.ask ? t.blocked : t.border)
      .child(v_flex().gap(1).text_size(11.5).text_color(t.muted).children(
        this.tail.length ? this.tail.map((l, i) => div().id(`tail-${i}`).truncate().child(l))
          : [div().text_color(t.dim).child("Reading its screen…")]))
      .child(Input.new(this.reply).h(30).px(9).rounded(6).border_1().border_color(t.input).bg(t.popover)
        .text_size(12.5).text_color(t.foreground));

    const build = !!this.text && h_flex().gap(6).items_center().flex_wrap()
      .child(div().text_color(t.dim).child("Build in"))
      .children(REPOS.map((repo) => this.chip(t, `b-${repo}`, `${repo} → ${this.base(repo)}`, this.buildRepos.has(repo), (_e, cx) => {
        this.buildRepos.has(repo) ? this.buildRepos.delete(repo) : this.buildRepos.add(repo);
        cx.notify();
      })))
      .child(this.button(t, "build", "Build", (cx) => this.build(cx), true));

    return v_flex().size_full().gap(12)
      .child(head)
      .when(!!this.note, (el) => el.child(div().text_color(/^Not/.test(this.note) ? t.blocked : t.dim).child(this.note)))
      .child(v_flex().flex_1().min_h(0).p(14).rounded(8).bg(t.background).border_1().border_color(t.border).overflow_y_scrollbar()
        .child(this.text ? TextView.markdown(`prd-${id}`, this.text).text_size(13).text_color(t.foreground)
          : div().text_color(t.dim).child(pl ? "The planner is reading the code; PRD.md appears here as it writes it." : "No PRD.md in this folder.")))
      .when(!!talk, (el) => el.child(talk))
      .when(!!build, (el) => el.child(build));
  }

  render() {
    const t = theme();
    const paneOf = new Map(agents().map((a) => [a.address, a.pane]));
    const bar = h_flex().h(40).flex_none().px(16).items_center().gap(12).border_b(1).border_color(t.border).cursor_move()
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("PRDs"))
      .child(div().flex_1().text_color(t.dim).text_size(11.5).child("drag here to move · ⌘⇧R or Esc to hide"))
      .child(this.button(t, "hide", "×", () => this.hide()));
    const left = still(v_flex().w(400).flex_none().h_full().p(16).gap(18).border_r(1).border_color(t.border).overflow_y_scrollbar()
      .child(this.intake(t))
      .when(!this.cur && !!this.note, (el) => el.child(div().text_color(t.blocked).child(this.note)))
      .child(this.listView(t)));
    return v_flex().id("prd-root").size_full().bg(t.popover).text_size(12.5)
      .track_focus(this.handle).on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.hide(); } })
      .on_drop((e, cx) => this.attach(e.paths, cx))
      .child(bar)
      .child(h_flex().flex_1().min_h(0)
        .child(left)
        .child(still(v_flex().flex_1().min_w(0).h_full().p(16).child(this.detail(t, paneOf)))));
  }
}
