'use strict';
// A burst of prompts seconds apart gets the brief once, not once each.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('the same brief within ninety seconds is said once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-brief-said-'));
  const before = { dir: process.env.CLAUDE_CONFIG_DIR, rep: process.env.USAGE_LIMITS_BRIEF_REPEAT };
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.USAGE_LIMITS_BRIEF_REPEAT;
  try {
    delete require.cache[require.resolve('../skills/usage-limits/scripts/brief.js')];
    const brief = require('../skills/usage-limits/scripts/brief.js');
    const T = Date.UTC(2026, 8, 20, 21, 0, 0);
    const line = '[usage-limits] binding window is 5-hour 52% used, about 58 turns of headroom, resets in 4h 29m.';
    assert.strictEqual(brief.sayOnce('s-1', line, T), line, 'first time: said');
    assert.strictEqual(brief.sayOnce('s-1', line.replace('52%', '53%'), T + 30 * 1000), '', 'same shape thirty seconds later: silent');
    assert.strictEqual(brief.sayOnce('s-2', line, T + 30 * 1000), line, 'another session: said');
    assert.strictEqual(brief.sayOnce('s-1', line + ' The budget is nearly gone.', T + 40 * 1000), line + ' The budget is nearly gone.', 'a different instruction: said');
    assert.strictEqual(brief.sayOnce('s-1', line, T + 3 * 60 * 1000), line, 'after the window: said again');
    assert.strictEqual(brief.sayOnce('s-1', '', T), '', 'nothing stays nothing');
    process.env.USAGE_LIMITS_BRIEF_REPEAT = '1';
    assert.strictEqual(brief.sayOnce('s-1', line, T + 3 * 60 * 1000 + 5000), line, 'opted out: always said');
    assert.strictEqual(brief.shapeOf('5-hour 12% used, 3 turns'), '#-hour #% used, # turns');
  } finally {
    if (before.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before.dir;
    if (before.rep === undefined) delete process.env.USAGE_LIMITS_BRIEF_REPEAT; else process.env.USAGE_LIMITS_BRIEF_REPEAT = before.rep;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
