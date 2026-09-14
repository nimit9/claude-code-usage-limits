---
description: Put this work off until a time you name, and start nothing now
---

Do not start the work in this message. Schedule it, confirm in one line, and stop.

Run, from the plugin's skill directory:

```
node skills/usage-limits/scripts/defer.js "$ARGUMENTS" --work "<the work, one item per line>"
```

Where `$ARGUMENTS` is the time the user gave. Accepted forms:

- `9:50pm`, `21:50`, `9pm`, `09:05` - a clock time. A time already past today
  means tomorrow.
- `in 90m`, `in 2h`, `in 45 minutes`
- `reset` - when the binding usage window resets, plus a few minutes for the
  meter to turn over

Pass the work itself in `--work`: the list of things the user asked for, one per
line, written so a session with none of this conversation's context can act on
it. That text is saved to disk and handed to the run when it fires. If the user
gave no list, summarise the pending work from this session instead.

Then print the single line the script returns and **write nothing else**. Do not
start any of the work, do not read files "to prepare", do not draft a plan in
the reply. The whole point of the command is that this turn is cheap and
nothing happens yet.

Other forms:

- `node skills/usage-limits/scripts/defer.js status` - what is deferred and when
  it fires
- `node skills/usage-limits/scripts/defer.js cancel` - call it off

## What actually happens

The work is saved as a continuation and a real scheduled task is registered
(Windows Task Scheduler, or `at`/launchd elsewhere). At the named time the same
wake script the usage relay uses starts a fresh session in the original
directory and hands it the saved plan. If the launch fails - a machine whose
network is not up yet is the common one - it retries rather than giving up.

If the time is unreadable or ambiguous, the script refuses and says so. It never
picks a reading: a deferral that fires at the wrong hour while nobody is awake
is worse than one that was never set.
