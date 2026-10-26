import * as path from 'path';
import { defaultSessionName, hostAlias } from './naming';

/** A dev container the user has opened before: which project on which cluster. */
export interface Entry {
	/** SSH alias of the login node, as used in the user's ssh config. */
	cluster: string;
	/** Absolute project path on the cluster. */
	projectPath: string;
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

const KEY = 'remoteSlurmContainers.entries';

/** Extensions from the config that have not been installed into the container yet. */
export function extensionsToInstall(entry: Entry): string[] {
	const installed = new Set((entry.installedExtensions ?? []).map(id => id.toLowerCase()));
	return (entry.extensions ?? []).filter(id => !installed.has(id.toLowerCase()));
}

export class Registry {
	constructor(private readonly store: StateStore) { }

	/** Most recently used first. */
	list(): Entry[] {
		return [...this.store.get<Entry[]>(KEY, [])].sort((a, b) => b.lastUsed - a.lastUsed);
	}

	findByAlias(alias: string): Entry | undefined {
		return this.list().find(e => e.alias === alias);
	}

	/** Returns the existing entry for the project or creates one with a session name unique on that cluster. */
	async register(cluster: string, projectPath: string, now = Date.now()): Promise<Entry> {
		const normalized = path.posix.normalize(projectPath).replace(/(.)\/$/, '$1');
		const existing = this.list().find(e => e.cluster === cluster && e.projectPath === normalized);
		if (existing) {
			return this.update(existing.alias, { lastUsed: now });
		}
		const taken = new Set(this.list().filter(e => e.cluster === cluster).map(e => e.session));
		const base = defaultSessionName(normalized);
		let session = base;
		for (let i = 2; taken.has(session); i++) {
			session = `${base}-${i}`;
		}
		const entry: Entry = {
			cluster, projectPath: normalized, session, alias: hostAlias(cluster, session),
			name: path.posix.basename(normalized) || normalized, lastUsed: now,
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
