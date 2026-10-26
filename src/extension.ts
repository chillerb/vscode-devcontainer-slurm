import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Slurm Dev Container', { log: true });
	context.subscriptions.push(log);
}

export function deactivate() {}
