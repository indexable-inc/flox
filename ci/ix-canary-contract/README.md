# Canary contract tests

Run with Node.js 20 or newer and Bash:

```sh
cd ci/ix-canary-contract
npm ci --ignore-scripts
npm test
```

The tests read `.github/workflows/ix-canary.yml`, evaluate its promotion expression with GitHub's `@actions/expressions`, and execute its warmth check in Bash. The canary runs only by manual dispatch. Tests cover default-branch bootstrap eligibility and marker failures; an older valid marker remains useful when no automatic refresh runs. They also check that the fork's CI cannot dispatch upstream installer builds or notifications. Set `WORKFLOW_PATH` to test another canary revision.

With Nix and jq installed, the cache test executes the real setup step, changes HOME, and checks that Nix still uses the flake's declared caches. This test is explicitly skipped when Nix is unavailable.

Bats admission tests evaluate the workflow's job guard before the package build has a result. The local-script tests run the real Bats launcher against a temporary Git checkout and a fake Nix executable. They check that both tag partitions invoke `nix run` for the complete test package, collect its report, and propagate a failed build or test command.

The ARM64 Bats jobs can start after scope classification because each VM realizes its own test package closure. The separate Nix build remains a workflow check. Cold runs can now start two more 32-vCPU VMs alongside the build lanes, so compare total workflow time and storage pressure on complete runs before claiming a speedup. Remote-builder lanes would need their own publication dependency if added to this matrix.
