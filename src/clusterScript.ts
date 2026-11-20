import { CONFIG_DIR, CONFIG_FILE, CONFIG_NAME, configFromPath, DevcontainerConfig, LEGACY_CONFIG_FILE } from './config';
import { ConnectionInfo, ConnectionStrategy, JobContext } from './connection/types';
import { AGENT_MOUNTS, PREFIX } from './naming';
import { shellQuote, writeFileSnippet } from './shell';

/** Lines printed by the generated scripts start with this marker; anything else (e.g. motd) is ignored. */
export const MARKER = '@@sdc:';

/**
 * Job states that count as "the session has a job". A cancelled job stays visible as COMPLETING for a few
 * seconds and must not be reused.
 */
const ACTIVE_STATES = 'PENDING,CONFIGURING,RUNNING,SUSPENDED';

/** Consecutive squeue failures tolerated while waiting for a job. */
const SQUEUE_RETRIES = 5;

/** State directory on the cluster, relative to `$HOME`. */
export const STATE_DIR = `.${PREFIX}`;

/** Session directory relative to `$HOME`. */
function sessionPath(session: string): string {
	return `${STATE_DIR}/sessions/${session}`;
}

export function clusterPaths(home: string, session: string): { baseDir: string; sessionDir: string } {
	return { baseDir: `${home}/${STATE_DIR}`, sessionDir: `${home}/${sessionPath(session)}` };
}

/** Parses `@@sdc:key=value` lines. */
export function parseMarkedLine(line: string): [key: string, value: string] | undefined {
	const start = line.indexOf(MARKER);
	if (start < 0) {
		return undefined;
	}
	const rest = line.slice(start + MARKER.length).replace(/\r$/, '');
	const eq = rest.indexOf('=');
	return eq < 0 ? [rest, ''] : [rest.slice(0, eq), rest.slice(eq + 1)];
}

/**
 * Wraps a script body in a function: bash reads the whole function before running it, so commands that
 * read stdin cannot swallow the rest of a script piped into `bash -s`.
 */
function wrap(body: string): string {
	return `main() {
say() { printf '${MARKER}%s\\n' "$*"; }
${body}
}
main
`;
}

/**
 * Reads the user's environment and the project's configurations on the login node: the default
 * `.slurmtainer/slurmtainer.json` and the named `.slurmtainer/<name>/slurmtainer.json` (one level, like Dev
 * Containers). Prints `home`, `user`, `env` (base64) and one `config=<relative path>:<base64>` per file, or
 * `config-missing` (plus `legacy-config` for a file at the location used before 0.4.0).
 */
export function probeScript(projectPath: string): string {
	return wrap(`set -u
say "home=$HOME"
say "user=$(id -un)"
say "env=$(env -0 | base64 | tr -d '\\n')"
p=${shellQuote(projectPath)}
found=
for f in "$p/"${shellQuote(CONFIG_FILE)} "$p/"${shellQuote(CONFIG_DIR)}/*/${shellQuote(CONFIG_NAME)}; do
	[ -f "$f" ] && [ -r "$f" ] || continue
	found=1
	say "config=\${f#"$p/"}:$(base64 < "$f" | tr -d '\\n')"
done
if [ -z "$found" ]; then
	say "config-missing=$p/"${shellQuote(CONFIG_DIR)}
	legacy="$p/"${shellQuote(LEGACY_CONFIG_FILE)}
	[ -r "$legacy" ] && say "legacy-config=$legacy"
fi
command -v sbatch >/dev/null 2>&1 || say "error=sbatch not found on the login node"`);
}

/** A configuration file found by {@link probeScript}. */
export interface ProbedConfig {
	/** Folder name in `.slurmtainer/`; `''` for the default configuration. */
	config: string;
	/** Path relative to the project, e.g. `.slurmtainer/gpu/slurmtainer.json`. */
	relPath: string;
	text: string;
}

export interface ProbeResult {
	home: string;
	user: string;
	env: Record<string, string>;
	/** Default configuration first, then the named ones in the order the shell listed them (sorted). */
	configs: ProbedConfig[];
	/** Set when there is no configuration: the folder that was searched. */
	missing?: string;
	/** Set when there is no configuration but one at the location used before 0.4.0. */
	legacy?: string;
}

/** Decodes the output of {@link probeScript}. */
export function parseProbe(values: [string, string][]): ProbeResult {
	const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');
	const result: ProbeResult = { home: '', user: '', env: {}, configs: [] };
	for (const [key, value] of values) {
		if (key === 'home') {
			result.home = value;
		} else if (key === 'user') {
			result.user = value;
		} else if (key === 'env') {
			for (const pair of decode(value).split('\0')) {
				const eq = pair.indexOf('=');
				if (eq > 0) {
					result.env[pair.slice(0, eq)] = pair.slice(eq + 1);
				}
			}
		} else if (key === 'config') {
			// base64 contains no ':', so the last one separates path and content.
			const sep = value.lastIndexOf(':');
			const relPath = value.slice(0, sep);
			const config = configFromPath(relPath);
			if (sep > 0 && config !== undefined) {
				result.configs.push({ config, relPath, text: decode(value.slice(sep + 1)) });
			}
		} else if (key === 'config-missing') {
			result.missing = value;
		} else if (key === 'legacy-config') {
			result.legacy = value;
		}
	}
	return result;
}

export interface LaunchOptions {
	ctx: JobContext;
	strategy: ConnectionStrategy;
	/** Public key that may log into the job's sshd. */
	authorizedKey: string;
	timeoutSeconds: number;
	pollSeconds: number;
}

/**
 * Reuses the running/pending job of the session or submits a new one, then waits until the container is
 * reachable. Prints progress (`submitted`, `reusing`, `state`, `log`), `error` on failure and finally the
 * connection values, `user` and `hostkey`.
 */
export function launchScript(opts: LaunchOptions): string {
	const { ctx, strategy } = opts;
	const files: Record<string, { content: string; executable?: boolean }> = {
		...strategy.sessionFiles(ctx),
		'job.sh': { content: jobScript(ctx, strategy), executable: true },
	};
	const writes = Object.entries(files)
		.map(([name, f]) => writeFileSnippet(`"$sdir/${name}"`, f.content, f.executable ? '700' : '600'))
		.join('\n');
	return wrap(`set -euo pipefail
umask 077
base=${shellQuote(ctx.baseDir)}
sdir=${shellQuote(ctx.sessionDir)}
mkdir -p "$base/ssh" "$sdir"
if [ ! -f "$base/ssh/host_ed25519" ]; then
	ssh-keygen -q -t ed25519 -N '' -C ${PREFIX}-host -f "$base/ssh/host_ed25519" </dev/null
fi
key=${shellQuote(opts.authorizedKey)}
touch "$base/ssh/authorized_keys"
grep -qxF "$key" "$base/ssh/authorized_keys" || printf '%s\\n' "$key" >> "$base/ssh/authorized_keys"
if ! jobs=$(squeue -h -u "$(id -un)" -n ${shellQuote(ctx.jobName)} -t ${ACTIVE_STATES} -o %i); then
	say "error=squeue failed on the login node"
	exit 6
fi
job=\${jobs%%$'\\n'*}
# Session folders are named after the project folder (and configuration). Another project or configuration with
# the same name may take over the session once its job has ended (e.g. after it was removed from the list).
# The owner is the absolute path of the configuration file; 0.4.0 wrote only the project path, which is accepted
# for a running job of the same project.
project=${shellQuote(ctx.projectPath)}
owner=${shellQuote(`${ctx.projectPath}/${ctx.configPath}`)}
if [ -n "$job" ] && [ -f "$sdir/project" ]; then
	current=$(cat "$sdir/project")
	if [ "$current" != "$owner" ] && [ "$current" != "$project" ]; then
		say "error=Session ${ctx.session} is in use by $current (job $job). Stop that job first (scancel $job)."
		exit 3
	fi
fi
printf '%s\\n' "$owner" > "$sdir/project"
if [ -n "$job" ]; then
	say "reusing=$job"
else
${writes}
	rm -f "$sdir/connection"
	out=$(sbatch --parsable "$sdir/job.sh" </dev/null)
	job=\${out%%;*}
	say "submitted=$job"
fi
deadline=$((SECONDS + ${opts.timeoutSeconds}))
last=
failures=0
while :; do
	# A job that left the queue is reported as "Invalid job id"; other errors (e.g. controller timeouts)
	# are retried a few times before giving up.
	if out=$(squeue -h -j "$job" -o %T 2>&1); then
		state=$out
		failures=0
	elif [[ "$out" == *"Invalid job id"* ]]; then
		state=
	else
		failures=$((failures + 1))
		if [ "$failures" -ge ${SQUEUE_RETRIES} ]; then
			say "error=squeue keeps failing while waiting for job $job: $out"
			exit 6
		fi
		sleep ${opts.pollSeconds}
		continue
	fi
	if [ "$state" != "$last" ]; then
		say "state=$state"
		last=$state
	fi
	case "$state" in
		PENDING|CONFIGURING|RUNNING|REQUEUED|RESIZING|SUSPENDED) ;;
		*)
			say "error=Job $job is no longer active\${state:+ ($state)}. Log: $sdir/job.log"
			tail -n 30 "$sdir/job.log" 2>/dev/null | sed 's/^/${MARKER}log=/' || true
			exit 4
			;;
	esac
	if [ -f "$sdir/connection" ] && grep -qx "job=$job" "$sdir/connection"; then
		break
	fi
	if [ "$SECONDS" -ge "$deadline" ]; then
		say "error=Timed out waiting for job $job (state: $state). It keeps running; connect again later or stop it."
		exit 5
	fi
	sleep ${opts.pollSeconds}
done
sed 's/^/${MARKER}/' "$sdir/connection"
say "user=$(id -un)"
say "hostkey=$(cat "$base/ssh/host_ed25519.pub")"`);
}

/** Builds the connection info from the output of {@link launchScript}; throws if anything is missing. */
export function parseConnectionInfo(values: [string, string][], strategy: ConnectionStrategy): ConnectionInfo {
	const all = Object.fromEntries(values);
	const missing = ['job', 'node', 'user', 'hostkey', ...strategy.requiredValues].filter(key => !all[key]);
	if (missing.length > 0) {
		throw new Error(`The cluster did not report ${missing.join(', ')} for the container. Check the job log.`);
	}
	if (!/^ssh-\S+ \S+/.test(all['hostkey'])) {
		throw new Error(`Unexpected sshd host key from the cluster: ${all['hostkey']}`);
	}
	if (strategy.requiredValues.includes('port') && !/^\d+$/.test(all['port'])) {
		throw new Error(`Unexpected port from the cluster: ${all['port']}`);
	}
	return { jobId: all['job'], node: all['node'], user: all['user'], hostKey: all['hostkey'], values: all };
}

/** Cancels the job of a session. Prints `stopped=<job ids>` (empty if there was none) or `error`. */
export function stopScript(jobName: string): string {
	return wrap(`set -u
if ! jobs=$(squeue -h -u "$(id -un)" -n ${shellQuote(jobName)} -t ${ACTIVE_STATES} -o %i 2>&1); then
	say "error=squeue failed on the login node: $jobs"
	exit 6
fi
if [ -n "$jobs" ]; then
	if ! out=$(scancel $jobs 2>&1); then
		say "error=scancel $(echo $jobs) failed: $out"
		exit 7
	fi
fi
say "stopped=$(echo $jobs)"`);
}

/** Prints the job log of a session. */
export function logScript(session: string): string {
	return wrap(`f="$HOME"/${shellQuote(`${sessionPath(session)}/job.log`)}
if [ -r "$f" ]; then
	sed 's/^/${MARKER}log=/' "$f"
else
	say "error=No job log found at $f"
fi`);
}

export function sbatchDirectives(jobName: string, logFile: string, config: DevcontainerConfig): string[] {
	const s = config.slurm;
	const opts: string[] = [`--job-name=${jobName}`, `--output=${logFile}`, '--nodes=1', '--ntasks=1'];
	const add = (flag: string, value: string | number | undefined) => {
		if (value !== undefined && value !== '') {
			opts.push(`${flag}=${value}`);
		}
	};
	add('--partition', s.partition);
	add('--time', s.time);
	add('--cpus-per-task', s.cpusPerTask);
	add('--mem', s.mem);
	add('--gpus', s.gpus);
	add('--account', s.account);
	add('--qos', s.qos);
	add('--constraint', s.constraint);
	opts.push(...s.sbatchArgs);
	for (const opt of opts) {
		if (/[\r\n]/.test(opt)) {
			throw new Error(`Invalid sbatch option: ${JSON.stringify(opt)}`);
		}
	}
	return opts.map(o => `#SBATCH ${o}`);
}

/** Shell expression for the persistent workdir: the configured path or `<state dir>/work/<session>`. */
function persistentWorkdir(ctx: JobContext): string {
	const configured = ctx.config.apptainer.persistentWorkdirPath;
	if (configured === undefined) {
		return shellQuote(`${ctx.baseDir}/work/${ctx.session}`);
	}
	return configured.startsWith('~/') ? `"$HOME"/${shellQuote(configured.slice(2))}` : shellQuote(configured);
}

/** The batch script: starts the Apptainer instance, then hands over to the connection strategy. */
export function jobScript(ctx: JobContext, strategy: ConnectionStrategy): string {
	const { config } = ctx;
	const binds = [
		`${ctx.projectPath}:${config.workspaceFolder}`,
		...config.mounts.map(m => `${m.source}:${m.target}${m.readonly ? ':ro' : ''}`),
	].flatMap(b => ['--bind', shellQuote(b)]);
	const workdir = config.apptainer.persistentWorkdir ? persistentWorkdir(ctx) : undefined;
	// Binds can't be added to a running instance, so the directories that will hold forwarded agent sockets
	// are mounted up front (at hidden paths; enter.sh points SSH_AUTH_SOCK there).
	const agentBinds = ctx.forwardSshAgent
		? ['--bind', shellQuote(`/tmp:${AGENT_MOUNTS.tmp}`), '--bind', `"$HOME"/${shellQuote(`.ssh/agent:${AGENT_MOUNTS.home}`)}`]
		: [];
	const startArgs = [
		...config.apptainer.runArgs.map(shellQuote), ...(workdir ? ['--workdir', '"$workdir"'] : []),
		...binds, ...agentBinds, shellQuote(config.image), '"$instance"',
	];
	const modules = config.apptainer.modules.length === 0 ? '' : `if ! command -v module >/dev/null 2>&1; then
	for f in /etc/profile.d/lmod.sh /etc/profile.d/modules.sh /usr/share/lmod/lmod/init/bash; do
		if [ -r "$f" ]; then . "$f"; break; fi
	done
fi
module load ${config.apptainer.modules.map(shellQuote).join(' ')}
`;
	return `#!/bin/bash
${sbatchDirectives(ctx.jobName, `${ctx.sessionDir}/job.log`, config).join('\n')}
# Generated by Slurmtainer.
set -uo pipefail
sdir=${shellQuote(ctx.sessionDir)}
apptainer=${shellQuote(config.apptainer.binary)}
instance="${PREFIX}-$SLURM_JOB_ID"
${workdir ? `workdir=${workdir}\nmkdir -p "$workdir" && chmod 700 "$workdir"\n` : ''}${ctx.forwardSshAgent ? '(umask 077; mkdir -p "$HOME/.ssh/agent")\n' : ''}log() { echo "[${PREFIX}] $*"; }
publish_connection() {
	{
		echo "job=$SLURM_JOB_ID"
		echo "node=\${SLURMD_NODENAME:-$(hostname)}"
		echo "apptainer=$apptainer"
${ctx.forwardSshAgent ? '\t\techo "agent=1"\n' : ''}		printf '%s\\n' "$@"
	} > "$sdir/connection.tmp" && mv "$sdir/connection.tmp" "$sdir/connection"
}
cleanup() {
	trap - EXIT
	if grep -qx "job=$SLURM_JOB_ID" "$sdir/connection" 2>/dev/null; then
		rm -f "$sdir/connection"
	fi
	kill $(jobs -p) 2>/dev/null
	"$apptainer" instance stop "$instance" >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 0' TERM INT
${modules}apptainer=$(command -v "$apptainer") || { log "$apptainer not found"; exit 1; }
log "job $SLURM_JOB_ID on $(hostname): starting "${shellQuote(config.image)}
if ! "$apptainer" instance start ${startArgs.join(' ')}; then
	log "failed to start the container instance"
	exit 1
fi
${strategy.jobFragment(ctx)}
`;
}
