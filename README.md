# herdr setup

My [Herdr](https://herdr.dev) setup: the desktop app's look and mods, the named agent team that runs in
herdr-core (`hc`), and the software factory that turns a typed task into a draft PR.

| Folder | Goes to | What it is |
| --- | --- | --- |
| `herdr-app/` | `~/.config/herdr-app/` | Layouts (`batman`, `traveler`, `my-traveler`, `transparent`), themes, keys, settings, and my own mods (Batman sidebar and agents, Traveler chrome, inbox, and the `factory` board) |
| `herdr-core/` | `~/.config/herdr-core/` | The agent team: `team.md` (roster and rules), one template per agent, the `builder` template the factory uses, and workflow folders |
| `herdr-tui/` | `~/.config/herdr/` | The terminal version's config and done sound |
| `bin/` | `~/.local/bin/` | `hc-team` (starts the named agents), `factory-task` (starts a builder for one task), `factory-clean` (cleans up after builders) |

Copy each folder to where it goes. herdr-app reloads layouts, keys and mods as they change.

## Software factory

Two floating windows in herdr-app. Typed ideas become PRDs; typed tasks (or PRDs) become one-commit draft PRs,
each built by its own agent in its own git worktree, so your normal sessions are never touched.

| Piece | File | What it does |
| --- | --- | --- |
| PRD writer (⌘⇧R) | `herdr-app/mods/prd/` | Idea + attachments + repos → starts a `planner`, shows `PRD.md` live, answer its questions, **Build** hands it to the factory (one builder per repo, backend first) |
| Factory board (⌘⇧F) | `herdr-app/mods/factory/` | Task + attachments + repo + base branch → **Build now**; pause / play / interrupt / instruct / open / end builders; your open PRs with a built-in PR viewer (description, checks, diff, Ready for review) |
| `planner` | `herdr-core/templates/planner.md` | Sonnet agent: reads the repos (never edits), asks at most 3 questions, writes `PRD.md` |
| `builder` | `herdr-core/templates/builder.md` | Implements one task in its worktree, runs checks, one clean commit, draft PR into the chosen base, labels `pr=<url>`; stops with an `ask` label when unsure |
| `factory-task` | `bin/factory-task` | `factory-task [--task-dir DIR] <repo> <base> "<task>"`: worktree + `factory/<slug>-<id>` branch cut from `origin/<base>`, starts a builder in its own tab of a Factory space |
| `factory-clean` | `bin/factory-clean` | `--end <builder>` stops it and removes its worktree and branch; with no args, clears builders whose PR is merged or closed |
| Hotkeys | `herdr-app/keys.json` | `cmd-shift-f` → `mod.open:factory`, `cmd-shift-r` → `mod.open:prd` |

### Set it up

Needs herdr-app, herdr-core (`hc`), Claude Code, `gh` (logged in), git.

1. Copy `herdr-app/mods/{factory,prd}` to `~/.config/herdr-app/mods/`, and the two hotkeys into your `keys.json`.
2. Copy `herdr-core/templates/{builder,planner}.md` to `~/.config/herdr-core/templates/`.
3. Copy `bin/factory-task` and `bin/factory-clean` to `~/.local/bin/` and `chmod +x` them.
4. Edit for your machine: the repo list and base branches (`REPOS`, `BASES` at the top of both mods' `main.js`),
   the repos root and GitHub org (`revspot`) in `factory-task`, `factory-clean`, the mods and the templates,
   and the test commands in `builder.md` step 6.
5. Press ⌘⇧F, type a task, pick repo and base, Build now. Data lives under `~/.config/herdr-app/data/{factory,prd}/`.

Paths in the scripts and templates are for this machine (`/Users/pranav/...`): change them to match yours.
