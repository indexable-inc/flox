import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const launcher = fileURLToPath(new URL('../../.github/scripts/ix-local-integration-tests.sh', import.meta.url));
const report = '<testsuite tests="1" failures="0"/>\n';

function runLocalBats(tags, nixStatus = 0) {
  const scratch = mkdtempSync(join(tmpdir(), 'flox-local-bats-'));
  const checkout = join(scratch, 'checkout');
  const bin = join(scratch, 'bin');
  const tests = join(scratch, 'tests');
  const argumentsPath = join(scratch, 'nix-arguments');
  try {
    for (const directory of [checkout, bin, tests]) mkdirSync(directory);
    const initialized = spawnSync('git', ['init', '-q', checkout], {encoding: 'utf8'});
    assert.equal(initialized.status, 0, initialized.stderr);
    writeFileSync(join(tests, 'report.xml'), report);
    writeFileSync(join(bin, 'nix'), `#!/bin/sh
printf '%s\\n' "$@" > "$NIX_ARGUMENTS"
if [ "$NIX_STATUS" -ne 0 ]; then exit "$NIX_STATUS"; fi
printf 'TESTS_DIR: %s\\n' "$TEST_REPORT_DIRECTORY"
`, {mode: 0o755});
    const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, NOSYSBASHRC: '1', MATRIX_SYSTEM: 'aarch64-linux', MATRIX_TEST_TAGS: tags, NIX_ARGUMENTS: argumentsPath, NIX_STATUS: String(nixStatus), TEST_REPORT_DIRECTORY: tests};
    delete env.BASH_ENV;
    delete env.ENV;
    const result = spawnSync('bash', ['--noprofile', '--norc', launcher], {cwd: checkout, env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL'});
    assert.equal(result.error, undefined);
    const reportPath = join(checkout, 'report.xml');
    return {status: result.status, stderr: result.stderr, args: readFileSync(argumentsPath, 'utf8').trimEnd().split('\n'), report: existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null};
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

for (const tags of ['containerize', '!containerize']) {
  test(`local ${tags} Bats builds its test closure without another job's artifacts`, () => {
    const step = workflow.jobs['nix-build-bats-tests'].steps.find(step => step.name === 'Run Bats Tests (ix, local)');
    assert.equal(step.run, './.github/scripts/ix-local-integration-tests.sh');
    const result = runLocalBats(tags);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.args, [
      'run', '--accept-flake-config', '--extra-experimental-features', 'nix-command flakes',
      '.#packages.aarch64-linux.flox-cli-tests', '--', '--ci-runner', 'flox-aarch64-linux',
      '--', '--filter-tags', tags, '--report-formatter', 'junit',
    ]);
    assert.equal(result.report, report);
  });
}

test('a failed local build or Bats command fails the job before report collection', () => {
  const result = runLocalBats('!containerize', 7);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.report, null);
});
