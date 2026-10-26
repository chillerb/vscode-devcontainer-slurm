import * as vscode from 'vscode';
import { Entry, extensionsToInstall, Registry } from './registry';

/**
 * In a window connected to a container: installs the extensions listed in `customizations.vscode.extensions`,
 * like the Dev Containers extension does. The list was resolved during connect (with the login node's
 * environment). This extension runs locally and cannot see extensions installed in the container, so it
 * remembers what it installed instead.
 */
export async function installConfiguredExtensions(entry: Entry, registry: Registry, log: vscode.LogOutputChannel): Promise<void> {
	const missing = extensionsToInstall(entry).filter(id => !vscode.extensions.getExtension(id));
	if (missing.length === 0) {
		return;
	}
	const installed: string[] = [];
	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Installing extensions in the container',
	}, async progress => {
		for (const id of missing) {
			progress.report({ message: id });
			try {
				await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
				installed.push(id);
				log.info(`installed ${id}`);
			} catch (e) {
				log.error(`could not install ${id}: ${e instanceof Error ? e.message : String(e)}`);
				vscode.window.showWarningMessage(`Could not install extension ${id} in the container.`);
			}
		}
	});
	const current = registry.findByAlias(entry.alias);
	if (current) {
		await registry.update(entry.alias, { installedExtensions: [...(current.installedExtensions ?? []), ...installed] });
	}
}
