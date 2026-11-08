import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {Lexer, Parser, Evaluator, data} from '@actions/expressions';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(process.env.CI_WORKFLOW_PATH ?? new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const classifier = new URL('../../.github/scripts/classify-ci-scope.sh', import.meta.url);
const cases = [
  ['nef-dev', {}, 'ix-nef', ['Test NEF', 'Test buildenvLib']],
  ['nix-plugins-dev', {os: 'ubuntu-22.04-8core'}, 'ix-nix-plugins', ['Build', 'Test']],
  ['cli-unit', {os: 'ubuntu-22.04-8core'}, 'ix-cli-unit', ['Build', 'CLI Unit Tests', 'Check schemas are up to date']],
  ['nix-build', {system: 'aarch64-linux'}, 'ix-nix-build', ['Build (ix, local)']],
  ['nix-build-crate2nix', {system: 'aarch64-linux'}, 'ix-crate2nix', ['Build (ix, local)']],
  ...workflow.jobs['nix-build-bats-tests'].strategy.matrix.include.map(matrix => [
    'nix-build-bats-tests', matrix, matrix['ix-runner'].at(-1), ['Run Bats Tests (ix, local)'],
  ]),
];
function value(input) {
  if (typeof input === 'string') return new data.StringData(input);
  if (typeof input === 'boolean') return new data.BooleanData(input);
  if (Array.isArray(input)) return new data.Array(...input.map(value));
  return new data.Dictionary(...Object.entries(input).map(([key, input]) => ({key, value: value(input)})));
}
function evaluate(expression, context, cancelled = false) {
  if (expression === undefined) return new data.BooleanData(true);
  if (typeof expression !== 'string') return value(expression);
  if (!expression.startsWith('${{')) return value(expression);
  const cancellation = {name: 'cancelled', minArgs: 0, maxArgs: 0, call: () => value(cancelled)};
  const parsed = new Parser(new Lexer(expression.slice(3, -2).trim()).lex().tokens, Object.keys(context), [cancellation]).parse();
  return new Evaluator(parsed, value(context), new Map([['cancelled', cancellation]])).evaluate();
}
function context(matrix, heavy = 'true', head = 'Axionize/flox') {
  return {github: {repository: 'indexable-inc/flox', event_name: 'pull_request', ref_name: '9/merge', event: {pull_request: {head: {repo: {full_name: head}}}, repository: {default_branch: 'ix'}}}, matrix, needs: {scope: {outputs: {heavy}}}, env: {}, vars: {MANAGED_CACHE_PUBLIC_S3_BUCKET: 's3://not-for-forks'}, secrets: {MANAGED_CACHE_PUBLIC_SECRET_KEY: 'must-not-reach-forks'}};
}
for (const [id, matrix, lineage, testSteps] of cases) {
  test(`fork ${lineage} receives 32-vCPU IX capacity and executes real work without publication credentials`, () => {
    const job = workflow.jobs[id];
    const c = context(matrix);
    for (const [key, expression] of Object.entries(job.env ?? {})) c.env[key] = evaluate(expression, c).coerceString();
    assert.equal(evaluate(job.if, c).coerceString(), 'true');
    assert.equal(evaluate(job.if, c, true).coerceString(), 'false');
    const labels = evaluate(job['runs-on'], c);
    assert.ok(labels instanceof data.Array, `${id}: fork must receive the IX label array`);
    assert.deepEqual(labels.values().map(item => item.coerceString()), ['ix','arm64','ix-flox','ix-cpu-32',lineage]);
    assert.equal(c.env.NIX_BUILD_CORES, '32');
    assert.deepEqual(job.permissions, {contents: 'read'});
    for (const name of ['Setup (ix)', ...testSteps]) {
      const step = job.steps.find(step => step.name === name);
      assert.ok(step, `${id}: ${name}`);
      assert.equal(evaluate(step.if, c).coerceString(), 'true', `${id}: ${name}`);
    }
    for (const step of job.steps.filter(step => step.name === 'Setup' || step.name === 'Configure AWS Credentials')) {
      assert.equal(evaluate(step.if, c).coerceString(), 'false', `${id}: credentialed setup`);
    }
    const local = job.steps.find(step => step.name === 'Build (ix, local)');
    if (local) for (const key of ['NIX_SUBSTITUTER', 'NIX_SUBSTITUTER_KEY']) {
      assert.equal(evaluate(local.env[key], c).coerceString(), '', `${id}: fork publication ${key}`);
    }
  });
}
test('workflow changes exercise the heavy path while documentation remains scoped', () => {
  for (const [file, expected] of [['.github/workflows/ci.yml','heavy=true'],['README.md','heavy=false']]) {
    const r = spawnSync('bash', [classifier.pathname, '--classify-only'], {input: file+'\n',encoding: 'utf8',env: {...process.env,GITHUB_OUTPUT:'',GITHUB_STEP_SUMMARY:''}});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), expected);
  }
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.equal(Object.hasOwn(workflow.on, 'pull_request_target'), false);
});
