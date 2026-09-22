'use strict';

// The two ends of the backlog: getting something onto it, and getting it off
// again once it is actually done.
//
// What these tests are really protecting is a pair of silent failures. One is
// an item written to the wrong file - a global note that lands in a repo
// nobody will open again, or a repo note that follows you everywhere. The
// other is much worse: a run that does nothing, ticks the line off anyway and
// closes the issue, so the work disappears from the list without ever having
// happened. That is what the verification is for, and why the refusals here
// matter more than the successes.
//
// Nothing in this file may call the real `gh`, push anything, or touch a
// repository outside its own temporary directory.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const burn = require('../skills/usage-limits/scripts/burn.js');

const MINUTE = 60 * 1000;
const NOW = new Date('2026-09-22T20:00:00').getTime();

function git(repo, args) {
  const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(run.status, 0, 'git ' + args.join(' ') + ': ' + (run.stderr || ''));
  return run.stdout;
}

// A config directory and a repository of its own. The repository is a real
// one because half of what is under test is a git question: is the tree
// clean, has HEAD moved, which branch is checked out.
function withRepo(fn, options) {
  const opts = options || {};
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-add-cfg-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'burn-add-repo-')));
  const saved = { config: process.env.CLAUDE_CONFIG_DIR, backlog: process.env.USAGE_LIMITS_BACKLOG };
  process.env.CLAUDE_CONFIG_DIR = config;
  delete process.env.USAGE_LIMITS_BACKLOG;
  if (opts.git !== false) {
    git(repo, ['init', '-q', '--initial-branch=main', '.']);
    git(repo, ['config', 'user.email', 'burn@example.test']);
    git(repo, ['config', 'user.name', 'Burn Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'first']);
  }
  const restore = () => {
    if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.config;
    if (saved.backlog === undefined) delete process.env.USAGE_LIMITS_BACKLOG;
    else process.env.USAGE_LIMITS_BACKLOG = saved.backlog;
    fs.rmSync(config, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  };
  let result;
  try {
    result = fn({ config, repo });
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => {
        restore();
        return value;
      },
      (err) => {
        restore();
        throw err;
      }
    );
  }
  restore();
  return result;
}

function reading(expiringTurns) {
  return {
    binding: {
      key: 'five_hour',
      label: '5-hour',
      percentUsed: 40,
      stale: false,
      msToReset: 40 * MINUTE,
      resetsAt: NOW + 40 * MINUTE,
    },
    turnsLeft: 50,
    surplus: Number.isFinite(expiringTurns)
      ? { expiringTurns, spendableTurns: 3, msToReset: 40 * MINUTE, saidAt: null }
      : null,
  };
}

// Every command that can refuse returns { text, code }; the older ones return
// a string. `spoken` is what both callers use, so the tests use it too.
async function run(argv, options, now) {
  return burn.spoken(await burn.main(argv, Number.isFinite(now) ? now : NOW, options));
}

function commitAll(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message || 'work']);
}

/* --------------------------------------------------------------- add ------ */

test('add with no flag writes to this repository, with its size', async () => {
  await withRepo(async ({ repo, config }) => {
    const said = await run(['add', 'Fix the flaky drift test', '--size', 'S'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(said.code, 0);
    assert.match(said.text, /^- Fix the flaky drift test ~S$/m);
    assert.match(said.text, new RegExp('-> ' + repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/BACKLOG\\.md'));
    assert.match(fs.readFileSync(path.join(repo, 'BACKLOG.md'), 'utf8'), /^- Fix the flaky drift test ~S$/m);
    assert.strictEqual(fs.existsSync(path.join(config, 'backlog.md')), false, 'the global file is not touched');
  });
});

test('add --global writes to the global file, untagged', async () => {
  await withRepo(async ({ repo, config }) => {
    const said = await run(['add', 'Upgrade node everywhere', '--global'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(said.code, 0);
    assert.match(said.text, /^- Upgrade node everywhere ~M$/m);
    const global = fs.readFileSync(path.join(config, 'backlog.md'), 'utf8');
    assert.match(global, /^- Upgrade node everywhere ~M$/m);
    assert.doesNotMatch(global, /@/);
    assert.strictEqual(fs.existsSync(path.join(repo, 'BACKLOG.md')), false);
  });
});

test('add --repo writes to the global file, tagged, and says when there is no such directory', async () => {
  await withRepo(async ({ repo, config }) => {
    const said = await run(['add', 'Fix auth redirect', '--repo', 'no-such-repo-anywhere'], {
      cwd: repo,
      root: repo,
      gh: false,
    });
    assert.strictEqual(said.code, 0);
    assert.match(said.text, /^- Fix auth redirect @no-such-repo-anywhere ~M$/m);
    assert.match(said.text, /No directory named "no-such-repo-anywhere" was found; the tag is a label/);
    assert.match(fs.readFileSync(path.join(config, 'backlog.md'), 'utf8'), /@no-such-repo-anywhere ~M$/m);

    // And the tag is one `taggedForRepo` already understands, so the item is
    // invisible from here and visible from there.
    const here = burn.collect({ root: repo, gh: false });
    assert.deepStrictEqual(here.items.map((item) => item.text), []);
  });
});

test('--global and --repo together is a refusal, and writes nothing', async () => {
  await withRepo(async ({ repo, config }) => {
    const said = await run(['add', 'Something', '--global', '--repo', 'kosha'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(said.code, 1);
    assert.match(said.text, /--global and --repo say different things/);
    assert.strictEqual(fs.existsSync(path.join(config, 'backlog.md')), false);
    assert.strictEqual(fs.existsSync(path.join(repo, 'BACKLOG.md')), false);
  });
});

test('add refuses nonsense rather than writing it', async () => {
  await withRepo(async ({ repo }) => {
    assert.strictEqual((await run(['add'], { cwd: repo, root: repo, gh: false })).code, 1);
    const size = await run(['add', 'A thing', '--size', 'XL'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(size.code, 1);
    assert.match(size.text, /Unknown size "XL"; it is S, M or L\./);
    assert.strictEqual(fs.existsSync(path.join(repo, 'BACKLOG.md')), false);
  });
});

test('a lowercase size is a size', async () => {
  await withRepo(async ({ repo }) => {
    await run(['add', 'A small thing', '--size', 's'], { cwd: repo, root: repo, gh: false });
    assert.match(fs.readFileSync(path.join(repo, 'BACKLOG.md'), 'utf8'), /~S$/m);
  });
});

test('add creates the file with a header, then appends without touching what is there', async () => {
  await withRepo(async ({ repo }) => {
    await run(['add', 'First'], { cwd: repo, root: repo, gh: false });
    const file = path.join(repo, 'BACKLOG.md');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# Backlog\n\n- First ~M\n');
    await run(['add', 'Second'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# Backlog\n\n- First ~M\n- Second ~M\n');
  });
});

test('a file written with CRLF stays a file written with CRLF', async () => {
  await withRepo(async ({ repo }) => {
    const file = path.join(repo, 'BACKLOG.md');
    fs.writeFileSync(file, '# Backlog\r\n\r\n- Already here ~M\r\n');
    await run(['add', 'Newcomer'], { cwd: repo, root: repo, gh: false });
    const text = fs.readFileSync(file, 'utf8');
    assert.strictEqual(text, '# Backlog\r\n\r\n- Already here ~M\r\n- Newcomer ~M\r\n');
  });
});

test('a file with no trailing newline gets one rather than a joined line', async () => {
  await withRepo(async ({ repo }) => {
    const file = path.join(repo, 'BACKLOG.md');
    fs.writeFileSync(file, '- Already here ~M');
    await run(['add', 'Newcomer'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '- Already here ~M\n- Newcomer ~M\n');
  });
});

test('an item already written down anywhere is not written again', async () => {
  await withRepo(async ({ repo, config }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the flaky drift test ~S\n');
    fs.writeFileSync(path.join(config, 'backlog.md'), '- Fix auth redirect @kosha ~M\n');

    // Spacing and case are the only differences forgiven, and the @tag comes
    // off before the comparison: it is a label, not part of the item.
    const repeat = await run(['add', 'fix   the FLAKY drift test'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(repeat.code, 0, 'already there is not a failure');
    assert.match(repeat.text, /Already on the backlog, so nothing was written:/);
    assert.match(repeat.text, /Fix the flaky drift test/);

    const tagged = await run(['add', 'Fix auth redirect', '--global'], { cwd: repo, root: repo, gh: false });
    assert.match(tagged.text, /Already on the backlog/);

    assert.strictEqual(fs.readFileSync(path.join(repo, 'BACKLOG.md'), 'utf8'), '- Fix the flaky drift test ~S\n');
    assert.strictEqual(fs.readFileSync(path.join(config, 'backlog.md'), 'utf8'), '- Fix auth redirect @kosha ~M\n');
  });
});

/* -------------------------------------------------------------- done ------ */

test('done ticks the line in whichever file holds it', async () => {
  await withRepo(async ({ repo, config }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '# Backlog\n\n- [ ] Fix the flaky drift test ~S\n');
    fs.writeFileSync(path.join(config, 'backlog.md'), '- Upgrade node everywhere ~M\n');
    commitAll(repo, 'backlog');

    // Something happened, so the verification has no objection.
    fs.writeFileSync(path.join(repo, 'fixed.txt'), 'the work\n');

    const one = await run(['done', 'Fix the flaky drift test'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(one.code, 0);
    assert.match(one.text, /- \[x\] Fix the flaky drift test ~S/);
    assert.match(fs.readFileSync(path.join(repo, 'BACKLOG.md'), 'utf8'), /^- \[x\] Fix the flaky drift test ~S$/m);

    const two = await run(['done', 'Upgrade node everywhere'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(two.code, 0);
    assert.match(fs.readFileSync(path.join(config, 'backlog.md'), 'utf8'), /^- \[x\] Upgrade node everywhere ~M$/m);

    // A ticked item is not work, so it is gone from the backlog entirely.
    assert.deepStrictEqual(burn.collect({ root: repo, gh: false }).items, []);
  });
});

test('an item that was an issue is closed, and a failure to close it is said rather than thrown', async () => {
  await withRepo(async ({ repo }) => {
    const calls = [];
    const options = {
      cwd: repo,
      root: repo,
      gh: false,
      closeIssue: (number, root) => {
        calls.push([number, root]);
        return { ok: true };
      },
    };
    // The plan is the only place a gh item exists once `gh` is not consulted,
    // which is exactly how an unattended run meets one.
    burn.writeRecord({
      plan: { at: NOW, root: repo, head: burn.gitHead(repo), status: '', dirty: false, unattended: false, branch: null, items: [{ text: '#12 Fix the login redirect', size: 'M', turns: 25, source: 'gh' }] },
    });
    fs.writeFileSync(path.join(repo, 'fixed.txt'), 'the work\n');

    const closed = await run(['done', '1'], options);
    assert.strictEqual(closed.code, 0);
    assert.deepStrictEqual(calls, [['12', repo]]);
    assert.match(closed.text, /Closed issue #12\./);

    const failing = await run(['done', '#12 Fix the login redirect'], {
      ...options,
      closeIssue: () => ({ ok: false, error: 'gh: not logged in' }),
    });
    assert.strictEqual(failing.code, 0, 'a failed close is not a failed run');
    assert.match(failing.text, /Could not close issue #12: gh: not logged in\. Close it by hand\./);
  });
});

test('nothing changed since the plan means nothing gets ticked off', async () => {
  await withRepo(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the flaky drift test ~S\n');
    commitAll(repo, 'backlog');
    const options = { cwd: repo, root: repo, gh: false, reading: reading(40), backlog: burn.collect({ root: repo, gh: false }) };

    const plan = await run(['pick'], options);
    assert.strictEqual(plan.code, 0);
    assert.match(plan.text, /Plan, 8 of 40 turns:/);
    const recorded = burn.readRecord().plan;
    assert.strictEqual(recorded.head, burn.gitHead(repo));
    assert.strictEqual(recorded.status, '');
    assert.strictEqual(recorded.dirty, false);

    const refused = await run(['done', 'Fix the flaky drift test'], options);
    assert.strictEqual(refused.code, 1);
    assert.match(refused.text, /Nothing has changed since `burn pick` printed the plan/);
    assert.match(refused.text, /HEAD is still [0-9a-f]{7}, the commit `burn pick` recorded/);
    assert.match(refused.text, /git status --porcelain is byte for byte what it was then \(clean then, clean now\)/);
    assert.match(refused.text, /--force to tick it off anyway/);
    assert.doesNotMatch(fs.readFileSync(path.join(repo, 'BACKLOG.md'), 'utf8'), /\[x\]/);

    // --force is the override, and it says so.
    const forced = await run(['done', 'Fix the flaky drift test', '--force'], options);
    assert.strictEqual(forced.code, 0);
    assert.match(forced.text, /^--force: nothing has changed since `burn pick` printed the plan/m);
    assert.match(fs.readFileSync(path.join(repo, 'BACKLOG.md'), 'utf8'), /- \[x\] Fix the flaky drift test/);
  });
});

test('work that happened is work, whether it was committed or only started', async () => {
  await withRepo(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the flaky drift test ~S\n- Upgrade node ~M\n');
    commitAll(repo, 'backlog');
    const options = { cwd: repo, root: repo, gh: false, reading: reading(40), backlog: burn.collect({ root: repo, gh: false }) };
    await run(['pick'], options);

    // A commit moves HEAD, which is enough on its own.
    fs.writeFileSync(path.join(repo, 'one.txt'), 'a\n');
    commitAll(repo, 'the first item');
    const first = await run(['done', '1'], options);
    assert.strictEqual(first.code, 0);
    assert.match(first.text, /- \[x\] Fix the flaky drift test/);
  });
});

test('outside a git repository there is nothing to verify, and it says so', async () => {
  await withRepo(
    async ({ repo }) => {
      fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the flaky drift test ~S\n');
      const said = await run(['done', 'Fix the flaky drift test'], { cwd: repo, root: repo, gh: false });
      assert.strictEqual(said.code, 0);
      assert.match(said.text, /Not a git repository, so there is nothing to compare against; ticking on trust\./);
      assert.match(fs.readFileSync(path.join(repo, 'BACKLOG.md'), 'utf8'), /- \[x\]/);
    },
    { git: false }
  );
});

test('an ambiguous name is a question, not a guess', async () => {
  await withRepo(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the drift test ~S\n- Fix the drift docs ~S\n');
    commitAll(repo, 'backlog');
    fs.writeFileSync(path.join(repo, 'work.txt'), 'something\n');

    const said = await run(['done', 'drift'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(said.code, 1);
    assert.match(said.text, /"drift" matches 2 items:/);
    assert.match(said.text, /Fix the drift test/);
    assert.match(said.text, /Fix the drift docs/);
    assert.doesNotMatch(fs.readFileSync(path.join(repo, 'BACKLOG.md'), 'utf8'), /\[x\]/);

    // In full, it is not ambiguous at all.
    const exact = await run(['done', 'Fix the drift docs'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(exact.code, 0);

    const missing = await run(['done', 'something nobody wrote down'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(missing.code, 1);
    assert.match(missing.text, /Nothing on the backlog matches/);
  });
});

test('--all ticks off everything the plan named', async () => {
  await withRepo(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the drift test ~S\n- Upgrade node ~M\n');
    commitAll(repo, 'backlog');
    const options = { cwd: repo, root: repo, gh: false, reading: reading(40), backlog: burn.collect({ root: repo, gh: false }) };
    await run(['pick'], options);
    fs.writeFileSync(path.join(repo, 'work.txt'), 'both of them\n');

    const said = await run(['done', '--all'], options);
    assert.strictEqual(said.code, 0);
    const text = fs.readFileSync(path.join(repo, 'BACKLOG.md'), 'utf8');
    assert.match(text, /- \[x\] Fix the drift test/);
    assert.match(text, /- \[x\] Upgrade node/);
  });
});

/* -------------------------------------------------------- unattended ------ */

test('an unattended pick will not touch a dirty tree', async () => {
  await withRepo(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the drift test ~S\n');
    commitAll(repo, 'backlog');
    fs.writeFileSync(path.join(repo, 'half-done.txt'), 'work in progress\n');

    const said = await run(['pick', '--unattended'], {
      cwd: repo,
      root: repo,
      gh: false,
      reading: reading(40),
      backlog: burn.collect({ root: repo, gh: false }),
    });
    assert.strictEqual(said.code, 1);
    assert.match(said.text, /The working tree is not clean/);
    assert.match(said.text, /\?\? half-done\.txt/);
    assert.match(said.text, /Nothing was started and nothing was scheduled\./);
    assert.strictEqual(burn.gitBranch(repo), 'main', 'and no branch was made');
    assert.strictEqual(burn.readRecord(), null, 'and no plan was recorded');
  });
});

test('an unattended pick works on a branch of its own, and says so first', async () => {
  await withRepo(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the drift test ~S\n');
    commitAll(repo, 'backlog');
    const started = burn.gitHead(repo);

    const said = await run(['pick', '--unattended'], {
      cwd: repo,
      root: repo,
      gh: false,
      reading: reading(40),
      backlog: burn.collect({ root: repo, gh: false }),
    });
    assert.strictEqual(said.code, 0);
    const branch = 'burn/2026-09-22-1';
    assert.match(said.text.split('\n')[0], new RegExp('^On branch ' + branch.replace('/', '\\/') + ', cut from [0-9a-f]{7}\\.'));
    assert.match(said.text, /nothing is pushed and the branch you were on is untouched/);
    assert.match(said.text, /Plan, 8 of 40 turns:/);
    assert.strictEqual(burn.gitBranch(repo), branch);

    const plan = burn.readRecord().plan;
    assert.strictEqual(plan.branch, branch);
    assert.strictEqual(plan.head, started, 'the branch starts where the work started');
    assert.strictEqual(plan.unattended, true);

    // And done commits there, naming what it did, without pushing.
    fs.writeFileSync(path.join(repo, 'fixed.txt'), 'the work\n');
    const finished = await run(['done', '--all'], { cwd: repo, root: repo, gh: false });
    assert.strictEqual(finished.code, 0);
    assert.match(finished.text, /Committed [0-9a-f]{7} to burn\/2026-09-22-1: burn: Fix the drift test\./);
    assert.match(finished.text, /Review that branch and merge or drop it; nothing was pushed\./);
    assert.strictEqual(burn.gitBranch(repo), branch, 'still on the burn branch');
    assert.strictEqual(git(repo, ['log', '-1', '--pretty=%s']).trim(), 'burn: Fix the drift test');
    // The default branch never moved.
    assert.strictEqual(git(repo, ['rev-parse', 'main']).trim(), started);
  });
});

test('a second unattended run the same day gets its own branch', async () => {
  await withRepo(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the drift test ~S\n- Upgrade node ~M\n');
    commitAll(repo, 'backlog');
    assert.strictEqual(burn.branchName(repo, NOW), 'burn/2026-09-22-1');
    git(repo, ['branch', 'burn/2026-09-22-1']);
    assert.strictEqual(burn.branchName(repo, NOW), 'burn/2026-09-22-2');
  });
});

test('an unattended pick refuses a directory that is not a repository', async () => {
  await withRepo(
    async ({ repo }) => {
      fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the drift test ~S\n');
      const said = await run(['pick', '--unattended'], {
        cwd: repo,
        root: repo,
        gh: false,
        reading: reading(40),
        backlog: burn.collect({ root: repo, gh: false }),
      });
      assert.strictEqual(said.code, 1);
      assert.match(said.text, /Not a git repository/);
      assert.match(said.text, /has no undo, so nothing was started/);
      assert.strictEqual(burn.readRecord(), null);
    },
    { git: false }
  );
});

test('an unattended pick with nothing on the backlog does not go looking', async () => {
  await withRepo(async ({ repo }) => {
    const said = await run(['pick', '--unattended'], {
      cwd: repo,
      root: repo,
      gh: false,
      reading: reading(40),
      backlog: burn.collect({ root: repo, gh: false }),
    });
    assert.strictEqual(said.code, 0);
    assert.match(said.text, /nothing on the backlog\. Nothing to do\./);
    assert.doesNotMatch(said.text, /Suggest 3-5 candidates/);
  });
});

test('an interactive pick is unchanged: no branch, no clean-tree demand', async () => {
  await withRepo(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the drift test ~S\n');
    const said = await run(['pick'], {
      cwd: repo,
      root: repo,
      gh: false,
      reading: reading(40),
      backlog: burn.collect({ root: repo, gh: false }),
    });
    assert.strictEqual(said.code, 0);
    assert.strictEqual(burn.gitBranch(repo), 'main');
    assert.doesNotMatch(said.text, /On branch/);
    assert.match(said.text.split('\n')[0], /^About 40 turns will expire unused/);
    assert.strictEqual(burn.readRecord().plan.branch, null);
  });
});

test('the wake asks for the unattended form, and still names nothing but pick', () => {
  assert.match(burn.WAKE_PROMPT, /^Run \/usage-limits:burn pick --unattended and do exactly what it prints\./);
  assert.match(burn.WAKE_PROMPT, /Do not start anything not on that list\.$/);
  assert.strictEqual(burn.WAKE_PROMPT.match(/burn [a-z]+/g).join(','), 'burn pick');
});

test('help mentions the two new commands', async () => {
  const help = burn.spoken(await burn.main(['help'], NOW)).text;
  assert.match(help, /burn add /);
  assert.match(help, /burn done /);
  assert.match(help, /--unattended/);
});
