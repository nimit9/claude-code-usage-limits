'use strict';

// Carrying a project across the reset.
//
// The old shape of the last hour before a limit was: notice the wall, write a
// plan, stop. The plan then sat in a dead terminal until somebody came back and
// read it. Everything the session knew - the files it had open, the half-made
// decision, the reason the second approach was abandoned - went with the
// window.
//
// The relay is the other half of that handoff. While there is still budget it
// arms a one-shot wake a few minutes after the window resets, and at that
// moment it hands the stored continuation back to the same conversation. The
// arming costs nothing and changes nothing about the work in progress; that is
// the point. Nobody should slow down to prepare for a wall.
//
// What this is NOT: a way to run an agent the user did not ask for. It is off
// until switched on, it only arms while there is a plan or a todo list to carry
// (an idle chat is not a project), and its default delivery is a notification,
// not a launch. Nothing here starts work unattended unless somebody chose that
// outright.
//
// Claude Code has its own version of this - autoContinueAtUsageLimit waits
// inside an open session and continues when the limit lifts - and where that
// applies it is better, because the process never dies. It is documented not to
// offer the wait for -p runs or background sessions, and it cannot help a
// terminal that has been closed, a machine that slept, or Codex. It also sends
// a fixed prompt of its own rather than the plan the session actually wrote.
// That is the gap this fills, and the reason it defers: when the native wait is
// what fired, the relay stands down.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const host = require('./host.js');
const voice = require('./voice.js');

const MINUTE = 60 * 1000;

const DEFAULTS = {
  // Off. Scheduling an agent to run while nobody is watching is a decision
  // somebody has to make on purpose.
  enabled: false,
  // Where the safety net goes up. Not a wall and not a warning: at this point
  // the session carries on exactly as before, and a wake is prepared in case
  // the budget runs out before the work does.
  at: 75,
  // Long enough after the reset that the meter has actually turned over. The
  // endpoint's reset time is the moment the window opens, and a request one
  // second later has been refused before.
  graceMinutes: 5,
  // notify  - raise a toast and leave the continuation on disk (default)
  // resume  - hand the continuation back to the conversation itself
  mode: 'notify',
  // off | resume | always. Only the middle one is free: 'always' changes a
  // Claude Code setting, and says so.
  thinking: 'resume',
  // Not restored by --resume. Whatever was in force in the session is gone at
  // wake time, so it is stated or the resumed run sits waiting for a person.
  permissionMode: null,
  model: null,
  // If the reading says the window has not turned over yet, try again this
  // many times before giving up and leaving a note.
  attempts: 3,
  // What to do when the user is at the keyboard when the wake fires. Their
  // session is the one that matters; a second agent in the same directory is
  // a way to lose work.
  whenBusy: 'notify',
  // WHERE IN THE TURN the arming happens.
  //
  //   threshold  the moment the window crosses `at`, which is mid-reply. What
  //              gets carried is whatever state the reply happened to be in.
  //   completion the end of the reply. The work has reached a boundary, the
  //              todo list is current, and the continuation describes
  //              something finished rather than something interrupted.
  //
  // 'completion' is the default because the difference is not cosmetic: a
  // continuation captured halfway through a tool call describes a state the
  // next session cannot resume from cleanly.
  armOn: 'completion',
  // The exception to waiting for a boundary. Past this, arm immediately
  // whatever the turn is doing - a relay that politely waits for a completion
  // that never comes, because the limit cut the reply off mid-sentence, is a
  // relay that was never armed at all.
  backstopAt: 95,
  // Being offline is not failing. These are the retries reserved for a machine
  // that cannot reach the API, and the minutes between them. Twelve at ten
  // minutes covers two hours of a router being off, which is the common case.
  offlineAttempts: 12,
  offlineRetryMinutes: 10,
  // Run the resumed session in a window you can see. Invisible is tidier and
  // it is also how you find out in the morning that nothing happened and have
  // no idea why.
  show: true,
  // What happens after a wake fails for a reason that will not fix itself:
  // arm again for the next window, or stop and leave it to a person.
  onFailure: 'rearm',
  // And how many times it may do that. Without a cap, "arm again for the next
  // window" is a scheduled task that reschedules itself forever, which is a
  // worse failure than giving up: it is invisible, it never ends, and nobody
  // asked for it. Two rearms means the work gets three windows to happen in.
  maxRearms: 2,
  // Keep the full stdout and stderr of every resumed run on disk. It is the
  // only record of what happened while nobody was watching.
  runLog: true,
};

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function relayFile() {
  return path.join(configDir(), 'usage-limits-relay.json');
}

function logFile() {
  return path.join(configDir(), 'usage-limits-relay.log');
}

// Every resumed run's full output, kept per run. `relay log --run` reads the
// newest one back. Without this a failed overnight wake leaves one line in the
// note log and nothing to diagnose it with.
function runLogDir() {
  return path.join(configDir(), 'relay-runs');
}

function runLogFile(id, now) {
  const stamp = new Date(Number.isFinite(now) ? now : Date.now()).toISOString().replace(/[:.]/g, '-');
  return path.join(runLogDir(), String(id).slice(0, 8) + '-' + stamp + '.log');
}

function writeRunLog(file, text) {
  try {
    fs.mkdirSync(runLogDir(), { recursive: true });
    fs.writeFileSync(file, String(text == null ? '' : text), 'utf8');
    // Ten runs is more history than anyone reads and less than a directory
    // nobody ever cleans.
    const kept = fs.readdirSync(runLogDir()).filter((name) => name.endsWith('.log')).sort();
    for (const stale of kept.slice(0, Math.max(0, kept.length - 10))) {
      try {
        fs.unlinkSync(path.join(runLogDir(), stale));
      } catch (err) {
        // A log that will not delete is not worth a failed wake.
      }
    }
    return file;
  } catch (err) {
    return null;
  }
}

function latestRunLog() {
  try {
    const names = fs.readdirSync(runLogDir()).filter((name) => name.endsWith('.log')).sort();
    if (!names.length) return null;
    const file = path.join(runLogDir(), names[names.length - 1]);
    return { file, text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    return null;
  }
}

function planFile(id) {
  return path.join(configDir(), 'usage-limits-relay-' + String(id).replace(/[^A-Za-z0-9_-]/g, '') + '.md');
}

function note(line, now) {
  try {
    fs.appendFileSync(logFile(), new Date(Number.isFinite(now) ? now : Date.now()).toISOString() + '  ' + line + '\n');
  } catch (err) {
    // A log that cannot be written must not stop the thing it is logging.
  }
}

function empty() {
  return { version: 1, config: {}, armed: null, history: [] };
}

function read() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(relayFile(), 'utf8'));
  } catch (err) {
    return empty();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty();
  return {
    version: 1,
    config: parsed.config && typeof parsed.config === 'object' && !Array.isArray(parsed.config) ? parsed.config : {},
    armed: parsed.armed && typeof parsed.armed === 'object' && !Array.isArray(parsed.armed) ? parsed.armed : null,
    history: Array.isArray(parsed.history) ? parsed.history.slice(-10) : [],
  };
}

// Written to a sibling and renamed into place. Two hooks can run at once, and a
// reader that lands between the truncate and the write of a plain writeFileSync
// sees half a file; the rename is the only step another process can observe.
function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function write(state) {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    writeAtomic(relayFile(), JSON.stringify(state, null, 2) + '\n');
    return true;
  } catch (err) {
    return false;
  }
}

// File first, then environment, then the defaults. The environment wins over
// the file so a single run can be steered without editing anything, which is
// also how every other setting in this plugin behaves.
function settings(state) {
  const held = state || read();
  const env = process.env;
  const stored = held.config || {};
  const bool = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const text = String(value).toLowerCase();
    if (['1', 'on', 'true', 'yes'].includes(text)) return true;
    if (['0', 'off', 'false', 'no'].includes(text)) return false;
    return fallback;
  };
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const pick = (value, allowed, fallback) => {
    const text = value === undefined || value === null ? '' : String(value).toLowerCase();
    return allowed.includes(text) ? text : fallback;
  };
  return {
    enabled: bool(env.USAGE_LIMITS_RELAY, bool(stored.enabled, DEFAULTS.enabled)),
    at: Math.min(99, Math.max(10, number(env.USAGE_LIMITS_RELAY_AT, number(stored.at, DEFAULTS.at)))),
    graceMinutes: Math.min(180, Math.max(1, number(env.USAGE_LIMITS_RELAY_GRACE, number(stored.graceMinutes, DEFAULTS.graceMinutes)))),
    mode: pick(env.USAGE_LIMITS_RELAY_MODE, ['notify', 'resume'], pick(stored.mode, ['notify', 'resume'], DEFAULTS.mode)),
    thinking: pick(env.USAGE_LIMITS_RELAY_THINKING, ['off', 'resume', 'always'], pick(stored.thinking, ['off', 'resume', 'always'], DEFAULTS.thinking)),
    permissionMode: typeof stored.permissionMode === 'string' ? stored.permissionMode : DEFAULTS.permissionMode,
    model: typeof stored.model === 'string' ? stored.model : DEFAULTS.model,
    attempts: Math.min(10, Math.max(1, number(stored.attempts, DEFAULTS.attempts))),
    whenBusy: pick(stored.whenBusy, ['notify', 'resume'], DEFAULTS.whenBusy),
    armOn: pick(env.USAGE_LIMITS_RELAY_ARM_ON, ['threshold', 'completion'], pick(stored.armOn, ['threshold', 'completion'], DEFAULTS.armOn)),
    backstopAt: Math.min(100, Math.max(10, number(stored.backstopAt, DEFAULTS.backstopAt))),
    offlineAttempts: Math.min(48, Math.max(1, number(stored.offlineAttempts, DEFAULTS.offlineAttempts))),
    offlineRetryMinutes: Math.min(120, Math.max(2, number(stored.offlineRetryMinutes, DEFAULTS.offlineRetryMinutes))),
    show: bool(stored.show, DEFAULTS.show),
    onFailure: pick(stored.onFailure, ['rearm', 'stop'], DEFAULTS.onFailure),
    maxRearms: Math.min(10, Math.max(0, number(stored.maxRearms, DEFAULTS.maxRearms))),
    runLog: bool(stored.runLog, DEFAULTS.runLog),
  };
}

function configure(changes) {
  const state = read();
  state.config = Object.assign({}, state.config, changes || {});
  write(state);
  return settings(state);
}

/* ------------------------------------------------------ is there work? ---- */

// A relay for a conversation with nothing outstanding is a scheduled agent
// with nothing to do, which is the exact thing this must never become. The
// evidence has to come from the session itself, so it is read out of the
// transcript: a todo list with anything unfinished, or a plan that was
// approved. Both are things the user asked for.
const TAIL_BYTES = 512 * 1024;

function transcriptTail(file, bytes) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const want = Math.min(size, bytes || TAIL_BYTES);
    const buffer = Buffer.alloc(want);
    fs.readSync(handle, buffer, 0, want, size - want);
    return buffer.toString('utf8');
  } catch (err) {
    return '';
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch (err) {
        // Nothing useful to do about a handle that will not close.
      }
    }
  }
}

function detectWork(transcriptPath, options) {
  const out = { todos: [], pending: 0, plan: null, hasWork: false, source: null };
  if (!transcriptPath) return out;
  const text = transcriptTail(transcriptPath, options && options.bytes);
  if (!text) return out;
  const lines = text.split('\n');
  // Read backwards: the newest todo list is the only one that describes now.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.charAt(0) !== '{') continue;
    if (out.todos.length === 0 && line.indexOf('"TodoWrite"') === -1 && line.indexOf('"ExitPlanMode"') === -1) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      continue;
    }
    const content = event && event.message && Array.isArray(event.message.content) ? event.message.content : [];
    for (const part of content) {
      if (!part || part.type !== 'tool_use' || !part.input) continue;
      if (part.name === 'TodoWrite' && Array.isArray(part.input.todos) && !out.todos.length) {
        out.todos = part.input.todos
          .filter((todo) => todo && typeof todo.content === 'string')
          .map((todo) => ({ content: todo.content, status: String(todo.status || 'pending') }));
        out.source = 'todos';
      }
      if (part.name === 'ExitPlanMode' && typeof part.input.plan === 'string' && !out.plan) {
        out.plan = part.input.plan.slice(0, 4000);
        if (!out.source) out.source = 'plan';
      }
    }
    if (out.todos.length && out.plan) break;
  }
  out.pending = out.todos.filter((todo) => todo.status !== 'completed').length;
  out.hasWork = out.pending > 0 || Boolean(out.plan);
  return out;
}

/* --------------------------------------------------- what gets handed on -- */

// The continuation the session wrote itself, stored by the /usage-limits:relay
// note command. This is the good case: a paragraph from the session that knows
// what it was doing beats anything reconstructed from a todo list.
// The continuation is delivered on stdin now (wake.js), where the cap is
// 10 MB, so the old 8,000-character slice was a leftover from the argv era -
// and a silent one: a plan that ran long simply lost its tail. 64 KB is more
// than any note needs and small enough that a runaway write cannot fill a
// disk.
const CONTINUATION_MAX = 65536;

// `options.force` is the only way to write ANOTHER session's armed
// continuation. On 2026-09-14 a session wrote its note to whatever record was
// armed without checking whose it was; the armed record belonged to a peer,
// and the peer's 343-byte handoff was replaced with 3 KB of somebody else's
// plan minutes before it was due to fire. One machine has one relay, so
// displacement is normal - but a session may only overwrite a different
// session's plan on purpose, never by default.
function saveContinuation(id, text, options) {
  const body = String(text || '').slice(0, CONTINUATION_MAX).trim();
  if (!body) return null;
  const me = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const armedNow = read().armed;
  if (armedNow && armedNow.id === id && me && me !== id && !(options && options.force)) {
    note('refused to overwrite the armed continuation of ' + id + ' from session ' + me + ' (pass force to do it on purpose)');
    return null;
  }
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(planFile(id), body + '\n');
  } catch (err) {
    return null;
  }
  const state = read();
  if (state.armed && state.armed.id === id) {
    state.armed.continuation = true;
    state.armed.continuationAt = Date.now();
    write(state);
  }
  return planFile(id);
}

function readContinuation(id) {
  try {
    return fs.readFileSync(planFile(id), 'utf8').trim();
  } catch (err) {
    return '';
  }
}

// The prompt that restarts the work.
//
// Written the way the user writes, because it is delivered as if it came from
// them and a form letter gets a form letter back. Written in the imperative,
// because a resumed session that opens by asking what to do has wasted the
// wake it was given.
function compose(input) {
  const parts = [];
  const options = input || {};
  if (options.thinking) parts.push('ultrathink');
  parts.push(
    'The usage window has reset and this is the plugin picking the work back up, not a new request. ' +
      'Carry on from where the last turn stopped, at full quality, without re-asking what to do.'
  );
  const continuation = String(options.continuation || '').trim();
  if (continuation) {
    parts.push('This is what the session left for itself:\n\n' + continuation);
  }
  const work = options.work;
  if (work && work.todos && work.todos.length) {
    const outstanding = work.todos.filter((todo) => todo.status !== 'completed');
    if (outstanding.length) {
      parts.push(
        'Still outstanding when the budget ran out:\n' +
          outstanding.map((todo) => '- ' + todo.content + (todo.status === 'in_progress' ? ' (was mid-change)' : '')).join('\n')
      );
    }
  }
  if (!continuation && work && work.plan) {
    parts.push('The plan that was approved:\n\n' + work.plan);
  }
  parts.push('Verify anything that was mid-change before building on it: the last turn may have been cut off part-way through an edit.');
  const card = options.voice;
  if (card) parts.push('When you write back to the user, this is how they write:\n' + card);
  return parts.join('\n\n');
}

/* ------------------------------------------------------------ machinery --- */

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch (err) {
      // Try the next one.
    }
  }
  return null;
}

// Codex installs itself into a content-addressed folder that changes with
// every update, so the path is discovered rather than remembered.
function findCodex(env) {
  const environment = env || process.env;
  if (environment.CODEX_CLI_PATH) return firstExisting([environment.CODEX_CLI_PATH]);
  const local = environment.LOCALAPPDATA;
  if (local) {
    const bin = path.join(local, 'OpenAI', 'Codex', 'bin');
    try {
      const found = fs
        .readdirSync(bin)
        .map((entry) => path.join(bin, entry, process.platform === 'win32' ? 'codex.exe' : 'codex'))
        .filter((file) => {
          try {
            fs.accessSync(file);
            return true;
          } catch (err) {
            return false;
          }
        })
        .sort();
      if (found.length) return found[found.length - 1];
    } catch (err) {
      // Not installed there.
    }
  }
  return firstExisting([
    path.join(os.homedir(), '.codex', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
  ]);
}

function findClaude(env) {
  const environment = env || process.env;
  if (environment.USAGE_LIMITS_CLAUDE_CLI) return firstExisting([environment.USAGE_LIMITS_CLAUDE_CLI]);
  if (process.platform === 'win32') {
    const found = firstExisting([
      environment.APPDATA ? path.join(environment.APPDATA, 'npm', 'claude.cmd') : null,
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    ]);
    if (found) return found;
  }
  return firstExisting([
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
  ]);
}

// Computer Use, if the user installed it. The relay uses it for one thing:
// asking whether somebody is at the machine before starting an agent in the
// directory they might be working in. It is never used to type into a
// terminal - that plugin refuses to send input to a shell or an editor on
// purpose, and routing around a safety rule because it is inconvenient is how
// safety rules stop meaning anything.
function findComputerUse(env) {
  const environment = env || process.env;
  if (environment.USAGE_LIMITS_COMPUTER_USE) return firstExisting([environment.USAGE_LIMITS_COMPUTER_USE]);
  const roots = [
    path.join(configDir(), 'plugins', 'cache', 'computer-use', 'computer-use'),
    path.join(os.homedir(), '.claude', 'plugins', 'cache', 'computer-use', 'computer-use'),
  ];
  for (const root of roots) {
    let versions;
    try {
      versions = fs.readdirSync(root).sort();
    } catch (err) {
      continue;
    }
    for (const version of versions.reverse()) {
      const cli = path.join(root, version, 'tools', 'cli.mjs');
      try {
        fs.accessSync(cli);
        return cli;
      } catch (err) {
        // Keep looking.
      }
    }
  }
  return null;
}

function capabilities(env) {
  return {
    claude: findClaude(env),
    codex: findCodex(env),
    computerUse: findComputerUse(env),
    node: process.execPath,
  };
}

// The wake time: the moment the window opens, plus enough slack that the meter
// has really turned over.
function wakeAt(resetsAt, graceMinutes, now) {
  // Number(null) is 0 and Number('') is 0, and a wake booked for the epoch
  // plus five minutes is a wake booked for right now. A missing reset time has
  // to read as missing.
  if (resetsAt === null || resetsAt === undefined || resetsAt === '') return null;
  const reset = Number(resetsAt);
  if (!Number.isFinite(reset)) return null;
  const at = reset + Math.max(1, graceMinutes) * MINUTE;
  const floor = (Number.isFinite(now) ? now : Date.now()) + MINUTE;
  return Math.max(at, floor);
}

// One name per WAKE, not one per session.
//
// Reusing a name entangles every registration with the previous one's fate,
// and all of it is undocumented: whether -Force truly replaces a stale
// definition, what happens when a name is re-registered while its predecessor
// is pending expiry-deletion, and whether an old EndBoundary survives the
// update. On top of that MultipleInstances defaults to IgnoreNew, so a
// previous run still held open by the four-hour execution limit silently
// swallows the next launch.
//
// A unique suffix removes all of it at once, and lets DeleteExpiredTaskAfter
// do what it should: each fired wake garbage-collects itself. cancelSchedule
// works off the stored name, so nothing downstream changes.
function taskName(id, at) {
  const stamp = Number.isFinite(at) ? at : Date.now();
  return (
    'UsageLimitsRelay-' +
    String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) +
    '-' +
    stamp.toString(36)
  );
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// One argument, quoted the way CommandLineToArgvW will unquote it. The rule
// that matters and that a naive version misses: a backslash is only an escape
// when it precedes a quote, so a run of backslashes before the closing quote
// has to be doubled or the quote is eaten - which is exactly what a config
// directory ending in a backslash did to the wake's command line.
function winArg(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) return text;
  let out = '"';
  let slashes = 0;
  for (const ch of text) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(slashes) + ch;
    }
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

function two(value) {
  return String(value).padStart(2, '0');
}

// Registered through the ScheduledTasks module rather than schtasks.exe, for
// one reason that matters: a schtasks /V1 one-shot cannot carry
// StartWhenAvailable, so a machine asleep at the trigger moment misses the run
// silently and forever. -StartWhenAvailable makes it fire on wake instead,
// which is the whole difference between a relay and a coin toss. schtasks is
// still the fallback for a box where the module is missing.
// The two registrations below are bounded by the caller's deadline, not by a
// fixed figure: from inside a hook there may be a few seconds left, from the
// command line there are as many as it takes. Measured once at 38 seconds
// worst case when both spawns waited their full fixed timeouts, inside a hook
// that is killed at ten.
function remainingMs(deadline, ceiling) {
  const left = Number.isFinite(deadline) ? deadline - Date.now() : ceiling;
  return Math.max(0, Math.min(ceiling, left));
}

// Does Windows agree that this task will run?
//
// `state` and `next` come straight from Get-ScheduledTask and
// Get-ScheduledTaskInfo. A task can register cleanly and still never fire,
// and each of these has been seen: Disabled by policy or by an earlier
// failure; NextRunTime empty because the trigger time had already passed by
// the time it was written; NextRunTime set to something other than what was
// asked for, meaning the trigger did not take. None of them raised an error
// before, so the relay reported an armed wake and nothing happened.
function verifyRegistration(state, next, wanted, now) {
  const said = String(state || '').trim();
  if (/disabled/i.test(said)) {
    return { ok: false, error: 'the scheduled task registered but is Disabled, so it will not run' };
  }
  const text = String(next || '').trim();
  if (!text) {
    return { ok: false, error: 'the scheduled task registered but Windows reports no next run time, so it will not fire' };
  }
  // It has to LOOK like a timestamp before it is read as one.
  //
  // Date.parse is far too willing: Date.parse("12345") is the year 12345, which
  // is finite, comfortably in the future, and would sail through every check
  // below. This function exists to refuse a task that will not fire, so
  // accepting garbage as proof that one will is the worst failure it has.
  // PowerShell's .ToString("s") is always yyyy-MM-ddTHH:mm:ss; anything else is
  // not an answer to the question that was asked.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(text)) {
    return { ok: false, error: 'could not read the next run time Windows reported: ' + text };
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) {
    return { ok: false, error: 'could not read the next run time Windows reported: ' + text };
  }
  if (at <= now) {
    return { ok: false, error: 'the scheduled task next run time is already in the past' };
  }
  // Five minutes of slack: Task Scheduler rounds to the minute and a trigger
  // can be nudged. Anything further out is a different time from the one asked
  // for, which means the trigger did not take.
  if (Number.isFinite(wanted) && Math.abs(at - wanted) > 5 * 60 * 1000) {
    return {
      ok: false,
      error: 'the scheduled task is set for ' + new Date(at).toISOString() + ', not the requested ' + new Date(wanted).toISOString(),
    };
  }
  return { ok: true, nextRun: at };
}

function scheduleWindows(when, argv, name, cwd, deadline) {
  let lastVerifyError = null;
  const date = new Date(when);
  const stamp =
    date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate()) + ' ' +
    two(date.getHours()) + ':' + two(date.getMinutes()) + ':' + two(date.getSeconds());
  const argument = argv.map(winArg).join(' ');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$action = New-ScheduledTaskAction -Execute ' + psQuote(process.execPath) +
      ' -Argument ' + psQuote(argument) + ' -WorkingDirectory ' + psQuote(cwd || os.homedir()),
    '$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date ' + psQuote(stamp) + ')',
    // A one-shot task does not remove itself. Without an expiry, every relay
    // leaves a dead entry in Task Scheduler forever; the wake also unregisters
    // itself when it finishes, and this is what catches the wakes that never
    // get to run at all.
    // "zzz" is load-bearing. EndBoundary is documented as
    // YYYY-MM-DDTHH:MM:SS(+-)HH:MM, and .ToString("s") emits no offset at
    // all. A boundary written without one can be read as UTC, which west of
    // Greenwich puts it HOURS IN THE PAST - so the task is born expired,
    // never fires, and DeleteExpiredTaskAfter quietly reaps it. None of that
    // raises an error: registration returns SCHED_S_SOME_TRIGGERS_FAILED
    // (0x0004131B), which is a SUCCESS code, so PowerShell never throws and
    // the relay reported a wake that could not happen.
    '$trigger.EndBoundary = (Get-Date ' + psQuote(stamp) + ').AddHours(12).ToString("yyyy-MM-ddTHH:mm:sszzz")',
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries ' +
      '-DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 4) ' +
      '-DeleteExpiredTaskAfter (New-TimeSpan -Minutes 10)',
    'Register-ScheduledTask -TaskName ' + psQuote(name) + ' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null',
    // Ask Windows whether it will actually fire, rather than trusting that a
    // registration which did not throw is a wake that will happen.
    //
    // This is the difference between "it said it would restart at 4:30 and
    // nothing happened" and an error at arming time. Register-ScheduledTask
    // reports success for a task that will never run: a trigger already in the
    // past, a task left Disabled, a name whose previous registration is still
    // being torn down. NextRunTime is the only field that answers the question
    // actually being asked.
    '$info = Get-ScheduledTaskInfo -TaskName ' + psQuote(name) + ' -ErrorAction SilentlyContinue',
    '$state = (Get-ScheduledTask -TaskName ' + psQuote(name) + ' -ErrorAction SilentlyContinue).State',
    '$next = ""',
    'if ($info -and $info.NextRunTime) { $next = $info.NextRunTime.ToString("s") }',
    'Write-Output ("registered|" + $state + "|" + $next)',
  ].join('\n');
  const file = path.join(os.tmpdir(), name + '.ps1');
  try {
    fs.writeFileSync(file, script, 'utf8');
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: Math.max(500, remainingMs(deadline, 8000)),
    });
    const registered = (run.stdout || '').match(/registered\|([^|\r\n]*)\|([^\r\n]*)/);
    if (run.status === 0 && registered) {
      const verdict = verifyRegistration(registered[1], registered[2], when, Date.now());
      if (verdict.ok) return { ok: true, how: 'ScheduledTasks', nextRun: verdict.nextRun };
      // Registered but it will not fire. Fall through to schtasks rather than
      // reporting a wake that is not going to happen.
      lastVerifyError = verdict.error;
    }
    // No time left for a second attempt is a plain refusal, not a hung hook.
    if (remainingMs(deadline, 8000) < 1500) return { ok: false, error: 'no time left in this hook to register the wake; it will arm on the next prompt' };
    // schtasks cannot express StartWhenAvailable, so this path is a worse
    // guarantee and says so rather than pretending the two are the same.
    const fallback = spawnSync(
      'schtasks.exe',
      ['/Create', '/TN', name, '/TR', '"' + process.execPath + '" ' + argument, '/SC', 'ONCE',
        '/ST', two(date.getHours()) + ':' + two(date.getMinutes()),
        '/SD', two(date.getMonth() + 1) + '/' + two(date.getDate()) + '/' + date.getFullYear(),
        '/IT', '/Z', '/F'],
      { encoding: 'utf8', windowsHide: true, timeout: Math.max(500, remainingMs(deadline, 8000)) }
    );
    if (fallback.status === 0) return { ok: true, how: 'schtasks', warning: 'a sleeping machine will miss this wake' };
    // Both paths failed. If the PowerShell one registered something that
    // will not fire - or will fire at the wrong time - leaving it behind is
    // an orphan that nothing tracks and nothing cancels.
    if (lastVerifyError) {
      try {
        cancelSchedule(name);
      } catch (err) {
        // Nothing further to do; the expiry is the backstop.
      }
    }
    return { ok: false, error: (lastVerifyError || run.stderr || fallback.stderr || 'could not register a scheduled task').trim().split('\n')[0] };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      // Leaving a script behind in the temp directory is not worth reporting.
    }
  }
}

function schedulePosix(when, argv, name, cwd) {
  const seconds = Math.max(60, Math.round((when - Date.now()) / 1000));
  // `at` is the right tool and is absent on most desktops now. A detached
  // sleeper is second best: it survives the terminal closing, but not a
  // reboot, and the status line says so.
  const command = [process.execPath].concat(argv).map((value) => "'" + String(value).replace(/'/g, "'\\''") + "'").join(' ');
  const at = spawnSync('sh', ['-c', 'command -v at >/dev/null 2>&1 && echo yes || echo no'], { encoding: 'utf8' });
  if ((at.stdout || '').trim() === 'yes') {
    const minutes = Math.max(1, Math.round(seconds / 60));
    const run = spawnSync('sh', ['-c', 'echo ' + JSON.stringify(command) + ' | at now + ' + minutes + ' minutes'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    // macOS ships `at` but launchd leaves atrun DISABLED by default, so the
    // command succeeds, prints a job id, and the wake never fires. Reporting
    // ok for that is worse than not having it: it is a silent no-op that looks
    // like a scheduled wake. Fall through to the sleeper, which at least runs.
    if (run.status === 0 && process.platform !== 'darwin') return { ok: true, how: 'at' };
  }
  try {
    const child = spawn('sh', ['-c', 'sleep ' + seconds + ' && ' + command], {
      detached: true,
      stdio: 'ignore',
      cwd: cwd || os.homedir(),
    });
    child.unref();
    return { ok: true, how: 'sleeper', warning: 'a reboot before the reset will cancel this wake', pid: child.pid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function schedule(when, argv, name, cwd, deadline) {
  if (process.platform === 'win32') return scheduleWindows(when, argv, name, cwd, deadline);
  return schedulePosix(when, argv, name, cwd);
}

function cancelSchedule(name) {
  if (process.platform === 'win32') {
    const run = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Unregister-ScheduledTask -TaskName ' + psQuote(name) + ' -Confirm:$false'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 }
    );
    if (run.status === 0) return true;
    return spawnSync('schtasks.exe', ['/Delete', '/TN', name, '/F'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).status === 0;
  }
  return false;
}

/* ------------------------------------------------------------- arming ----- */

// Everything that has to be true before a wake is scheduled, in the order that
// makes the answer most useful to read.
function armable(input) {
  const options = input || {};
  const config = options.config || settings();
  if (!config.enabled) return { ok: false, why: 'the relay is off' };
  const binding = options.binding;
  if (!binding || binding.percentUsed === null || binding.percentUsed === undefined) return { ok: false, why: 'no usable window reading' };
  if (binding.stale) return { ok: false, why: 'the reading is stale' };
  if (binding.percentUsed < config.at) return { ok: false, why: 'below ' + config.at + ' per cent' };
  if (!Number.isFinite(binding.resetsAt)) return { ok: false, why: 'the window has no known reset time' };
  if (!options.sessionId) return { ok: false, why: 'no session id' };
  if (!options.work || !options.work.hasWork) return { ok: false, why: 'no plan or unfinished todo list to carry' };
  // The boundary rule. Past the threshold but not yet at the backstop, arming
  // waits for the reply to finish - the Stop hook passes atCompletion and this
  // is the only caller that does. Mid-reply callers get told to wait, and the
  // brief says so rather than reporting a silent nothing.
  if (config.armOn === 'completion' && !options.atCompletion && binding.percentUsed < config.backstopAt) {
    return {
      ok: false,
      pending: true,
      why: 'waiting for this reply to finish before arming (past ' + config.backstopAt + ' per cent it stops waiting)',
    };
  }
  return { ok: true };
}

function arm(input) {
  const options = input || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const config = options.config || settings();
  // `at` is an exact wake time, for work deferred to a moment somebody named
  // rather than to a window reset. The grace minutes exist so the meter has
  // really turned over before a resume fires; a time a person typed does not
  // want fifteen minutes added to it. Still floored a minute out, because a
  // task registered for a moment already past fires immediately.
  const when = Number.isFinite(options.at)
    ? Math.max(options.at, now + MINUTE)
    : wakeAt(options.resetsAt, config.graceMinutes, now);
  if (!when) return { ok: false, error: 'no reset time to wake after' };

  const state = read();
  const id = options.sessionId;
  const name = taskName(id, when);
  // Names are unique per wake now, so re-arming no longer replaces the old
  // registration by name; the previous one has to be retired by hand or it
  // stays live and fires on its own.
  //
  // It is retired AFTER the replacement is registered, never before. While
  // the names were identical, -Force made this one atomic operation. With
  // unique names, cancelling first opens a window in which the old wake is
  // gone and the new one does not exist yet - and if registration then
  // fails, that window never closes: the user is left with no relay at all,
  // unattended, having had a working one a moment earlier.
  const previousTask = state.armed && state.armed.task && state.armed.task !== name ? state.armed.task : null;
  // Re-arming the same session for the same reset would register the task
  // twice; -Force replaces it, and the record is rewritten either way.
  const argv = [path.join(__dirname, 'wake.js'), '--id', id];
  if (options.hostName) argv.push('--host', options.hostName);
  // The wake runs hours later in a process that inherits nothing. If this
  // session is pointed at a config directory of its own, the wake has to be
  // pointed at the same one or it reads somebody else's relay - which in
  // testing meant it read the real one and found nothing armed.
  if (process.env.CLAUDE_CONFIG_DIR) argv.push('--config-dir', process.env.CLAUDE_CONFIG_DIR);
  const scheduled = options.schedule === false ? { ok: true, how: 'none' } : schedule(when, argv, name, options.cwd, options.deadline);
  if (scheduled.ok && previousTask) {
    // Safe now: the replacement exists.
    try {
      cancelSchedule(previousTask);
    } catch (err) {
      // The expiry removes it eventually either way.
    }
  }
  if (!scheduled.ok) {
    // The old wake is deliberately left alone here. A stale wake that still
    // fires is worth more than none, and it carries the same continuation.
    note('arm failed for ' + id + ': ' + scheduled.error + (previousTask ? '; the previous wake was left in place' : ''), now);
    return { ok: false, error: scheduled.error };
  }

  const record = {
    id,
    task: scheduled.how === 'none' ? null : name,
    host: options.hostName || host.CLAUDE,
    cwd: options.cwd || process.cwd(),
    project: options.project || null,
    armedAt: now,
    wakeAt: when,
    resetsAt: options.resetsAt,
    percentAtArming: options.binding ? options.binding.percentUsed : null,
    window: options.binding ? options.binding.label || options.binding.key : null,
    // The label is for reading; the key is what the meter is indexed by.
    windowKey: options.binding && options.binding.key ? options.binding.key : null,
    mode: config.mode,
    how: scheduled.how,
    warning: scheduled.warning || null,
    attempt: 0,
    continuation: false,
    // The outstanding items travel with the record, not just their count. They
    // are the work; a wake that knows only "two things were pending" has
    // nothing to hand back.
    work: options.work
      ? {
          pending: options.work.pending,
          source: options.work.source,
          todos: (options.work.todos || []).filter((todo) => todo.status !== 'completed').slice(0, 20),
          plan: options.work.plan ? String(options.work.plan).slice(0, 2000) : null,
        }
      : null,
  };
  // Displacing somebody else's live relay is legitimate - one machine, one
  // relay - but it must not be silent. A wake still in the future belonged to
  // work that somebody expected to be picked up.
  if (state.armed && state.armed.id !== id) {
    if (Number.isFinite(state.armed.wakeAt) && state.armed.wakeAt > now) {
      note('displacing the relay armed for ' + state.armed.id + ' (was due ' + new Date(state.armed.wakeAt).toISOString() + ')', now);
    }
    if (state.armed.task) cancelSchedule(state.armed.task);
  }
  state.armed = record;
  write(state);
  note('armed ' + id + ' for ' + new Date(when).toISOString() + ' via ' + scheduled.how, now);
  return { ok: true, record };
}

// `id` is optional, and when it is given it is a guard rather than a lookup:
// clear the relay only if the thing armed is the thing the caller means.
//
// Without it, disarm clears whatever happens to be armed, and that is not
// hypothetical. Measured 2026-09-14: a second process armed a throwaway
// session at 04:57:04 and cleaned it up four seconds later, and the cleanup
// took a live relay for an unrelated session - armed seven seconds earlier,
// due to wake five hours later - with it. Nothing reported that, because from
// disarm's point of view it did exactly what it was asked.
//
// A person typing `relay cancel` means "whatever is armed", so the CLI passes
// no id and the old behaviour stands. Anything that knows which session it is
// tidying up should say so.
function disarm(reason, now, id) {
  const state = read();
  if (!state.armed) return { ok: true, changed: false };
  if (id && state.armed.id !== id) {
    note('refused to disarm ' + state.armed.id + ' on behalf of ' + id, Number.isFinite(now) ? now : Date.now());
    return { ok: true, changed: false, refused: true, armed: state.armed.id };
  }
  const record = state.armed;
  if (record.task) cancelSchedule(record.task);
  state.history.push(Object.assign({}, record, { endedAt: Number.isFinite(now) ? now : Date.now(), outcome: reason || 'cancelled' }));
  state.history = state.history.slice(-10);
  state.armed = null;
  write(state);
  try {
    fs.unlinkSync(planFile(record.id));
  } catch (err) {
    // The continuation file may never have been written.
  }
  note('disarmed ' + record.id + ': ' + (reason || 'cancelled'), now);
  return { ok: true, changed: true, record };
}

function formatWait(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm';
}

function status(now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const state = read();
  const config = settings(state);
  const able = capabilities();
  const lines = [];
  lines.push(
    'Relay is ' + (config.enabled ? 'ON' : 'OFF') + ', arming at ' + config.at + ' per cent, waking ' +
      config.graceMinutes + ' min after the reset, delivery ' + config.mode + '.'
  );
  if (state.armed) {
    lines.push(
      'Armed: session ' + state.armed.id.slice(0, 8) + ' in ' + state.armed.cwd + ', wake in ' +
        formatWait(state.armed.wakeAt - at) + ' (' + new Date(state.armed.wakeAt).toLocaleString() + '), via ' + state.armed.how + '.'
    );
    if (state.armed.warning) lines.push('  Caveat: ' + state.armed.warning + '.');
    lines.push('  Continuation written: ' + (state.armed.continuation ? 'yes' : 'not yet'));
  } else {
    lines.push('Nothing armed.');
  }
  lines.push(
    'Available here: ' + [
      able.claude ? 'claude CLI' : null,
      able.codex ? 'codex CLI' : null,
      able.computerUse ? 'Computer Use' : null,
    ].filter(Boolean).join(', ') || 'no CLI found'
  );
  const last = state.history[state.history.length - 1];
  if (last) lines.push('Last relay: ' + last.outcome + ' at ' + new Date(last.endedAt).toLocaleString() + '.');
  return lines.join('\n');
}

/* ------------------------------------------------------ always thinking --- */

// "Ultrathink all the time" is two different things and only one of them is a
// prompt. Claude Code recognises the word ultrathink in the text it is given,
// which is what the relay puts there; for every other turn the switch lives in
// settings as alwaysThinkingEnabled. Writing somebody's settings file is not
// something to do quietly, so it is backed up first and reported afterwards.
function settingsFile() {
  return path.join(configDir(), 'settings.json');
}

function applyAlwaysThinking(on) {
  const file = settingsFile();
  let parsed = {};
  let existed = false;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    existed = true;
    // Editors on Windows save JSON with a byte order mark often enough that
    // refusing it would read as "your settings file is broken" to somebody
    // whose settings file is fine.
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
    fs.writeFileSync(file + '.bak-usage-limits', raw);
  } catch (err) {
    if (existed) return { ok: false, error: 'settings.json is not readable JSON; left untouched' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'settings.json is not an object; left untouched' };
  if (on) parsed.alwaysThinkingEnabled = true;
  else delete parsed.alwaysThinkingEnabled;
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, file, backup: existed ? file + '.bak-usage-limits' : null };
}

// `relay arm [--session <id>] [note text]`: take the current reading, book the
// wake against the binding window's reset, and store any text given as the
// continuation. Uses the report rather than the hook's cache, so it costs a
// scan; that is fine from a command line.
async function armByHand(rest) {
  const usage = require('./usage.js');
  usage.setHost(host.detect(process.argv.slice(2), process.env));
  const config = configure({ enabled: true });
  const now = Date.now();
  const data = await usage.report(now, {});
  const binding = data && data.binding;
  if (!binding || !Number.isFinite(binding.resetsAt)) return 'No window with a known reset time to arm against; run /usage and try again.';
  const at = rest.indexOf('--session');
  const sessionId = at !== -1 && rest[at + 1] ? rest[at + 1] : (data.session && data.session.id) || null;
  if (!sessionId) return 'No session id: pass --session <id> (from usage.js --sessions).';
  const text = rest.filter((item, i) => item !== '--session' && !(at !== -1 && i === at + 1)).join(' ').trim();
  const result = arm({
    now,
    config,
    sessionId,
    binding,
    resetsAt: binding.resetsAt,
    cwd: process.cwd(),
    project: path.basename(process.cwd()),
    hostName: usage.currentHost(),
    work: { hasWork: true, pending: 1, source: 'manual', todos: [], plan: text || null },
  });
  if (!result.ok) return 'Could not arm: ' + result.error;
  if (text) saveContinuation(sessionId, text);
  return (
    'Armed by hand for session ' + sessionId.slice(0, 8) + ': wake at ' +
      new Date(result.record.wakeAt).toLocaleString() + ' via ' + result.record.how + '.' +
      (text ? ' Continuation saved.' : ' No continuation yet - add one with: relay note "<text>"')
  );
}

/* ------------------------------------------------------------- doctor ----- */

// Everything that has to be true hours from now, checked while somebody is
// still here to fix it.
//
// The relay's whole promise is that it works unattended, and every part of it
// fails quietly: a CLI that moved, a permission mode nobody set so the run sits
// waiting for an approval, a machine that sleeps through its own wake, a
// network that is not there. Each of those has cost a whole window at least
// once. This asks all of them at once and says which would bite.
async function doctor(now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const state = read();
  const config = settings(state);
  const caps = capabilities();
  const checks = [];
  const add = (name, ok, detail, severity) => checks.push({ name, ok, detail, severity: severity || (ok ? 'ok' : 'error') });

  add('relay enabled', config.enabled, config.enabled ? 'on, arming at ' + config.at + ' per cent' : 'off - nothing will ever be scheduled');
  add('delivery mode', true, config.mode === 'resume' ? 'resume: it starts the CLI itself' : 'notify: it raises a toast and leaves the plan on disk', 'ok');
  add('arming point', true, config.armOn === 'completion'
    ? 'completion - it waits for the reply to finish, and stops waiting past ' + config.backstopAt + ' per cent'
    : 'threshold - it arms the moment the window crosses ' + config.at + ' per cent, even mid-reply', 'ok');

  // The one that has cost the most windows: a headless resume starts in the
  // default permission mode, so a run that needs to edit a file stops and asks
  // a person who is asleep.
  if (config.mode === 'resume') {
    add('permission mode', Boolean(config.permissionMode),
      config.permissionMode
        ? '--permission-mode ' + config.permissionMode
        : 'not set - the resumed run will stop at the first approval and wait for nobody. Set: relay permission acceptEdits');
  }

  const cli = caps.claude || caps.codex;
  add('a CLI to resume with', Boolean(cli), cli || 'neither the claude nor the codex CLI could be found on PATH');

  const net = await require('./net.js').reachable({ timeoutMs: 8000 });
  add('network to the API', net.online, net.detail,
    net.online ? 'ok' : net.reason === 'intercepted' ? 'error' : 'warning');

  // Can a task actually be registered by this account? Registering and removing
  // a throwaway is the only honest answer; asking the policy is not.
  if (process.platform === 'win32') {
    const probeName = 'usage-limits-doctor-probe';
    const registered = scheduleWindows(at + 6 * 60 * MINUTE, [path.join(__dirname, 'wake.js'), '--id', 'doctor-probe'], probeName, os.homedir(), at + 20000);
    add('scheduled tasks', registered.ok, registered.ok
      ? 'registered a test task via ' + registered.how + (registered.how === 'schtasks'
        ? ' - the PowerShell path failed, so a sleeping machine will miss its wake'
        : ' - StartWhenAvailable and WakeToRun are set, so a machine that was off or asleep still runs it')
      : registered.error, registered.ok && registered.how === 'schtasks' ? 'warning' : undefined);
    if (registered.ok) cancelSchedule(probeName);

    // A wake at 3am is no use if the machine hibernates at midnight and the
    // task is not allowed to wake it. This reads the actual power policy.
    const power = spawnSync('powercfg.exe', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const denied = /Allow wake timers[\s\S]{0,600}?Current AC Power Setting Index: 0x00000000/i.test(power.stdout || '');
    add('wake timers', !denied,
      denied
        ? 'wake timers are disabled on AC power, so a sleeping machine will not wake for the relay. Fix in Windows power settings, or: powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1'
        : 'the power plan allows a scheduled task to wake this machine',
      denied ? 'warning' : 'ok');
  } else {
    add('scheduled wake', true, 'posix: at(1) or launchd, checked at arming time', 'ok');
  }

  add('config directory writable', (() => {
    try {
      fs.mkdirSync(configDir(), { recursive: true });
      const probe = path.join(configDir(), '.doctor');
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      return true;
    } catch (err) {
      return false;
    }
  })(), configDir());

  if (state.armed) {
    const continuation = readContinuation(state.armed.id);
    add('continuation saved', Boolean(continuation && continuation.trim()),
      continuation && continuation.trim()
        ? continuation.trim().length + ' characters - the resumed run knows what it is picking up'
        : 'nothing written. The wake would hand back only the todo list, which is thinner than a paragraph the session wrote itself. Use: relay note "<what to do next>"',
      'warning');
    add('wake time', Number.isFinite(state.armed.wakeAt),
      new Date(state.armed.wakeAt).toLocaleString() + ' (' + formatWait(state.armed.wakeAt - at) + ' from now) via ' + state.armed.how);
  } else {
    add('armed', false, 'nothing is armed yet', 'warning');
  }

  const errors = checks.filter((c) => c.severity === 'error');
  const warnings = checks.filter((c) => c.severity === 'warning');
  const mark = (c) => (c.severity === 'ok' ? '  ok   ' : c.severity === 'warning' ? '  warn ' : '  FAIL ');
  const lines = checks.map((c) => mark(c) + c.name.padEnd(26) + ' ' + c.detail);
  lines.unshift(errors.length
    ? errors.length + ' thing' + (errors.length === 1 ? '' : 's') + ' would stop the relay working.'
    : warnings.length
      ? 'Nothing would stop it, but ' + warnings.length + ' thing' + (warnings.length === 1 ? ' is' : 's are') + ' worth fixing.'
      : 'Everything the relay needs is in place.');
  lines.unshift('');
  return { text: lines.join('\n'), checks, errors: errors.length, warnings: warnings.length };
}

/* ----------------------------------------------------------------- cli ---- */

function main(argv) {
  const args = argv || [];
  const command = (args[0] || 'status').toLowerCase();
  const rest = args.slice(1);
  const value = rest.filter((item) => !item.startsWith('--'))[0];

  if (command === 'status') return status(Date.now());
  if (command === 'on' || command === 'off') {
    const config = configure({ enabled: command === 'on' });
    return (
      'Relay ' + (config.enabled ? 'ON' : 'OFF') + '.\n' +
      (config.enabled
        ? 'It arms once the binding window passes ' + config.at + ' per cent AND the session has an unfinished ' +
          'todo list or an approved plan. Delivery is "' + config.mode + '"' +
          (config.mode === 'notify' ? ' - it will notify you, not start anything by itself.' : ' - it will hand the plan back to the conversation itself.')
        : 'Nothing will be scheduled.')
    );
  }
  if (command === 'at') {
    if (!value) return 'Give a percentage, for example: relay at 75';
    return 'Arming at ' + configure({ at: Number(value) }).at + ' per cent.';
  }
  if (command === 'grace') {
    if (!value) return 'Give minutes, for example: relay grace 5';
    return 'Waking ' + configure({ graceMinutes: Number(value) }).graceMinutes + ' minutes after the reset.';
  }
  if (command === 'mode') {
    if (!['notify', 'resume'].includes(String(value))) return 'Mode is notify or resume.';
    const config = configure({ mode: value });
    return (
      'Delivery is now "' + config.mode + '".' +
      (config.mode === 'resume'
        ? '\nAt the wake it will run the CLI itself in the project directory. Set a permission mode ' +
          '(relay permission acceptEdits) or the resumed run will sit waiting for an approval nobody is there to give.'
        : '')
    );
  }
  if (command === 'permission') {
    if (!value) return 'Give one of: manual, acceptEdits, auto, dontAsk, plan, bypassPermissions.';
    return 'Resumed runs will use --permission-mode ' + configure({ permissionMode: value }).permissionMode + '.';
  }
  if (command === 'model') {
    return 'Resumed runs will use --model ' + (configure({ model: value || null }).model || '(the default)') + '.';
  }
  if (command === 'thinking') {
    if (!['off', 'resume', 'always'].includes(String(value))) return 'Thinking is off, resume or always.';
    const config = configure({ thinking: value });
    if (value !== 'always') {
      return (
        'Thinking: ' + config.thinking + '.' +
        (config.thinking === 'resume' ? ' The word ultrathink goes into the prompt the relay delivers.' : '')
      );
    }
    const applied = applyAlwaysThinking(true);
    return applied.ok
      ? 'Thinking: always. Set alwaysThinkingEnabled in ' + applied.file +
        (applied.backup ? ' (backup at ' + applied.backup + ')' : '') +
        '.\nIt applies to new sessions. Note that adaptive-reasoning models decide their own budget, so this is a request, not a guarantee.'
      : 'Could not set it: ' + applied.error;
  }
  if (command === 'note') {
    const state = read();
    if (!state.armed) return 'Nothing is armed, so there is nowhere to put a continuation yet.';
    const fromFile = rest.indexOf('--file') !== -1 ? rest[rest.indexOf('--file') + 1] : null;
    let text = fromFile ? '' : rest.filter((item) => item !== '--file').join(' ');
    if (fromFile) {
      try {
        text = fs.readFileSync(fromFile, 'utf8');
      } catch (err) {
        return 'Could not read ' + fromFile;
      }
    }
    const written = saveContinuation(state.armed.id, text);
    return written ? 'Continuation saved for the relay (' + written + ').' : 'Nothing to save.';
  }
  if (command === 'cancel') {
    const result = disarm('cancelled by hand', Date.now());
    return result.changed ? 'Relay cancelled and the scheduled wake removed.' : 'Nothing was armed.';
  }
  // Arming by hand, for the cases the hook cannot see: Codex writes no plan
  // tool into its rollouts, so nothing there ever reads as work to carry; and
  // a person can have a project in their head that is in no todo list.
  if (command === 'arm') return armByHand(rest);
  if (command === 'armon' || command === 'arm-on') {
    if (!['threshold', 'completion'].includes(String(value))) {
      return 'Arming is "threshold" (the moment the window crosses the mark, mid-reply) or "completion" (the end of the reply).';
    }
    const config = configure({ armOn: value });
    return config.armOn === 'completion'
      ? 'Arming at completion. Crossing ' + config.at + ' per cent no longer arms anything by itself - the relay arms when the reply it is watching finishes, so what it carries is work that reached a boundary rather than a state it was halfway through. Past ' + config.backstopAt + ' per cent it stops waiting and arms anyway, because a completion that never comes is a relay that was never armed.'
      : 'Arming at the threshold. It arms the moment the window crosses ' + config.at + ' per cent, even mid-reply.';
  }
  if (command === 'backstop') {
    if (!value) return 'Give a percentage, for example: relay backstop 95';
    const config = configure({ backstopAt: Number(value) });
    return 'Past ' + config.backstopAt + ' per cent it stops waiting for a completion and arms immediately.';
  }
  if (command === 'show') {
    const on = !['off', 'false', 'no', '0'].includes(String(value || 'on').toLowerCase());
    configure({ show: on });
    return on
      ? 'The resumed run will open in a window you can see, and its full output is kept either way (relay log --run).'
      : 'The resumed run will be invisible. Its output is still kept: relay log --run.';
  }
  if (command === 'onfailure' || command === 'on-failure') {
    if (!['rearm', 'stop'].includes(String(value))) return 'On failure: "rearm" (try again next window) or "stop" (leave it to a person).';
    const config = configure({ onFailure: value });
    return config.onFailure === 'rearm'
      ? 'A wake that fails will arm again for the next window rather than being lost, up to ' + config.maxRearms +
        ' time' + (config.maxRearms === 1 ? '' : 's') + ' - so the work gets ' + (config.maxRearms + 1) + ' windows to happen in, and then it stops.'
      : 'A wake that fails will stop and leave a note.';
  }
  if (command === 'rearms') {
    if (!value) return 'Give a count, for example: relay rearms 2';
    const config = configure({ maxRearms: Number(value) });
    return 'A failing wake will arm itself again at most ' + config.maxRearms + ' time' + (config.maxRearms === 1 ? '' : 's') + '.';
  }
  if (command === 'offline') {
    if (!value) return 'Give a number of retries, for example: relay offline 12';
    const config = configure({ offlineAttempts: Number(value) });
    return 'A machine that cannot reach the API will retry ' + config.offlineAttempts + ' times, ' +
      config.offlineRetryMinutes + ' minutes apart at first and backing off from there. Being offline never counts as a failed run.';
  }
  if (command === 'doctor' || command === 'check') return doctor(Date.now()).then((r) => r.text);
  if (command === 'log') {
    if (rest.includes('--run')) {
      const latest = latestRunLog();
      if (!latest) return 'No resumed run has been recorded yet.';
      return latest.file + '\n\n' + latest.text.split('\n').slice(-120).join('\n');
    }
    try {
      return fs.readFileSync(logFile(), 'utf8').split('\n').slice(-20).join('\n');
    } catch (err) {
      return 'No relay log yet.';
    }
  }
  return [
    'usage: relay.js [status|on|off|at N|grace N|mode notify|resume|permission MODE|model NAME|',
    '                 thinking off|resume|always|armon threshold|completion|backstop N|',
    '                 show on|off|onfailure rearm|stop|offline N|doctor|',
    '                 arm [--session ID] [TEXT]|note TEXT|cancel|log [--run]]',
    '',
    status(Date.now()),
  ].join('\n');
}

if (require.main === module) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then(
      (text) => {
        process.stdout.write(text + '\n');
        process.exit(0);
      },
      (err) => {
        process.stdout.write('relay: ' + err.message + '\n');
        process.exit(0);
      }
    );
}

module.exports = {
  DEFAULTS,
  MINUTE,
  main,
  settingsFile,
  applyAlwaysThinking,
  configDir,
  relayFile,
  logFile,
  planFile,
  note,
  empty,
  read,
  write,
  settings,
  configure,
  detectWork,
  transcriptTail,
  saveContinuation,
  readContinuation,
  compose,
  capabilities,
  findClaude,
  findCodex,
  findComputerUse,
  wakeAt,
  taskName,
  psQuote,
  winArg,
  remainingMs,
  armByHand,
  schedule,
  verifyRegistration,
  scheduleWindows,
  schedulePosix,
  cancelSchedule,
  armable,
  arm,
  disarm,
  status,
  formatWait,
  doctor,
  runLogDir,
  runLogFile,
  writeRunLog,
  latestRunLog,
};
