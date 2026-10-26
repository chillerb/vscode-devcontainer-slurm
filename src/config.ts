import * as jsonc from 'jsonc-parser';
import * as path from 'path';

/** Location of the configuration file, relative to the project folder. */
export const CONFIG_DIR = '.slurm-devcontainer';
export const CONFIG_FILE = `${CONFIG_DIR}/slurm-devcontainer.json`;

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

export function parseConfig(text: string, vars: ConfigVariables): DevcontainerConfig {
	const errors: jsonc.ParseError[] = [];
	const raw: unknown = jsonc.parse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const e = errors[0];
		throw new ConfigError(`${CONFIG_FILE}: invalid JSON (${jsonc.printParseErrorCode(e.error)} at offset ${e.offset})`);
	}
	if (!isObject(raw)) {
		throw new ConfigError(`${CONFIG_FILE}: expected a JSON object`);
	}

	const localBasename = path.posix.basename(vars.localWorkspaceFolder);
	const baseSubst = (value: string) => substitute(value, {
		localWorkspaceFolder: vars.localWorkspaceFolder,
		localWorkspaceFolderBasename: localBasename,
	}, vars.localEnv);

	const workspaceFolder = baseSubst(optString(raw, 'workspaceFolder') ?? '/workspaces/${localWorkspaceFolderBasename}');
	if (!workspaceFolder.startsWith('/')) {
		throw new ConfigError(`${CONFIG_FILE}: "workspaceFolder" must be an absolute path`);
	}
	const subst = (value: string) => substitute(value, {
		localWorkspaceFolder: vars.localWorkspaceFolder,
		localWorkspaceFolderBasename: localBasename,
		containerWorkspaceFolder: workspaceFolder,
		containerWorkspaceFolderBasename: path.posix.basename(workspaceFolder),
	}, vars.localEnv);

	const image = optString(raw, 'image');
	if (!image) {
		throw new ConfigError(`${CONFIG_FILE}: "image" is required`);
	}

	const slurm = optObject(raw, 'slurm') ?? {};
	const apptainer = optObject(raw, 'apptainer') ?? {};
	const connection = optObject(raw, 'connection') ?? {};
	const connectionType = optString(connection, 'type', 'connection.type') ?? 'sshd';
	if (connectionType !== 'sshd') {
		throw new ConfigError(`${CONFIG_FILE}: unsupported "connection.type" "${connectionType}" (supported: "sshd")`);
	}
	const gpus = slurm['gpus'];
	if (gpus !== undefined && typeof gpus !== 'number' && typeof gpus !== 'string') {
		throw new ConfigError(`${CONFIG_FILE}: "slurm.gpus" must be a number or string`);
	}

	for (const key of ['persistentHome', 'persistentHomePath']) {
		if (key in apptainer) {
			throw new ConfigError(`${CONFIG_FILE}: "apptainer.${key}" was replaced by "apptainer.persistentWorkdir"${key === 'persistentHomePath' ? ' and "apptainer.persistentWorkdirPath"' : ''}`);
		}
	}
	const runArgs = optStringArray(apptainer, 'runArgs', 'apptainer.runArgs').map(subst);
	const persistentWorkdir = optBoolean(apptainer, 'persistentWorkdir', 'apptainer.persistentWorkdir') ?? false;
	const persistentWorkdirPath = mapOptional(optString(apptainer, 'persistentWorkdirPath', 'apptainer.persistentWorkdirPath'), subst);
	if (persistentWorkdirPath !== undefined) {
		if (!persistentWorkdir) {
			throw new ConfigError(`${CONFIG_FILE}: "apptainer.persistentWorkdirPath" requires "apptainer.persistentWorkdir": true`);
		}
		if (!persistentWorkdirPath.startsWith('/') && !persistentWorkdirPath.startsWith('~/')) {
			throw new ConfigError(`${CONFIG_FILE}: "apptainer.persistentWorkdirPath" must be an absolute path or start with ~/`);
		}
	}
	if (persistentWorkdir && runArgs.some(arg => arg === '--workdir' || arg === '-W' || arg.startsWith('--workdir='))) {
		throw new ConfigError(`${CONFIG_FILE}: "apptainer.runArgs" contains --workdir, which conflicts with "apptainer.persistentWorkdir". `
			+ 'Either set "persistentWorkdir" to false or remove --workdir from "runArgs".');
	}

	const customizations = optObject(raw, 'customizations') ?? {};
	const vscodeCustomizations = optObject(customizations, 'vscode', 'customizations.vscode') ?? {};

	return {
		name: optString(raw, 'name'),
		image: resolveImage(subst(image), vars.localWorkspaceFolder),
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

/** Bare references such as `ubuntu:24.04` are treated as Docker images, relative paths are resolved against the config folder. */
export function resolveImage(image: string, localWorkspaceFolder: string): string {
	if (/^[a-z]+:\/\//.test(image) || image.startsWith('/')) {
		return image;
	}
	if (image.startsWith('./') || image.startsWith('../') || image.endsWith('.sif')) {
		return path.posix.resolve(localWorkspaceFolder, CONFIG_DIR, image);
	}
	return `docker://${image}`;
}

function parseMount(value: unknown, index: number, subst: (s: string) => string): BindMount {
	const where = `${CONFIG_FILE}: "mounts[${index}]"`;
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
		throw new ConfigError(`${CONFIG_FILE}: "${label}" must be a string`);
	}
	return value;
}

function optNumber(obj: Record<string, unknown>, key: string, label = key): number | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'number') {
		throw new ConfigError(`${CONFIG_FILE}: "${label}" must be a number`);
	}
	return value;
}

function optBoolean(obj: Record<string, unknown>, key: string, label = key): boolean | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'boolean') {
		throw new ConfigError(`${CONFIG_FILE}: "${label}" must be true or false`);
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
		throw new ConfigError(`${CONFIG_FILE}: "${label}" must be an object`);
	}
	return value;
}

function optArray(obj: Record<string, unknown>, key: string, label = key): unknown[] {
	const value = obj[key];
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new ConfigError(`${CONFIG_FILE}: "${label}" must be an array`);
	}
	return value;
}

function optStringArray(obj: Record<string, unknown>, key: string, label = key): string[] {
	const value = optArray(obj, key, label);
	if (!value.every(v => typeof v === 'string')) {
		throw new ConfigError(`${CONFIG_FILE}: "${label}" must be an array of strings`);
	}
	return value as string[];
}

function optStringMap(obj: Record<string, unknown>, key: string): Record<string, string> {
	const value = optObject(obj, key) ?? {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v !== 'string') {
			throw new ConfigError(`${CONFIG_FILE}: "${key}.${k}" must be a string`);
		}
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
			throw new ConfigError(`${CONFIG_FILE}: "${key}" contains an invalid variable name "${k}"`);
		}
	}
	return value as Record<string, string>;
}

function mapValues(obj: Record<string, string>, fn: (s: string) => string): Record<string, string> {
	return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

/** Commented starter configuration written by the "Add Configuration File" command. */
export function configTemplate(name: string): string {
	return `// Configuration for the Slurm Dev Containers extension.
// Format: a subset of devcontainer.json (https://containers.dev) plus "slurm", "apptainer" and "connection".
{
	"name": ${JSON.stringify(name)},

	// Apptainer image: "docker://…", "oras://…", "library://…" or a path to a .sif file.
	// Bare names such as "ubuntu:24.04" are treated as Docker images.
	"image": "docker://mcr.microsoft.com/devcontainers/base:ubuntu",

	// The project folder is mounted here inside the container.
	"workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",

	// Environment variables inside the container. \${localEnv:VAR} reads VAR on the login node.
	"containerEnv": {},

	// Additional bind mounts, e.g. "source=/scratch/\${localEnv:USER},target=/scratch,type=bind".
	"mounts": [],

	"customizations": {
		"vscode": {
			// Extensions installed inside the container window.
			"extensions": []
		}
	},

	// Resources of the Slurm job (translated into #SBATCH lines).
	"slurm": {
		"time": "08:00:00",
		"cpusPerTask": 4,
		"mem": "16G"
		// "partition": "gpu",
		// "gpus": 1,
		// "account": "my-project",
		// "sbatchArgs": ["--qos=normal"]
	},

	"apptainer": {
		// Environment modules loaded before running apptainer, e.g. ["apptainer"].
		"modules": [],
		// Extra arguments for "apptainer instance start", e.g. ["--nv"] for NVIDIA GPUs,
		// or ["--containall"] to isolate the container from your home directory and the host.
		"runArgs": [],
		// Keep the container's /tmp, /var/tmp and home in a persistent directory on disk (apptainer --workdir).
		// Needed with "--contain"/"--containall": otherwise they live on a tiny temporary filesystem
		// (64 MiB by default), too small for the VS Code server and lost after every job. With a persistent
		// workdir, the VS Code server and extensions are downloaded only once. It has no effect without
		// "--contain"/"--containall". Set it to false if you pass your own --workdir in "runArgs".
		"persistentWorkdir": false
		// Optional location; default: ~/.slurm-devcontainer/work/<project> on the cluster.
		// "persistentWorkdirPath": "~/containers/\${localWorkspaceFolderBasename}"
	}
}
`;
}
