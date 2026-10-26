# TODO

Design and decisions: see the "Architecture" section in `README.md` (once written). Short version:
a UI extension (runs locally) submits a Slurm job on the login node via `ssh <alias>`. The job starts an
Apptainer instance and a user-level sshd, and VS Code connects via Remote-SSH (`ProxyJump <alias>`) using
extension-owned files in `~/.ssh/slurm-devcontainer/`. The user's `~/.ssh/config` is only changed (a single
`Include` line) after explicit consent.

## In progress

## Planned (MVP)

- [ ] `clusterScript.ts`: generate the connect script, `job.sh`, `sshd_config` and `enter.sh` + tests (`bash -n`)
- [ ] `sshConfig.ts`: Host block upsert/remove, Include detection/insertion, key generation, known_hosts pinning + tests
- [ ] `remote.ts`: run scripts on the login node through `ssh -o BatchMode=yes` with streamed output and cancellation
- [ ] `registry.ts`: local list of known devcontainers (`globalState`) + tests
- [ ] `session.ts` + commands: Open, Add, Connect, Stop, Remove, Show Job Log
- [ ] Container-window behaviour: install `customizations.vscode.extensions`; Stop from inside the container
- [ ] README (requirements, setup, Include consent, ControlMaster/2FA, troubleshooting) + CHANGELOG
- [ ] Manual end-to-end test on a real Slurm cluster (needs the user)

## Done

- [x] Rename the extension to `slurm-devcontainer` and set up the manifest (extensionKind `ui`, Remote-SSH dependency, commands, settings, JSON schema, `jsonc-parser`); remove helloWorld
- [x] Unit-test setup that runs without a VS Code instance (plain mocha on the pure modules)
- [x] `config.ts`: parse and validate `.slurm-devcontainer/devcontainer.json` (JSONC, defaults, variable substitution) + tests
- [x] Command "Add Slurm Dev Container Configuration" (writes a template)
- [x] `connection/`: `ConnectionStrategy` interface + `sshd` strategy

## Future

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
- Publish to the VS Code Marketplace and Open VSX
