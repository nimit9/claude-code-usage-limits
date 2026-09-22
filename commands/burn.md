---
description: "Spend budget that would expire unused: list the backlog, pick what fits the surplus, or arm a wake before the reset"
---

Run, with no arguments meaning `pick`:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/usage-limits/scripts/burn.js" $ARGUMENTS
```

Then do what it prints, and nothing else.

- **A plan** - the numbered list with a budget above it. Do those items, in
  order, starting now. Stop when the window resets or the list ends, whichever
  comes first, and run `burn done <n>` as you finish each one - that ticks the
  line, closes the issue if it was one, and commits when the run is on a branch
  of its own.
- **"No surplus right now"** - say that in one line and stop. Do not go looking
  for something to do instead.
- **"Suggest 3-5 candidates"** - there is budget about to expire and no backlog
  written down. Suggest three to five things from this repository that would
  use it, and **ask before starting any of them**.
- **"No backlog"**, **"Nothing queued"**, **"Armed for ..."** - print the line
  and stop.

Do not start any other work as part of this command. The whole point of it is
that the work it picks was decided in advance, by the user, in a file.

## The other forms

- `list` - the merged backlog with each item's source and size
- `add "<thing>" [--size S|M|L] [--global | --repo <name>]` - write one line
  down. No flag means this repository's `BACKLOG.md`, `--global` means
  `~/.claude/backlog.md`, `--repo` means the same file tagged for that
  repository. It refuses to write a duplicate and says where the item already
  is, so there is never any reason to open the file yourself.
- `done "<thing>" | <n> | --all [--force]` - tick the item off wherever it
  lives, and close its GitHub issue if it was one. It refuses when nothing has
  changed since `pick` printed the plan; `--force` overrides that.
- `pick --unattended` - the form the scheduled wake uses. It refuses a dirty
  working tree or a directory that is not a repository, and works on a
  `burn/<date>-<n>` branch that `done` commits to and never pushes. Do not use
  it by hand.
- `arm [--before 20] [--min-turns 10]` - book a one-shot wake that many minutes
  before the window resets, which will run `pick --unattended` and do exactly
  what it prints
- `cancel` - call that wake off
- `status` - what is armed, and which backlog sources were found

## Where the backlog comes from

Merged in this order, deduplicated by text:

1. `BACKLOG.md` in the current repository
2. `~/.claude/backlog.md` (or `$USAGE_LIMITS_BACKLOG`)
3. Open GitHub issues labelled `burn`, when `gh` is installed and the repository
   is on GitHub

Items are markdown list items. `- [x]` means done and is skipped. A trailing
`~S`, `~M` or `~L` sizes the item in turns (8, 25 and 60 by default; `~M` is the
default). An `@path` in a global item means it belongs to that repository.

`arm` refuses to schedule anything when the backlog is empty, so an unattended
run can only ever do work somebody wrote down beforehand.
