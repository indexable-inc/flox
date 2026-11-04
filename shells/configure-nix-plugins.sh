#!/usr/bin/env bash
set -euo pipefail

compiler_package="${1:?compiler package path is required}"
source_dir="${2:?source directory is required}"
build_dir="${3:?build directory is required}"
prefix="${4:?installation prefix is required}"
toolchain_file="$build_dir/.flox-toolchain"
current_toolchain="$(mktemp)"
trap 'rm -f "$current_toolchain"' EXIT

# Meson clears dependencies with --clearcache, but retains its compiler,
# initial flags and source directory. Changed inputs need a fresh configuration.
printf '%s\n' \
  "compiler_package=$compiler_package" \
  "source_dir=$source_dir" \
  "meson=$(meson --version)" \
  "CXX=${CXX:?CXX is required}" \
  "CXX_LD=${CXX_LD-}" \
  "CXXFLAGS=${CXXFLAGS-}" \
  "CPPFLAGS=${CPPFLAGS-}" \
  "LDFLAGS=${LDFLAGS-}" \
  "NIX_CFLAGS_COMPILE=${NIX_CFLAGS_COMPILE-}" \
  "NIX_LDFLAGS=${NIX_LDFLAGS-}" \
  "PKG_CONFIG_PATH=${PKG_CONFIG_PATH-}" \
  > "$current_toolchain"

options=(--reconfigure --clearcache)
if [[ -f "$build_dir/meson-private/coredata.dat" ]] &&
  { [[ ! -f "$toolchain_file" ]] || ! cmp -s "$current_toolchain" "$toolchain_file"; }; then
  options+=(--wipe)
fi
meson setup "${options[@]}" --prefix "$prefix" "$build_dir" "$source_dir"
cp "$current_toolchain" "$toolchain_file"
