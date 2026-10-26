# Change Log

All notable changes to the "slurm-devcontainer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- `.slurm-devcontainer/devcontainer.json` configuration (devcontainer.json subset plus `slurm`, `apptainer` and `connection`) with a JSON schema.
- Commands to open the current folder in a container, connect to known containers from any window, add, stop and remove containers, show the job log and create a starter configuration.
- `sshd` connection strategy: the job runs an unprivileged sshd that forces sessions into the Apptainer instance; Remote-SSH connects via ProxyJump through the login node.
- Installation of `customizations.vscode.extensions` in container windows.
