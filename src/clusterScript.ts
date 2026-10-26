import { CONFIG_FILE, DevcontainerConfig } from './config';
import { ConnectionStrategy, JobContext } from './connection/types';
import { PREFIX } from './naming';
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

export function clusterPaths(home: string, session: string): { baseDir: string; sessionDir: string } {
	const baseDir = `${home}/${STATE_DIR}`;
	return { baseDir, sessionDir: `${baseDir}/sessions/${session}` };
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

/** Reads the user's environment and the project config on the login node. Prints home, user, env and config (base64). */
export function probeScript(projectPath: string): string {
	return wrap(`set -u
say "home=$HOME"
say "user=$(id -un)"
say "env=$(env -0 | base64 | tr -d '\\n')"
f=${shellQuote(`${projectPath}/${CONFIG_FILE}`)}
if [ -r "$f" ]; then
	say "config=$(base64 < "$f" | tr -d '\\n')"
else
	say "config-missing=$f"
fi
command -v sbatch >/dev/null 2>&1 || say "error=sbatch not found on the login node"`);
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
# Session folders are named after the project folder. Another project with the same name may take over
# the session once its job has ended (e.g. after it was removed from the list).
project=${shellQuote(ctx.projectPath)}
if [ -n "$job" ] && [ -f "$sdir/project" ] && [ "$(cat "$sdir/project")" != "$project" ]; then
	say "error=Session ${ctx.session} is in use by $(cat "$sdir/project") (job $job). Stop that job first (scancel $job)."
	exit 3
fi
printf '%s\\n' "$project" > "$sdir/project"
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
	return wrap(`f="$HOME/${STATE_DIR}/sessions/"${shellQuote(session)}/job.log
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

/** The batch script: starts the Apptainer instance, then hands over to the connection strategy. */
export function jobScript(ctx: JobContext, strategy: ConnectionStrategy): string {
	const { config } = ctx;
	const binds = [
		`${ctx.projectPath}:${config.workspaceFolder}`,
		...config.mounts.map(m => `${m.source}:${m.target}${m.readonly ? ':ro' : ''}`),
	].flatMap(b => ['--bind', shellQuote(b)]);
	const startArgs = [...config.apptainer.runArgs.map(shellQuote), ...binds, shellQuote(config.image), '"$instance"'];
	const modules = config.apptainer.modules.length === 0 ? '' : `if ! command -v module >/dev/null 2>&1; then
	for f in /etc/profile.d/lmod.sh /etc/profile.d/modules.sh /usr/share/lmod/lmod/init/bash; do
		if [ -r "$f" ]; then . "$f"; break; fi
	done
fi
module load ${config.apptainer.modules.map(shellQuote).join(' ')}
`;
	return `#!/bin/bash
${sbatchDirectives(ctx.jobName, `${ctx.sessionDir}/job.log`, config).join('\n')}
# Generated by Slurm Dev Container.
set -uo pipefail
sdir=${shellQuote(ctx.sessionDir)}
apptainer=${shellQuote(config.apptainer.binary)}
instance="${PREFIX}-$SLURM_JOB_ID"
log() { echo "[${PREFIX}] $*"; }
publish_connection() {
	{
		echo "job=$SLURM_JOB_ID"
		echo "node=\${SLURMD_NODENAME:-$(hostname)}"
		echo "apptainer=$apptainer"
		printf '%s\\n' "$@"
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
log "job $SLURM_JOB_ID on $(hostname): starting ${config.image}"
if ! "$apptainer" instance start ${startArgs.join(' ')}; then
	log "failed to start the container instance"
	exit 1
fi
${strategy.jobFragment(ctx)}
`;
}
