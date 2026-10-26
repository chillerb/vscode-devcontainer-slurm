import * as vscode from 'vscode';
import { CONFIG_FILE, parseConfig } from './config';
import { Entry } from './registry';

/**
 * In a window connected to a container: installs the extensions listed in `customizations.vscode.extensions`,
 * like the Dev Containers extension does.
 */
export async function installConfiguredExtensions(entry: Entry, log: vscode.LogOutputChannel): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	let text: string;
	try {
		text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, CONFIG_FILE)));
	} catch {
		log.warn(`no ${CONFIG_FILE} in ${folder.uri.path}, skipping extension installation`);
		return;
	}
	const config = parseConfig(text, { localWorkspaceFolder: entry.projectPath, localEnv: {} });
	const missing = config.extensions.filter(id => !vscode.extensions.getExtension(id));
	if (missing.length === 0) {
		return;
	}
	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Installing extensions in the container',
	}, async progress => {
		for (const id of missing) {
			progress.report({ message: id });
			try {
				await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
				log.info(`installed ${id}`);
			} catch (e) {
				log.error(`could not install ${id}: ${e instanceof Error ? e.message : String(e)}`);
				vscode.window.showWarningMessage(`Could not install extension ${id} in the container.`);
			}
		}
	});
}
