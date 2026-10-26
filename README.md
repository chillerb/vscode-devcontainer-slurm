# Slurm Dev Container

Develop inside [Apptainer](https://apptainer.org/) containers that run as [Slurm](https://slurm.schedmd.com/) jobs on HPC clusters, similar to the [Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers) extension, which needs Docker.

You describe the container in `.slurm-devcontainer/devcontainer.json`. With one command the extension:
1. submits a Slurm job (or reuses the running one) that starts the container on a compute node;
2. opens the project inside the container at `/workspaces/<project>` in a new VS Code window.

> **Status:** early MVP. Feedback and bug reports are welcome. See [`TODO.md`](TODO.md) for planned features.

## How it works

```
 your computer                      login node                         compute node (Slurm job)
┌──────────────────┐  ssh <alias>  ┌──────────────────┐               ┌──────────────────────────────┐
│ VS Code          │──────────────▶│ sbatch / squeue  │──── sbatch ──▶│ apptainer instance (image)   │
│  + this extension│               └──────────────────┘               │ sshd (as you, random port)   │
│  + Remote-SSH    │════════ ssh -J <alias> node:port ═══════════════▶│   └─ every session runs      │
└──────────────────┘                                                  │      inside the container    │
                                                                      └──────────────────────────────┘
```

- The extension runs on **your computer**. It runs `sbatch`/`squeue`/`scancel` on the login node through your normal `ssh <alias>`.
- The job starts an Apptainer instance and the compute node's own `sshd` binary, running **as your user** on a free port. Every session on that sshd is forced into the container, so VS Code's server and your terminals run inside it.
- Remote-SSH connects to that sshd through the login node (`ProxyJump`). The connection uses a host entry that the extension writes into its own file, `~/.ssh/slurm-devcontainer/config`.
- The extension remembers each dev container (login node + project path). **Connect to Container...** works from any window, and later connects reuse the running job or start a new one.

## Requirements

**On your computer**
- VS Code with the [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension.
- An OpenSSH client (`ssh`, `ssh-keygen`).
- `ssh <alias>` to the login node must work **without a password prompt**. The extension runs ssh in batch mode. Use an SSH key, or a `ControlMaster` connection if your cluster requires 2FA (see below).

**On the cluster**
- Slurm commands (`sbatch`, `squeue`, `scancel`) on the login node.
- Apptainer (or Singularity) on the compute nodes, with support for `apptainer instance`.
- An `sshd` binary on the compute nodes (default `/usr/sbin/sshd`). No root access or system sshd configuration is needed.
- The login node must be able to reach compute nodes on TCP ports 20000–50000.
- A home directory shared between login and compute nodes.

Many clusters meet these requirements, but some sites forbid user-level sshd processes in jobs. Check your site's policy if connections fail.

## Getting started

1. Connect VS Code to the cluster login node with Remote-SSH and open your project folder.
2. Run **Slurm Dev Container: Add Configuration File...** and adjust the image and resources.
3. Run **Slurm Dev Container: Open Folder in Container**.
   - The first time, the extension asks whether it may add one line to `~/.ssh/config` on your computer (see [Files](#files-written-by-the-extension)). You can also copy the line and add it yourself.
   - A notification shows the job state while the job is pending. When it is running, a new window opens inside the container.
4. Later, run **Slurm Dev Container: Connect to Container...** from any window, even without a connection to the cluster. It reconnects to the running job or starts a new one.

## Configuration

`.slurm-devcontainer/devcontainer.json` (JSON with comments) uses a subset of [devcontainer.json](https://containers.dev/implementors/json_reference/):

```jsonc
{
	"name": "my-project",
	"image": "docker://mcr.microsoft.com/devcontainers/python:3.12",
	"workspaceFolder": "/workspaces/${localWorkspaceFolderBasename}",
	"containerEnv": { "DATA_DIR": "/scratch/${localEnv:USER}" },
	"mounts": ["source=/scratch/${localEnv:USER},target=/scratch,type=bind"],
	"customizations": { "vscode": { "extensions": ["ms-python.python"] } },
	"slurm": { "partition": "gpu", "time": "08:00:00", "cpusPerTask": 8, "mem": "32G", "gpus": 1 },
	"apptainer": { "modules": ["apptainer"], "runArgs": ["--nv"] }
}
```

| Property | Description |
|---|---|
| `image` | **Required.** `docker://…`, `oras://…`, `library://…` or a path to a `.sif` file. Relative paths are resolved against `.slurm-devcontainer/`. Bare names like `ubuntu:24.04` mean `docker://ubuntu:24.04`. |
| `workspaceFolder` | Where the project is mounted and opened. Default: `/workspaces/${localWorkspaceFolderBasename}`. |
| `containerEnv`, `remoteEnv` | Environment variables inside the container. |
| `mounts` | Extra bind mounts: `"source=…,target=…[,readonly]"` or `{ "source", "target", "readonly" }`. |
| `customizations.vscode.extensions` | Extensions installed when the container window opens. |
| `slurm` | `partition`, `time`, `cpusPerTask`, `mem`, `gpus`, `account`, `qos`, `constraint`, plus `sbatchArgs` for anything else (e.g. `["--gres=gpu:a100:1"]`). |
| `apptainer` | `binary` (default `apptainer`; use `singularity` on older systems), `modules` to `module load` first, `runArgs` for `apptainer instance start` (e.g. `--nv`, `--writable-tmpfs`). |
| `connection` | `type` (only `sshd` for now) and `sshdPath` (default `/usr/sbin/sshd`). |

Variables: `${localWorkspaceFolder}` and `${localWorkspaceFolderBasename}` refer to the project folder on the cluster. `${containerWorkspaceFolder}` is the folder inside the container. `${localEnv:VAR}` and `${localEnv:VAR:default}` read your environment on the login node.

The project folder and your home directory are available inside the container (Apptainer binds `$HOME` by default). The container image is read-only. Add `--writable-tmpfs` to `runArgs` if tools need to write outside your home directory.

## Commands

| Command | Description |
|---|---|
| Open Folder in Container | Opens the current Remote-SSH folder (on a login node) in its dev container. |
| Connect to Container... | Picks a known dev container and connects, starting a job if none is running. |
| Add Container... | Registers a project by login host and path without opening it first. |
| Stop Container Job... | Cancels the Slurm job (`scancel`). |
| Remove Container from List... | Forgets a dev container, optionally stopping its job first. |
| Show Job Log... | Shows the job's output (container start-up, sshd). |
| Add Configuration File... | Creates a commented `.slurm-devcontainer/devcontainer.json`. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `slurmDevcontainer.sshPath` | `ssh` | Local ssh executable. |
| `slurmDevcontainer.openInNewWindow` | `true` | Open containers in a new window. |
| `slurmDevcontainer.connectTimeoutMinutes` | `30` | How long to wait for a pending job. The job keeps waiting in the queue after a timeout. |

## Files written by the extension

**On your computer**
- `~/.ssh/slurm-devcontainer/config` holds one `Host slurm-devcontainer-<cluster>-<project>` entry per dev container. The compute node and port are updated on every connect.
- `~/.ssh/slurm-devcontainer/id_ed25519` is a key pair used only to log into the containers' sshd.
- `~/.ssh/slurm-devcontainer/known_hosts` holds the pinned host key of the job sshd, one per cluster. It is fetched over your trusted login connection.
- `~/.ssh/config` gets the line `Include ~/.ssh/slurm-devcontainer/config` at the top, **only if you click "Add Line"**. Remote-SSH can only find the container hosts through this line. No other change is ever made to your SSH config.

**On the cluster** (in your home directory)
- `~/.slurm-devcontainer/ssh/` holds the sshd host key and an `authorized_keys` file containing only the extension's public key.
- `~/.slurm-devcontainer/sessions/<project>/` holds the generated `job.sh`, `sshd_config` and `enter.sh`, plus `job.log` and the current `connection` details.

## Logins with 2FA or passwords

The extension cannot answer password or 2FA prompts. Let one interactive login be shared by all ssh connections with `ControlMaster`, in `~/.ssh/config` on your computer:

```sshconfig
Host my-cluster
  HostName login.cluster.example.org
  User jdoe
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 8h
```

Log in once in a terminal (`ssh my-cluster`). Afterwards the extension and Remote-SSH reuse that connection. ControlMaster is not available with the Windows OpenSSH client.

## Troubleshooting

- **The job fails or never becomes ready.** Run **Show Job Log...**. Common causes are an image that cannot be pulled, a missing `module load`, or a site that does not allow user-level sshd.
- **"Could not resolve hostname slurm-devcontainer-…"**: the `Include` line is missing from `~/.ssh/config` or is not at the top (before any `Host`/`Match` block).
- **Connection times out after the job started.** The login node probably cannot reach the compute node's port. Ask your admins whether login→compute connections on high ports are allowed.
- **Remote-SSH asks for the platform of the host.** Choose "Linux".
- **Extensions fail to install in the container.** Compute nodes often have no internet access. Set `"remote.downloadExtensionsLocally": true` so VS Code downloads extensions on your computer and uploads them.
- The extension's output channel is **Output → Slurm Dev Container**, and it contains the details of every step.

## Development

```sh
npm install
npm run compile      # type-check, lint, bundle
npm run test:unit    # unit tests (no VS Code instance needed)
```

Press <kbd>F5</kbd> in VS Code to start an Extension Development Host.
