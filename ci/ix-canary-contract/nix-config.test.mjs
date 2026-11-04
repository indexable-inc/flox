import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const action = YAML.parse(readFileSync(join(root, '.github/actions/ix-setup/action.yml'), 'utf8'));
const setup = action.runs.steps.find(step => step.name === 'Authenticate nix flake fetches');
const hasNix = spawnSync('nix', ['--version']).status === 0;

test('job cache configuration survives an isolated test HOME', {skip: !hasNix}, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ix-nix-config-'));
  try {
    const home = join(scratch, 'runner');
    const testHome = join(scratch, 'test');
    mkdirSync(home);
    mkdirSync(testHome);
    const env = {...process.env, HOME: home, GITHUB_ENV: join(scratch, 'github-env'), NIX_ACCESS_TOKEN: 'test-not-a-secret'};
    for (const key of ['NIX_USER_CONF_FILES', 'NIX_CONFIG', 'XDG_CONFIG_HOME']) delete env[key];
    const configured = spawnSync('bash', ['-c', setup.run], {cwd: root, env, encoding: 'utf8'});
    assert.equal(configured.status, 0, configured.stderr);
    const exported = readFileSync(env.GITHUB_ENV, 'utf8').match(/^NIX_USER_CONF_FILES=(.+)$/m);
    assert.ok(exported, 'setup must export the config path for subsequent steps');
    const config = JSON.parse(spawnSync('nix', ['eval', '--json', '--file', 'flake.nix', 'nixConfig'], {cwd: root, env, encoding: 'utf8'}).stdout);
    const isolated = spawnSync('nix', ['config', 'show', 'substituters'], {
      cwd: root, env: {...env, HOME: testHome, NIX_USER_CONF_FILES: exported[1]}, encoding: 'utf8',
    });
    assert.equal(isolated.status, 0, isolated.stderr);
    assert.deepEqual(isolated.stdout.trim().split(/\s+/), ['https://cache.nixos.org', ...config['extra-substituters']]);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
});
