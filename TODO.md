# TODO

Design and decisions: see "How it works" in `README.md`. Short version:
a UI extension (runs locally) submits a Slurm job on the login node via `ssh <alias>`. The job starts an
Apptainer instance and a user-level sshd, and VS Code connects via Remote-SSH (`ProxyJump <alias>`) using
extension-owned files in `~/.ssh/slurm-devcontainer/`. The user's `~/.ssh/config` is only changed (a single
`Include` line) after explicit consent.

## In progress

## Planned (MVP)

- [ ] Manual end-to-end test on a real Slurm cluster (needs the user): F5, Open Folder in Container, reconnect from a local window, Stop
- [ ] Integration tests (`npm test`): the template test is still a placeholder. The runner cannot unpack VS Code in this devcontainer, and it must install Remote-SSH because of `extensionDependencies`
- [ ] Before 1 Dec 2026: migrate Marketplace publishing from the global PAT to Entra ID (`azure/login` with GitHub OIDC + `vsce publish --azure-credential`); global Azure DevOps PATs stop working then

## Done

- [x] Rename the extension to `slurm-devcontainer` and set up the manifest (extensionKind `ui`, Remote-SSH dependency, commands, settings, JSON schema, `jsonc-parser`); remove helloWorld
- [x] Unit-test setup that runs without a VS Code instance (plain mocha on the pure modules)
- [x] `config.ts`: parse and validate `.slurm-devcontainer/slurm-devcontainer.json` (JSONC, defaults, variable substitution) + tests
- [x] Command "Add Slurm Dev Container Configuration" (writes a template)
- [x] `connection/`: `ConnectionStrategy` interface + `sshd` strategy
- [x] `clusterScript.ts`: generate the connect script, `job.sh`, `sshd_config` and `enter.sh` + tests (`bash -n`)
- [x] `sshConfig.ts`: Host block upsert/remove, Include detection/insertion, key generation, known_hosts pinning + tests
- [x] `remote.ts`: run scripts on the login node through `ssh -o BatchMode=yes` with streamed output and cancellation
- [x] `registry.ts`: local list of known devcontainers (`globalState`) + tests
- [x] `session.ts` + commands: Open, Add, Connect, Stop, Remove, Show Job Log
- [x] Container-window behaviour: install `customizations.vscode.extensions`; Stop from inside the container
- [x] README (requirements, setup, Include consent, ControlMaster/2FA, troubleshooting) + CHANGELOG
- [x] Optional persistent container home (`apptainer.persistentHome`, `persistentHomePath`) for `--containall`; README sections on isolation and Apptainer vs. Docker
- [x] Packaging: publisher `chillerb`, MIT license, repository links, preview flag, `.vscodeignore`; CI and release workflow (VS Code Marketplace); `VSCE_PAT` secret added

## Future

- Optional persistent Apptainer overlay per project (`apptainer overlay create --size <MB> overlay.img`, then `--overlay overlay.img`) as an alternative to `persistentHome`: makes the whole container file system writable and persistent. Caveats: only one container may use an overlay image read-write at a time (fits one job per project), fixed size, needs overlay support on the site (unprivileged: fuse-overlayfs/fuse2fs), and image-owned paths such as `/home/vscode` stay unwritable for the user's UID
- Tell the user when a cancelled connect leaves a pending job in the queue (offer Stop)

- Sidebar tree view of known devcontainers (job state, Connect/Stop buttons)
- Askpass integration (VS Code input boxes) for password/2FA logins
- Status bar with remaining walltime and a warning before the time limit
- More connection strategies: `computeSsh` (pam_slurm_adopt + RemoteCommand), `tunnel` (`code tunnel`), a static ProxyCommand relay (keeps VS Code's native "Open Recent" working across jobs)
- Research: a Dev Containers-like remote authority resolver (proposed API) with `srun --overlap` as transport
- Fall back to `.devcontainer/devcontainer.json` + `customizations.slurm`
- Pre-pull/convert `docker://` images to a cached SIF on the login node; build from Dockerfile or `.def`
- Lifecycle hooks (`postCreateCommand`, `postStartCommand`, `postAttachCommand`)
- Resource profiles (CPU/GPU quick pick); `salloc`-based interactive mode
- Isolate the VS Code server/extension directory per container
- CI integration test against a dockerised Slurm cluster
- Open VSX: drop the hard `extensionDependencies` on Microsoft's Remote-SSH (not available on Open VSX), detect any `ssh-remote` resolver at runtime (e.g. `jeanp413.open-remote-ssh` in VSCodium) and offer to install a fitting one, test with VSCodium, re-add the `open-vsx` publish job (`OVSX_PAT` secret already exists; namespace `chillerb`, consider claiming it)
