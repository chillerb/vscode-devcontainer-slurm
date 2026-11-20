import * as path from 'path';
import * as vscode from 'vscode';
import { sshAuthority, sshHostFromAuthority } from './authority';
import { clusterPaths, launchScript, logScript, parseConnectionInfo, parseProbe, ProbedConfig, ProbeResult, probeScript, stopScript } from './clusterScript';
import { CONFIG_FILE, ConfigError, configDisplayName, configPath, parseConfig } from './config';
import { sshdStrategy } from './connection/sshd';
import { jobName, PREFIX } from './naming';
import { Entry, Registry } from './registry';
import { checkResult, lastValue, RemoteError, runOnCluster } from './remote';
import { IDENTITY_FILE, INCLUDE_TARGET, KNOWN_HOSTS_FILE, LocalSsh } from './sshConfig';

const POLL_SECONDS = 5;

class Cancelled extends Error { }

/** Implements the user-facing commands. */
export class Sessions {
	constructor(private readonly registry: Registry, private readonly log: vscode.LogOutputChannel) { }

	private get settings() {
		const c = vscode.workspace.getConfiguration('remoteSlurmContainers');
		return {
			sshPath: c.get<string>('sshPath') || 'ssh',
			openInNewWindow: c.get<boolean>('openInNewWindow', true),
			connectTimeoutMinutes: c.get<number>('connectTimeoutMinutes', 30),
			forwardSshAgent: c.get<boolean>('forwardSshAgent', false),
		};
	}

	private get localSsh(): LocalSsh {
		return new LocalSsh(this.settings.sshPath);
	}

	/** The entry of the container this window is connected to, if any. */
	currentEntry(): Entry | undefined {
		const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority;
		const host = authority ? sshHostFromAuthority(authority) : undefined;
		return host?.startsWith(`${PREFIX}-`) ? this.registry.findByAlias(host) : undefined;
	}

	/** "Open Folder in Container": the current Remote-SSH folder on a login node. */
	async openCurrentFolder(): Promise<void> {
		if (this.currentEntry()) {
			vscode.window.showInformationMessage('This window is already connected to a Slurm Dev Container.');
			return;
		}
		const folders = vscode.workspace.workspaceFolders ?? [];
		const folder = folders.length <= 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
		if (!folder) {
			if (folders.length === 0) {
				this.notConnectedHint();
			}
			return;
		}
		const cluster = folder.uri.scheme === 'vscode-remote' ? sshHostFromAuthority(folder.uri.authority) : undefined;
		if (!cluster) {
			this.notConnectedHint();
			return;
		}
		const probed = await this.pickConfig(cluster, folder.uri.path);
		if (!probed) {
			return;
		}
		const entry = await this.registry.register(cluster, folder.uri.path, probed.config);
		await this.connect(entry);
	}

	/**
	 * Reads the configurations of a project on the cluster. With several (`.slurmtainer/slurmtainer.json` and
	 * `.slurmtainer/<name>/slurmtainer.json`), the user picks one; each one is a separate dev container.
	 */
	private async pickConfig(cluster: string, projectPath: string): Promise<ProbedConfig | undefined> {
		const probe = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification, title: `Reading configurations on ${cluster}...`,
		}, async () => parseProbe(checkResult(cluster, await runOnCluster(cluster, probeScript(projectPath), { sshPath: this.settings.sshPath })).values));
		const configs = requireConfigs(probe, cluster);
		if (configs.length === 1) {
			return configs[0];
		}
		// The folder name is unique; the "name" (e.g. the starter template's ${localWorkspaceFolderBasename}) may not be.
		const vars = { localWorkspaceFolder: projectPath, localEnv: probe.env };
		const picked = await vscode.window.showQuickPick(configs.map(c => ({
			label: c.config || 'default',
			description: configDisplayName(c.text, vars),
			detail: c.relPath,
			probed: c,
		})), { title: `Select a configuration for ${path.posix.basename(projectPath)}`, matchOnDescription: true, matchOnDetail: true });
		return picked?.probed;
	}

	private notConnectedHint() {
		vscode.window.showErrorMessage(
			'Open the project folder on the cluster login node with Remote-SSH first, or use "Connect to Container..." to pick a known one.',
			'Connect to Container...',
		).then(choice => choice && vscode.commands.executeCommand('remoteSlurmContainers.connect'));
	}

	/** "Connect to Container...": picks a known entry and connects, from any window. */
	async connectCommand(): Promise<void> {
		const entry = await this.pickEntry('Connect to Slurm Dev Container');
		if (entry) {
			await this.connect(entry);
		}
	}

	async stopCommand(): Promise<void> {
		const entry = this.currentEntry() ?? await this.pickEntry('Stop Slurm Dev Container');
		if (!entry) {
			return;
		}
		const stop = 'Stop Job';
		const choice = await vscode.window.showWarningMessage(
			`Stop the Slurm job of ${entry.name} on ${entry.cluster}?`,
			{ modal: true, detail: 'Processes running in the container are terminated. Files in the project folder are kept.' },
			stop,
		);
		if (choice !== stop) {
			return;
		}
		await this.stop(entry);
	}

	private async stop(entry: Entry): Promise<void> {
		const result = checkResult(entry.cluster, await runOnCluster(entry.cluster, stopScript(jobName(entry.session)), { sshPath: this.settings.sshPath }));
		const stopped = lastValue(result, 'stopped');
		await this.localSsh.removeHost(entry.alias);
		this.log.info(`stop ${entry.alias}: ${stopped || 'no running job'}`);
		vscode.window.showInformationMessage(stopped ? `Stopped job ${stopped} of ${entry.name}.` : `${entry.name} has no running job.`);
	}

	async removeCommand(): Promise<void> {
		const entry = await this.pickEntry('Remove Slurm Dev Container from List');
		if (!entry) {
			return;
		}
		const remove = 'Remove';
		const stopAndRemove = 'Stop Job and Remove';
		const choice = await vscode.window.showWarningMessage(
			`Remove ${entry.name} on ${entry.cluster} from the list?`,
			{ modal: true, detail: 'The project folder on the cluster is not touched. A running job keeps running unless you stop it.' },
			remove, stopAndRemove,
		);
		if (choice === stopAndRemove) {
			await this.stop(entry);
		}
		if (choice) {
			await this.localSsh.removeHost(entry.alias);
			await this.registry.remove(entry.alias);
		}
	}

	async showLogCommand(): Promise<void> {
		const entry = this.currentEntry() ?? await this.pickEntry('Show Job Log');
		if (!entry) {
			return;
		}
		const result = checkResult(entry.cluster, await runOnCluster(entry.cluster, logScript(entry.session), { sshPath: this.settings.sshPath }));
		this.log.info(`----- job log of ${entry.name} on ${entry.cluster} -----`);
		for (const [key, value] of result.values) {
			if (key === 'log') {
				this.log.info(value);
			}
		}
		this.log.show();
	}

	private async pickEntry(title: string): Promise<Entry | undefined> {
		const entries = this.registry.list();
		if (entries.length === 0) {
			vscode.window.showInformationMessage('No Slurm Dev Containers yet. Open the project folder on the cluster login node with Remote-SSH and run "Open Folder in Container".');
			return undefined;
		}
		type Item = vscode.QuickPickItem & { entry?: Entry };
		const items: Item[] = entries.map(entry => ({
			label: entry.name,
			description: entry.cluster,
			detail: entry.projectPath,
			entry,
		}));
		const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Select a dev container', matchOnDescription: true, matchOnDetail: true });
		return picked?.entry;
	}

	/** Finds or submits the job, waits until the container is reachable and opens it. */
	async connect(entry: Entry): Promise<void> {
		if (!await this.ensureInclude()) {
			return;
		}
		const settings = this.settings;
		const ssh = this.localSsh;
		const workspaceFolder = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `${entry.name} on ${entry.cluster}`,
			cancellable: true,
		}, async (progress, token) => {
			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());
			const run = async (script: string, onValue?: (key: string, value: string) => void) => {
				try {
					return checkResult(entry.cluster, await runOnCluster(entry.cluster, script, { sshPath: settings.sshPath, signal: controller.signal, onValue }));
				} catch (e) {
					throw controller.signal.aborted ? new Cancelled() : e;
				}
			};

			progress.report({ message: 'Reading configuration...' });
			const authorizedKey = await ssh.ensureKey();
			const probe = parseProbe((await run(probeScript(entry.projectPath))).values);
			const relPath = configPath(entry.config);
			const probed = requireConfigs(probe, entry.cluster).find(c => c.config === entry.config);
			if (!probed) {
				throw new ConfigError(`${relPath} no longer exists in ${entry.projectPath} on ${entry.cluster}. Remove the container from the list or restore the file.`);
			}
			const config = parseConfig(probed.text, { localWorkspaceFolder: entry.projectPath, localEnv: probe.env }, relPath);
			const home = probe.home;
			const ctx = {
				session: entry.session, jobName: jobName(entry.session), projectPath: entry.projectPath, configPath: relPath, config,
				forwardSshAgent: settings.forwardSshAgent,
				...clusterPaths(home, entry.session),
			};

			progress.report({ message: 'Looking for a running job...' });
			let jobId = '';
			const result = await run(launchScript({
				ctx, strategy: sshdStrategy, authorizedKey,
				timeoutSeconds: Math.round(settings.connectTimeoutMinutes * 60), pollSeconds: POLL_SECONDS,
			}), (key, value) => {
				this.log.info(`${entry.alias}: ${key}=${value}`);
				if (key === 'submitted' || key === 'reusing') {
					jobId = value;
					progress.report({ message: key === 'submitted' ? `Submitted job ${value}...` : `Found job ${value}...` });
				} else if (key === 'state') {
					progress.report({ message: `Job ${jobId}: ${value.toLowerCase() || 'unknown'}...` });
				}
			});

			const info = parseConnectionInfo(result.values, sshdStrategy);
			const options = sshdStrategy.hostOptions(entry.cluster, info, { identityFile: IDENTITY_FILE, knownHostsFile: KNOWN_HOSTS_FILE });
			if (settings.forwardSshAgent) {
				options['ForwardAgent'] = 'yes';
				if (info.values['agent'] !== '1') {
					this.log.warn(`${entry.alias}: job ${info.jobId} was started without SSH agent forwarding`);
					vscode.window.showInformationMessage(
						`SSH agent forwarding takes effect after the job of ${entry.name} is restarted (Stop Container Job, then connect again).`);
				}
			}
			await ssh.writeHost(entry.alias, options);
			if (options['HostKeyAlias']) {
				await ssh.pinHostKey(options['HostKeyAlias'], info.hostKey);
			}
			await this.registry.update(entry.alias, {
				lastJobId: info.jobId, workspaceFolder: config.workspaceFolder, extensions: config.extensions, lastUsed: Date.now(),
			});
			this.log.info(`${entry.alias}: job ${info.jobId} ready on ${info.node}`);
			return config.workspaceFolder;
		});

		const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: sshAuthority(entry.alias), path: workspaceFolder });
		await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: settings.openInNewWindow });
	}

	/** Makes sure ~/.ssh/config includes our file; only ever changes it with the user's consent. */
	private async ensureInclude(): Promise<boolean> {
		const ssh = this.localSsh;
		if (await ssh.userConfigHasInclude()) {
			return true;
		}
		const line = `Include ${INCLUDE_TARGET}`;
		const add = 'Add Line';
		const copy = 'Copy Line';
		const choice = await vscode.window.showInformationMessage('One-time SSH setup', {
			modal: true,
			detail: `Slurmtainer keeps the SSH host entries of your containers in ${INCLUDE_TARGET} and never edits other SSH files on its own. `
				+ `For Remote-SSH to find these entries, ${path.join('~', '.ssh', 'config')} on this computer needs this line at the top:\n\n${line}\n\n`
				+ 'Add it for you now, or copy it and add it yourself?',
		}, add, copy);
		if (choice === add) {
			await ssh.addIncludeToUserConfig();
			this.log.info(`added "${line}" to ${ssh.userConfigPath}`);
			return true;
		}
		if (choice === copy) {
			await vscode.env.clipboard.writeText(`${line}\n`);
			vscode.window.showInformationMessage(`Copied. Add the line at the top of ${ssh.userConfigPath}, then connect again.`);
		}
		return false;
	}
}

/** The configurations found by the probe; throws a helpful error if there are none. */
function requireConfigs(probe: ProbeResult, cluster: string): ProbedConfig[] {
	if (probe.legacy !== undefined) {
		throw new ConfigError(`Found an old configuration at ${probe.legacy}. Since version 0.4.0 it is called ${CONFIG_FILE}: `
			+ 'rename the folder .slurm-devcontainer to .slurmtainer and the file slurm-devcontainer.json to slurmtainer.json.');
	}
	if (probe.configs.length === 0) {
		throw new ConfigError(`No configuration found in ${probe.missing ?? 'the project'}. Open the project on ${cluster} and run "Slurmtainer: Add Configuration File...".`);
	}
	return probe.configs;
}

/** Runs a command and reports errors to the user. */
export async function reportErrors(log: vscode.LogOutputChannel, fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof Cancelled || (e instanceof Error && e.name === 'AbortError')) {
			log.info('cancelled');
			return;
		}
		const message = e instanceof Error ? e.message : String(e);
		log.error(message);
		if (e instanceof RemoteError) {
			for (const [key, value] of e.result?.values ?? []) {
				if (key === 'log') {
					log.error(`  ${value}`);
				}
			}
			if (e.result?.stderr) {
				log.error(e.result.stderr.trim());
			}
		}
		const choice = await vscode.window.showErrorMessage(message, 'Show Log');
		if (choice) {
			log.show();
		}
	}
}
