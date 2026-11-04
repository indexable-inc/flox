import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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

test('job cache configuration preserves transport budgets across an isolated test HOME', {skip: !hasNix}, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ix-nix-config-'));
  try {
    const home = join(scratch, 'runner');
    const testHome = join(scratch, 'test');
    const systemConfig = join(scratch, 'system');
    mkdirSync(home);
    mkdirSync(testHome);
    mkdirSync(systemConfig);
    // Distinct image settings expose a job that replaces its owner's budgets.
    writeFileSync(join(systemConfig, 'nix.conf'), 'experimental-features = nix-command flakes\nconnect-timeout = 17\ndownload-attempts = 7\n');
    const env = {...process.env, HOME: home, NIX_CONF_DIR: systemConfig, GITHUB_ENV: join(scratch, 'github-env'), NIX_ACCESS_TOKEN: 'test-not-a-secret'};
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
    const protocol = spawnSync('nix', ['config', 'show', 'http2'], {
      cwd: root, env: {...env, HOME: testHome, NIX_USER_CONF_FILES: exported[1]}, encoding: 'utf8',
    });
    assert.equal(protocol.status, 0, protocol.stderr);
    assert.equal(protocol.stdout.trim(), 'false');
    const budgets = spawnSync('nix', ['config', 'show'], {
      cwd: root, env: {...env, HOME: testHome, NIX_USER_CONF_FILES: exported[1]}, encoding: 'utf8',
    });
    assert.equal(budgets.status, 0, budgets.stderr);
    assert.match(budgets.stdout, /^connect-timeout = 17$/m);
    // Determinate renamed download-attempts but still accepts it in nix.conf.
    assert.match(budgets.stdout, /^(?:download-attempts|filetransfer-retry-attempts) = 7$/m);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
});
