#!/usr/bin/env bash
# ============================================================================ #
#
# The ix-leg counterpart of `remote-execute-integration-tests.sh`.
#
# The original renders a command, ssh's it to a Tailscale-reachable NixOS
# builder, tees the output, then scp's `report.xml` back out of the temporary
# WORKDIR the run announced on stdout as `TESTS_DIR: <path>`. On an ix runner
# the "remote builder" and the runner are the same machine, so the ssh and the
# scp both collapse into running the command and copying a local file.
#
# Semantics preserved from the original, one for one:
#
#   * SAME INVOCATION. `nix run --accept-flake-config <ref> --
#     --ci-runner "flox-$MATRIX_SYSTEM" -- --filter-tags "$MATRIX_TEST_TAGS"
#     --report-formatter junit`.
#   * SAME `git clean -xfd` FIRST. The suite assumes a pristine tree.
#     NOTE: on ix this matters more, not less — a warm seed disk carries the
#     previous job's ignored files, which is precisely the state the original
#     was protecting against on a reused hosted runner.
#   * SAME REPORT RETRIEVAL. `TESTS_DIR:` is parsed out of the tee'd output
#     and `$TESTS_DIR/report.xml` lands at `./report.xml`.
#
# Deliberate deviation: the flake ref. The original builds
# `github:flox/flox/$GITHUB_SHA#packages.$MATRIX_SYSTEM.flox-cli-tests`, which
# does not resolve for a commit that only exists on a fork; this runs the
# checked-out tree instead.
#
# ---------------------------------------------------------------------------- #

set -euxo pipefail

function main() {
  git clean -xfd

  local -r flake_ref=".#packages.${MATRIX_SYSTEM}.flox-cli-tests"

  nix run \
    --accept-flake-config \
    --extra-experimental-features "nix-command flakes" \
    "$flake_ref" \
    -- \
    --ci-runner "flox-${MATRIX_SYSTEM}" \
    -- \
    --filter-tags "$MATRIX_TEST_TAGS" \
    --report-formatter junit \
    | tee output.txt

  local -r tests_dir="$(awk '{ if ($1 == "TESTS_DIR:") { print $2 } }' output.txt)"
  if [ -z "$tests_dir" ]; then
    echo "::error::the suite did not announce a TESTS_DIR; no report to collect" >&2
    exit 1
  fi
  cp "${tests_dir}/report.xml" ./report.xml
}

main "$@"
