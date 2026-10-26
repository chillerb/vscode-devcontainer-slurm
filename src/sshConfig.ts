import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { PREFIX } from './naming';

/**
 * Local SSH files. Everything lives in the extension-owned folder `~/.ssh/slurm-devcontainer/`; the user's
 * `~/.ssh/config` only needs one `Include` line, which is added only after the user agreed.
 */
export const OWN_DIR = `~/.ssh/${PREFIX}`;
export const INCLUDE_TARGET = `${OWN_DIR}/config`;
export const IDENTITY_FILE = `${OWN_DIR}/id_ed25519`;
export const KNOWN_HOSTS_FILE = `${OWN_DIR}/known_hosts`;

const HEADER = '# Managed by the Slurm Dev Container extension. Manual changes are overwritten.\n';

/** Expands a leading `~/` to the local home directory. */
export function expandHome(p: string, home = os.homedir()): string {
	return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function quoteValue(value: string): string {
	return /\s/.test(value) ? `"${value}"` : value;
}

export type HostBlocks = Map<string, Record<string, string>>;

/** Parses `Host` blocks with one alias each (the format written by {@link renderHostBlocks}). */
export function parseHostBlocks(text: string): HostBlocks {
	const blocks: HostBlocks = new Map();
	let current: Record<string, string> | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const m = /^(\S+)\s+(.*)$/.exec(line);
		if (!m) {
			continue;
		}
		const value = m[2].replace(/^"(.*)"$/, '$1');
		if (m[1].toLowerCase() === 'host') {
			current = {};
			blocks.set(value, current);
		} else if (current) {
			current[m[1]] = value;
		}
	}
	return blocks;
}

export function renderHostBlocks(blocks: HostBlocks): string {
	const parts = [...blocks].map(([alias, options]) =>
		[`Host ${alias}`, ...Object.entries(options).map(([k, v]) => `  ${k} ${quoteValue(v)}`)].join('\n'));
	return `${HEADER}\n${parts.join('\n\n')}${parts.length ? '\n' : ''}`;
}

export function upsertHostBlock(text: string, alias: string, options: Record<string, string>): string {
	const blocks = parseHostBlocks(text);
	blocks.set(alias, options);
	return renderHostBlocks(blocks);
}

export function removeHostBlock(text: string, alias: string): string {
	const blocks = parseHostBlocks(text);
	blocks.delete(alias);
	return renderHostBlocks(blocks);
}

/** Whether an ssh config contains an `Include` of our managed file. */
export function hasInclude(text: string, home = os.homedir()): boolean {
	const targets = new Set([INCLUDE_TARGET, expandHome(INCLUDE_TARGET, home), `${PREFIX}/config`].map(p => p.replace(/\\/g, '/')));
	return text.split(/\r?\n/).some(line => {
		const m = /^\s*include\s+(.*)$/i.exec(line);
		return m !== null && m[1].split(/\s+/).some(arg => targets.has(arg.replace(/^"(.*)"$/, '$1').replace(/\\/g, '/')));
	});
}

/**
 * Prepends the `Include` line. It has to come before the first `Host`/`Match` block, otherwise it would only
 * apply inside that block.
 */
export function addInclude(text: string): string {
	return `# Added by the Slurm Dev Container extension (VS Code)\nInclude ${INCLUDE_TARGET}\n\n${text}`;
}

/** Concrete host aliases (no wildcards, not ours) defined in an ssh config, for picking a login node. */
export function listHosts(text: string): string[] {
	const hosts = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*host\s+(.*)$/i.exec(line);
		for (const alias of m ? m[1].trim().split(/\s+/) : []) {
			if (!/[*?!]/.test(alias) && !alias.startsWith(`${PREFIX}-`)) {
				hosts.add(alias);
			}
		}
	}
	return [...hosts];
}

/** Replaces the known_hosts entry of `alias` with `hostKey` (`ssh-ed25519 AAAA… comment`). */
export function upsertKnownHost(text: string, alias: string, hostKey: string): string {
	const [type, key] = hostKey.trim().split(/\s+/);
	const kept = text.split(/\r?\n/).filter(line => line.trim() && line.split(/\s+/)[0] !== alias);
	return [...kept, `${alias} ${type} ${key}`].join('\n') + '\n';
}

/** File operations on the real local files. */
export class LocalSsh {
	constructor(private readonly sshPath = 'ssh', private readonly home = os.homedir()) { }

	path(p: string): string {
		return expandHome(p, this.home);
	}

	get userConfigPath(): string {
		return path.join(this.home, '.ssh', 'config');
	}

	/** Creates the extension's key pair if needed and returns the public key. */
	async ensureKey(): Promise<string> {
		const key = this.path(IDENTITY_FILE);
		if (!await exists(key)) {
			await fs.mkdir(path.dirname(key), { recursive: true, mode: 0o700 });
			await promisify(execFile)(this.sshKeygenPath(), ['-q', '-t', 'ed25519', '-N', '', '-C', `${PREFIX}@${os.hostname()}`, '-f', key]);
		}
		return (await fs.readFile(`${key}.pub`, 'utf8')).trim();
	}

	async userConfigHasInclude(): Promise<boolean> {
		return hasInclude(await readOrEmpty(this.userConfigPath), this.home);
	}

	async addIncludeToUserConfig(): Promise<void> {
		const file = this.userConfigPath;
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		const text = await readOrEmpty(file);
		if (!hasInclude(text, this.home)) {
			await fs.writeFile(file, addInclude(text), { mode: 0o600 });
		}
	}

	async listUserHosts(): Promise<string[]> {
		return listHosts(await readOrEmpty(this.userConfigPath));
	}

	async writeHost(alias: string, options: Record<string, string>): Promise<void> {
		await this.updateFile(INCLUDE_TARGET, text => upsertHostBlock(text, alias, options));
	}

	async removeHost(alias: string): Promise<void> {
		await this.updateFile(INCLUDE_TARGET, text => removeHostBlock(text, alias));
	}

	async pinHostKey(alias: string, hostKey: string): Promise<void> {
		await this.updateFile(KNOWN_HOSTS_FILE, text => upsertKnownHost(text, alias, hostKey));
	}

	private async updateFile(file: string, update: (text: string) => string): Promise<void> {
		const p = this.path(file);
		await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
		await fs.writeFile(p, update(await readOrEmpty(p)), { mode: 0o600 });
	}

	private sshKeygenPath(): string {
		const base = path.basename(this.sshPath);
		if (base !== 'ssh' && base !== 'ssh.exe') {
			return 'ssh-keygen';
		}
		const dir = path.dirname(this.sshPath);
		const name = base.replace('ssh', 'ssh-keygen');
		return dir === '.' ? name : path.join(dir, name);
	}
}

async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(() => true, () => false);
}

async function readOrEmpty(p: string): Promise<string> {
	try {
		return await fs.readFile(p, 'utf8');
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return '';
		}
		throw e;
	}
}
