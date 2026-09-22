---
name: backlog
description: "Write something down for later instead of dropping it. Use whenever the user says add to the backlog, note that for later, we should eventually, remember to, let's do that another time, or file that - and whenever you find work you cannot finish now (out of scope, out of budget, blocked, a TODO you had to leave) and would otherwise only mention in passing. Also for showing the backlog, ticking an item off, or spending spare usage budget on it."
---

# Backlog

One line, one command. The script decides which file it belongs in, whether it
is already written down, and whether anything actually happened before an item
is ticked off - so never edit `BACKLOG.md` or `~/.claude/backlog.md` by hand.

| Do this | Run |
| --- | --- |
| Note something for this repo | `claude-usage-limits burn add "<thing>" --size S\|M\|L` |
| Note something for everywhere | `claude-usage-limits burn add "<thing>" --global` |
| Note something for another repo | `claude-usage-limits burn add "<thing>" --repo <name>` |
| Show what is on the list | `claude-usage-limits burn list` |
| Tick one off | `claude-usage-limits burn done "<thing>"` (or its number, or `--all`) |
| Spend budget that is about to expire | `claude-usage-limits burn pick` |

No flag means this repository; `--global` and `--repo` both mean
`~/.claude/backlog.md`, tagged in the second case so it surfaces there.
`--size` defaults to `M` (S is a quick fix, L is an afternoon).

The command prints the line it wrote and where it wrote it, or says the item
was already on the list. Say that back in one line and carry on; do not open
the file to check.

If `claude-usage-limits` is not on PATH, run the same arguments through
`node ~/.claude/plugins/cache/usage-limits/usage-limits/skills/usage-limits/scripts/burn.js`
(or `"${CLAUDE_PLUGIN_ROOT}/skills/usage-limits/scripts/burn.js"` inside the
plugin).
