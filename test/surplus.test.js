'use strict';

// Use it or lose it.
//
// The failure this guards against is not a wrong number, it is a sentence that
// fires when it should not: "spend this, it is about to expire" said to a
// session that is in fact nearly out of budget would be the plugin producing
// the exact accident it exists to prevent. So most of these are about the
// gates - the reset has to be near, the waste has to be real, and it is said
// once a quarter of an hour rather than on every prompt.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const recommend = require('../skills/usage-limits/scripts/recommend.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-09-21T20:00:00.000Z');

function binding(overrides) {
  return Object.assign(
    { key: 'five_hour', label: '5-hour', percentUsed: 40, stale: false, msToReset: 40 * MINUTE },
    overrides
  );
}

/* ------------------------------------------------------------ the maths --- */

test('surplus is spendable against the clock, not against the limit', () => {
  // Forty minutes left at four turns an hour is under three turns spendable
  // against fifty left, so forty-seven of them are going to be destroyed.
  const reading = recommend.surplusOf({ binding: binding(), turnsLeft: 50, turnsPerHour: 4 });
  assert.strictEqual(reading.surplus, true);
  assert.ok(Math.abs(reading.spendableTurns - 8 / 3) < 0.01);
  assert.ok(Math.abs(reading.expiringTurns - (50 - 8 / 3)) < 0.01);
});

test('a pace that can spend the window is no surplus at all', () => {
  // Four hours left at thirty turns an hour against fifty left: the limit is
  // the constraint, not the clock, and nothing here is going to waste.
  const reading = recommend.surplusOf({
    binding: binding({ msToReset: 4 * HOUR }),
    turnsLeft: 50,
    turnsPerHour: 30,
  });
  assert.strictEqual(reading.surplus, false);
});

test('the margin is real: parity is not a surplus', () => {
  // Exactly enough time to spend it. At the factor of 0.8 this has to read as
  // no surplus, or every idle-ish window would carry the clause.
  const reading = recommend.surplusOf({
    binding: binding({ msToReset: HOUR }),
    turnsLeft: 10,
    turnsPerHour: 10,
  });
  assert.strictEqual(reading.surplus, false);
  // And just inside the margin still is not.
  assert.strictEqual(
    recommend.surplusOf({ binding: binding({ msToReset: HOUR }), turnsLeft: 10, turnsPerHour: 8.5 }).surplus,
    false
  );
});

test('a question that cannot be answered reads as unknown, not as no surplus', () => {
  for (const input of [
    { binding: null, turnsLeft: 50, turnsPerHour: 4 },
    { binding: binding({ stale: true }), turnsLeft: 50, turnsPerHour: 4 },
    { binding: binding({ msToReset: null }), turnsLeft: 50, turnsPerHour: 4 },
    { binding: binding({ msToReset: 0 }), turnsLeft: 50, turnsPerHour: 4 },
    { binding: binding(), turnsLeft: null, turnsPerHour: 4 },
    { binding: binding(), turnsLeft: 50, turnsPerHour: 0 },
    { binding: binding(), turnsLeft: 50, turnsPerHour: null },
  ]) {
    assert.strictEqual(recommend.surplusOf(input), null, JSON.stringify(input));
  }
});

test('decide and the clause read the same window the same way', () => {
  // The 'reset-first' posture and the brief's clause are one rule. A binding
  // window priced at a dollar a point with fifty-cent turns puts turnsLeft at
  // a hundred; four turns an hour cannot spend that in forty minutes.
  const decision = recommend.decide({
    binding: { key: 'five_hour', label: '5-hour', percentLeft: 50, usdPerPercent: 1, stale: false, msToReset: 40 * MINUTE },
    rates: { median: 0.5, high: 1, sample: 20 },
    settings: {},
    recentTurnsPerHour: 4,
  });
  assert.strictEqual(decision.posture, 'reset-first');
  assert.match(decision.reason, /resets before this pace can spend it/);
});

/* ------------------------------------------------------------ the gates --- */

test('the clause waits until the reset is near', () => {
  const far = recommend.surplusClause({
    binding: binding({ msToReset: 6 * HOUR }),
    turnsLeft: 400,
    turnsPerHour: 4,
  });
  assert.strictEqual(far, null, 'six hours out this is a forecast, not a plan');

  const near = recommend.surplusClause({ binding: binding(), turnsLeft: 50, turnsPerHour: 4 });
  assert.ok(near, 'forty minutes out it is a fact about tonight');
  assert.strictEqual(near.expiringTurns, 47);
  assert.strictEqual(near.spendableTurns, 3);
  assert.strictEqual(near.msToReset, 40 * MINUTE);
  assert.strictEqual(near.saidAt, null);
});

test('a handful of turns is not worth a sentence', () => {
  // Eight turns going to waste is under the floor of ten and says nothing
  // anybody would act on.
  const small = recommend.surplusClause({
    binding: binding({ msToReset: 30 * MINUTE }),
    turnsLeft: 9,
    turnsPerHour: 1,
  });
  assert.strictEqual(small, null);
  // The floor moves with the configuration rather than being baked in.
  const lowered = recommend.surplusClause({
    binding: binding({ msToReset: 30 * MINUTE }),
    turnsLeft: 9,
    turnsPerHour: 1,
    minTurns: 5,
  });
  assert.ok(lowered);
  assert.strictEqual(lowered.expiringTurns, 9);
});

test('the near-reset window is configurable too', () => {
  const opts = { binding: binding({ msToReset: 3 * HOUR }), turnsLeft: 200, turnsPerHour: 4 };
  assert.strictEqual(recommend.surplusClause(opts), null);
  assert.ok(recommend.surplusClause(Object.assign({ withinMinutes: 240 }, opts)));
});

/* ----------------------------------------------------------- the clause --- */

// Loaded after the assertions above so a failure in the pure arithmetic is not
// buried under a hook's worth of requires.
const brief = require('../skills/usage-limits/scripts/brief.js');
const usage = require('../skills/usage-limits/scripts/usage.js');

function parts(overrides) {
  return Object.assign(
    {
      binding: { key: 'five_hour', label: '5-hour', percentUsed: 40, stale: false },
      othersSummary: '',
      turnsLeft: 50,
      resetsIn: '40m',
      pressure: 'roomy',
      surplus: { expiringTurns: 47, spendableTurns: 3, msToReset: 40 * MINUTE, saidAt: null },
    },
    overrides
  );
}

test('standard says what will expire, in how long, and what to run', () => {
  const text = brief.briefText(parts());
  assert.match(
    text,
    /About 47 turns of this window will expire unused in 40m; if there is a backlog, this is the time to spend them \(run \/usage-limits:burn\)\./
  );
});

test('max says the same thing in eleven words', () => {
  const text = brief.briefText(parts({ mode: { policy: { briefStyle: 'terse' } } }));
  assert.match(text, /47 turns expire unused in 40m; \/usage-limits:burn\./);
  assert.doesNotMatch(text, /if there is a backlog/, 'the long form has no business in terse');
});

test('off says nothing, surplus or not', () => {
  assert.strictEqual(brief.briefText(parts({ mode: { policy: { briefStyle: 'none' } } })), '');
});

test('no surplus, no clause', () => {
  const text = brief.briefText(parts({ surplus: null }));
  assert.doesNotMatch(text, /expire unused/);
  assert.doesNotMatch(text, /usage-limits:burn/);
});

test('the reset time in the clause is the one the rest of the line quotes', () => {
  // The reading carries its own milliseconds so the clause can be built from a
  // reading alone, but where the line already says a reset it must not print a
  // second, differently rounded one beside it.
  const text = brief.briefText(parts({ resetsIn: '1h 2m', surplus: { expiringTurns: 47, spendableTurns: 3, msToReset: 3_700_000, saidAt: null } }));
  assert.match(text, /expire unused in 1h 2m/);
});

test('a pinned tier does not silence it: pinning governs switching, not spending', () => {
  const text = brief.briefText(
    parts({ mode: { policy: { briefStyle: 'normal' }, bounds: { pin: true, floor: { model: 'opus' } } } })
  );
  assert.match(text, /expire unused in 40m/);
});

/* ------------------------------------------------------- said once, ish --- */

test('the clause is said at most once a quarter of an hour per session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-surplus-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  // The said file follows the host: on a machine with Codex installed,
  // detection would otherwise put it in ~/.codex and this would be testing the
  // developer's own state.
  usage.setHost('claude');
  try {
    assert.strictEqual(brief.surplusSaidAt('s-1'), null, 'nothing said yet');
    assert.strictEqual(brief.surplusSayable('s-1', NOW), true);
    brief.markSurplus('s-1', NOW);

    assert.strictEqual(brief.surplusSaidAt('s-1'), NOW);
    assert.strictEqual(brief.surplusSayable('s-1', NOW + MINUTE), false, 'a minute later: silent');
    assert.strictEqual(brief.surplusSayable('s-1', NOW + 14 * MINUTE), false);
    assert.strictEqual(brief.surplusSayable('s-1', NOW + 15 * MINUTE), true, 'a quarter of an hour later: said');
    assert.strictEqual(brief.surplusSayable('s-2', NOW + MINUTE), true, 'another session hears it too');
    assert.strictEqual(brief.SURPLUS_REPEAT_MS, 15 * MINUTE);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the brief settings carry the two gates, and the environment can move them', () => {
  assert.strictEqual(brief.DEFAULTS.surplusWithinMinutes, 90);
  assert.strictEqual(brief.DEFAULTS.surplusMinTurns, 10);
  const saved = { within: process.env.USAGE_LIMITS_SURPLUS_WITHIN, min: process.env.USAGE_LIMITS_SURPLUS_MIN_TURNS };
  process.env.USAGE_LIMITS_SURPLUS_WITHIN = '30';
  process.env.USAGE_LIMITS_SURPLUS_MIN_TURNS = '4';
  try {
    const config = brief.settings();
    assert.strictEqual(config.surplusWithinMinutes, 30);
    assert.strictEqual(config.surplusMinTurns, 4);
  } finally {
    for (const [key, value] of [
      ['USAGE_LIMITS_SURPLUS_WITHIN', saved.within],
      ['USAGE_LIMITS_SURPLUS_MIN_TURNS', saved.min],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
