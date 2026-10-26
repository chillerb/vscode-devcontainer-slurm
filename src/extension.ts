import * as vscode from 'vscode';
import { addConfigFile } from './addConfig';
import { installConfiguredExtensions } from './containerWindow';
import { Registry } from './registry';
import { reportErrors, Sessions } from './session';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Slurm Dev Containers', { log: true });
	const registry = new Registry(context.globalState);
	const sessions = new Sessions(registry, log);
	const command = (id: string, fn: () => Promise<unknown>) =>
		vscode.commands.registerCommand(`remoteSlurmContainers.${id}`, () => reportErrors(log, fn));

	context.subscriptions.push(
		log,
		command('addConfig', addConfigFile),
		command('open', () => sessions.openCurrentFolder()),
		command('connect', () => sessions.connectCommand()),
		command('add', () => sessions.addEntry()),
		command('stop', () => sessions.stopCommand()),
		command('remove', () => sessions.removeCommand()),
		command('showLog', () => sessions.showLogCommand()),
	);

	const entry = sessions.currentEntry();
	if (entry) {
		log.info(`connected to ${entry.name} on ${entry.cluster} (job ${entry.lastJobId ?? 'unknown'})`);
		void reportErrors(log, () => installConfiguredExtensions(entry, registry, log));
	}
}

export function deactivate() {}
