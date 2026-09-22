#!/usr/bin/env node
'use strict';

// "There is more budget than time. What is it for?"
//
// Every other part of this plugin exists to stop work being started that
// cannot finish. This one exists for the opposite waste, which is larger and
// completely invisible: turns left in a window at its reset are destroyed, not
// carried over, so an hour spent being careful with a budget that expires at
// nine has cost exactly as much as running out at eight - it just has nothing
// to show for it.
//
//   node burn.js list      what is on the backlog, and where it came from
//   node burn.js pick      what fits in the budget that is about to expire
//   node burn.js arm       book a wake shortly before the reset
//   node burn.js cancel    call that wake off
//   node burn.js status    what is armed and what the sources are
//
// The rule that makes this safe to leave armed overnight: it never invents
// work. The backlog is a file the user wrote, or issues they labelled, and an
// empty backlog is a refusal to schedule anything rather than an invitation to
// go and find something. The wake prompt says "run pick and do exactly what it
// prints", so an unattended run can only ever do what was already written down
// before anybody went to bed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const relay = require('./relay.js');
const host = require('./host.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// What a backlog item costs, in turns. Sizes rather than estimates, because a
// person writing a list at midnight will tag three letters and will not price
// anything. The numbers are deliberately coarse: they decide how many items go
// on the list, and being wrong by a third only means the list is a little long
// or a little short.
const DEFAULT_SIZES = { S: 8, M: 25, L: 60 };

// The tag that goes on the end of a line, and the size an untagged line gets.
// Medium, because most things are, and because guessing small would pack the
// list with more items than the window can really hold.
const DEFAULT_SIZE = 'M';

// How long before the reset the wake fires, and how much backlog is worth
// waking for at all.
const DEFAULT_BEFORE_MINUTES = 20;
const DEFAULT_MIN_TURNS = 10;

// gh is a network call at the end of a chain of guesses. Five seconds is
// generous for `gh issue list` and short enough that a hung auth prompt cannot
// make this command feel broken.
const GH_TIMEOUT_MS = 5000;
const GH_LIMIT = 20;

/* ------------------------------------------------------------- where ------ */

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Named like every other file this plugin keeps in that directory. The
// directory is shared with Claude Code's own state and a bare `burn.json`
// there would read as something Claude Code owns.
function recordFile() {
  return path.join(configDir(), 'usage-limits-burn.json');
}

function globalBacklogFile() {
  return process.env.USAGE_LIMITS_BACKLOG || path.join(configDir(), 'backlog.md');
}

function sizes() {
  const env = process.env;
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    S: number(env.USAGE_LIMITS_BURN_S, DEFAULT_SIZES.S),
    M: number(env.USAGE_LIMITS_BURN_M, DEFAULT_SIZES.M),
    L: number(env.USAGE_LIMITS_BURN_L, DEFAULT_SIZES.L),
  };
}

// The repository the backlog belongs to. Not in a repository is not an error:
// a directory with a BACKLOG.md in it is a backlog, and asking git about it
// costs one failed process either way.
function gitRoot(cwd) {
  try {
    const run = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
    });
    const out = (run.stdout || '').trim();
    if (run.status === 0 && out) return out;
  } catch (err) {
    // No git, or no repository. The working directory is the answer.
  }
  return cwd || process.cwd();
}

/* ------------------------------------------------------------ reading ----- */

// One markdown list item.
//
// The format is whatever somebody already writes in a BACKLOG.md, which is the
// whole point: a backlog nobody would have written anyway is a backlog that
// stays empty. Bullets or dashes, task boxes or not, `~S`/`~M`/`~L` on the end
// when the size matters, `@path` when the item belongs to another repository.
const ITEM = /^\s*[-*]\s+(?:\[([ xX])\]\s*)?(.+?)\s*$/;
const SIZE_TAG = /\s*~([SMLsml])\s*$/;
const REPO_TAG = /@(\S+)/;

function parseBacklog(text, source, turnsFor) {
  const items = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(ITEM);
    if (!match) continue;
    // A finished item is not work. Skipping it here rather than filtering
    // later is what lets `pick` tell Claude to tick the line off: the next run
    // simply does not see it.
    if (match[1] && match[1].toLowerCase() === 'x') continue;
    let body = match[2];
    let size = DEFAULT_SIZE;
    const tagged = body.match(SIZE_TAG);
    if (tagged) {
      size = tagged[1].toUpperCase();
      body = body.replace(SIZE_TAG, '');
    }
    body = body.trim();
    if (!body) continue;
    const repo = body.match(REPO_TAG);
    items.push({
      text: body,
      size,
      turns: turnsFor[size] || turnsFor[DEFAULT_SIZE],
      repo: repo ? repo[1] : null,
      source,
    });
  }
  return items;
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

// Does an item tagged `@something` mean this repository? Both spellings people
// actually use: the full path, and the directory name on its own.
function taggedForRepo(tag, root) {
  if (!tag) return true;
  const name = path.basename(root);
  const expanded = tag.startsWith('~') ? path.join(os.homedir(), tag.slice(1)) : tag;
  if (path.basename(expanded.replace(/[/\\]+$/, '')) === name) return true;
  try {
    return path.resolve(expanded) === path.resolve(root);
  } catch (err) {
    return false;
  }
}

function onPath(command) {
  const parts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [command + '.exe', command + '.cmd', command] : [command];
  for (const dir of parts) {
    for (const name of names) {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch (err) {
        // Not here.
      }
    }
  }
  return false;
}

function isGitHubRepo(root) {
  try {
    const run = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
    });
    return run.status === 0 && /github\.com/i.test(run.stdout || '');
  } catch (err) {
    return false;
  }
}

// Issues the user labelled `burn`, which is the same act as writing a line in
// BACKLOG.md: somebody decided in advance that this is fair game for spare
// budget. Every failure here is silent on purpose - no gh, not logged in, no
// network, a repository with no issues - because a backlog that prints an
// error about a tool the user may not even have is worse than a shorter one.
function ghIssues(root, turnsFor) {
  if (!onPath('gh') || !isGitHubRepo(root)) return [];
  let parsed;
  try {
    const run = spawnSync(
      'gh',
      ['issue', 'list', '--label', 'burn', '--state', 'open', '--json', 'number,title', '--limit', String(GH_LIMIT)],
      { cwd: root, encoding: 'utf8', timeout: GH_TIMEOUT_MS }
    );
    if (run.status !== 0) return [];
    parsed = JSON.parse(run.stdout || '[]');
  } catch (err) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((row) => row && row.number && row.title)
    .map((row) => ({
      text: '#' + row.number + ' ' + row.title,
      size: DEFAULT_SIZE,
      turns: turnsFor[DEFAULT_SIZE],
      repo: null,
      source: 'gh',
    }));
}

// The merged backlog, in the order `pick` will spend it.
//
// The order is the preference and it is not arbitrary: work in the repository
// you are standing in needs no context switch, a global item is something you
// meant to get to anywhere, and a labelled issue is the furthest from the
// thing in front of you. Deduplicated by text so the same line written in two
// places is one item, and the first source to name it keeps it.
function collect(options) {
  const opts = options || {};
  const root = opts.root || gitRoot(opts.cwd || process.cwd());
  const turnsFor = opts.sizes || sizes();
  const found = [];
  const repoFile = path.join(root, 'BACKLOG.md');
  const repoText = readFile(repoFile);
  if (repoText !== null) found.push(...parseBacklog(repoText, 'BACKLOG.md', turnsFor));

  const globalFile = globalBacklogFile();
  const globalText = readFile(globalFile);
  if (globalText !== null) {
    found.push(
      ...parseBacklog(globalText, globalFile, turnsFor).filter((item) => taggedForRepo(item.repo, root))
    );
  }

  if (opts.gh !== false) found.push(...ghIssues(root, turnsFor));

  const seen = new Set();
  const items = [];
  for (const item of found) {
    const key = item.text.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return {
    root,
    items,
    sources: [
      repoText !== null ? repoFile : null,
      globalText !== null ? globalFile : null,
      items.some((item) => item.source === 'gh') ? 'gh issue list --label burn' : null,
    ].filter(Boolean),
  };
}

/* ----------------------------------------------------------- the budget --- */

// The same reading the brief prints, from the same one pass over the windows,
// so `pick` can never offer to spend turns the line said were not there.
async function reading(now, argv) {
  const usage = require('./usage.js');
  usage.setHost(host.detect(argv || [], process.env));
  const data = await usage.report(now, {});
  return {
    binding: data.binding || null,
    turnsLeft: data.binding && Number.isFinite(data.binding.turnsLeft) ? data.binding.turnsLeft : null,
    surplus: data.surplus || null,
  };
}

// Greedy, in source order. Not a knapsack: the order is a preference the user
// expressed by where they wrote the item, and reshuffling it to pack the
// window two turns fuller would trade that away for nothing.
function pickItems(items, budget) {
  const chosen = [];
  let spent = 0;
  for (const item of items || []) {
    if (spent + item.turns > budget) continue;
    chosen.push(item);
    spent += item.turns;
  }
  return { chosen, spent };
}

/* ---------------------------------------------------------- the record ---- */

function readRecord() {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

function writeRecord(record) {
  try {
    fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
    fs.writeFileSync(recordFile(), JSON.stringify(record, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

function clearRecord() {
  try {
    fs.unlinkSync(recordFile());
    return true;
  } catch (err) {
    return false;
  }
}

function sessionId(argv, env) {
  const at = (argv || []).indexOf('--session-id');
  if (at !== -1 && argv[at + 1]) return argv[at + 1];
  return (
    env.CLAUDE_CODE_SESSION_ID ||
    env.CLAUDE_SESSION_ID ||
    env.CODEX_SESSION_ID ||
    'burn-' + Date.now().toString(36)
  );
}

function argOf(argv, name) {
  const at = (argv || []).indexOf(name);
  return at === -1 ? null : argv[at + 1] || null;
}

function numberArg(argv, name, fallback) {
  const raw = argOf(argv, name);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clock(stamp) {
  const d = new Date(stamp);
  let hour = d.getHours();
  const meridiem = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 === 0 ? 12 : hour % 12;
  return hour + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + meridiem;
}

function span(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm';
}

/* -------------------------------------------------------- the commands ---- */

const EMPTY =
  'No backlog. Add items to BACKLOG.md in this repo or ~/.claude/backlog.md, or label GitHub issues `burn`.';

function renderList(found) {
  if (!found.items.length) return EMPTY;
  const lines = ['Backlog for ' + found.root, ''];
  for (const item of found.items) {
    lines.push(
      '  [' + item.size + ', ' + String(item.turns).padStart(2) + '] ' + item.text +
        '   (' + item.source + ')'
    );
  }
  lines.push('');
  lines.push(
    found.items.length + ' item' + (found.items.length === 1 ? '' : 's') + ', ' +
      found.items.reduce((sum, item) => sum + item.turns, 0) + ' turns in all, from ' +
      found.sources.join(', ') + '.'
  );
  return lines.join('\n');
}

async function pick(now, argv, options) {
  const opts = options || {};
  const state = opts.reading || (await reading(now, argv));
  const found = opts.backlog || collect({ cwd: opts.cwd || process.cwd() });
  const surplus = state.surplus;

  if (!surplus) {
    const where = state.binding
      ? state.binding.label + ' window' +
        (Number.isFinite(state.turnsLeft) ? ', about ' + state.turnsLeft + ' turns left' : '') +
        (Number.isFinite(state.binding.msToReset) ? ', resets in ' + span(state.binding.msToReset) : '')
      : 'no usable window reading';
    return where + '.\nNo surplus right now; nothing to burn.';
  }

  if (!found.items.length) {
    // The one place this command asks Claude to think of work rather than read
    // it, and it is bounded on both sides: a handful of candidates, and a
    // question before anything starts. Nothing here runs unattended - `arm`
    // refuses an empty backlog outright - so this path only ever happens with
    // somebody watching.
    return (
      'Surplus of ' + surplus.expiringTurns + ' turns and no backlog. Suggest 3-5 candidates from ' +
      'this repo (TODO/FIXME comments, failing or missing tests, stale docs, open issues) and ask ' +
      'before starting any.'
    );
  }

  const { chosen, spent } = pickItems(found.items, surplus.expiringTurns);
  const head =
    'About ' + surplus.expiringTurns + ' turns will expire unused in ' + span(surplus.msToReset) +
    ' (this pace can spend about ' + surplus.spendableTurns + ' of what is left).';
  if (!chosen.length) {
    return (
      head + '\n\nNothing on the backlog fits in ' + surplus.expiringTurns + ' turns; the smallest ' +
      'item is ' + Math.min(...found.items.map((item) => item.turns)) + '. Split one, or leave it.'
    );
  }

  const lines = [head, '', 'Plan, ' + spent + ' of ' + surplus.expiringTurns + ' turns:'];
  chosen.forEach((item, index) => {
    lines.push('  ' + (index + 1) + '. [' + item.size + ', ' + item.turns + '] ' + item.text + '   (' + item.source + ')');
  });
  lines.push('');
  lines.push(
    'Do these now, in order; stop when the window resets or the list ends; mark each done in its ' +
      'BACKLOG.md line (`- [x]`) when finished.'
  );
  return lines.join('\n');
}

// The prompt the wake delivers. It references `pick` and nothing else on
// purpose: whatever is on the backlog at the moment it fires is the whole
// scope, and a prompt that described the work itself would be a prompt that
// could go stale between arming and firing.
const WAKE_PROMPT =
  'Run /usage-limits:burn pick and do exactly what it prints. Do not start anything not on that list.';

async function arm(now, argv, options) {
  const opts = options || {};
  const found = opts.backlog || collect({ cwd: opts.cwd || process.cwd() });
  const beforeMinutes = numberArg(argv, '--before', DEFAULT_BEFORE_MINUTES);
  const minTurns = numberArg(argv, '--min-turns', DEFAULT_MIN_TURNS);

  // The safety rule, and it is checked before anything else is even read: no
  // backlog, no unattended run. An empty list is not a reason to go looking.
  if (!found.items.length) return 'Nothing queued; not arming.';
  const queued = found.items.reduce((sum, item) => sum + item.turns, 0);
  if (queued < minTurns) {
    return (
      'Only ' + queued + ' turns of backlog, under the ' + minTurns + ' turn floor; not arming. ' +
      'Add items, or lower it with --min-turns.'
    );
  }

  // A wake that cannot start a session is a scheduled task that will do
  // nothing at the hour it was asked to do something, which is worse than
  // saying so now.
  const hostName = host.detect(argv || [], process.env);
  const caps = relay.capabilities(process.env);
  const launcher = hostName === host.CODEX ? caps.codex : caps.claude;
  if (!launcher) {
    return (
      'The relay cannot start a ' + hostName + ' session on this machine: no ' + hostName +
      ' command was found on PATH. Nothing was armed.'
    );
  }

  const state = opts.reading || (await reading(now, argv));
  const resetsAt = state.binding && Number.isFinite(state.binding.resetsAt) ? state.binding.resetsAt : null;
  if (!Number.isFinite(resetsAt)) {
    return 'The reset time is not known right now, so there is no moment to wake before. Nothing was armed.';
  }

  // Before the reset, not after it: the whole point is to spend the window
  // that is about to end, and a wake five minutes late spends the new one.
  const wakeAt = Math.max(resetsAt - beforeMinutes * MINUTE, now + MINUTE);

  const existing = readRecord();
  if (existing && Number.isFinite(existing.wakeAt) && Math.abs(existing.wakeAt - wakeAt) < MINUTE) {
    return 'Already armed for ' + clock(existing.wakeAt) + '; nothing changed.';
  }

  const id = sessionId(argv, process.env);
  const cwd = argOf(argv, '--cwd') || opts.cwd || process.cwd();
  // Saved before the task is registered: a wake that fires with nothing to
  // read is worse than a plan nobody scheduled.
  relay.saveContinuation(id, WAKE_PROMPT);
  const armed = relay.arm({
    now,
    sessionId: id,
    cwd,
    hostName,
    at: wakeAt,
    binding: {
      percentUsed: state.binding ? state.binding.percentUsed : null,
      resetsAt,
    },
    work: { hasWork: true, pending: found.items.length, source: 'burn', todos: [] },
    // Tests must never register a real scheduled task on the machine running
    // them; relay.arm has carried this seam since the deferral tests.
    schedule: opts.schedule === false ? false : undefined,
  });
  if (!armed.ok) return 'Could not schedule it: ' + armed.error;

  const at = armed.record && Number.isFinite(armed.record.wakeAt) ? armed.record.wakeAt : wakeAt;
  writeRecord({
    sessionId: id,
    cwd,
    wakeAt: at,
    items: found.items.map((item) => ({ text: item.text, size: item.size, turns: item.turns, source: item.source })),
    armedAt: now,
  });
  relay.note('burn armed ' + id + ' for ' + new Date(at).toISOString(), now);
  return (
    'Armed for ' + clock(at) + ' (in ' + span(at - now) + '), ' + beforeMinutes + ' minutes before the ' +
    'window resets, with ' + found.items.length + ' item' + (found.items.length === 1 ? '' : 's') +
    ' (' + queued + ' turns) queued. It will run /usage-limits:burn pick and nothing else. ' +
    '"burn cancel" calls it off.'
  );
}

function cancel(now, argv) {
  const record = readRecord();
  if (!record) return 'Nothing was armed.';
  const result = relay.disarm('burn cancelled by hand', now, record.sessionId);
  clearRecord();
  return result && result.ok === false
    ? 'Removed the record, but could not cancel the wake: ' + result.error
    : 'Cancelled the burn booked for ' + clock(record.wakeAt) + '.';
}

function status(now, argv, options) {
  const opts = options || {};
  const found = opts.backlog || collect({ cwd: opts.cwd || process.cwd() });
  const record = readRecord();
  const lines = [];
  lines.push(
    record && Number.isFinite(record.wakeAt)
      ? 'Armed for ' + clock(record.wakeAt) + ' (' +
        (record.wakeAt > now ? 'in ' + span(record.wakeAt - now) : span(now - record.wakeAt) + ' ago') + '), ' +
        (record.items || []).length + ' item' + ((record.items || []).length === 1 ? '' : 's') + ' queued.'
      : 'Nothing armed.'
  );
  lines.push(
    found.items.length
      ? 'Backlog: ' + found.items.length + ' item' + (found.items.length === 1 ? '' : 's') + ', ' +
        found.items.reduce((sum, item) => sum + item.turns, 0) + ' turns, from ' + found.sources.join(', ') + '.'
      : 'Backlog: empty. ' + EMPTY
  );
  return lines.join('\n');
}

const HELP = [
  'burn list                     what is on the backlog, and where it came from',
  'burn pick                     what fits in the budget that is about to expire',
  'burn arm [--before 20] [--min-turns 10]',
  '                              book a wake shortly before the reset',
  'burn cancel                   call that wake off',
  'burn status                   what is armed, and which sources were found',
].join('\n');

async function main(argv, now, options) {
  const args = (argv || []).filter((a) => a !== undefined);
  const first = args.find((a) => !a.startsWith('--')) || 'pick';
  const at = Number.isFinite(now) ? now : Date.now();

  if (first === 'help') return HELP;
  if (first === 'list') return renderList((options && options.backlog) || collect({ cwd: options && options.cwd }));
  if (first === 'status') return status(at, args, options);
  if (first === 'cancel' || first === 'off') return cancel(at, args);
  if (first === 'arm') return arm(at, args, options);
  if (first === 'pick') return pick(at, args, options);
  return 'Unknown: ' + first + '\n' + HELP;
}

if (require.main === module) {
  main(process.argv.slice(2), Date.now()).then(
    (text) => {
      process.stdout.write(text + '\n');
      process.exitCode = 0;
    },
    (err) => {
      process.stderr.write('burn: ' + (err && err.message ? err.message : String(err)) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = {
  parseBacklog,
  collect,
  pickItems,
  taggedForRepo,
  readRecord,
  writeRecord,
  clearRecord,
  recordFile,
  globalBacklogFile,
  sizes,
  gitRoot,
  reading,
  pick,
  arm,
  cancel,
  status,
  main,
  WAKE_PROMPT,
  EMPTY,
  HELP,
  DEFAULT_SIZES,
  DEFAULT_BEFORE_MINUTES,
  DEFAULT_MIN_TURNS,
};
