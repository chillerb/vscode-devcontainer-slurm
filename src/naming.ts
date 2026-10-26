import * as path from 'path';

export const PREFIX = 'slurm-devcontainer';

/** Lower-case name that is safe in SSH host aliases, Slurm job names and file names. */
export function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'project';
}

/** Default session name for a project folder on the cluster. */
export function defaultSessionName(projectPath: string): string {
	return slug(path.posix.basename(projectPath));
}

/** SSH host alias of the container, e.g. `slurm-devcontainer-marburg-my-project`. */
export function hostAlias(cluster: string, session: string): string {
	return `${PREFIX}-${slug(cluster)}-${session}`;
}

export function jobName(session: string): string {
	return `${PREFIX}-${session}`;
}
