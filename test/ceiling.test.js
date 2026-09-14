'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ceiling = require('../skills/usage-limits/scripts/ceiling.js');

const NO_ENV = {};

// A cap belongs to the session that set it. These helpers keep that fact in
// one place: `capped(60)` is a stored cap owned by SESSION, and every assess
// below passes that same id. A cap with no session, or another session's, is
// covered by its own tests further down.
const SESSION = 'session-that-set-it';
function capped(percent) {
  return { ceilingPercent: percent, ceilingSession: SESSION };
}

test('isMultiplier matches the fan-out calls and nothing else', () => {
  for (const name of ['Agent', 'Task', 'Workflow', 'Subagent', 'Dispatch']) {
    assert.equal(ceiling.isMultiplier(name), true, name + ' should be a multiplier');
  }
  // Antigravity spells its tools in snake_case, lowercased from the step type.
  assert.equal(ceiling.isMultiplier('task'), true);
  assert.equal(ceiling.isMultiplier('spawn_subagent'), true);
  // Everything that saves work, reads, or runs a test must stay allowed at any
  // percentage. This list is the whole safety argument for the feature.
  for (const name of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'run_command', 'view_file', '']) {
    assert.equal(ceiling.isMultiplier(name), false, name + ' must not be a multiplier');
  }
});

test('a ceiling nobody set never refuses anything', () => {
  const at = ceiling.assess({ percent: 99, state: {}, env: NO_ENV, sessionId: SESSION });
  assert.equal(at.set, false);
  assert.equal(at.over, false);
  assert.equal(ceiling.verdict(at, 'Agent').decision, 'allow');
});

test('a ceiling with no reading behind it never refuses anything', () => {
  // Guessing high would block work over a number nobody measured.
  const at = ceiling.assess({ percent: null, state: capped(60), env: NO_ENV, sessionId: SESSION });
  assert.equal(at.set, true);
  assert.equal(at.over, false);
  assert.equal(ceiling.verdict(at, 'Agent').decision, 'allow');
});

test('below the ceiling nothing is refused', () => {
  const at = ceiling.assess({ percent: 40, state: capped(60), env: NO_ENV, sessionId: SESSION });
  assert.equal(at.over, false);
  assert.equal(at.near, false);
  assert.equal(ceiling.verdict(at, 'Agent').decision, 'allow');
  assert.equal(ceiling.warning(at), null);
});

test('near the ceiling it warns but still allows', () => {
  const at = ceiling.assess({ percent: 55, state: capped(60), env: NO_ENV, sessionId: SESSION });
  assert.equal(at.over, false);
  assert.equal(at.near, true);
  assert.equal(ceiling.verdict(at, 'Agent').decision, 'allow');
  const warning = ceiling.warning(at);
  assert.match(warning, /5 points/);
  assert.match(warning, /60%/);
});

test('at and past the ceiling, fan-out is refused and nothing else is', () => {
  for (const percent of [60, 61, 100]) {
    const at = ceiling.assess({ percent, state: capped(60), env: NO_ENV, sessionId: SESSION });
    assert.equal(at.over, true, percent + ' should be over');
    const denied = ceiling.verdict(at, 'Agent');
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason, /ceiling/i);
    // The refusal has to say what to do instead, or it just gets retried.
    assert.match(denied.reason, /yourself/i);
    // And it must not be blocking the work itself.
    for (const safe of ['Read', 'Write', 'Edit', 'Bash']) {
      assert.equal(ceiling.verdict(at, safe).decision, 'allow', safe + ' must stay allowed');
    }
  }
});

test('the environment beats the file, and can turn the ceiling off', () => {
  const state = capped(60);
  const raised = ceiling.assess({ percent: 70, state, env: { USAGE_LIMITS_CEILING: '80' }, sessionId: SESSION });
  assert.equal(raised.ceiling, 80);
  assert.equal(raised.over, false);
  assert.equal(raised.source, 'environment');

  const off = ceiling.assess({ percent: 99, state, env: { USAGE_LIMITS_CEILING: 'off' }, sessionId: SESSION });
  assert.equal(off.set, false);
  assert.equal(ceiling.verdict(off, 'Agent').decision, 'allow');

  // A percent sign is how a person writes a percentage.
  assert.equal(ceiling.assess({ percent: 1, state, env: { USAGE_LIMITS_CEILING: '75%' }, sessionId: SESSION }).ceiling, 75);
});

test('an unreadable environment value falls back to the file rather than to zero', () => {
  // Number('') is 0, and a ceiling of zero would refuse every fan-out from the
  // first turn of the window. That is the failure this guard exists for.
  for (const bad of ['banana', '0', '-5', '101']) {
    const at = ceiling.assess({ percent: 50, state: capped(60), env: { USAGE_LIMITS_CEILING: bad }, sessionId: SESSION });
    assert.equal(at.ceiling, 60, 'bad value "' + bad + '" should fall through to the file');
  }
});

test('a stored ceiling outside 1-100 is ignored', () => {
  for (const bad of [0, -1, 101, NaN, null, undefined, '60']) {
    const at = ceiling.assess({ percent: 99, state: { ceilingPercent: bad, ceilingSession: SESSION }, env: NO_ENV });
    assert.equal(at.set, false, String(bad) + ' should not be a ceiling');
  }
});

test('describe says what is happening in words', () => {
  assert.match(ceiling.describe(ceiling.assess({ percent: 10, state: {}, env: NO_ENV, sessionId: SESSION })), /not set/);
  const over = ceiling.assess({ percent: 90, state: capped(60), env: NO_ENV, sessionId: SESSION });
  assert.match(ceiling.describe(over), /REACHED/);
});

test('a cap belongs to the session that set it, and to no other', () => {
  // The reported bug: a cap set in one session was still refusing fan-outs
  // after the session restarted. "Do not spend past 65 per cent" is said about
  // the work in front of you, not about tomorrow.
  const state = capped(60);
  const mine = ceiling.assess({ percent: 90, state, env: NO_ENV, sessionId: SESSION });
  assert.equal(mine.set, true);
  assert.equal(mine.over, true);
  assert.equal(ceiling.verdict(mine, 'Agent').decision, 'deny');

  const theirs = ceiling.assess({ percent: 90, state, env: NO_ENV, sessionId: 'a-different-session' });
  assert.equal(theirs.set, false, "a cap from another session must not bind here");
  assert.equal(theirs.over, false);
  assert.equal(ceiling.verdict(theirs, 'Agent').decision, 'allow');
  assert.equal(theirs.otherSessionCap, 60, "but it is still reported, not hidden");
});

test('a cap with no session recorded is ignored, not honoured', () => {
  // Written before caps were session-scoped. Honouring it is the bug.
  const legacy = ceiling.assess({ percent: 99, state: { ceilingPercent: 65 }, env: NO_ENV, sessionId: SESSION });
  assert.equal(legacy.set, false);
  assert.equal(ceiling.verdict(legacy, 'Agent').decision, 'allow');
  assert.equal(legacy.staleCap, 65, "reported so it can be explained rather than silently dropped");
});

test('the environment cap needs no session - it is this process, said outright', () => {
  const at = ceiling.assess({ percent: 90, state: {}, env: { USAGE_LIMITS_CEILING: '70' }, sessionId: null });
  assert.equal(at.set, true);
  assert.equal(at.over, true);
  assert.equal(at.source, 'environment');
});
