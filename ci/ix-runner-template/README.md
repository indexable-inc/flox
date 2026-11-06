# flox CI runner template for ix ARM64 CI

The NixOS configuration behind `runs-on: ["ix", "ix-*"]` for this
repository's ix runner pool. Three layers, bottom to top:

| layer | owner | what it is |
| --- | --- | --- |
| `module.nix` | ix | the single-job JIT runner mechanism. One GitHub Actions runner, one job, one VM. |
| `platform.nix` | ix | ix substrate policy: cache.ix.dev substitution, GC headroom, hosted-image parity packages, 16-thread parallelism defaults. |
| `flox.nix` | **this repo** | the flox family delta: cache.flox.dev substitution, nix daemon `max-jobs`/`cores`, and 8-thread parallelism pins. |

The first two are consumed as a pinned *source* input (`flake.nix`,
`inputs.ix-runner-template`), not vendored, so a platform fix arrives as a
rev bump rather than a manual re-copy.

## How a job reaches this image

1. A workflow job declares `runs-on: ["ix", "ix-<lane>"]`.
2. GitHub fires a `workflow_job` webhook at the ix runner control plane.
3. The control plane matches the job to the pool whose `runner_label` is
   `ix`, and computes a **lineage** = `sha256(sorted unique labels joined by
   "\n")[0:8]`. The `ix-<lane>` label is what gives each lane its own
   lineage, and therefore its own warm seed disk.
4. It either forks the lineage's seed snapshot (**warm**) or cold-boots this
   template (**cold**), writes a single-use JIT credential to
   `/var/lib/ix-runner/jitconfig`, and the guest's `ix-runner.path` unit
   starts the runner.
5. The runner serves exactly one job and exits. The control plane deletes
   the machine — or, when the job was a green default-branch run, snapshots
   it first, which is how the *next* job of that lane boots with this one's
   warm `/nix/store` and `$HOME` already in place.

There is no registration token, no runner slot, no repair path: one job per
machine makes the machine boundary the isolation.

## Ephemerality

Ephemeral by construction, not by an `--ephemeral` flag. The credential is a
JIT config good for a single job; the unit's `ExecStartPre` *moves* it out of
the watched path before the runner starts, so a spent blob can never ride
into a seed snapshot; `Restart=no`; and the machine is deleted once the
registration disappears.

## Verifying a built image

```sh
ix shell <vm> -- sh -c '
  ls -d /nix/store/*github-runner-with-node20
  /usr/sbin/systemctl is-active ix-runner.path      # -> active   (armed)
  /usr/sbin/systemctl is-active ix-runner.service   # -> inactive (no credential yet)
  /usr/sbin/systemctl show ix-runner.service -p Environment
  grep substituters /etc/nix/nix.conf               # must list cache.flox.dev
'
```

## Platform validation

The production ARM64 streams cut was measured on 2026-10-24 after the ix
worker fix landed. A fresh `runs-on: ["ix", "ix-<lane>"]` VM took 3.4 seconds
for its first snapshot. The previous worker failed the same first cut at 5.7 to
5.9 seconds because its pause budget was fixed at 5 seconds. The second cut on
the old worker took about 1.1 seconds, which is why a retry hid the defect.

This measures the ix snapshot path, not a Flox job. Flox CI timings and seed
promotion are recorded from the first green `canary` run after this branch's
jobs complete.

The production Flox pool must point at this repository's template with
`template_attr = "flox"` and `flake_dir = "ci/ix-runner-template"`. Changing
that row is a seed reset by design. Existing holders are retired, then the
first green default-branch job creates the new generation.

The workflows also carry the `ix-flox` label. It keeps the ix pool match while
changing the lineage key, so a template roll cannot select a stale seed from
the old pool generation.

## Bumping the pin

`inputs.ix-runner-template` is pinned by exact commit. Bump it deliberately:
a bump changes the pool's `template_rev`, which invalidates **every** seed
lineage, so the next job of every lane cold-boots and re-seeds. Do it in a
quiet window, never as a side effect of an unrelated change.

The pool row's `template_rev` must be updated in the same motion — the ix
control plane resolves `github:<repo>/<template_rev>?dir=<flake_dir>#<attr>`
as a unit, and a rev from one source with a ref from another names a commit
that does not exist.
