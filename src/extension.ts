import * as vscode from 'vscode';
import { addConfigFile } from './addConfig';
import { Registry } from './registry';
import { reportErrors, Sessions } from './session';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Slurm Dev Container', { log: true });
	const sessions = new Sessions(new Registry(context.globalState), log);
	const command = (id: string, fn: () => Promise<unknown>) =>
		vscode.commands.registerCommand(`slurmDevcontainer.${id}`, () => reportErrors(log, fn));

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
}

export function deactivate() {}
