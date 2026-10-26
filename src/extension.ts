import * as vscode from 'vscode';
import { addConfigFile } from './addConfig';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Slurm Dev Container', { log: true });
	context.subscriptions.push(
		log,
		vscode.commands.registerCommand('slurmDevcontainer.addConfig', addConfigFile),
	);
}

export function deactivate() {}
