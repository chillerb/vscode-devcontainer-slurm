import * as path from 'path';

export const PREFIX = 'slurmtainer';

/** Lower-case name that is safe in SSH host aliases, Slurm job names and file names. */
export function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'project';
}

/**
 * Default session name for a project folder and configuration on the cluster: the folder name, plus the name
 * of a named configuration (`.slurmtainer/<config>/slurmtainer.json`).
 */
export function defaultSessionName(projectPath: string, config = ''): string {
	const base = slug(path.posix.basename(projectPath));
	return config ? `${base}-${slug(config)}` : base;
}

/** SSH host alias of the container, e.g. `slurmtainer-cluster-a-my-project`. */
export function hostAlias(cluster: string, session: string): string {
	return `${PREFIX}-${slug(cluster)}-${session}`;
}

/**
 * Where the host's agent socket directories are mounted in the container when SSH agent forwarding is on:
 * sshd creates the forwarded socket in `/tmp/ssh-XXXX/` (OpenSSH < 10.1) or `~/.ssh/agent/` (OpenSSH >= 10.1,
 * see its release notes), so both are mounted. Newer sshd can choose the location with `AgentSocketPath`, but
 * older sshd refuses to start with unknown keywords, so the generated sshd_config doesn't set it.
 */
export const AGENT_MOUNTS = { tmp: `/mnt/${PREFIX}/host-tmp`, home: `/mnt/${PREFIX}/host-agent` };

export function jobName(session: string): string {
	return `${PREFIX}-${session}`;
}
