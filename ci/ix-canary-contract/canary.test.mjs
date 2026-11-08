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

function expressionData(value) {
  if (typeof value === 'string') return new data.StringData(value);
  return new data.Dictionary(...Object.entries(value).map(([key, value]) => ({key, value: expressionData(value)})));
}

function runContract(branch = 'ix', repository = 'indexable-inc/flox', marker = {}) {
  const github = { event_name: 'workflow_dispatch', ref_name: branch, repository: 'indexable-inc/flox', event: {repository: {default_branch: 'ix', full_name: repository}} };
  const canPromote = new Evaluator(parsed, expressionData({github})).evaluate().coerceString();
  const result = spawnSync('bash', ['-c', step.run], { encoding: 'utf8', env: {...process.env, CAN_PROMOTE: canPromote, WARM: 'false', MARKER_SHA: '', MARKER_EPOCH: '', ...marker} });
  assert.equal(result.error, undefined);
  return {canPromote, status: result.status, output: result.stdout + result.stderr};
}

test('cold default-branch manual run reaches bootstrap', () => {
  const result = runContract();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Cold ix canary bootstrap/);
});
test('cold feature-branch manual run fails', () => {
  const result = runContract('feature');
  assert.equal(result.status, 1, result.output);
});
test('cold manual run with another repository fails', () => {
  const result = runContract('ix', 'untrusted/flox');
  assert.equal(result.status, 1, result.output);
});
test('repository case does not reject a trusted dispatch', () => {
  assert.equal(runContract('ix', 'Indexable-Inc/Flox').status, 0);
});
test('a valid marker from an earlier manual run passes', () => {
  assert.equal(runContract('ix', 'indexable-inc/flox', {WARM: 'true', MARKER_SHA: 'previous', MARKER_EPOCH: '1'}).status, 0);
});
for (const branch of ['ix', 'feature']) {
  test(`a malformed marker on ${branch} fails`, () => {
    const result = runContract(branch, 'indexable-inc/flox', {WARM: 'true'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Malformed warmth marker/);
  });
}
test('each embedded shell script parses', () => {
  for (const step of workflow.jobs.canary.steps) {
    const result = spawnSync('bash', ['-n', '-c', step.run], {encoding: 'utf8'});
    assert.equal(result.status, 0, `${step.name}: ${result.stderr}`);
  }
});

const ciPath = process.env.CI_WORKFLOW_PATH ?? new URL('../../.github/workflows/ci.yml', import.meta.url);
const ci = YAML.parse(readFileSync(ciPath, 'utf8'));
const bats = ci.jobs['nix-build-bats-tests'];
for (const [event, headRepository, cancelled, expected] of [
  ['push', 'indexable-inc/flox', false, 'true'],
  ['workflow_dispatch', 'indexable-inc/flox', false, 'true'],
  ['merge_group', 'indexable-inc/flox', false, 'true'],
  ['pull_request', 'indexable-inc/flox', false, 'true'],
  ['pull_request', 'contributor/flox', false, 'true'],
  ['push', 'indexable-inc/flox', true, 'false'],
]) {
  test(`Bats admission before package builds: ${event}, ${headRepository}, cancelled=${cancelled}`, () => {
    const cancellation = {name: 'cancelled', minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(cancelled)};
    const condition = new Parser(new Lexer(bats.if.slice(3, -2).trim()).lex().tokens, ['github', 'needs'], [cancellation]).parse();
    const github = {event_name: event, repository: 'indexable-inc/flox', event: {pull_request: {head: {repo: {full_name: headRepository}}}}};
    const needs = {scope: {outputs: {heavy: 'true'}}};
    assert.equal(new Evaluator(condition, expressionData({github, needs}), new Map([['cancelled', cancellation]])).evaluate().coerceString(), expected);
  });
}
test('independent Bats lanes preserve the ARM64 test matrix and build checks', () => {
  assert.deepEqual(bats.needs, ['scope']);
  assert.equal(bats.if, ci.jobs['nix-build'].if);
  assert.deepEqual(bats.strategy.matrix.include.map(row => [row.system, row['test-tags'], row['ix-runner']]), [
    ['aarch64-linux', 'containerize', ['ix', 'arm64', 'ix-flox', 'ix-cpu-32', 'ix-bats-containerize']],
    ['aarch64-linux', '!containerize', ['ix', 'arm64', 'ix-flox', 'ix-cpu-32', 'ix-bats']],
  ]);
  assert.notEqual(ci.jobs['nix-build']['continue-on-error'], true);
  assert.notEqual(bats['continue-on-error'], true);
  assert.ok(ci.jobs['nix-build'].steps.some(step => step.name === 'Build (ix, local)'));
});
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

for (const name of ['CLI Unit Tests', 'Check schemas are up to date']) {
  const step = ci.jobs['cli-unit'].steps.find(step => step.name === name);
  const condition = new Parser(new Lexer(step.if.slice(3, -2).trim()).lex().tokens, ['github', 'needs'], []).parse();
  for (const [repository, branch, event, heavy, expected] of [
    ['indexable-inc/flox', 'ix', 'push', 'true', 'true'],
    ['indexable-inc/flox', 'ix', 'workflow_dispatch', 'true', 'true'],
    ['flox/flox', 'main', 'push', 'true', 'false'],
    ['flox/flox', 'main', 'pull_request', 'true', 'true'],
    ['indexable-inc/flox', 'feature', 'pull_request', 'false', 'false'],
  ]) {
    test(`${name} executes ${repository} ${branch} ${event} heavy=${heavy}: ${expected}`, () => {
      const github = {repository, ref_name: branch, event_name: event, event: {repository: {default_branch: repository === 'flox/flox' ? 'main' : 'ix'}}};
      const needs = {scope: {outputs: {heavy}}};
      assert.equal(new Evaluator(condition, expressionData({github, needs})).evaluate().coerceString(), expected);
    });
  }
}
