import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const action = YAML.parse(readFileSync(new URL('../../.github/actions/ix-setup/action.yml', import.meta.url), 'utf8'));
const step = action.runs.steps.find(step => step.name === 'Preserve plugin build artifacts');

test('ix setup exports the plugin cache outside the checkout', () => {
  const home = mkdtempSync(join(tmpdir(), 'plugin cache '));
  try {
    const output = join(home, 'github-env');
    const workspace = join(home, 'work/flox/flox');
    const env = {...process.env, HOME: home, GITHUB_WORKSPACE: workspace, GITHUB_ENV: output, NOSYSBASHRC: '1'};
    delete env.BASH_ENV;
    delete env.ENV;
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', step.run], {env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL'});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const exported = readFileSync(output, 'utf8').trim();
    const cache = join(home, '.cache/ix-ci/flox/nix-plugins');
    assert.equal(exported, `FLOX_NIX_PLUGINS_BUILD_DIR=${cache}`);
    assert.ok(relative(workspace, cache).startsWith('..'));
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});
