import * as path from 'path';
import { defaultSessionName, hostAlias } from './naming';

/** A dev container the user has opened before: which project on which cluster. */
export interface Entry {
	/** SSH alias of the login node, as used in the user's ssh config. */
	cluster: string;
	/** Absolute project path on the cluster. */
	projectPath: string;
	/** Configuration folder in `.slurmtainer/`; `''` for the default `.slurmtainer/slurmtainer.json`. */
	config: string;
	/** Unique per cluster; used for the job name, the session directory and the host alias. */
	session: string;
	/** SSH host alias of the container. */
	alias: string;
	name: string;
	lastJobId?: string;
	/** Workspace folder inside the container, known after the first connect. */
	workspaceFolder?: string;
	/** `customizations.vscode.extensions`, resolved on the login node during the last connect. */
	extensions?: string[];
	/** Extensions already installed into this container by the extension. */
	installedExtensions?: string[];
	lastUsed: number;
}

/** The subset of `vscode.Memento` used here, so the registry can be tested without VS Code. */
export interface StateStore {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

const KEY = 'remoteSlurmContainers.containers';
/** Key used up to 0.3.x; its entries refer to the old `slurm-devcontainer-*` host aliases. */
const LEGACY_KEY = 'remoteSlurmContainers.entries';

/** Extensions from the config that have not been installed into the container yet. */
export function extensionsToInstall(entry: Entry): string[] {
	const installed = new Set((entry.installedExtensions ?? []).map(id => id.toLowerCase()));
	return (entry.extensions ?? []).filter(id => !installed.has(id.toLowerCase()));
}

export class Registry {
	constructor(private readonly store: StateStore) { }

	/** Drops the entries of versions before the rename to slurmtainer (clean break, see CHANGELOG 0.4.0). */
	async dropLegacyEntries(): Promise<boolean> {
		if (this.store.get<Entry[] | undefined>(LEGACY_KEY, undefined) === undefined) {
			return false;
		}
		await this.store.update(LEGACY_KEY, undefined);
		return true;
	}

	/** Most recently used first. */
	list(): Entry[] {
		return [...this.store.get<Entry[]>(KEY, [])].sort((a, b) => b.lastUsed - a.lastUsed);
	}

	findByAlias(alias: string): Entry | undefined {
		return this.list().find(e => e.alias === alias);
	}

	/**
	 * Returns the existing entry for the project and configuration or creates one with a session name unique on
	 * that cluster. Each configuration of a project is a separate dev container with its own job.
	 */
	async register(cluster: string, projectPath: string, config: string, now = Date.now()): Promise<Entry> {
		const normalized = path.posix.normalize(projectPath).replace(/(.)\/$/, '$1');
		const existing = this.list().find(e => e.cluster === cluster && e.projectPath === normalized && e.config === config);
		if (existing) {
			return this.update(existing.alias, { lastUsed: now });
		}
		// Sessions are unique per cluster; aliases must be unique across clusters ("a" + "b-c" and "a-b" + "c" both
		// give slurmtainer-a-b-c).
		const taken = new Set(this.list().filter(e => e.cluster === cluster).map(e => e.session));
		const aliases = new Set(this.list().map(e => e.alias));
		const base = defaultSessionName(normalized, config);
		let session = base;
		for (let i = 2; taken.has(session) || aliases.has(hostAlias(cluster, session)); i++) {
			session = `${base}-${i}`;
		}
		const project = path.posix.basename(normalized) || normalized;
		const entry: Entry = {
			cluster, projectPath: normalized, config, session, alias: hostAlias(cluster, session),
			name: config ? `${project} (${config})` : project, lastUsed: now,
		};
		await this.store.update(KEY, [...this.list(), entry]);
		return entry;
	}

	async update(alias: string, changes: Partial<Omit<Entry, 'alias' | 'cluster' | 'session'>>): Promise<Entry> {
		const entries = this.list();
		const index = entries.findIndex(e => e.alias === alias);
		if (index < 0) {
			throw new Error(`Unknown dev container ${alias}`);
		}
		entries[index] = { ...entries[index], ...changes };
		await this.store.update(KEY, entries);
		return entries[index];
	}

	async remove(alias: string): Promise<void> {
		await this.store.update(KEY, this.list().filter(e => e.alias !== alias));
	}
}
