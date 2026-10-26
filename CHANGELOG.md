# Change Log

All notable changes to the "remote-slurm-containers" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [v0.3.1] - 2026-10-26

### Fixed

- Installing the configured extensions in a container no longer asks whether to install them on all your devices (Settings Sync); they are installed for the container only.

### Documentation

- GPUs need `--nv` in `apptainer.runArgs` in addition to `slurm.gpus`.

## [v0.3.0] - 2026-10-26

### Changed

- Containers are isolated by default: `apptainer.runArgs` defaults to `["--containall"]` and `apptainer.persistentWorkdir` to `true`. Use `"runArgs": []` and `"persistentWorkdir": false` for an unisolated container.
- **Breaking:** `apptainer.persistentHome`/`persistentHomePath` are replaced by `apptainer.persistentWorkdir`/`persistentWorkdirPath`. The persistent `--workdir` (default `~/.slurm-devcontainer/work/<project>`) holds the container's `/tmp`, `/var/tmp` and home. A config using the old options reports the new names. The old `~/.slurm-devcontainer/home/<project>` folder can be deleted.

### Fixed

- `--containall` containers can now download the VS Code server. It was downloaded via `/tmp`, which stayed on Apptainer's small temporary filesystem.
- A `--workdir` in `runArgs` together with `persistentWorkdir` is reported as a configuration error.

## [v0.2.0] - 2026-10-26

### Added

- `apptainer.persistentHome` and `apptainer.persistentHomePath`: use a persistent directory as the container's home instead of your real home. This makes `--contain`/`--containall` usable; the VS Code server and extensions are downloaded once and kept across jobs.

### Documentation

- How to isolate the container with `--containall`, what is and isn't isolated, and how Apptainer differs from Docker.

## [v0.1.2] - 2026-10-26

### Fixed

- The extension failed to activate, so every command reported "command not found". A dependency (`jsonc-parser`) was bundled incorrectly.

## [v0.1.1] - 2026-10-26

### Changed

- First Marketplace release (0.1.0 was never published): extension ID `remote-slurm-containers`, display name "Slurm Dev Containers".

## [v0.1.0] - 2026-10-26

### Added

- `.slurm-devcontainer/slurm-devcontainer.json` configuration (devcontainer.json subset plus `slurm`, `apptainer` and `connection`) with a JSON schema.
- Commands to open the current folder in a container, connect to known containers from any window, add, stop and remove containers, show the job log and create a starter configuration.
- `sshd` connection strategy: the job runs an unprivileged sshd that forces sessions into the Apptainer instance; Remote-SSH connects via ProxyJump through the login node.
- Installation of `customizations.vscode.extensions` in container windows.
