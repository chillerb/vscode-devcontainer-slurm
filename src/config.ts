import * as jsonc from 'jsonc-parser';
import * as path from 'path';

/** Location of the configuration file, relative to the project folder. */
export const CONFIG_DIR = '.slurmtainer';
export const CONFIG_NAME = 'slurmtainer.json';
/** The default configuration. Named configurations live in `.slurmtainer/<name>/slurmtainer.json`. */
export const CONFIG_FILE = `${CONFIG_DIR}/${CONFIG_NAME}`;
/** Location used up to 0.3.x, before the rename to slurmtainer. Only detected to tell the user to rename it. */
export const LEGACY_CONFIG_FILE = '.slurm-devcontainer/slurm-devcontainer.json';

export interface SlurmOptions {
	partition?: string;
	time?: string;
	cpusPerTask?: number;
	mem?: string;
	gpus?: string;
	account?: string;
	qos?: string;
	constraint?: string;
	sbatchArgs: string[];
}

export interface ApptainerOptions {
	binary: string;
	modules: string[];
	runArgs: string[];
	/**
	 * Pass a persistent `--workdir`. With `--contain(all)`, Apptainer keeps the container's `/tmp`, `/var/tmp`
	 * and home there instead of on a tiny tmpfs, so the VS Code server can be downloaded and survives jobs.
	 */
	persistentWorkdir: boolean;
	/** Absolute or `~/` path of that directory; defaults to a folder per project in the cluster state directory. */
	persistentWorkdirPath?: string;
}

export interface ConnectionOptions {
	type: 'sshd';
	sshdPath: string;
}

export interface BindMount {
	source: string;
	target: string;
	readonly: boolean;
}

export interface DevcontainerConfig {
	name?: string;
	/** Apptainer image reference: `docker://…`, `oras://…`, `library://…` or an absolute `.sif` path. */
	image: string;
	workspaceFolder: string;
	containerEnv: Record<string, string>;
	remoteEnv: Record<string, string>;
	mounts: BindMount[];
	extensions: string[];
	slurm: SlurmOptions;
	apptainer: ApptainerOptions;
	connection: ConnectionOptions;
}

/** Values available for `${…}` substitution. "local" refers to the cluster, where the project lives. */
export interface ConfigVariables {
	/** Absolute path of the project folder on the cluster. */
	localWorkspaceFolder: string;
	/** Environment of the user on the cluster login node. */
	localEnv: Record<string, string>;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

/** Path of a configuration relative to the project: `''` is the default one, otherwise a folder in `.slurmtainer/`. */
export function configPath(config: string): string {
	return config ? `${CONFIG_DIR}/${config}/${CONFIG_NAME}` : CONFIG_FILE;
}

/** The inverse of {@link configPath}; undefined for paths that are not a configuration. */
export function configFromPath(relPath: string): string | undefined {
	if (relPath === CONFIG_FILE) {
		return '';
	}
	const m = /^\.slurmtainer\/([^/]+)\/slurmtainer\.json$/.exec(relPath);
	return m ? m[1] : undefined;
}

/**
 * The `"name"` of a configuration with `${localWorkspaceFolder…}` and `${localEnv:…}` resolved, if it can be read
 * without full validation (for pick lists).
 */
export function configDisplayName(text: string, vars: ConfigVariables): string | undefined {
	const raw: unknown = jsonc.parse(text, [], { allowTrailingComma: true });
	if (!isObject(raw) || typeof raw['name'] !== 'string' || !raw['name']) {
		return undefined;
	}
	return substitute(raw['name'], {
		localWorkspaceFolder: vars.localWorkspaceFolder,
		localWorkspaceFolderBasename: path.posix.basename(vars.localWorkspaceFolder),
	}, vars.localEnv);
}

/**
 * Parses a configuration. `relPath` (relative to the project) is used in error messages and as the base for
 * relative image paths.
 */
export function parseConfig(text: string, vars: ConfigVariables, relPath = CONFIG_FILE): DevcontainerConfig {
	try {
		return parseConfigBody(text, vars, relPath);
	} catch (e) {
		throw e instanceof ConfigError ? new ConfigError(`${relPath}: ${e.message}`) : e;
	}
}

function parseConfigBody(text: string, vars: ConfigVariables, relPath: string): DevcontainerConfig {
	const errors: jsonc.ParseError[] = [];
	const raw: unknown = jsonc.parse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const e = errors[0];
		throw new ConfigError(`invalid JSON (${jsonc.printParseErrorCode(e.error)} at offset ${e.offset})`);
	}
	if (!isObject(raw)) {
		throw new ConfigError(`expected a JSON object`);
	}

	const localBasename = path.posix.basename(vars.localWorkspaceFolder);
	const baseSubst = (value: string) => substitute(value, {
		localWorkspaceFolder: vars.localWorkspaceFolder,
		localWorkspaceFolderBasename: localBasename,
	}, vars.localEnv);

	const workspaceFolder = baseSubst(optString(raw, 'workspaceFolder') ?? '/workspaces/${localWorkspaceFolderBasename}');
	if (!workspaceFolder.startsWith('/')) {
		throw new ConfigError(`"workspaceFolder" must be an absolute path`);
	}
	const subst = (value: string) => substitute(value, {
		localWorkspaceFolder: vars.localWorkspaceFolder,
		localWorkspaceFolderBasename: localBasename,
		containerWorkspaceFolder: workspaceFolder,
		containerWorkspaceFolderBasename: path.posix.basename(workspaceFolder),
	}, vars.localEnv);

	const image = optString(raw, 'image');
	if (!image) {
		throw new ConfigError(`"image" is required`);
	}

	const slurm = optObject(raw, 'slurm') ?? {};
	const apptainer = optObject(raw, 'apptainer') ?? {};
	const connection = optObject(raw, 'connection') ?? {};
	const connectionType = optString(connection, 'type', 'connection.type') ?? 'sshd';
	if (connectionType !== 'sshd') {
		throw new ConfigError(`unsupported "connection.type" "${connectionType}" (supported: "sshd")`);
	}
	const gpus = slurm['gpus'];
	if (gpus !== undefined && typeof gpus !== 'number' && typeof gpus !== 'string') {
		throw new ConfigError(`"slurm.gpus" must be a number or string`);
	}

	for (const key of ['persistentHome', 'persistentHomePath']) {
		if (key in apptainer) {
			throw new ConfigError(`"apptainer.${key}" was replaced by "apptainer.persistentWorkdir"${key === 'persistentHomePath' ? ' and "apptainer.persistentWorkdirPath"' : ''}`);
		}
	}
	// Isolated by default, as Dev Containers users expect. An explicit "runArgs" replaces the default entirely.
	const runArgs = 'runArgs' in apptainer ? optStringArray(apptainer, 'runArgs', 'apptainer.runArgs').map(subst) : ['--containall'];
	const persistentWorkdir = optBoolean(apptainer, 'persistentWorkdir', 'apptainer.persistentWorkdir') ?? true;
	const persistentWorkdirPath = mapOptional(optString(apptainer, 'persistentWorkdirPath', 'apptainer.persistentWorkdirPath'), subst);
	if (persistentWorkdirPath !== undefined) {
		if (!persistentWorkdir) {
			throw new ConfigError(`"apptainer.persistentWorkdirPath" requires "apptainer.persistentWorkdir": true`);
		}
		if (!persistentWorkdirPath.startsWith('/') && !persistentWorkdirPath.startsWith('~/')) {
			throw new ConfigError(`"apptainer.persistentWorkdirPath" must be an absolute path or start with ~/`);
		}
	}
	if (persistentWorkdir && runArgs.some(arg => arg === '--workdir' || arg === '-W' || arg.startsWith('--workdir='))) {
		throw new ConfigError(`"apptainer.runArgs" contains --workdir, which conflicts with "apptainer.persistentWorkdir". `
			+ 'Either set "persistentWorkdir" to false or remove --workdir from "runArgs".');
	}

	const customizations = optObject(raw, 'customizations') ?? {};
	const vscodeCustomizations = optObject(customizations, 'vscode', 'customizations.vscode') ?? {};

	return {
		name: mapOptional(optString(raw, 'name'), subst),
		image: resolveImage(subst(image), vars.localWorkspaceFolder, relPath),
		workspaceFolder,
		containerEnv: mapValues(optStringMap(raw, 'containerEnv'), subst),
		remoteEnv: mapValues(optStringMap(raw, 'remoteEnv'), subst),
		mounts: optArray(raw, 'mounts').map((m, i) => parseMount(m, i, subst)),
		extensions: optStringArray(vscodeCustomizations, 'extensions', 'customizations.vscode.extensions'),
		slurm: {
			partition: optString(slurm, 'partition', 'slurm.partition'),
			time: optString(slurm, 'time', 'slurm.time'),
			cpusPerTask: optNumber(slurm, 'cpusPerTask', 'slurm.cpusPerTask'),
			mem: optString(slurm, 'mem', 'slurm.mem'),
			gpus: gpus === undefined ? undefined : String(gpus),
			account: optString(slurm, 'account', 'slurm.account'),
			qos: optString(slurm, 'qos', 'slurm.qos'),
			constraint: optString(slurm, 'constraint', 'slurm.constraint'),
			sbatchArgs: optStringArray(slurm, 'sbatchArgs', 'slurm.sbatchArgs').map(subst),
		},
		apptainer: {
			binary: optString(apptainer, 'binary', 'apptainer.binary') ?? 'apptainer',
			modules: optStringArray(apptainer, 'modules', 'apptainer.modules'),
			runArgs,
			persistentWorkdir,
			persistentWorkdirPath,
		},
		connection: {
			type: 'sshd',
			sshdPath: optString(connection, 'sshdPath', 'connection.sshdPath') ?? '/usr/sbin/sshd',
		},
	};
}

/**
 * Replaces `${name}` and `${localEnv:VAR}` / `${localEnv:VAR:default}` like the Dev Containers spec.
 * Unknown variables are left untouched.
 */
export function substitute(value: string, named: Record<string, string>, env: Record<string, string>): string {
	return value.replace(/\$\{([^}:]+)(?::([^}:]+)(?::([^}]*))?)?\}/g, (match, name: string, arg?: string, def?: string) => {
		if (arg === undefined && name in named) {
			return named[name];
		}
		if (name === 'localEnv' && arg !== undefined) {
			return env[arg] ?? def ?? '';
		}
		return match;
	});
}

/**
 * Bare references such as `ubuntu:24.04` are treated as Docker images, relative paths are resolved against the
 * folder of the configuration file (`relPath`, relative to the project).
 */
export function resolveImage(image: string, localWorkspaceFolder: string, relPath = CONFIG_FILE): string {
	if (/^[a-z]+:\/\//.test(image) || image.startsWith('/')) {
		return image;
	}
	if (image.startsWith('./') || image.startsWith('../') || image.endsWith('.sif')) {
		return path.posix.resolve(localWorkspaceFolder, path.posix.dirname(relPath), image);
	}
	return `docker://${image}`;
}

function parseMount(value: unknown, index: number, subst: (s: string) => string): BindMount {
	const where = `"mounts[${index}]"`;
	let fields: Record<string, unknown>;
	if (typeof value === 'string') {
		fields = {};
		for (const part of value.split(',')) {
			const eq = part.indexOf('=');
			const key = (eq < 0 ? part : part.slice(0, eq)).trim();
			fields[key] = eq < 0 ? true : part.slice(eq + 1).trim();
		}
		fields['source'] ??= fields['src'];
		fields['target'] ??= fields['dst'] ?? fields['destination'];
	} else if (isObject(value)) {
		fields = value;
	} else {
		throw new ConfigError(`${where} must be a string or an object`);
	}
	const type = fields['type'] ?? 'bind';
	if (type !== 'bind') {
		throw new ConfigError(`${where}: only bind mounts are supported, got type "${String(type)}"`);
	}
	if (typeof fields['source'] !== 'string' || typeof fields['target'] !== 'string') {
		throw new ConfigError(`${where} needs a "source" and a "target"`);
	}
	return {
		source: subst(fields['source']),
		target: subst(fields['target']),
		readonly: fields['readonly'] === true || fields['readonly'] === 'true' || fields['ro'] === true,
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optString(obj: Record<string, unknown>, key: string, label = key): string | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new ConfigError(`"${label}" must be a string`);
	}
	return value;
}

function optNumber(obj: Record<string, unknown>, key: string, label = key): number | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'number') {
		throw new ConfigError(`"${label}" must be a number`);
	}
	return value;
}

function optBoolean(obj: Record<string, unknown>, key: string, label = key): boolean | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'boolean') {
		throw new ConfigError(`"${label}" must be true or false`);
	}
	return value;
}

function mapOptional(value: string | undefined, fn: (s: string) => string): string | undefined {
	return value === undefined ? undefined : fn(value);
}

function optObject(obj: Record<string, unknown>, key: string, label = key): Record<string, unknown> | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (!isObject(value)) {
		throw new ConfigError(`"${label}" must be an object`);
	}
	return value;
}

function optArray(obj: Record<string, unknown>, key: string, label = key): unknown[] {
	const value = obj[key];
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new ConfigError(`"${label}" must be an array`);
	}
	return value;
}

function optStringArray(obj: Record<string, unknown>, key: string, label = key): string[] {
	const value = optArray(obj, key, label);
	if (!value.every(v => typeof v === 'string')) {
		throw new ConfigError(`"${label}" must be an array of strings`);
	}
	return value as string[];
}

function optStringMap(obj: Record<string, unknown>, key: string): Record<string, string> {
	const value = optObject(obj, key) ?? {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v !== 'string') {
			throw new ConfigError(`"${key}.${k}" must be a string`);
		}
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
			throw new ConfigError(`"${key}" contains an invalid variable name "${k}"`);
		}
	}
	return value as Record<string, string>;
}

function mapValues(obj: Record<string, string>, fn: (s: string) => string): Record<string, string> {
	return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}
