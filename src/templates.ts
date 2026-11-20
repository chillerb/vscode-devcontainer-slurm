import * as fs from 'fs/promises';
import * as path from 'path';
import { CONFIG_NAME } from './config';

/**
 * A configuration template: a folder containing a `slurmtainer.json` and optionally more files (e.g. an
 * Apptainer `.def` file), which are all copied into the project.
 */
export interface Template {
	/** Folder name of the template. */
	name: string;
	/** `built-in` or the template directory it was found in. */
	source: string;
	/** Absolute path of the template folder. */
	dir: string;
}

/**
 * Lists the templates in `builtinDir` and the user's template directories. Each subfolder containing a
 * `slurmtainer.json` is a template. A user template overrides a built-in one with the same name; user
 * templates come first. Directories that cannot be read are reported through `onError` and skipped.
 */
export async function listTemplates(builtinDir: string, userDirs: string[], onError: (message: string) => void = () => { }): Promise<Template[]> {
	const found = new Map<string, Template>();
	for (const [dir, source] of [...userDirs.map(d => [d, d]), [builtinDir, 'built-in']]) {
		let names: string[];
		try {
			names = (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
		} catch (e) {
			onError(`cannot read template directory ${dir}: ${e instanceof Error ? e.message : String(e)}`);
			continue;
		}
		for (const name of names) {
			const templateDir = path.join(dir, name);
			if (!found.has(name) && await isFile(path.join(templateDir, CONFIG_NAME))) {
				found.set(name, { name, source, dir: templateDir });
			}
		}
	}
	return [...found.values()];
}

/** All files of a template, as paths relative to its folder (with `/` separators), `slurmtainer.json` first. */
export async function templateFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (rel: string) => {
		for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(child);
			} else if (entry.isFile()) {
				files.push(child);
			}
		}
	};
	await walk('');
	return files.sort((a, b) => Number(b === CONFIG_NAME) - Number(a === CONFIG_NAME) || a.localeCompare(b));
}

/** Folder names allowed for named configurations. */
export function validConfigName(name: string): string | undefined {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
		return 'Use letters, digits, ".", "_" and "-" (starting with a letter or digit)';
	}
	return undefined;
}

async function isFile(p: string): Promise<boolean> {
	return fs.stat(p).then(s => s.isFile(), () => false);
}
