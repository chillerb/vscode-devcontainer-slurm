import { DevcontainerConfig } from '../config';

/** Everything needed to generate the cluster-side files of a session. */
export interface JobContext {
	session: string;
	jobName: string;
	/** Absolute project path on the cluster. */
	projectPath: string;
	config: DevcontainerConfig;
	/** Absolute session directory on the cluster (`~/.slurm-devcontainer/sessions/<session>`). */
	sessionDir: string;
	/** Absolute state directory on the cluster (`~/.slurm-devcontainer`). */
	baseDir: string;
}

/** Reported by the cluster once the container is ready. */
export interface ConnectionInfo {
	jobId: string;
	node: string;
	user: string;
	/** Strategy-specific values written by the job, e.g. `port`. */
	values: Record<string, string>;
	/** Public host key of the job's sshd (`ssh-ed25519 AAAA…`). */
	hostKey: string;
}

export interface LocalSshFiles {
	identityFile: string;
	knownHostsFile: string;
}

export interface SessionFile {
	content: string;
	executable?: boolean;
}

/**
 * How VS Code reaches the container. Only `sshd` exists so far; see TODO.md for planned alternatives.
 */
export interface ConnectionStrategy {
	readonly type: string;
	/** Keys the job must publish via `publish_connection`, e.g. `port`. */
	readonly requiredValues: readonly string[];
	/** Files written to the session directory before the job is submitted. */
	sessionFiles(ctx: JobContext): Record<string, SessionFile>;
	/**
	 * Bash appended to `job.sh` after the container instance has started. It must call
	 * `publish_connection key=value…` once the container is reachable and then keep running.
	 */
	jobFragment(ctx: JobContext): string;
	/** Options of the local SSH `Host` entry for the container. */
	hostOptions(cluster: string, info: ConnectionInfo, files: LocalSshFiles): Record<string, string>;
}
