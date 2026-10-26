# AGENTS

## Scope of this Project

- the devcontainer vscode extension is very useful for developing in sandboxed, isolated environments
- unfortunately, the devcontainer extension does not support slurm and apptainer
- goal of this project: a vscode extension `remote-slurm-containers` (display name "Slurm Dev Containers"; formerly `slurm-devcontainer` and `vscode-devcontainer-slurm`), which provides some of the functionality for slurm environments

## Users Perspective

Here is an example for the vision of the user's perspective:

- user connects to login node via ssh and runs a vscode session
- after adding configuration files (`.slurm-devcontainer/slurm-devcontainer.json`), user executes vscode command called, for example, `Open in slurm devcontainer`
- vsode will then submit a slurm job for development
- the slurm jub runs the apptainer container for development, to which vscode will connect and mount and open the project in `/workspaces/{project}` (similar to the actual devcontainer plugin)

## MVP

- keep it simple, if possible
- key functionality: simple way to start devcontainer sessions in slurm
- follow best-practices for vscode extensions as recommended in the tutorials here: https://code.visualstudio.com/api

## TODO

Track your todos in the `TODO.md` file.

## Architecture

- **UI extension** (`extensionKind: ["ui"]`): it always runs on the user's computer, also in Remote-SSH windows. It talks to clusters through the local `ssh <alias>` (`src/remote.ts`, `BatchMode=yes`) and depends on Microsoft's Remote-SSH (`extensionDependencies`).
- **Connect flow** (`src/session.ts`):
  1. `probeScript` reads the user, `$HOME`, the environment and the project config on the login node.
  2. `parseConfig` parses and validates the config.
  3. `launchScript` reuses the session's pending/running job or writes `job.sh`, `sshd_config` and `enter.sh` and runs `sbatch`, then waits for `connection`.
  4. The extension writes the `Host slurm-devcontainer-<cluster>-<project>` block and pins the host key.
  5. `vscode.openFolder(vscode-remote://ssh-remote+<alias>/workspaces/<project>)`.
- **In the job** (`jobScript`): `apptainer instance start`, then the compute node's own `sshd` runs as the user on a free port. `ForceCommand enter.sh` runs every SSH session inside the instance via `apptainer exec instance://…`. Remote-SSH connects with `ProxyJump <login alias>`.
- **Modules:**
  - `config.ts`: config parsing, defaults, `${…}` substitution and the starter template;
  - `clusterScript.ts`: all generated bash;
  - `connection/`: the `ConnectionStrategy` interface and `sshd` implementation;
  - `sshConfig.ts`: local SSH files;
  - `registry.ts`: known containers in `globalState`;
  - `authority.ts`: parsing `ssh-remote+…` authorities;
  - `containerWindow.ts`: installs `customizations.vscode.extensions`.
- **State:**
  - local: `~/.ssh/slurm-devcontainer/` holds `config`, a key pair and `known_hosts`;
  - cluster: `~/.slurm-devcontainer/` holds `ssh/` (sshd host key, `authorized_keys`), `sessions/<project>/` (generated files, `job.log`, `connection`) and `work/<project>/` (persistent Apptainer workdir: the container's `/tmp`, `/var/tmp` and home).

## Decisions (agreed with the user; keep unless they reopen them)

- **Never change the user's `~/.ssh/config` without consent.** The only change is one `Include ~/.ssh/slurm-devcontainer/config` line, added after a modal dialog. Everything else lives in extension-owned files.
- **The user sshd in the job** is the only connection strategy so far. Others (pam_slurm_adopt, `code tunnel`) go behind `ConnectionStrategy`. A Dev Containers-like remote authority resolver is not possible for third-party extensions: the API is proposed-only.
- **Naming:**
  - The extension identity is `chillerb.remote-slurm-containers`, with display name "Slurm Dev Containers" and command/setting prefix `remoteSlurmContainers.*`.
  - The config `.slurm-devcontainer/slurm-devcontainer.json`, the host aliases `slurm-devcontainer-*` and the cluster/local folders deliberately keep the `slurm-devcontainer` stem, just as Microsoft's `remote-containers` kept `.devcontainer`.
- **Isolated by default:** `apptainer.runArgs` defaults to `["--containall"]` and `apptainer.persistentWorkdir` to `true` (a managed `--workdir` per project), as Dev Containers users expect. An explicit `runArgs` replaces the default entirely.
- **No automatic magic for Apptainer flags:** nothing is derived from `runArgs` (no detection of `--contain`). The only check is a conflict error when `runArgs` contains `--workdir` while `persistentWorkdir` is on. Rethinking the options (a beginner-friendly isolation switch vs. raw flags for experts) is a Future TODO.
- **Published on the VS Code Marketplace only.** Open VSX lacks Microsoft's Remote-SSH; see `TODO.md`.

## Pitfalls we ran into

- **Bundling:** esbuild must use `mainFields: ['module', 'main']`. Otherwise it bundles `jsonc-parser`'s UMD build and leaves `require('./impl/…')` unresolved. The extension then fails to load, and VS Code only says "command '…' not found". `npm run check-bundle` loads `dist/extension.js` with a stub `vscode` module; CI and the release workflow run it.
- **"command not found"** for a command that appears in the palette means activation failed. Look at Output → "Extension Host", or "Developer: Show Running Extensions".
- **Generated bash** is piped into `bash -l -s`. It is wrapped in a function (`wrap()`) so commands reading stdin can't swallow the rest of the script. Output lines carry the `@@sdc:` marker so login-shell noise is ignored.
- **Slurm:**
  - Only pending/running jobs count as active; a cancelled job stays visible as COMPLETING for a few seconds.
  - `squeue -j` fails with "Invalid job id" once a job has left the queue. Other squeue errors are transient and retried.
- **Apptainer:** it is not an isolation sandbox by default (same user, node hostname/network, home, `/tmp` and admin `bind path`s are visible). With `--contain`/`--containall`, home and `/tmp` are a tmpfs limited by `sessiondir max size` (64 MiB by default). The VS Code CLI downloads the server archive into `/tmp`, so a persistent `--home` is not enough (0.2.0's `persistentHome` failed with "No space left on device"). A disk-backed `--workdir` fixes both, because with `--contain` it also hosts the home. Hence `persistentWorkdir`. The image's own `/home/vscode` is no alternative: the SIF is read-only and owned by another UID.
- **Logins with a port** must be passed as `ssh://user@host:port`, because ssh rejects `host:port` as a destination.
- **The UI extension cannot see extensions installed on the remote server** (`vscode.extensions.getExtension`), so the registry remembers what it installed.
- **Marketplace:**
  - categories are validated only when publishing, not by `vsce package`;
  - versions can never be republished;
  - publishing uses a global Azure DevOps PAT (`VSCE_PAT`, scope Marketplace → Manage, "All accessible organizations"), and those stop working on 1 Dec 2026 (see `TODO.md`).
- **Tests:** the VS Code integration runner (`npm test`) cannot unpack VS Code inside this devcontainer. Use `npm run test:unit` (plain mocha on the pure modules). The cluster scripts are tested against fake `sbatch`/`squeue`/`apptainer`/`sshd` executables. Nothing replaces a manual test on a real cluster.

## Workflow

- **Build and test:** `npm run compile`, `npm run test:unit`, `npm run package && npm run check-bundle`, `npx @vscode/vsce package`.
- **Commits:** make an atomic commit per finished TODO item and keep `TODO.md` up to date. Never push; the user pushes.
- **Releases:**
  - bump the version (`npm version X.Y.Z --no-git-tag-version`) and add a `CHANGELOG.md` entry;
  - the user pushes a matching `vX.Y.Z` tag, which triggers `.github/workflows/release.yml`;
  - never move or reuse tags or versions; a broken release gets a new version.
- **Design discussions:** explain options concretely (which files change, what is stored where) and give a recommendation before asking the user to choose.
