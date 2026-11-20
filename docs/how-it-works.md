# How it works

This document explains how Slurm Dev Containers gets VS Code into an Apptainer container running as a Slurm
job. It starts with the big picture and then goes through each step in detail.

## Overview

```
 your computer                      login node                         compute node (Slurm job)
┌──────────────────┐  ssh <alias>  ┌──────────────────┐               ┌──────────────────────────────┐
│ VS Code          │──────────────▶│ sbatch / squeue  │──── sbatch ──▶│ apptainer instance (image)   │
│  + this extension│               └──────────────────┘               │ sshd (as you, random port)   │
│  + Remote-SSH    │════════ ssh -J <alias> node:port ═══════════════▶│   └─ every session runs      │
└──────────────────┘                                                  │      inside the container    │
                                                                      └──────────────────────────────┘
```

The extension never runs on the cluster. It runs on your computer, even inside Remote-SSH windows, and it
does two things:

1. **It starts the container.** Through your normal `ssh <alias>` to the login node, it submits a Slurm job.
   The job starts an Apptainer instance from your image. It also starts the compute node's own `sshd`, as
   your user, on a free port.
2. **It hands over to Remote-SSH.** It writes an SSH host entry for the job (`ProxyJump` through the login
   node to `node:port`) and opens the project folder on that host. From then on, Microsoft's Remote-SSH
   extension does what it always does.

`sshd` runs **on the compute node, not inside the container**. Every SSH session on it is forced through a
small script, `enter.sh`, which runs the session inside the container with
`apptainer exec instance://…`. This is the Apptainer counterpart of `docker exec` in Dev Containers. Because
of it, any image works, and images don't need `openssh-server`.

Remote-SSH then installs and starts the VS Code server through that SSH connection, so the server runs inside
the container. The VS Code window talks to the server through a port forwarded by the SSH connection.

```
VS Code window ──websocket──▶ local ssh ═══▶ login node ═══▶ sshd on node:port ──forward──▶ 127.0.0.1:<srv> ──▶ VS Code server (in container)
                                                                   │
                                                                   └─ commands/shells ─▶ enter.sh ─▶ apptainer exec instance://…
```

## The connect flow step by step

When you run **Open Folder in Container** or **Connect to Container...**, `src/session.ts` goes through the
following steps.

### 1. Running scripts on the login node (`src/remote.ts`)

Every interaction with the cluster is one SSH call from your computer:

```
ssh -T -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=30 -o ServerAliveCountMax=4 <cluster> 'bash -l -s'
```

- **How the script runs:** the generated script is written to ssh's stdin. `bash -l -s` runs it in a login
  shell, so `module`, `PATH` and the Slurm commands are set up as in an interactive session.
- **The options:** `BatchMode=yes` makes ssh fail instead of waiting for a password prompt nobody could
  answer. The keepalive options keep the connection open during long waits for a pending job.
- **The `wrap()` function:** every script is wrapped in `main() { … }; main`. Bash reads the whole function
  before it runs anything, so a command that reads stdin can't swallow the rest of the script. The wrapper
  also defines `say()`, which prints `@@sdc:key=value`.
- **How results come back:** only output lines containing `@@sdc:key=value` count. Everything else, such as
  the motd or module messages, is ignored. The pairs are collected in order and passed to a callback as soon
  as they arrive, which drives the progress notification.
- **How errors are detected:** an `error=` value becomes an error with that message. Exit code 255 means ssh
  itself failed. Any other non-zero exit code is also an error. `log=` lines are copied to the output channel.

All scripts are generated in `src/clusterScript.ts`:

| Script | Used by | Purpose |
|---|---|---|
| `probeScript` | Connect | Reads the user, `$HOME`, the environment and the config file |
| `launchScript` | Connect | Reuses or submits the job and waits until it is reachable |
| `stopScript` | Stop | `squeue` for the session's active jobs, then `scancel`, prints `stopped=<ids>` |
| `logScript` | Show Job Log | Prints `job.log` as `log=` lines |

### 2. Probing and parsing the config

First, the extension creates its own key pair `~/.ssh/slurm-devcontainer/id_ed25519(.pub)` on your
computer if it doesn't exist yet. This key is used only for the containers.

Then `probeScript` runs on the login node and reports:

| Key | Value |
|---|---|
| `home` | `$HOME`, used to build absolute cluster paths |
| `user` | `id -un` |
| `env` | `env -0 \| base64`: the full login-node environment, NUL-separated and base64-encoded so newlines and special characters survive |
| `config` | `.slurm-devcontainer/slurm-devcontainer.json`, base64-encoded; or `config-missing=<path>` |
| `error` | only if `sbatch` is not on the `PATH` |

`parseConfig` (`src/config.ts`) then:

- parses the config as JSONC, so comments and trailing commas are allowed;
- substitutes `${localWorkspaceFolder}`, `${localWorkspaceFolderBasename}`, `${containerWorkspaceFolder}`
  and `${localEnv:VAR[:default]}`. Here "local" means the login node, because that's where the project is;
- applies the defaults:
  - `workspaceFolder`: `/workspaces/<basename>`
  - `apptainer.runArgs`: `["--containall"]`
  - `apptainer.persistentWorkdir`: `true`
  - `apptainer.binary`: `apptainer`
  - `connection.sshdPath`: `/usr/sbin/sshd`
- turns `image` into a full reference: a bare name like `ubuntu:24.04` becomes `docker://ubuntu:24.04`, and
  a relative path or `*.sif` is resolved against `.slurm-devcontainer/`;
- rejects invalid settings, such as a relative `workspaceFolder` or `--workdir` in `runArgs` while
  `persistentWorkdir` is on.

The session name is the slugified project folder name, with `-2`, `-3`… added if the name is already taken
on that cluster. It determines:

- the Slurm job name: `slurm-devcontainer-<session>`;
- the session directory: `~/.slurm-devcontainer/sessions/<session>`;
- the default workdir: `~/.slurm-devcontainer/work/<session>`;
- the local host alias: `slurm-devcontainer-<cluster>-<session>`.

### 3. Launching and waiting (`launchScript`)

Everything below runs in a single SSH call with `set -euo pipefail` and `umask 077`.

1. **Shared SSH files** (one set per cluster, in `~/.slurm-devcontainer/ssh/`):
   - creates `host_ed25519` once. This is the host key of every job's sshd on this cluster, which is why the
     extension can pin it locally;
   - adds your local public key to `authorized_keys` unless the exact line is already there.
2. **Look for an existing job:**
   `squeue -u $USER -n slurm-devcontainer-<session> -t PENDING,CONFIGURING,RUNNING,SUSPENDED`. Only pending
   or running jobs count; a cancelled job stays visible as COMPLETING for a few seconds and must not be
   reused.
3. **Ownership check:** `$sdir/project` records which project path owns the session. If a job is active and
   the file names a different project, the script stops with an error. Otherwise it writes the current path
   into the file.
4. **Reuse or submit:**
   - If a job exists, it reports `reusing=<id>` and **does not rewrite any files**. Config changes only take
     effect after you stop the job and connect again.
   - Otherwise it writes `sshd_config`, `enter.sh` and `job.sh` into the session directory, deletes any old
     `connection` file, runs `sbatch --parsable job.sh` and reports `submitted=<id>`.
5. **Polling loop** (every 5 s, up to the `connectTimeoutMinutes` setting, default 30):
   - `squeue -h -j <id> -o %T`; it reports `state=<STATE>` whenever the state changes.
   - "Invalid job id" means the job has left the queue. That, or any state that isn't active, is reported as
     an error, together with the last 30 lines of `job.log`.
   - Other `squeue` errors are retried up to 5 times in a row.
   - The loop ends when `connection` exists and contains `job=<this id>`. Checking the ID prevents reading a
     file left over from an older job.
   - If the deadline passes, the script reports a timeout and the job stays in the queue.
6. **Final output:** every line of `connection` (`job=`, `node=`, `apptainer=`, `port=`), plus `user=` and
   `hostkey=` (the contents of `host_ed25519.pub`).

`parseConnectionInfo` checks that all of these values are present, that the host key starts with `ssh-` and
that the port is numeric.

### 4. Writing the local SSH entry

The extension writes a host block into its own file, `~/.ssh/slurm-devcontainer/config`:

```
Host slurm-devcontainer-<cluster>-<session>
  HostName <node>
  Port <port>
  User <user>
  ProxyJump <cluster>
  IdentityFile ~/.ssh/slurm-devcontainer/id_ed25519
  IdentitiesOnly yes
  HostKeyAlias slurm-devcontainer-<cluster>
  UserKnownHostsFile ~/.ssh/slurm-devcontainer/known_hosts
  StrictHostKeyChecking yes
```

It pins the sshd host key under `HostKeyAlias` in `~/.ssh/slurm-devcontainer/known_hosts`. Your own
`~/.ssh/config` only needs one line, `Include ~/.ssh/slurm-devcontainer/config`, which the extension adds
only after you agree in a dialog.

### 5. Opening the folder

The extension calls
`vscode.openFolder(vscode-remote://ssh-remote+slurm-devcontainer-<cluster>-<session>/workspaces/<project>)`.
Remote-SSH takes over from here; see [How VS Code reaches the container](#how-vs-code-reaches-the-container).

## Files generated for the job

### `job.sh`: the batch script

The script starts with the `#SBATCH` directives:

- always: `--job-name=slurm-devcontainer-<session>`, `--output=<session dir>/job.log`, `--nodes=1`,
  `--ntasks=1`;
- if set in the config: `--partition`, `--time`, `--cpus-per-task`, `--mem`, `--gpus`, `--account`,
  `--qos`, `--constraint`;
- every entry of `slurm.sbatchArgs`.

It then:

1. **Sets variables:** `sdir`, `apptainer` (the binary) and `instance="slurm-devcontainer-$SLURM_JOB_ID"`.
2. **Prepares the workdir** if `persistentWorkdir` is on: `mkdir -p` and `chmod 700` on the workdir.
3. **Defines `publish_connection key=value…`:** it writes `job=`, `node=` (`$SLURMD_NODENAME`),
   `apptainer=` (the resolved binary path) and the given pairs to `connection.tmp`, then renames it to
   `connection`. The rename is atomic, so the polling loop never sees a half-written file.
4. **Sets up cleanup** with `trap cleanup EXIT` and `trap 'exit 0' TERM INT`. The cleanup function removes
   `connection` if it still belongs to this job, kills background processes (sshd) and runs
   `apptainer instance stop`. `scancel` or reaching the time limit therefore shuts things down cleanly.
5. **Loads modules** if `apptainer.modules` is set. If `module` isn't defined in the batch shell, it first
   sources Lmod or Environment Modules.
6. **Resolves the binary** with `command -v`, and exits if it isn't found.
7. **Starts the container:**
   ```
   apptainer instance start <runArgs> [--workdir "$workdir"] \
     --bind <project>:<workspaceFolder> [--bind src:dst[:ro] …] <image> "$instance"
   ```
   The instance runs in the background inside the job's cgroup, so Slurm's resource limits apply to it.
8. **Hands over to the connection strategy** (`src/connection/sshd.ts`):
   - Up to 20 times: pick a random port between 20000 and 49999. Skip it if something already listens on
     `127.0.0.1:$port`. Otherwise start `sshd -D -e -f $sdir/sshd_config -p $port &`, wait 2 s and keep the
     port if sshd is still alive.
   - Run `publish_connection "port=$port"`, which is the signal the login node is waiting for.
   - `wait $sshd_pid`: the job lives as long as sshd does.

### `sshd_config`: the unprivileged sshd

```
HostKey ~/.slurm-devcontainer/ssh/host_ed25519
AuthorizedKeysFile ~/.slurm-devcontainer/ssh/authorized_keys
PidFile none
UsePAM no
StrictModes no
PubkeyAuthentication yes
PasswordAuthentication no
AllowTcpForwarding yes
X11Forwarding no
PermitTTY yes
PrintMotd no
ForceCommand ~/.slurm-devcontainer/sessions/<session>/enter.sh
```

(The generated file uses absolute paths.)

This is the compute node's own `sshd` binary, running as you. Because it doesn't run as root, it can only
accept logins for your account. `UsePAM no` and `StrictModes no` are needed for the same reason. It accepts
only the extension's key, and `AllowTcpForwarding yes` lets Remote-SSH forward to the VS Code server.
`ForceCommand` means every command and shell session, including the VS Code server install, goes through
`enter.sh`.

### `enter.sh`: putting every SSH session into the container

```bash
job=$(sed -n 's/^job=//p' "$sdir/connection")
apptainer=$(sed -n 's/^apptainer=//p' "$sdir/connection")
# exits with "the container is not running" if either is empty
export APPTAINERENV_<K>='<v>' …          # containerEnv + remoteEnv (SINGULARITYENV_ for singularity)
export APPTAINERENV_SLURM_DEVCONTAINER_JOB_ID="$job"
exec "$apptainer" exec --pwd <workspaceFolder> "instance://slurm-devcontainer-$job" /bin/sh -c '
  if command -v bash >/dev/null 2>&1; then sh=bash; else sh=sh; fi
  if [ -n "$1" ]; then exec "$sh" -c "$1"; else exec "$sh" -l; fi' sh "${SSH_ORIGINAL_COMMAND:-}"
```

Without `enter.sh`, an SSH login would land on the bare compute node, and the VS Code server would run outside
the container. The script:

1. **Moves the session into the container.** `apptainer exec instance://…` joins the running instance, so
   all sessions share one container (same processes, same `/tmp`).
2. **Finds the right instance at runtime.** It reads the job ID and binary from `connection`, so the file
   doesn't depend on a particular job. If no job is running, it says so instead of quietly leaving you on
   the host.
3. **Passes the environment.** `--containall` implies `--cleanenv`, so `containerEnv` and `remoteEnv` only
   reach the container as `APPTAINERENV_*` variables.
4. **Sets the working directory** with `--pwd <workspaceFolder>`.
5. **Runs the requested command or a shell.** Remote-SSH sends commands such as its server setup script
   (`SSH_ORIGINAL_COMMAND`). A plain login gets `bash -l`, or `sh` if the image has no bash.

**Why not run sshd inside the container instead?** Then `enter.sh` wouldn't be needed, but every image would
have to include `openssh-server`. Most common images (`python`, `ubuntu`, `nvidia/cuda`, the Dev Containers
base images) don't. The host's sshd is always available, so this approach works with any image. Running sshd
inside the container could be added later as a separate `ConnectionStrategy` for images that ship it.

## How VS Code reaches the container

After `vscode.openFolder`, Remote-SSH does what it does for any SSH host. It doesn't know it is talking to a
container.

1. **Remote-SSH connects over SSH** with the host block: through the login node (`ProxyJump`) to the job's
   sshd on `node:port`, using the extension's key and the pinned host key.
2. **It runs its setup script.** sshd runs `enter.sh` instead of the command, and `enter.sh` executes the
   command inside the container. The script:
   - checks whether the right server version is in `~/.vscode-server` and downloads it if not;
   - starts the server in the background, listening on `127.0.0.1:<random port>` with a connection token;
   - prints the port and token, which Remote-SSH reads back.

   With `--containall`, the container's home lives in the persistent workdir. The server is therefore
   downloaded once per project and survives job restarts.
3. **It opens a tunnel to the server.** Remote-SSH asks sshd to forward traffic to
   `127.0.0.1:<server port>`. sshd handles forwarding itself, and `ForceCommand` doesn't apply to forwarded
   connections, so `enter.sh` isn't involved. The connection reaches the server because Apptainer doesn't
   isolate the network by default (`--containall` doesn't include `--net`): the container's `127.0.0.1` is
   the node's `127.0.0.1`.
4. **The window connects to the server** through the tunnel and authenticates with the token. From then on,
   everything the window does (file access, terminals, extensions, debugging) is a message to the server,
   and it executes it inside the container.

Some details vary by Remote-SSH version and settings, such as `remote.SSH.useLocalServer` and how exactly the
setup script is sent. The principle stays the same.

**What happens later:**

- **Terminals in VS Code** are opened by the server, which is already inside the container, so they don't go
  through SSH or `enter.sh`.
- **A second window, or reconnecting after sleep, while the job runs:** Remote-SSH connects again, finds the
  server still running and only rebuilds the tunnel.
- **A plain `ssh slurm-devcontainer-<cluster>-<session>`** from your terminal goes through `enter.sh` and
  gives you a login shell inside the container.
- **When the job ends** (time limit or Stop), the instance and sshd are gone, so the window loses its
  connection. Connecting again submits a new job and reuses the server from the workdir.

## Files on the cluster

```
~/.slurm-devcontainer/
├── ssh/host_ed25519{,.pub}, authorized_keys     # shared by all sessions on this cluster
├── sessions/<session>/
│   ├── project        # owning project path (collision check)
│   ├── job.sh, sshd_config, enter.sh            # written only when a new job is submitted
│   ├── job.log        # sbatch --output
│   └── connection     # job=, node=, apptainer=, port=  (created by the job, removed on exit)
└── work/<session>/    # persistent --workdir: the container's /tmp, /var/tmp and home (incl. ~/.vscode-server)
```

The `connection` file is the only link between the job and the outside world:

- the job writes it once sshd is listening;
- `launchScript` waits for it and reports its contents to the extension;
- `enter.sh` reads it to find the instance;
- the job's cleanup deletes it.
