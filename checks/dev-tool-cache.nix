# Global dependency patches change store paths and prevent binary substitution.
# These tools previously rebuilt GHC and Sphinx before Flox CI could start.
{
  lib,
  runCommand,
  haskellPackages,
  python3Packages,
  stockPkgs,
}:
let
  tools = {
    ghc = {
      actual = haskellPackages.ghc;
      stock = stockPkgs.haskellPackages.ghc;
    };
    sphinx = {
      actual = python3Packages.sphinx;
      stock = stockPkgs.python3Packages.sphinx;
    };
  };
  changed = lib.filterAttrs (_: tool: tool.actual.drvPath != tool.stock.drvPath) tools;
in
assert lib.assertMsg (changed == { }) ''
  Flox changes development-tool derivations that should reuse the nixpkgs cache:
  ${lib.concatMapStringsSep "\n" (
    name: "${name}: ${tools.${name}.actual.drvPath} != ${tools.${name}.stock.drvPath}"
  ) (lib.attrNames changed)}
  Scope required Flox dependency changes to Flox's packages.
'';
runCommand "dev-tool-cache" { } ''
  touch "$out"
''
