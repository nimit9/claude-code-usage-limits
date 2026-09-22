'use strict';

// Spending budget that would otherwise be destroyed.
//
// The risk here is not a wrong turn count, it is a scheduled task that starts
// a session at midnight with nothing written down for it to do. So the tests
// that matter most are the refusals: an empty backlog does not arm, and
// arming twice for the same moment does not book two wakes.
//
// Nothing in this file may register a real scheduled task. relay.arm takes
// `schedule: false` for exactly that, and burn.main passes it through.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const burn = require('../skills/usage-limits/scripts/burn.js');
const relay = require('../skills/usage-limits/scripts/relay.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-09-21T20:00:00').getTime();
const SIZES = burn.DEFAULT_SIZES;

// A config directory and a working directory of its own, because both the
// global backlog and the armed record live in the first and BACKLOG.md lives
// in the second. Without this the suite would read the developer's own list.
function withDirs(fn) {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-burn-cfg-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-burn-repo-'));
  const saved = { config: process.env.CLAUDE_CONFIG_DIR, backlog: process.env.USAGE_LIMITS_BACKLOG };
  process.env.CLAUDE_CONFIG_DIR = config;
  delete process.env.USAGE_LIMITS_BACKLOG;
  // Half of what is being tested is asynchronous, and a `finally` around a
  // promise-returning body tears the directories down while the body is still
  // using them - which failed as ENOENT on a file the test had just written.
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

// A binding window with a known surplus, so `pick` never has to touch the real
// account or scan a transcript.
function reading(expiringTurns) {
  return {
    binding: { key: 'five_hour', label: '5-hour', percentUsed: 40, stale: false, msToReset: 40 * MINUTE, resetsAt: NOW + 40 * MINUTE },
    turnsLeft: 50,
    surplus: Number.isFinite(expiringTurns)
      ? { expiringTurns, spendableTurns: 3, msToReset: 40 * MINUTE, saidAt: null }
      : null,
  };
}

/* ----------------------------------------------------------- the parsing -- */

test('a backlog is whatever somebody would have written anyway', () => {
  const items = burn.parseBacklog(
    [
      '# Backlog',
      '',
      '- [x] Already done',
      '- [X] Also done',
      '- Fix the flaky drift test ~S',
      '* Rewrite the calibration pass ~L',
      '- [ ] Document the relay permission mode',
      '  - An indented one counts too ~s',
      '',
      'A paragraph that is not a list item.',
      '-',
    ].join('\n'),
    'BACKLOG.md',
    SIZES
  );
  assert.deepStrictEqual(
    items.map((item) => [item.text, item.size, item.turns]),
    [
      ['Fix the flaky drift test', 'S', SIZES.S],
      ['Rewrite the calibration pass', 'L', SIZES.L],
      ['Document the relay permission mode', 'M', SIZES.M],
      ['An indented one counts too', 'S', SIZES.S],
    ]
  );
  assert.strictEqual(items[0].source, 'BACKLOG.md');
});

test('a ticked item is not work', () => {
  assert.strictEqual(burn.parseBacklog('- [x] done\n- [X] done too', 'x', SIZES).length, 0);
});

test('an item can name the repository it belongs to', () => {
  const [item] = burn.parseBacklog('- Tidy the panel colours @paisa ~S', 'x', SIZES);
  assert.strictEqual(item.repo, 'paisa');
  assert.strictEqual(item.size, 'S');
  // The tag stays in the text: whoever reads the plan needs to know where the
  // work is, and the size tag is the only thing that is machinery.
  assert.match(item.text, /@paisa/);
});

test('a repository is named by its path or by its name', () => {
  const root = '/Users/someone/projects/paisa';
  assert.strictEqual(burn.taggedForRepo(null, root), true, 'untagged belongs anywhere');
  assert.strictEqual(burn.taggedForRepo('paisa', root), true);
  assert.strictEqual(burn.taggedForRepo('/Users/someone/projects/paisa', root), true);
  assert.strictEqual(burn.taggedForRepo('/Users/someone/projects/paisa/', root), true);
  assert.strictEqual(burn.taggedForRepo('other', root), false);
});

test('the two files merge, deduplicated, repo first', () => {
  withDirs(({ config, repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the drift test ~S\n- Shared line\n');
    fs.writeFileSync(
      path.join(config, 'backlog.md'),
      ['- shared LINE', '- Upgrade node everywhere ~M', '- Not here @somewhere-else ~L'].join('\n')
    );
    // gh is off: a machine with it installed and a repository on GitHub would
    // otherwise make this test depend on somebody's issue list.
    const found = burn.collect({ root: repo, gh: false });
    assert.deepStrictEqual(
      found.items.map((item) => item.text),
      ['Fix the drift test', 'Shared line', 'Upgrade node everywhere']
    );
    assert.strictEqual(found.items[0].source, 'BACKLOG.md');
    assert.strictEqual(found.items[2].source, path.join(config, 'backlog.md'));
    assert.strictEqual(found.sources.length, 2);
  });
});

test('no files at all is an empty backlog, not a failure', () => {
  withDirs(({ repo }) => {
    const found = burn.collect({ root: repo, gh: false });
    assert.deepStrictEqual(found.items, []);
    assert.deepStrictEqual(found.sources, []);
  });
});

/* ---------------------------------------------------------- the choosing -- */

test('greedy, in the order the sources were preferred', () => {
  const items = [
    { text: 'a', turns: 8 },
    { text: 'b', turns: 60 },
    { text: 'c', turns: 25 },
    { text: 'd', turns: 8 },
  ];
  const { chosen, spent } = burn.pickItems(items, 45);
  // b does not fit and is stepped over rather than ending the list.
  assert.deepStrictEqual(chosen.map((item) => item.text), ['a', 'c', 'd']);
  assert.strictEqual(spent, 41);
  assert.deepStrictEqual(burn.pickItems(items, 5).chosen, []);
});

test('no surplus prints the reading and stops', async () => {
  await withDirs(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the drift test ~S\n');
    const said = await burn.main(['pick'], NOW, {
      cwd: repo,
      reading: reading(null),
      backlog: burn.collect({ root: repo, gh: false }),
    });
    assert.match(said, /5-hour window, about 50 turns left, resets in 40m/);
    assert.match(said, /No surplus right now; nothing to burn\./);
  });
});

test('surplus and no backlog asks, and asks before starting', async () => {
  await withDirs(async ({ repo }) => {
    const said = await burn.main(['pick'], NOW, {
      cwd: repo,
      reading: reading(47),
      backlog: burn.collect({ root: repo, gh: false }),
    });
    assert.match(said, /Surplus of 47 turns and no backlog\./);
    assert.match(said, /Suggest 3-5 candidates from this repo/);
    assert.match(said, /ask before starting any\./);
  });
});

test('surplus and a backlog is a plan, with the budget on it', async () => {
  await withDirs(async ({ repo }) => {
    fs.writeFileSync(
      path.join(repo, 'BACKLOG.md'),
      ['- Fix the flaky drift test ~S', '- Rewrite the calibration pass ~L', '- Document the permission mode ~M'].join('\n')
    );
    const said = await burn.main([], NOW, {
      cwd: repo,
      reading: reading(40),
      backlog: burn.collect({ root: repo, gh: false }),
    });
    assert.match(said, /About 40 turns will expire unused in 40m/);
    // 8 + 25 fits in 40; the 60 turn item does not and is stepped over.
    assert.match(said, /Plan, 33 of 40 turns:/);
    assert.match(said, /1\. \[S, 8\] Fix the flaky drift test/);
    assert.match(said, /2\. \[M, 25\] Document the permission mode/);
    assert.doesNotMatch(said, /Rewrite the calibration pass/);
    assert.match(said, /Do these now, in order; stop when the window resets or the list ends/);
    assert.match(said, /mark each done in its BACKLOG\.md line \(`- \[x\]`\)/);
  });
});

test('list says what it found and where, and what to do when it found nothing', async () => {
  await withDirs(async ({ repo }) => {
    const empty = await burn.main(['list'], NOW, { cwd: repo, backlog: burn.collect({ root: repo, gh: false }) });
    assert.strictEqual(empty, burn.EMPTY);
    assert.match(empty, /BACKLOG\.md in this repo or ~\/\.claude\/backlog\.md/);
    assert.match(empty, /label GitHub issues `burn`/);

    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the flaky drift test ~S\n');
    const listed = await burn.main(['list'], NOW, { cwd: repo, backlog: burn.collect({ root: repo, gh: false }) });
    assert.match(listed, /\[S, {2}8\] Fix the flaky drift test {3}\(BACKLOG\.md\)/);
    assert.match(listed, /1 item, 8 turns in all/);
  });
});

/* ------------------------------------------------------------- the wake --- */

test('an empty backlog never books a wake', async () => {
  await withDirs(async ({ repo }) => {
    const said = await burn.main(['arm'], NOW, {
      cwd: repo,
      reading: reading(47),
      backlog: burn.collect({ root: repo, gh: false }),
      schedule: false,
    });
    assert.strictEqual(said, 'Nothing queued; not arming.');
    assert.strictEqual(burn.readRecord(), null, 'nothing recorded');
    assert.strictEqual(relay.read().armed, null, 'and nothing armed');
  });
});

test('a backlog too small to be worth waking for does not wake', async () => {
  await withDirs(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- One small thing ~S\n');
    const said = await burn.main(['arm', '--min-turns', '20'], NOW, {
      cwd: repo,
      reading: reading(47),
      backlog: burn.collect({ root: repo, gh: false }),
      schedule: false,
    });
    assert.match(said, /Only 8 turns of backlog, under the 20 turn floor; not arming\./);
    assert.strictEqual(burn.readRecord(), null);
  });
});

test('arming records the wake, and arming again for the same moment does not', async () => {
  await withDirs(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the flaky drift test ~S\n- Upgrade node ~M\n');
    const backlog = burn.collect({ root: repo, gh: false });
    const options = { cwd: repo, reading: reading(47), backlog, schedule: false };
    const argv = ['arm', '--session-id', 'burn-test', '--before', '20'];

    const first = await burn.main(argv, NOW, options);
    if (/no .* command was found on PATH/.test(first)) {
      // A machine with no Claude Code binary on PATH cannot be woken, and
      // saying so and stopping is the whole behaviour. There is nothing else
      // to assert here.
      assert.strictEqual(burn.readRecord(), null);
      return;
    }
    assert.match(first, /Armed for /);
    assert.match(first, /2 items \(33 turns\) queued/);
    assert.match(first, /run \/usage-limits:burn pick and nothing else/);

    const record = burn.readRecord();
    assert.ok(record, 'the arm is recorded');
    assert.strictEqual(record.sessionId, 'burn-test');
    assert.strictEqual(record.cwd, repo);
    assert.strictEqual(record.armedAt, NOW);
    // Twenty minutes before the reset, not after it: the point is to spend the
    // window that is ending, not the one that starts.
    assert.strictEqual(record.wakeAt, NOW + 20 * MINUTE);
    assert.deepStrictEqual(record.items.map((item) => item.text), ['Fix the flaky drift test', 'Upgrade node']);

    const again = await burn.main(argv, NOW + MINUTE, options);
    assert.match(again, /Already armed for /);
    assert.deepStrictEqual(burn.readRecord(), record, 'the record is untouched');

    // And the prompt the wake will deliver names `pick` and nothing else, so
    // an unattended run cannot reach past the list.
    assert.match(burn.WAKE_PROMPT, /^Run \/usage-limits:burn pick and do exactly what it prints\./);
    assert.match(burn.WAKE_PROMPT, /Do not start anything not on that list\.$/);

    const cancelled = await burn.main(['cancel'], NOW + 2 * MINUTE, options);
    assert.match(cancelled, /Cancelled the burn booked for /);
    assert.strictEqual(burn.readRecord(), null, 'the record is gone');
    assert.strictEqual(relay.read().armed, null, 'and so is the wake');
  });
});

test('an unknown reset time is said rather than guessed at', async () => {
  await withDirs(async ({ repo }) => {
    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the flaky drift test ~S\n- Upgrade node ~M\n');
    const said = await burn.main(['arm'], NOW, {
      cwd: repo,
      backlog: burn.collect({ root: repo, gh: false }),
      reading: { binding: { key: 'five_hour', label: '5-hour', resetsAt: null }, turnsLeft: null, surplus: null },
      schedule: false,
    });
    assert.match(said, /reset time is not known|no .* command was found on PATH/);
    assert.strictEqual(burn.readRecord(), null);
  });
});

test('cancel with nothing armed says so rather than throwing', async () => {
  await withDirs(async () => {
    assert.strictEqual(await burn.main(['cancel'], NOW), 'Nothing was armed.');
  });
});

test('status reports the armed state and the sources, armed or not', async () => {
  await withDirs(async ({ repo }) => {
    const bare = await burn.main(['status'], NOW, { cwd: repo, backlog: burn.collect({ root: repo, gh: false }) });
    assert.match(bare, /^Nothing armed\./m);
    assert.match(bare, /Backlog: empty\./);

    fs.writeFileSync(path.join(repo, 'BACKLOG.md'), '- Fix the flaky drift test ~S\n');
    burn.writeRecord({ sessionId: 's', cwd: repo, wakeAt: NOW + 30 * MINUTE, items: [{ text: 'a' }], armedAt: NOW });
    const armed = await burn.main(['status'], NOW, { cwd: repo, backlog: burn.collect({ root: repo, gh: false }) });
    assert.match(armed, /Armed for .*\(in 30m\), 1 item queued\./);
    assert.match(armed, /Backlog: 1 item, 8 turns, from .*BACKLOG\.md\./);
  });
});

test('the record lives beside the other caches and honours CLAUDE_CONFIG_DIR', () => {
  withDirs(({ config }) => {
    assert.strictEqual(burn.recordFile(), path.join(config, 'usage-limits-burn.json'));
    assert.strictEqual(burn.globalBacklogFile(), path.join(config, 'backlog.md'));
    process.env.USAGE_LIMITS_BACKLOG = path.join(config, 'elsewhere.md');
    assert.strictEqual(burn.globalBacklogFile(), path.join(config, 'elsewhere.md'));
  });
});

test('the sizes are configurable, and nonsense falls back to the defaults', () => {
  const saved = process.env.USAGE_LIMITS_BURN_S;
  try {
    assert.deepStrictEqual(burn.sizes(), { S: 8, M: 25, L: 60 });
    process.env.USAGE_LIMITS_BURN_S = '3';
    assert.strictEqual(burn.sizes().S, 3);
    process.env.USAGE_LIMITS_BURN_S = 'lots';
    assert.strictEqual(burn.sizes().S, 8);
  } finally {
    if (saved === undefined) delete process.env.USAGE_LIMITS_BURN_S;
    else process.env.USAGE_LIMITS_BURN_S = saved;
  }
});

test('help is reachable without touching the account or the scheduler', async () => {
  assert.match(await burn.main(['help'], NOW), /burn pick/);
  assert.match(await burn.main(['wat'], NOW), /^Unknown: wat/);
});
