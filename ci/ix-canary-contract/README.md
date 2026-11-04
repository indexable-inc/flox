# Canary contract tests

Run with Node.js 20 or newer and Bash:

```sh
cd ci/ix-canary-contract
npm ci --ignore-scripts
npm test
```

The tests read `.github/workflows/ix-canary.yml`, evaluate its promotion expression with GitHub's `@actions/expressions`, and execute its warmth check in Bash. They cover cold bootstrap eligibility and marker failures. They also check that the fork's CI cannot dispatch upstream installer builds or notifications. Set `WORKFLOW_PATH` to test another canary revision.

With Nix and jq installed, the cache test executes the real setup step, changes HOME, and checks that Nix still uses the flake's declared caches. This test is explicitly skipped when Nix is unavailable.
