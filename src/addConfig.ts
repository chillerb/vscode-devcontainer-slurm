import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_DIR, CONFIG_FILE, CONFIG_NAME } from './config';
import { expandHome } from './sshConfig';
import { listTemplates, templateFiles, validConfigName } from './templates';

/**
 * "Add Configuration File...": copies a template (built-in or from `templateDirectories`) into the project,
 * either as the default `.slurmtainer/slurmtainer.json` or as a named `.slurmtainer/<name>/slurmtainer.json`.
 */
export async function addConfigFile(builtinDir: string, log: vscode.LogOutputChannel): Promise<void> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		vscode.window.showErrorMessage('Open the project folder first (e.g. via Remote-SSH on the cluster login node).');
		return;
	}
	const folder = folders.length === 1
		? folders[0]
		: await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to add the Slurmtainer configuration to' });
	if (!folder) {
		return;
	}

	const userDirs = vscode.workspace.getConfiguration('remoteSlurmContainers').get<string[]>('templateDirectories', []);
	const templates = await listTemplates(builtinDir, userDirs.map(d => expandHome(d)), message => log.warn(message));
	const template = templates.length === 1 ? templates[0] : (await vscode.window.showQuickPick(
		templates.map(t => ({ label: t.name, description: t.source, template: t })),
		{ title: 'Add Slurmtainer Configuration (1/2)', placeHolder: 'Template' },
	))?.template;
	if (!template) {
		return;
	}

	const root = vscode.Uri.joinPath(folder.uri, CONFIG_DIR);
	let target = root;
	const defaultExists = await exists(vscode.Uri.joinPath(folder.uri, CONFIG_FILE));
	const named = 'Named configuration';
	const choice = defaultExists ? named : (await vscode.window.showQuickPick([
		{ label: 'Default configuration', description: CONFIG_FILE },
		{ label: named, description: `${CONFIG_DIR}/<name>/${CONFIG_NAME}`, detail: 'For projects with several configurations, e.g. one for CPU and one for GPU jobs' },
	], { title: 'Add Slurmtainer Configuration (2/2)', placeHolder: 'Where to create the configuration' }))?.label;
	if (!choice) {
		return;
	}
	if (choice === named) {
		const name = await vscode.window.showInputBox({
			title: 'Add Slurmtainer Configuration (2/2)',
			prompt: `Name of the configuration: it is created in ${CONFIG_DIR}/<name>/${defaultExists ? ` (${CONFIG_FILE} already exists)` : ''}`,
			value: template.name,
			validateInput: async v => validConfigName(v) ?? (await exists(vscode.Uri.joinPath(root, v)) ? `${CONFIG_DIR}/${v} already exists` : undefined),
		});
		if (!name) {
			return;
		}
		target = vscode.Uri.joinPath(root, name);
	}

	// Never overwrite: check every file first, then copy.
	const files = await templateFiles(template.dir);
	for (const file of files) {
		if (await exists(vscode.Uri.joinPath(target, file))) {
			throw new Error(`${path.posix.join(vscode.workspace.asRelativePath(target, false), file)} already exists; nothing was copied.`);
		}
	}
	for (const file of files) {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(target, file), await fs.readFile(path.join(template.dir, ...file.split('/'))));
	}
	log.info(`added template ${template.name} (${template.source}) to ${target.toString()}`);
	await vscode.window.showTextDocument(vscode.Uri.joinPath(target, CONFIG_NAME));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
