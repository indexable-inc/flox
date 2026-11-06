# The flox CI runner template, as its own subflake.
#
# This is the "BYO template" half of an ix runner pool: the pool row points
# at `github:<owner>/flox/<rev>?dir=ci/ix-runner-template#flox`, and the ix
# runner control plane builds exactly that on a fresh guest for every cold
# boot. It is a separate subflake, not an output of the repository's root
# flake, for the same reason the platform's own template is: a template's
# input closure must not drag in the consumer repository's inputs (flox's
# root flake pulls fenix, crane, pre-commit-hooks and a patched Nix; a
# runner image needs none of them).
#
# MECHANISM IS NOT VENDORED. `module.nix` (the single-job JIT runner) and
# `platform.nix` (ix's substrate policy) are consumed as a *source input*
# from the ix platform template rather than copied into this tree, so a
# platform fix arrives as a lock/rev bump here instead of a manual re-copy.
# `ci/ix-runner-template/flox.nix` is the only file this repository owns.
#
# ---------------------------------------------------------------------------
# Pinning
# ---------------------------------------------------------------------------
# `ix-runner-template` is pinned BY REV, never by branch. The control plane
# keys its template cache on the exact commit, so a mutable ref would
# re-resolve and cold-boot every lane. The rev below is the one the live
# reference pool (`harivansh-afk/baml`, pool `default`) runs at, verified
# green on 2026-08-20; bump it deliberately, in a quiet window, because a
# bump invalidates every seed lineage and the next job of each lane
# cold-boots.
{
  description = "flox CI runner template for ix runner pools";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # The ix platform runner template, as SOURCE (`flake = false`): we want
    # its module files, not its flake outputs, so `module.nix` and
    # `platform.nix` evaluate against the nixpkgs pinned above rather than
    # against a second, independently-locked copy.
    #
    # NO `?dir=` HERE, deliberately. On a `flake = false` input, `dir` is
    # recorded in the lock but does NOT move `outPath`: the input still
    # resolves to the repository root, and `"${input}/module.nix"` fails with
    # "path ... does not exist". The subdirectory is spelled out at the use
    # site below instead. (Verified: with `?dir=ci/runner-template` the eval
    # dies on `«github:indexable-inc/index/f3f39a01»/module.nix`.)
    ix-runner-template = {
      url = "github:indexable-inc/index/f3f39a0184d992aeab7d909e0b3acf65ac8a3c24";
      flake = false;
    };
  };

  outputs =
    {
      nixpkgs,
      ix-runner-template,
      ...
    }:
    let
      platform = "${ix-runner-template}/ci/runner-template";
      floxRunner = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          "${platform}/module.nix" # the mechanism, ix-owned
          "${platform}/platform.nix" # ix substrate policy
          ./flox.nix # this repository's family delta
          { services.ix-runner.enable = true; }
        ];
      };
    in
    {
      nixosConfigurations.flox = floxRunner;

      # A plain ix template leaves root-device and bootloader facts to the
      # platform's injected machine profile, so the configuration cannot be
      # realized standalone; extend it as a container for the check only, the
      # way the platform template's own flake does.
      checks.x86_64-linux.flox-runner-template =
        (floxRunner.extendModules {
          modules = [ { boot.isContainer = true; } ];
        }).config.system.build.toplevel;
    };
}
