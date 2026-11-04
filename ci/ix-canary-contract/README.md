# Canary contract tests

Run with Node.js 20 or newer and Bash:

```sh
cd ci/ix-canary-contract
npm ci --ignore-scripts
npm test
```

The tests read `.github/workflows/ix-canary.yml`, evaluate its promotion expression with GitHub's `@actions/expressions`, and execute its warmth check in Bash. They cover cold bootstrap eligibility and marker failures. Set `WORKFLOW_PATH` to test another workflow revision.
