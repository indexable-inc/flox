import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Lexer, Parser, Evaluator, data } from '@actions/expressions';
import YAML from 'yaml';

const workflowPath = process.env.WORKFLOW_PATH ?? new URL('../../.github/workflows/ix-canary.yml', import.meta.url);
const workflow = YAML.parse(readFileSync(workflowPath, 'utf8'));
const step = workflow.jobs.canary.steps.find(step => step.name === 'Enforce the warmth contract');
const expression = step.env.CAN_PROMOTE.slice(3, -2).trim();
const parsed = new Parser(new Lexer(expression).lex().tokens, ['github'], []).parse();
const now = Math.floor(Date.now() / 1000);

function expressionData(value) {
  if (typeof value === 'string') return new data.StringData(value);
  return new data.Dictionary(...Object.entries(value).map(([key, value]) => ({key, value: expressionData(value)})));
}

function runContract(event, branch = 'ix', repository = 'indexable-inc/flox', marker = {}) {
  const github = { event_name: event, ref_name: branch, repository: 'indexable-inc/flox', event: {repository: {default_branch: 'ix', full_name: repository}} };
  const canPromote = new Evaluator(parsed, expressionData({github})).evaluate().coerceString();
  const result = spawnSync('bash', ['-c', step.run], { encoding: 'utf8', env: {...process.env, EVENT_NAME: event, CAN_PROMOTE: canPromote, WARM: 'false', MARKER_SHA: '', MARKER_EPOCH: '', HEAD_SHA: 'current', ...marker} });
  assert.equal(result.error, undefined);
  return {canPromote, status: result.status, output: result.stdout + result.stderr};
}

for (const event of ['push', 'schedule', 'workflow_dispatch']) {
  test(`cold default-branch ${event} reaches bootstrap`, () => {
    const result = runContract(event);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Cold ix canary bootstrap/);
  });
  test(`cold feature-branch ${event} fails`, () => {
    const result = runContract(event, 'feature');
    assert.equal(result.status, 1, result.output);
  });
}
for (const event of ['schedule', 'workflow_dispatch']) {
  test(`cold ${event} with another repository fails`, () => {
    const result = runContract(event, 'ix', 'untrusted/flox');
    assert.equal(result.status, 1, result.output);
  });
}
for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'issue_comment', 'repository_dispatch', 'unknown']) {
  test(`cold default-branch ${event} fails`, () => {
    const result = runContract(event);
    assert.equal(result.status, 1, result.output);
  });
}
test('repository case does not reject a trusted dispatch', () => {
  assert.equal(runContract('workflow_dispatch', 'ix', 'Indexable-Inc/Flox').status, 0);
});
test('a scheduled marker behind the head by more than two hours fails', () => {
  const result = runContract('schedule', 'ix', 'indexable-inc/flox', {WARM: 'true', MARKER_SHA: 'old', MARKER_EPOCH: String(now - 7201)});
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Promoted seed is behind the default branch/);
});
test('a scheduled marker behind the head within the grace period passes', () => {
  const result = runContract('schedule', 'ix', 'indexable-inc/flox', {WARM: 'true', MARKER_SHA: 'old', MARKER_EPOCH: String(now - 60)});
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Promotion grace/);
});
test('a scheduled current marker passes', () => {
  assert.equal(runContract('schedule', 'ix', 'indexable-inc/flox', {WARM: 'true', MARKER_SHA: 'current', MARKER_EPOCH: String(now - 10800)}).status, 0);
});
test('a malformed marker on a feature branch still fails', () => {
  const result = runContract('workflow_dispatch', 'feature', 'indexable-inc/flox', {WARM: 'true'});
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Malformed warmth marker/);
});
for (const event of ['schedule', 'workflow_dispatch']) {
  test(`a malformed default-branch ${event} marker still fails`, () => {
    const result = runContract(event, 'ix', 'indexable-inc/flox', {WARM: 'true'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Malformed warmth marker/);
  });
}
test('a default-branch push can still repair a malformed marker', () => {
  const result = runContract('push', 'ix', 'indexable-inc/flox', {WARM: 'true'});
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Malformed warmth marker/);
});
test('each embedded shell script parses', () => {
  for (const step of workflow.jobs.canary.steps) {
    const result = spawnSync('bash', ['-n', '-c', step.run], {encoding: 'utf8'});
    assert.equal(result.status, 0, `${step.name}: ${result.stderr}`);
  }
});

const ci = YAML.parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const failure = {name: 'failure', minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(true)};
for (const job of ['trigger-flox-installers-workflow', 'report-failure']) {
  const condition = new Parser(new Lexer(ci.jobs[job].if.slice(3, -2).trim()).lex().tokens, ['github'], [failure]).parse();
  for (const [repository, branch, event, expected] of [
    ['indexable-inc/flox', 'ix', 'push', 'false'],
    ['flox/flox', 'main', 'push', 'true'],
    ['flox/flox', 'main', 'workflow_dispatch', 'false'],
    ['flox/flox', 'feature', 'push', 'false'],
  ]) {
    test(`${job} owns ${repository} ${branch} ${event}: ${expected}`, () => {
      const github = {repository, ref_name: branch, event_name: event, event: {repository: {default_branch: repository === 'flox/flox' ? 'main' : 'ix'}}};
      assert.equal(new Evaluator(condition, expressionData({github}), new Map([['failure', failure]])).evaluate().coerceString(), expected);
    });
  }
}
