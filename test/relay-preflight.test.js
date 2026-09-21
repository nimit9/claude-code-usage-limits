'use strict';
// The two questions Claude Code asks on a fresh start - trust this folder?
// bypass permissions? - are answered in .claude.json before the wake, in every
// spelling of the folder key, and the doctor reports when they are not.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function isolated(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-preflight-'));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    delete require.cache[require.resolve('../skills/usage-limits/scripts/relay.js')];
    return fn(dir, require('../skills/usage-limits/scripts/relay.js'));
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('preflight answers folder trust in every spelling and bypass permissions, with a backup', () => {
  isolated((dir, relay) => {
    const file = path.join(dir, '.claude.json');
    const cwd = process.platform === 'win32' ? 'C:\\Users\\Someone' : '/home/someone';
    const fwd = cwd.replace(/\\/g, '/');
    fs.writeFileSync(file, JSON.stringify({ projects: { [fwd]: { allowedTools: [], hasTrustDialogAccepted: false } }, other: 1 }));
    const r = relay.preflightPrompts(cwd, { permissionMode: 'bypassPermissions' });
    assert.ok(r.ok, r.error);
    assert.ok(r.changes.some((c) => /folder trust/.test(c)));
    assert.ok(r.changes.some((c) => /bypass permissions/.test(c)));
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(after.bypassPermissionsModeAccepted, true);
    assert.strictEqual(after.other, 1, 'nothing else is touched');
    for (const key of relay.projectKeys(cwd)) assert.strictEqual(after.projects[key].hasTrustDialogAccepted, true, key);
    assert.ok(fs.existsSync(file + '.bak-usage-limits'));
    const again = relay.preflightPrompts(cwd, { permissionMode: 'bypassPermissions' });
    assert.deepStrictEqual(again.changes, [], 'idempotent');
  });
});

test('a dry run reports without writing, and a missing file is created', () => {
  isolated((dir, relay) => {
    const file = path.join(dir, '.claude.json');
    const dry = relay.preflightPrompts(dir, { permissionMode: 'bypassPermissions' }, { dry: true });
    assert.ok(dry.ok);
    assert.ok(dry.changes.length >= 2);
    assert.ok(!fs.existsSync(file), 'dry run writes nothing');
    const wet = relay.preflightPrompts(dir, { permissionMode: 'default' });
    assert.ok(wet.ok);
    assert.ok(fs.existsSync(file));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.bypassPermissionsModeAccepted, undefined, 'only asked for when the mode is bypass');
    assert.strictEqual(parsed.projects[relay.projectKeys(dir)[0]].hasTrustDialogAccepted, true);
  });
});

test('arming pre-answers for the record cwd and the doctor sees a quiet start', async () => {
  await (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-preflight-arm-'));
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      delete require.cache[require.resolve('../skills/usage-limits/scripts/relay.js')];
      const relay = require('../skills/usage-limits/scripts/relay.js');
      fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ projects: {} }));
      const NOW = Date.UTC(2026, 8, 20, 20, 0, 0);
      const r = relay.arm({
        now: NOW, sessionId: 'pppp-1', cwd: dir, project: 'p', schedule: false,
        resetsAt: NOW + 3600000,
        binding: { percentUsed: 85, resetsAt: NOW + 3600000, key: 'five_hour', label: '5-hour' },
        work: { hasWork: true, pending: 1, source: 'test', todos: [] },
        config: { enabled: true, mode: 'resume', graceMinutes: 2, permissionMode: 'bypassPermissions', armOn: 'threshold', at: 80, attempts: 2, backstopAt: 95 },
      });
      assert.ok(r.ok, r.error);
      assert.ok(r.record.preflight.some((c) => /folder trust/.test(c)));
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
      assert.strictEqual(parsed.bypassPermissionsModeAccepted, true);
      assert.match(relay.status(NOW), /Pre-answered: folder trust/);
      const again = relay.preflightPrompts(dir, { permissionMode: 'bypassPermissions' }, { dry: true });
      assert.deepStrictEqual(again.changes, []);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
});
