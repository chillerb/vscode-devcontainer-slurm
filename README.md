# Slurm Dev Containers

Develop inside [Apptainer](https://apptainer.org/) containers that run as [Slurm](https://slurm.schedmd.com/) jobs on HPC clusters, similar to the [Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers) extension, which needs Docker.

You describe the container in `.slurm-devcontainer/slurm-devcontainer.json`. With one command the extension:
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
2. Run **Slurm Dev Containers: Add Configuration File...** and adjust the image and resources.
3. Run **Slurm Dev Containers: Open Folder in Container**.
   - The first time, the extension asks whether it may add one line to `~/.ssh/config` on your computer (see [Files](#files-written-by-the-extension)). You can also copy the line and add it yourself.
   - A notification shows the job state while the job is pending. When it is running, a new window opens inside the container.
4. Later, run **Slurm Dev Containers: Connect to Container...** from any window, even without a connection to the cluster. It reconnects to the running job or starts a new one.

## Configuration

`.slurm-devcontainer/slurm-devcontainer.json` (JSON with comments) uses a subset of [devcontainer.json](https://containers.dev/implementors/json_reference/):

```jsonc
{
	"name": "my-project",
	"image": "docker://mcr.microsoft.com/devcontainers/python:3.12",
	"workspaceFolder": "/workspaces/${localWorkspaceFolderBasename}",
	"containerEnv": { "DATA_DIR": "/scratch/${localEnv:USER}" },
	"mounts": ["source=/scratch/${localEnv:USER},target=/scratch,type=bind"],
	"customizations": { "vscode": { "extensions": ["ms-python.python"] } },
	"slurm": { "partition": "gpu", "time": "08:00:00", "cpusPerTask": 8, "mem": "32G", "gpus": 1 },
	"apptainer": { "modules": ["apptainer"], "runArgs": ["--containall", "--nv"] }
}
```

| Property | Description |
|---|---|
| `image` | **Required.** `docker://…`, `oras://…`, `library://…` or a path to a `.sif` file. Relative paths are resolved against `.slurm-devcontainer/`. Bare names like `ubuntu:24.04` mean `docker://ubuntu:24.04`. |
| `workspaceFolder` | Where the project is mounted and opened. Default: `/workspaces/${localWorkspaceFolderBasename}`. |
| `containerEnv`, `remoteEnv` | Environment variables inside the container. |
| `mounts` | Extra bind mounts: `"source=…,target=…[,readonly]"` or `{ "source", "target", "readonly" }`. |
| `customizations.vscode.extensions` | Extensions installed when the container window opens. Each one is installed once; extensions added to the list later are installed on the next connect. |
| `slurm` | `partition`, `time`, `cpusPerTask`, `mem`, `gpus`, `account`, `qos`, `constraint`, plus `sbatchArgs` for anything else (e.g. `["--gres=gpu:a100:1"]`). |
| `apptainer` | `binary` (default `apptainer`; use `singularity` on older systems), `modules` to `module load` first, `runArgs` for `apptainer instance start` (default `["--containall"]`; keep it when adding flags such as `--nv`), `persistentWorkdir` (default `true`) and `persistentWorkdirPath` for the container's persistent `/tmp` and home (see [Isolation](#isolation)). |
| `connection` | `type` (only `sshd` for now) and `sshdPath` (default `/usr/sbin/sshd`). |

Variables: `${localWorkspaceFolder}` and `${localWorkspaceFolderBasename}` refer to the project folder on the cluster. `${containerWorkspaceFolder}` is the folder inside the container. `${localEnv:VAR}` and `${localEnv:VAR:default}` read your environment on the login node.

The project folder is mounted at `workspaceFolder`. The container image itself is read-only.

## Isolation

Containers are **isolated by default**, as you know it from Dev Containers. The defaults are:

```jsonc
"apptainer": {
	"runArgs": ["--containall"],   // keep it when adding flags, e.g. ["--containall", "--nv"]
	"persistentWorkdir": true
	// "persistentWorkdirPath": "~/containers/${localWorkspaceFolderBasename}"  // optional
}
```

**What is hidden:** your real home directory (including SSH keys and dotfiles), the host's `/tmp`, the admin-configured bind paths, the host's processes (own PID namespace), and the host environment.

**The persistent workdir:** with `--containall`, Apptainer would keep the container's home and `/tmp` on a small temporary filesystem (64 MiB by default). That is too small for the VS Code server, whose download goes through `/tmp`, and it is lost after every job. `persistentWorkdir` passes Apptainer's `--workdir` with a directory on the cluster, by default `~/.slurm-devcontainer/work/<project>`. It holds the container's `/tmp`, `/var/tmp` and home. The container home appears at your normal home path but starts empty (`ls -a ~` shows `.vscode-server` after the first connect). The VS Code server and extensions are downloaded once and kept across jobs.

- **Downloading the server** needs internet access on the compute node. Otherwise set `"remote.SSH.localServerDownload": "always"` so VS Code downloads it on your computer.
- **Proxies:** `--containall` also clears the environment. If your site uses a proxy, pass it in: `"containerEnv": { "https_proxy": "${localEnv:https_proxy}" }`.
- **Your own `--workdir`:** set `"persistentWorkdir": false` if you pass `--workdir` in `runArgs`. The extension reports the conflict otherwise.
- **Resetting:** delete the work folder, then remove and re-add the container with **Remove Container from List...** so the configured extensions are installed again.

**What is not isolated:**

- **The network:** the container shares the node's network. Separating it would also cut off VS Code's connection.
- **The project folder** is mounted read-write. Anything in it, including `.git`, can be changed or deleted.
- **Mounts you add** under `mounts`.
- **Git credentials from VS Code:** VS Code forwards Git credential requests from the integrated terminal to your computer, so `git push` inside the container may use your local credentials. Set `"git.terminalAuthentication": false` (and possibly `"git.useIntegratedAskPass": false`) to prevent this.

### Turning isolation off

Set `"runArgs": []` (plus any flags you need, without `--containall`) and `"persistentWorkdir": false`. The container then behaves like plain Apptainer, which is built to blend into an HPC system rather than to isolate you from it. It swaps the software environment (the image's OS, libraries and tools) but keeps:

- **your user:** `whoami` shows your cluster user, with your normal permissions. There is no root, and no `vscode` user, even if the image defines one. A `/home/vscode` you may see comes from the image. This applies to isolated containers too.
- **the node's hostname and network:** a shell prompt shows the compute node's name. Check `cat /etc/os-release` to see that you are inside the container. This also applies to isolated containers.
- **parts of the host file system:** your home (at its real path), `/tmp`, `/var/tmp`, and any `bind path` entries your admins configured in `apptainer.conf`, often shared data or scratch file systems. Files there are protected only by their normal permissions.

## Commands

| Command | Description |
|---|---|
| Open Folder in Container | Opens the current Remote-SSH folder (on a login node) in its dev container. |
| Connect to Container... | Picks a known dev container and connects, starting a job if none is running. |
| Add Container... | Registers a project by login host and path without opening it first. |
| Stop Container Job... | Cancels the Slurm job (`scancel`). |
| Remove Container from List... | Forgets a dev container, optionally stopping its job first. |
| Show Job Log... | Shows the job's output (container start-up, sshd). |
| Add Configuration File... | Creates a commented `.slurm-devcontainer/slurm-devcontainer.json`. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `remoteSlurmContainers.sshPath` | `ssh` | Local ssh executable. |
| `remoteSlurmContainers.openInNewWindow` | `true` | Open containers in a new window. |
| `remoteSlurmContainers.connectTimeoutMinutes` | `30` | How long to wait for a pending job. The job keeps waiting in the queue after a timeout. |

## Files written by the extension

**On your computer**
- `~/.ssh/slurm-devcontainer/config` holds one `Host slurm-devcontainer-<cluster>-<project>` entry per dev container. The compute node and port are updated on every connect.
- `~/.ssh/slurm-devcontainer/id_ed25519` is a key pair used only to log into the containers' sshd.
- `~/.ssh/slurm-devcontainer/known_hosts` holds the pinned host key of the job sshd, one per cluster. It is fetched over your trusted login connection.
- `~/.ssh/config` gets the line `Include ~/.ssh/slurm-devcontainer/config` at the top, **only if you click "Add Line"**. Remote-SSH can only find the container hosts through this line. No other change is ever made to your SSH config.

**On the cluster** (in your home directory)
- `~/.slurm-devcontainer/ssh/` holds the sshd host key and an `authorized_keys` file containing only the extension's public key.
- `~/.slurm-devcontainer/work/<project>/` is the container's persistent workdir (`/tmp`, `/var/tmp` and home), with `persistentWorkdir: true` (the default) and no `persistentWorkdirPath`.
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
- The extension's output channel is **Output → Slurm Dev Containers**, and it contains the details of every step.

## Related projects

- [gmertes/vscode-remote-hpc](https://github.com/gmertes/vscode-remote-hpc): a script-based setup that connects VS Code's Remote-SSH to a Slurm compute node via an sshd started in a batch job. It uses the same connection idea, without containers.

## Development

```sh
npm install
npm run compile      # type-check, lint, bundle
npm run test:unit    # unit tests (no VS Code instance needed)
```

Press <kbd>F5</kbd> in VS Code to start an Extension Development Host.
