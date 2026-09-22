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
//   node burn.js add       write one line to the right backlog file
//   node burn.js pick      what fits in the budget that is about to expire
//   node burn.js done      tick an item off, close its issue, commit the work
//   node burn.js arm       book a wake shortly before the reset
//   node burn.js cancel    call that wake off
//   node burn.js status    what is armed and what the sources are
//
// The rule that makes this safe to leave armed overnight: it never invents
// work. The backlog is a file the user wrote, or issues they labelled, and an
// empty backlog is a refusal to schedule anything rather than an invitation to
// go and find something. The wake prompt says "run pick --unattended and do
// exactly what it prints", so an unattended run can only ever do what was
// already written down before anybody went to bed - on a branch of its own,
// from a clean tree, or not at all.
//
// Everything a person might otherwise be asked to remember is a decision this
// file makes instead: which file a new item belongs in, whether it is already
// written down somewhere, whether any work actually happened before an item is
// ticked off, and where an unattended run is allowed to write.

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
const GIT_TIMEOUT_MS = 5000;

// Committing can be slower than asking a question, because hooks run on it.
const GIT_COMMIT_TIMEOUT_MS = 30000;

// What the issue is told when an unattended run finishes it. Whoever reads the
// issue next needs to know a machine closed it, and why.
const GH_CLOSE_COMMENT = 'Done by an unattended burn run (/usage-limits:burn).';

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

function git(args, root, timeout) {
  try {
    return spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: timeout || GIT_TIMEOUT_MS,
    });
  } catch (err) {
    return { status: 1, stdout: '', stderr: err && err.message ? err.message : String(err) };
  }
}

function isGitRepo(root) {
  const run = git(['rev-parse', '--is-inside-work-tree'], root);
  return run.status === 0 && /true/.test(run.stdout || '');
}

function gitHead(root) {
  const run = git(['rev-parse', 'HEAD'], root);
  const out = (run.stdout || '').trim();
  return run.status === 0 && out ? out : null;
}

// The whole working tree and index state as one string, rather than the
// boolean "is it dirty". A boolean cannot tell one dirty tree from another, so
// it cannot answer the question `done` actually asks - did anything happen
// since the plan was printed - for a run that started dirty.
function gitStatus(root) {
  const run = git(['status', '--porcelain'], root);
  if (run.status !== 0) return null;
  return String(run.stdout || '').replace(/\s+$/, '');
}

function gitBranch(root) {
  const run = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const out = (run.stdout || '').trim();
  return run.status === 0 && out ? out : null;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '(no commits yet)';
}

// A branch per unattended run, dated so a week of them reads as a history and
// numbered so two in one night cannot collide.
function branchName(root, now) {
  const at = new Date(Number.isFinite(now) ? now : Date.now());
  const day =
    at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0') + '-' + String(at.getDate()).padStart(2, '0');
  for (let n = 1; n < 100; n += 1) {
    const name = 'burn/' + day + '-' + n;
    if (git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + name], root).status !== 0) return name;
  }
  return 'burn/' + day + '-' + Date.now().toString(36);
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

// One item is the same item as another when a person would say so. Case and
// spacing are the only differences worth forgiving: anything cleverer would
// start silently refusing to add lines somebody meant to add.
function key(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Every item written down anywhere, unfiltered by which repository it is
// tagged for. `collect` is what `pick` spends and so is narrowed to here;
// `add` and `done` need the wider view - an item tagged `@kosha` is still a
// duplicate when you are standing in another directory.
function everywhere(root, turnsFor, options) {
  const opts = options || {};
  const found = [];
  const repoFile = path.join(root, 'BACKLOG.md');
  const repoText = readFile(repoFile);
  if (repoText !== null) found.push(...parseBacklog(repoText, repoFile, turnsFor));
  const globalFile = globalBacklogFile();
  const globalText = readFile(globalFile);
  if (globalText !== null) found.push(...parseBacklog(globalText, globalFile, turnsFor));
  if (opts.gh !== false) found.push(...ghIssues(root, turnsFor));
  return found;
}

// `- Fix auth redirect @kosha` and `- Fix auth redirect` are one item written
// twice, so the tag comes off before the comparison as well as staying on.
function findExisting(items, text) {
  const wanted = key(text);
  if (!wanted) return null;
  for (const item of items || []) {
    if (key(item.text) === wanted) return item;
    if (key(String(item.text).replace(REPO_TAG, '')) === wanted) return item;
  }
  return null;
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
    const id = key(item.text);
    if (seen.has(id)) continue;
    seen.add(id);
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

/* ------------------------------------------------------------ writing ----- */

// Appended, never rewritten, and in whatever newline style the file already
// uses. A backlog is somebody's own file; a command that reformats it once is
// a command they stop pointing at their real one.
function appendLine(file, line) {
  const text = readFile(file);
  const created = text === null;
  const eol = text && /\r\n/.test(text) ? '\r\n' : '\n';
  try {
    if (created) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '# Backlog' + eol + eol + line + eol, 'utf8');
    } else {
      const pad = text.length === 0 || text.endsWith(eol) ? '' : eol;
      fs.appendFileSync(file, pad + line + eol, 'utf8');
    }
    return { ok: true, created };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// Turn one line into `- [x] ...`, leaving every other character of the file
// alone. The line is found the way `parseBacklog` found it, so an item can
// always be ticked by the text `pick` printed.
function tick(file, text) {
  const original = readFile(file);
  if (original === null) return { ok: false, error: file + ' is not there any more' };
  const eol = /\r\n/.test(original) ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const wanted = key(text);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(ITEM);
    if (!match) continue;
    if (match[1] && match[1].toLowerCase() === 'x') continue;
    const body = match[2].replace(SIZE_TAG, '').trim();
    if (key(body) !== wanted) continue;
    lines[i] = match[1]
      ? lines[i].replace(/\[\s\]/, '[x]')
      : lines[i].replace(/^(\s*[-*]\s+)/, '$1[x] ');
    try {
      fs.writeFileSync(file, lines.join(eol), 'utf8');
      return { ok: true, line: lines[i].trim() };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }
  return { ok: false, error: 'no unticked line matching that text in ' + file };
}

// A `@tag` is a label, not a lookup, so this only ever decides whether to say
// "there is no such directory" alongside a line that was written regardless.
function repoOnDisk(tag, root) {
  if (!tag) return null;
  const expanded = String(tag).startsWith('~') ? path.join(os.homedir(), String(tag).slice(1)) : String(tag);
  const candidates =
    expanded.indexOf('/') !== -1 || path.isAbsolute(expanded)
      ? [path.resolve(expanded)]
      : [
          path.join(path.dirname(root), expanded),
          path.join(os.homedir(), expanded),
          path.join(os.homedir(), 'projects', expanded),
        ];
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch (err) {
      // Not this one.
    }
  }
  return null;
}

const ISSUE_ITEM = /^#(\d+)\s+/;

// The gap that made labelled issues immortal: they were picked, done, and
// picked again the next night, because nothing ever closed them.
function closeIssue(number, root) {
  if (!onPath('gh')) return { ok: false, error: 'gh is not on PATH' };
  try {
    const run = spawnSync('gh', ['issue', 'close', String(number), '--comment', GH_CLOSE_COMMENT], {
      cwd: root,
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
    });
    if (run.status === 0) return { ok: true };
    const said = String(run.stderr || run.stdout || '').trim().split(/\r?\n/)[0];
    return { ok: false, error: said || 'gh exited ' + run.status };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// Flags that take the next word, so `burn add fix the --size S thing` cannot
// end up with "S" in the middle of the item text.
const VALUE_FLAGS = new Set(['--size', '--repo', '--cwd', '--session-id', '--before', '--min-turns']);

function parseFlags(argv) {
  const args = (argv || []).filter((arg) => arg !== undefined && arg !== null);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg.indexOf('--') !== 0) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    let value = eq === -1 ? null : arg.slice(eq + 1);
    if (VALUE_FLAGS.has(name)) {
      if (value === null) {
        value = args[i + 1] === undefined ? null : String(args[i + 1]);
        i += 1;
      }
      flags[name] = value;
    } else {
      flags[name] = value === null ? true : value;
    }
  }
  return { flags, positional };
}

// The text of an item, from whatever is left once the subcommand and the flags
// are taken out. Quoted or not: `burn add fix the flaky test` is what somebody
// types when they are in a hurry, and it should work.
function subject(positional, command) {
  return positional
    .filter((word, index) => !(index === 0 && word === command))
    .join(' ')
    .trim();
}

// Anything that exits non-zero says so by returning this instead of a string.
// The older commands still return plain strings, and both callers accept
// either, so nothing that already worked had to change shape.
function refuse(text) {
  return { text: text, code: 1 };
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

// One command, three destinations, and the script picks. The alternative is a
// paragraph in a skill telling Claude which file to edit by hand, which is a
// paragraph that has to be read, reasoned about and got right every time.
//
//   burn add "Fix the flaky drift test" --size S   -> this repo's BACKLOG.md
//   burn add "Upgrade node everywhere" --global    -> ~/.claude/backlog.md
//   burn add "Fix auth redirect" --repo kosha      -> the same, tagged @kosha
function add(now, argv, options) {
  const opts = options || {};
  const { flags, positional } = parseFlags(argv);
  const text = subject(positional, 'add');
  if (!text) {
    return refuse('Nothing to add. burn add "<what to do>" [--size S|M|L] [--global | --repo <name>]');
  }
  const wantsRepo = Object.prototype.hasOwnProperty.call(flags, '--repo');
  const wantsGlobal = Object.prototype.hasOwnProperty.call(flags, '--global');
  if (wantsGlobal && wantsRepo) {
    return refuse('--global and --repo say different things; pick one. --repo already means the global file.');
  }
  if (wantsRepo && (flags['--repo'] === true || !flags['--repo'])) {
    return refuse('--repo needs the name or path of a repository.');
  }

  const turnsFor = opts.sizes || sizes();
  const raw = flags['--size'] === undefined || flags['--size'] === true ? DEFAULT_SIZE : String(flags['--size']);
  const size = raw.toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(turnsFor, size)) {
    return refuse('Unknown size "' + raw + '"; it is S, M or L.');
  }

  const root = opts.root || gitRoot(opts.cwd || process.cwd());

  // Checked before anything is written, against all three sources, because the
  // alternative is Claude reading two files and a GitHub issue list to find
  // out - and getting it wrong when the line is in the one it did not read.
  const already = findExisting(everywhere(root, turnsFor, { gh: opts.gh }), text);
  if (already) {
    return (
      'Already on the backlog, so nothing was written:\n  ' +
      already.text +
      '   (' +
      already.source +
      ')'
    );
  }

  const tag = wantsRepo ? String(flags['--repo']) : null;
  const file = tag || wantsGlobal ? globalBacklogFile() : path.join(root, 'BACKLOG.md');
  const line = '- ' + text + (tag ? ' @' + tag : '') + ' ~' + size;

  const wrote = appendLine(file, line);
  if (!wrote.ok) return refuse('Could not write ' + file + ': ' + wrote.error);

  const lines = [];
  if (wrote.created) lines.push('Created ' + file + '.');
  lines.push(line);
  lines.push('-> ' + file);
  if (tag && !repoOnDisk(tag, root)) {
    lines.push('No directory named "' + tag + '" was found; the tag is a label, not a lookup, so it was written anyway.');
  }
  return lines.join('\n');
}

// What `pick` leaves behind so `done` can tell work from no work. Merged into
// whatever the record already holds, because an armed wake lives there too.
function rememberPlan(plan) {
  const record = readRecord() || {};
  record.plan = plan;
  writeRecord(record);
  return plan;
}

async function pick(now, argv, options) {
  const opts = options || {};
  const unattended = (argv || []).indexOf('--unattended') !== -1;
  const root = opts.root || gitRoot(opts.cwd || process.cwd());

  // Both refusals come before the account is read, let alone before anything
  // is edited: an unattended run that cannot be undone must not start, and
  // saying so costs two git calls.
  if (unattended) {
    if (!isGitRepo(root)) {
      return refuse(
        'Not a git repository: ' + root + '\n' +
          'An unattended run there has no undo, so nothing was started. Run `burn pick` yourself, or `git init` first.'
      );
    }
    const dirty = gitStatus(root);
    if (dirty) {
      return refuse(
        'The working tree is not clean, so an unattended run would edit work in progress:\n' +
          dirty.split(/\r?\n/).map((line) => '  ' + line).join('\n') + '\n' +
          'Nothing was started and nothing was scheduled. Commit it or put it aside, then run this again.'
      );
    }
  }

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
    // it, and it is bounded on three ways: a handful of candidates, a question
    // before anything starts, and not at all when nobody is watching.
    if (unattended) return 'Surplus of ' + surplus.expiringTurns + ' turns and nothing on the backlog. Nothing to do.';
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

  const lines = [];

  // The branch is made here and nowhere earlier: a run that had no surplus, or
  // nothing that fitted, should leave the repository exactly as it found it.
  let branch = null;
  if (unattended) {
    branch = branchName(root, now);
    const made = git(['checkout', '-b', branch], root);
    if (made.status !== 0) {
      return refuse(
        'Could not create the branch ' + branch + ': ' +
          (String(made.stderr || made.stdout || '').trim().split(/\r?\n/)[0] || 'git exited ' + made.status) +
          '\nNothing was started.'
      );
    }
    lines.push(
      'On branch ' + branch + ', cut from ' + shortSha(gitHead(root)) +
        '. All of this work goes there; nothing is pushed and the branch you were on is untouched.'
    );
    lines.push('');
  }

  lines.push(head, '', 'Plan, ' + spent + ' of ' + surplus.expiringTurns + ' turns:');
  chosen.forEach((item, index) => {
    lines.push('  ' + (index + 1) + '. [' + item.size + ', ' + item.turns + '] ' + item.text + '   (' + item.source + ')');
  });
  lines.push('');
  lines.push(
    'Do these now, in order; stop when the window resets or the list ends; run `burn done <n>` after ' +
      'each one, which ticks its BACKLOG.md line (`- [x]`), closes its issue if it was one' +
      (branch ? ', and commits to the branch' : '') + '.'
  );

  // The marker `done` verifies against. Written last, so a plan that was never
  // printed can never be used to justify ticking something off.
  const snapshot = gitStatus(root);
  rememberPlan({
    at: now,
    root,
    head: gitHead(root),
    status: snapshot,
    dirty: Boolean(snapshot),
    unattended,
    branch,
    items: chosen.map((item) => ({ text: item.text, size: item.size, turns: item.turns, source: item.source })),
  });

  return lines.join('\n');
}

/* ------------------------------------------------------------- done ------- */

// Did anything actually happen since the plan was printed?
//
// This exists because the expensive failure mode of an unattended run is not a
// bad edit, it is a run that did nothing and said it was finished: the item
// gets ticked, the issue gets closed, and the work is gone from the list
// without ever having been done. HEAD and the porcelain status are the two
// cheapest facts that cannot be got wrong.
function verify(root, plan) {
  if (!isGitRepo(root)) {
    return { ok: true, note: 'Not a git repository, so there is nothing to compare against; ticking on trust.' };
  }
  if (!plan || typeof plan.status === 'undefined') {
    return { ok: true, note: '`burn pick` recorded no plan, so there is nothing to compare against; ticking on trust.' };
  }
  const head = gitHead(root);
  const status = gitStatus(root);
  const moved = head !== (plan.head || null);
  const changed = status !== (typeof plan.status === 'string' ? plan.status : null);
  if (moved || changed) return { ok: true, note: null };
  return {
    ok: false,
    checked: [
      'HEAD is still ' + shortSha(head) + ', the commit `burn pick` recorded at ' + clock(plan.at) + '.',
      'git status --porcelain is byte for byte what it was then (' + (plan.dirty ? 'dirty then, identically dirty now' : 'clean then, clean now') + ').',
    ],
  };
}

// Which item is meant. Exact text first, then the number `pick` printed beside
// it, then a substring - and an ambiguous substring is a question, not a
// guess, because the cost of guessing here is ticking off the wrong thing.
function exactMatch(wanted, pool) {
  return (
    pool.find((item) => item.text === wanted) || pool.find((item) => key(item.text) === key(wanted)) || null
  );
}

function looseMatch(wanted, pool) {
  const id = key(wanted);
  return id ? pool.filter((item) => key(item.text).indexOf(id) !== -1) : [];
}

function commitBurn(root, branch, texts) {
  const current = gitBranch(root);
  if (branch && current !== branch) {
    return { ok: false, error: 'the checkout is on ' + current + ', not ' + branch + '; nothing was committed' };
  }
  if (!gitStatus(root)) return { ok: false, empty: true };
  const staged = git(['add', '-A'], root);
  if (staged.status !== 0) {
    return { ok: false, error: String(staged.stderr || '').trim().split(/\r?\n/)[0] || 'git add exited ' + staged.status };
  }
  const subjectLine = texts.length === 1 ? 'burn: ' + texts[0] : 'burn: ' + texts.length + ' backlog items';
  const body = texts.map((text) => '- ' + text).join('\n');
  const run = git(['commit', '-m', subjectLine, '-m', body], root, GIT_COMMIT_TIMEOUT_MS);
  if (run.status !== 0) {
    return { ok: false, error: String(run.stderr || run.stdout || '').trim().split(/\r?\n/)[0] || 'git commit exited ' + run.status };
  }
  return { ok: true, subject: subjectLine, sha: shortSha(gitHead(root)) };
}

//   burn done "Fix the flaky drift test"
//   burn done 2            the number pick printed
//   burn done --all
function done(now, argv, options) {
  const opts = options || {};
  const { flags, positional } = parseFlags(argv);
  const wanted = subject(positional, 'done');
  const all = Boolean(flags['--all']);
  const force = Boolean(flags['--force']);
  const root = opts.root || gitRoot(opts.cwd || process.cwd());
  const turnsFor = opts.sizes || sizes();
  const record = readRecord();
  const plan = record && record.plan && typeof record.plan === 'object' ? record.plan : null;
  const planItems = plan && Array.isArray(plan.items) ? plan.items : [];

  if (!all && !wanted) {
    return refuse('Which one? burn done "<the item>", or the number `pick` printed, or --all.');
  }

  const checked = verify(root, plan);
  if (!checked.ok && !force) {
    return refuse(
      'Nothing has changed since `burn pick` printed the plan, so there is nothing to mark done.\n' +
        checked.checked.map((line) => '  - ' + line).join('\n') + '\n' +
        'Do the work first, or pass --force to tick it off anyway.'
    );
  }

  // The file each item actually lives in, which is what gets edited. The plan
  // is only consulted for the numbering and for --all.
  const pool = everywhere(root, turnsFor, { gh: opts.gh });
  const seen = new Set();
  const candidates = [];
  for (const item of pool.concat(planItems)) {
    const id = key(item.text);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    candidates.push(item);
  }

  let targets = [];
  if (all) {
    if (!planItems.length) return refuse('`burn pick` recorded no plan, so --all has nothing to tick off.');
    targets = planItems.map((item) => exactMatch(item.text, candidates) || item);
  } else {
    const index = /^\d+$/.test(wanted) ? Number(wanted) : null;
    const exact = exactMatch(wanted, candidates);
    const numbered = index && planItems[index - 1] ? planItems[index - 1] : null;
    if (exact) targets = [exact];
    else if (numbered) targets = [exactMatch(numbered.text, candidates) || numbered];
    else {
      const loose = looseMatch(wanted, candidates);
      if (loose.length === 1) targets = [loose[0]];
      else if (loose.length > 1) {
        return refuse(
          '"' + wanted + '" matches ' + loose.length + ' items:\n' +
            loose.map((item) => '  ' + item.text + '   (' + item.source + ')').join('\n') + '\n' +
            'Say which one in full, or give its number from the plan.'
        );
      } else return refuse('Nothing on the backlog matches "' + wanted + '". `burn list` shows what is there.');
    }
  }

  const lines = [];
  if (checked.note) lines.push(checked.note);
  if (!checked.ok && force) {
    lines.push('--force: nothing has changed since `burn pick` printed the plan, and it is being ticked off regardless.');
  }

  const ticked = [];
  for (const item of targets) {
    const issue = String(item.text).match(ISSUE_ITEM);
    if (issue) {
      const close = opts.closeIssue ? opts.closeIssue(issue[1], root) : opts.gh === false ? { ok: false, error: 'gh was not consulted' } : closeIssue(issue[1], root);
      // Non-fatal on purpose: no gh, no network or no permission is a reason
      // to say so, not a reason to leave the rest of the run unfinished.
      lines.push(close && close.ok ? 'Closed issue #' + issue[1] + '.' : 'Could not close issue #' + issue[1] + ': ' + ((close && close.error) || 'unknown') + '. Close it by hand.');
      ticked.push(item.text);
      continue;
    }
    const file = item.source && item.source.indexOf(path.sep) !== -1 ? item.source : path.join(root, 'BACKLOG.md');
    const wrote = tick(file, item.text);
    if (wrote.ok) {
      lines.push(wrote.line + '   (' + file + ')');
      ticked.push(item.text);
    } else {
      lines.push('Could not tick "' + item.text + '": ' + wrote.error);
    }
  }

  if (!ticked.length) return refuse(lines.join('\n'));

  if (plan && plan.branch) {
    const committed = commitBurn(root, plan.branch, ticked);
    if (committed.ok) {
      lines.push(
        'Committed ' + committed.sha + ' to ' + plan.branch + ': ' + committed.subject +
          '. Review that branch and merge or drop it; nothing was pushed.'
      );
    } else if (committed.empty) {
      lines.push('Nothing to commit on ' + plan.branch + '.');
    } else {
      lines.push('Could not commit to ' + plan.branch + ': ' + committed.error + '.');
    }
  }

  return lines.join('\n');
}

// The prompt the wake delivers. It references `pick` and nothing else on
// purpose: whatever is on the backlog at the moment it fires is the whole
// scope, and a prompt that described the work itself would be a prompt that
// could go stale between arming and firing. `--unattended` is the difference
// between a wake and a person: a clean tree, a branch of its own, or nothing.
const WAKE_PROMPT =
  'Run /usage-limits:burn pick --unattended and do exactly what it prints. Do not start anything not on that list.';

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
  'burn add "<what to do>" [--size S|M|L] [--global | --repo <name>]',
  '                              write one line: this repo by default, global with',
  '                              --global, global and tagged with --repo',
  'burn pick [--unattended]      what fits in the budget that is about to expire;',
  '                              --unattended needs a clean tree and works on a branch',
  'burn done "<item>" | <n> | --all [--force]',
  '                              tick it off, close its issue, commit an unattended run',
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
  if (first === 'add') return add(at, args, options);
  if (first === 'done') return done(at, args, options);
  if (first === 'pick') return pick(at, args, options);
  return 'Unknown: ' + first + '\n' + HELP;
}

// Commands that can fail return { text, code }; the ones that were here before
// still return a string. Both callers unwrap the same way.
function spoken(out) {
  return typeof out === 'string' ? { text: out, code: 0 } : { text: out.text, code: out.code || 0 };
}

if (require.main === module) {
  main(process.argv.slice(2), Date.now()).then(
    (out) => {
      const said = spoken(out);
      process.stdout.write(said.text + '\n');
      process.exitCode = said.code;
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
  isGitRepo,
  gitHead,
  gitStatus,
  gitBranch,
  branchName,
  key,
  everywhere,
  findExisting,
  appendLine,
  tick,
  verify,
  spoken,
  reading,
  add,
  done,
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
