import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {Lexer, Parser, Evaluator, data} from '@actions/expressions';
import YAML from 'yaml';

const path = process.env.LINT_WORKFLOW_PATH ?? new URL('../../.github/workflows/nix-managed-lints.yml', import.meta.url);
const workflow = YAML.parse(readFileSync(path, 'utf8'));
const job = workflow.jobs['nix-git-hooks'];
const step = name => job.steps.find(step => step.name === name);

function expressionData(value) {
  if (typeof value === 'string') return new data.StringData(value);
  return new data.Dictionary(...Object.entries(value).map(([key, value]) => ({key, value: expressionData(value)})));
}

function condition(expression, event, branch = 'ix', repository = 'indexable-inc/flox') {
  const parsed = new Parser(new Lexer(expression.slice(3, -2).trim()).lex().tokens, ['github'], []).parse();
  return new Evaluator(parsed, expressionData({github: {
    event_name: event, ref_name: branch, repository,
    event: {repository: {default_branch: repository === 'indexable-inc/flox' ? 'ix' : 'main'}},
  }})).evaluate().coerceString();
}

function runStep(name, env = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'lint-warmup-'));
  try {
    // Record the external command boundary; execute the workflow's own selection logic.
    writeFileSync(join(scratch, 'nix'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$ARGUMENTS"\nexit "${NIX_STATUS:-0}"\n', {mode: 0o755});
    writeFileSync(join(scratch, 'git'), '#!/bin/bash\nset -eu\n[[ "$1" == rev-parse ]]\ncase "$2" in target) echo target-sha;; head) echo head-sha;; *) exit 1;; esac\n', {mode: 0o755});
    const shellEnv = {...process.env, PATH: `${scratch}:${process.env.PATH}`, ARGUMENTS: join(scratch, 'args'), GITHUB_ENV: join(scratch, 'env'), ...env};
    // NixOS's system bashrc can replace PATH and escape the command mocks.
    shellEnv.NOSYSBASHRC = '1';
    delete shellEnv.BASH_ENV;
    delete shellEnv.ENV;
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', step(name).run], {
      encoding: 'utf8', env: shellEnv, timeout: 5000, killSignal: 'SIGKILL',
    });
    assert.equal(result.error, undefined);
    return {status: result.status, stderr: result.stderr,
      args: name === 'Run Nix Git Hooks' && result.status === 0 ? readFileSync(join(scratch, 'args'), 'utf8').trim().split('\n') : [],
      refs: name !== 'Run Nix Git Hooks' ? readFileSync(join(scratch, 'env'), 'utf8') : ''};
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

for (const event of ['push', 'workflow_dispatch']) {
  test(`default-branch ${event} runs every lint without diff refs`, () => {
    assert.ok(Object.hasOwn(workflow.on, event));
    if (event === 'push') assert.deepEqual(workflow.on.push.branches, ['ix']);
    assert.equal(condition(job.if, event), 'true');
    assert.equal(condition(step('Fetch branches').if, event), 'false');
    const result = runStep('Run Nix Git Hooks', {EVENT_NAME: event});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.args, ['develop', '-L', '--no-update-lock-file', '--command', 'pre-commit', 'run', '--verbose', '--show-diff-on-failure', '--hook-stage', 'manual', '--all-files']);
  });
  test(`${event} cannot warm a feature branch or change upstream behavior`, () => {
    assert.equal(condition(job.if, event, 'feature'), 'false');
    assert.equal(condition(job.if, event, 'main', 'flox/flox'), 'false');
  });
}
for (const event of ['pull_request', 'merge_group']) {
  test(`${event} retains diff linting on forks and upstream`, () => {
    assert.equal(condition(job.if, event, 'feature', 'flox/flox'), 'true');
    assert.equal(condition(step('Fetch branches').if, event), 'true');
    const result = runStep('Run Nix Git Hooks', {EVENT_NAME: event});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.args.slice(-4), ['--from-ref', 'target-sha', '--to-ref', 'head-sha']);
    assert.ok(!result.args.includes('--all-files'));
  });
}
test('pull requests fetch GitHub PR refs even when the branch lives in a fork', () => {
  assert.equal(runStep('Determine target branch ( PR )', {BASE_REF: 'ix', PR_NUMBER: '42'}).refs,
    'TARGET_REF=refs/heads/ix\nHEAD_REF=refs/pull/42/head\n');
});
test('merge groups preserve their exact base and head refs', () => {
  assert.equal(runStep('Fetch target branch ( Merge Queue )', {MERGE_GROUP_BASE_REF: 'refs/heads/ix', MERGE_GROUP_HEAD_REF: 'refs/heads/gh-readonly-queue/ix/pr-42'}).refs,
    'TARGET_REF=refs/heads/ix\nHEAD_REF=refs/heads/gh-readonly-queue/ix/pr-42\n');
});
test('failed hooks fail the warmup', () => {
  assert.equal(runStep('Run Nix Git Hooks', {EVENT_NAME: 'push', NIX_STATUS: '7'}).status, 7);
});
test('unknown events cannot select lint files', () => {
  assert.equal(condition(job.if, 'repository_dispatch'), 'false');
  assert.equal(runStep('Run Nix Git Hooks', {EVENT_NAME: 'repository_dispatch'}).status, 1);
});
test('inherited Bash startup cannot replace the command mocks', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lint-startup-'));
  try {
    const startup = join(scratch, 'startup');
    writeFileSync(startup, 'exit 99\n');
    const result = runStep('Run Nix Git Hooks', {EVENT_NAME: 'push', BASH_ENV: startup, ENV: startup});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.args.at(-1), '--all-files');
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
});
