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

Press ⌘⇧F in herdr-app to open the board. Type a task, pick the repo and the branch the PR should go to,
and press Enter. `factory-task` makes a git worktree on a new branch cut from that base and starts a
`builder` agent there, in its own tab in a Factory space. The builder implements the change, runs the checks,
and opens a one-commit draft PR. On the board you can pause, play, interrupt or instruct a builder, open its
tab or PR, or end it. End stops it and removes its worktree and local branch.

Paths in the scripts and templates are for this machine (`/Users/pranav/...`): change them to match yours.
