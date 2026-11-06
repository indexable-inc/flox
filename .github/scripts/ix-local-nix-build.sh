#!/usr/bin/env bash
# ============================================================================ #
#
# The ix-leg counterpart of `remote-execute-nix-build.sh`.
#
# On a GitHub-hosted `ubuntu-latest` runner the `nix-build` job owns no build
# capacity of its own, so `remote-execute-nix-build.sh` scps a signing key to
# a Tailscale-reachable NixOS builder, ssh's in, builds there, and copies the
# result into the S3 substituter from that machine. An ix runner *is* a big
# NixOS box, so all of that apparatus is exactly the thing to delete: this
# script builds locally and keeps everything else identical.
#
# Semantics preserved from the original, one for one:
#
#   * SAME ATTRIBUTE, SAME FLAGS. `nix build --no-link --print-build-logs
#     --json --accept-flake-config <ref>` and then read `.[0].drvPath` out of
#     the JSON. The caller passes the same `packages.<system>.<name>` attr
#     paths in the same order.
#   * SAME PUSH. `nix copy --substitute-on-destination --to
#     "<store>?secret-key=<key>" "$DRV" "$DRV^*"` — the derivation and every
#     one of its outputs, substituting on the destination rather than
#     uploading what the cache already has.
#
# Deliberate deviations, each one forced:
#
#   * FLAKE REF. The original builds `github:flox/flox/$GITHUB_SHA#<attr>`.
#     That ref does not resolve for a commit that only exists on a fork, so
#     this builds the checked-out tree (`.#<attr>`) instead. Same tree, same
#     derivation; `actions/checkout` has already placed it and the `nix-build`
#     job checks out with `fetch-depth: 0` so `git describe` still works.
#   * PUSH IS CONDITIONAL. The substituter and its signing key arrive from
#     `secrets.MANAGED_CACHE_PUBLIC_*`, which a preview fork does not have.
#     With either unset the build still runs and is still a real pass/fail
#     signal; only the push is skipped, loudly, via `::notice::`. Set both on
#     the fork to turn it back on. There is no silent path: an unset key with
#     a set store, or the reverse, is a hard error.
#
# Usage: ix-local-nix-build.sh <attr_path> [<remote store>]
#
# ---------------------------------------------------------------------------- #

set -euo pipefail

function main() {
  local -r usage="USAGE: ix-local-nix-build.sh <attr_path> [<remote store>]"
  local -r attr_path="${1?$usage}"
  local -r remote_store="${2:-}"

  local -r nix_build_args=(
    nix build
    --extra-experimental-features "nix-command flakes"
    --no-link
    --print-build-logs
    --json
    --accept-flake-config
    ".#${attr_path}"
  )

  echo "+ ${nix_build_args[*]}" >&2
  local drv
  drv="$("${nix_build_args[@]}" | jq -r '.[0].drvPath')"
  if [ -z "$drv" ] || [ "$drv" = "null" ]; then
    echo "::error::nix build produced no drvPath for ${attr_path}" >&2
    exit 1
  fi
  echo "built ${attr_path} -> ${drv}" >&2

  # Report the closure size the way the original job's `closure` step was
  # meant to; harmless when nothing consumes it.
  nix path-info --extra-experimental-features nix-command -S --json "$drv^*" \
    | jq -r '.[] | "\(.path) \(.closureSize)"' >&2 || true

  local -r key="${NIX_SUBSTITUTER_KEY:-}"
  if [ -z "$remote_store" ] && [ -z "$key" ]; then
    echo "::notice title=Substituter push skipped::no NIX_SUBSTITUTER / NIX_SUBSTITUTER_KEY configured; ${attr_path} was built but not pushed" >&2
    return 0
  fi
  if [ -z "$remote_store" ] || [ -z "$key" ]; then
    echo "::error::NIX_SUBSTITUTER and NIX_SUBSTITUTER_KEY must be set together (store='${remote_store}', key set=$([ -n "$key" ] && echo yes || echo no))" >&2
    exit 1
  fi

  local -r key_file="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$key_file'" EXIT
  printenv NIX_SUBSTITUTER_KEY >"$key_file"

  local -r nix_copy_args=(
    nix copy
    --extra-experimental-features nix-command
    --substitute-on-destination
    --to "${remote_store}?secret-key=${key_file}"
    "$drv"
    "$drv^*"
  )
  echo "+ nix copy --to ${remote_store}?secret-key=<redacted> $drv $drv^*" >&2
  "${nix_copy_args[@]}"
}

main "$@"
