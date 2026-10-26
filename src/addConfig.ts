import * as vscode from 'vscode';
import { CONFIG_FILE, configTemplate } from './config';

/** Writes a commented starter config into a workspace folder (or opens the existing one). */
export async function addConfigFile(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		vscode.window.showErrorMessage('Open the project folder first (e.g. via Remote-SSH on the cluster login node).');
		return;
	}
	const folder = folders.length === 1
		? folders[0]
		: await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to add the Slurm Dev Container configuration to' });
	if (!folder) {
		return;
	}
	const uri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE);
	if (!await exists(uri)) {
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(configTemplate(folder.name)));
	}
	await vscode.window.showTextDocument(uri);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
