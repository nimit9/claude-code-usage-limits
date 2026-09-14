#!/usr/bin/env node
'use strict';

// The ceiling: the one thing in this plugin that is enforced rather than
// reported.
//
// Everything else here tells an agent where the budget stands and trusts it to
// act on that. For Claude Code that mostly works. For Codex it does not, and
// the reason is worth stating plainly rather than blaming the model: a number
// in the context is an input to a decision, and an agent part-way through a
// plan it was told to finish will weigh "the window is at 80 per cent" against
// "finish the whole list" and keep going, every time. It is not ignoring the
// figure. It is trading it off, and losing the trade.
//
// So the ceiling does not argue. Above it, the calls that MULTIPLY spend are
// refused at the hook, before the model's judgement is involved at all.
//
// Three rules shape what it refuses, and they are the whole design:
//
//   1. It never refuses work, only the expensive WAY of doing it. A fan-out of
//      eight subagents and doing the same eight things in sequence reach the
//      same place; only one of them can spend half a window between two
//      readings with nothing able to speak in between. Refusing the fan-out
//      leaves the task entirely possible, which is why this is a ceiling and
//      not a stop button.
//
//   2. It never refuses the cheap calls. Reading a file, running a test,
//      writing an edit - all of it stays allowed at any percentage, because an
//      agent that cannot save its work is worse than one that overspends.
//
//   3. It says why, in terms of what to do instead. A denial that reads "over
//      budget" gets retried. One that reads "do these sequentially yourself"
//      gets obeyed.
//
// Off by default. A ceiling nobody set is not a ceiling, and this file returns
// `allow` for every call until someone names a number.

const MULTIPLIERS = [
  // Claude Code, and the Codex equivalents, which use the same names.
  'Agent',
  'Task',
  'Workflow',
  // Codex names its fan-out differently depending on build; both have been
  // seen. Matching the name is cheap and a miss only costs enforcement, never
  // correctness.
  'Subagent',
  'Dispatch',
];

// Antigravity derives tool names by lowercasing the step type and stripping
// CORTEX_STEP_TYPE_, so its names are snake_case and cannot be matched by the
// list above.
const MULTIPLIER_PATTERN = /^(agent|task|workflow|subagent|dispatch|spawn_[a-z_]*agent|run_[a-z_]*agent)$/i;

// How far below the ceiling the warning starts. Ten points is about one long
// turn at xhigh on a 5-hour window, which is the last moment a warning can
// still change what happens next.
const NEAR_POINTS = 10;

function isMultiplier(tool) {
  const name = String(tool || '').trim();
  if (!name) return false;
  if (MULTIPLIERS.includes(name)) return true;
  return MULTIPLIER_PATTERN.test(name);
}

// The number, and who set it. An explicit environment value is the user saying
// it outright for this one session and beats the file, the same precedence the
// mode uses.
function ceilingFrom(state, env) {
  const environment = env || process.env;
  const raw = environment.USAGE_LIMITS_CEILING;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const text = String(raw).trim().toLowerCase();
    if (text === 'off' || text === 'none' || text === 'no') return { percent: null, source: 'environment' };
    const value = Number(text.replace(/%$/, ''));
    if (Number.isFinite(value) && value > 0 && value <= 100) {
      return { percent: value, source: 'environment' };
    }
    // A ceiling that cannot be read is not a ceiling of zero. Fall through to
    // the file rather than enforcing a number nobody typed.
  }
  const stored = state && Number.isFinite(state.ceilingPercent) ? state.ceilingPercent : null;
  if (stored !== null && stored > 0 && stored <= 100) return { percent: stored, source: 'the file' };
  return { percent: null, source: null };
}

// Where the binding window stands against the ceiling.
//
// `percent` is the BINDING window's, not the emptiest one's. A ceiling read
// against whichever window has the most left would never bind at all, which is
// the same mistake the brief was corrected for.
function assess(options) {
  const opts = options || {};
  const ceiling = ceilingFrom(opts.state, opts.env);
  const percent = Number.isFinite(opts.percent) ? opts.percent : null;
  if (ceiling.percent === null || percent === null) {
    return {
      set: ceiling.percent !== null,
      source: ceiling.source,
      ceiling: ceiling.percent,
      percent,
      over: false,
      near: false,
      headroomPoints: null,
    };
  }
  const headroomPoints = ceiling.percent - percent;
  return {
    set: true,
    source: ceiling.source,
    ceiling: ceiling.percent,
    percent,
    over: percent >= ceiling.percent,
    near: headroomPoints > 0 && headroomPoints <= NEAR_POINTS,
    headroomPoints,
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

// What to do about one tool call.
//
// Returns `allow` for everything the ceiling does not cover, which is almost
// everything. The caller turns a `deny` into whatever its host's hook protocol
// wants; this file deliberately knows nothing about that.
function verdict(state, tool) {
  if (!state || !state.set || !state.over) return { decision: 'allow', reason: null };
  if (!isMultiplier(tool)) return { decision: 'allow', reason: null };
  return {
    decision: 'deny',
    reason:
      'Usage ceiling reached: the binding window is ' +
      round(state.percent) +
      '% used and the ceiling is ' +
      state.ceiling +
      '%. Fan-out calls are refused past the ceiling because subagents spend the same window ' +
      'in parallel and nothing can report back until they stop. Nothing else is blocked. ' +
      'Do this work yourself, in this session, one step at a time - that is the same work at ' +
      'roughly a fifth of the spend. Do not retry this call and do not ask to raise the ' +
      'ceiling; if the ceiling is genuinely wrong, say so in your reply and let the user change it.',
  };
}

// The line for a session that is close but not over. Advice, not enforcement -
// there is still room, and the point of saying it here is that it arrives
// BEFORE the expensive call rather than after it.
function warning(state) {
  if (!state || !state.set || state.over || !state.near) return null;
  return (
    'Usage ceiling in ' +
    round(state.headroomPoints) +
    ' points: the binding window is ' +
    round(state.percent) +
    '% used against a ceiling of ' +
    state.ceiling +
    '%. Past the ceiling, fan-out calls are refused outright. Land what is in flight and ' +
    'prefer doing the next steps in this session over spawning agents for them.'
  );
}

// A short, honest description for the report and the panel.
function describe(state) {
  if (!state || !state.set) return 'Ceiling      not set';
  const where = state.percent === null ? 'no reading' : round(state.percent) + '% used';
  const status = state.over ? 'REACHED' : state.near ? 'close' : 'clear';
  return (
    'Ceiling      ' +
    state.ceiling +
    '% (' +
    status +
    ', ' +
    where +
    ')' +
    (state.source ? ' - set in ' + state.source : '')
  );
}

module.exports = {
  MULTIPLIERS,
  MULTIPLIER_PATTERN,
  NEAR_POINTS,
  isMultiplier,
  ceilingFrom,
  assess,
  verdict,
  warning,
  describe,
};
