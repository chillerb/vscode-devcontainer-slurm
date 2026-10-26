import { spawn } from 'child_process';
import { parseMarkedLine } from './clusterScript';

export interface RunResult {
	code: number | null;
	/** `@@sdc:key=value` lines in output order. */
	values: [string, string][];
	stderr: string;
}

export interface RunOptions {
	sshPath: string;
	/** Called for every marked line as soon as it arrives. */
	onValue?: (key: string, value: string) => void;
	signal?: AbortSignal;
}

export class RemoteError extends Error {
	constructor(message: string, readonly result?: RunResult) {
		super(message);
		this.name = 'RemoteError';
	}
}

/**
 * Pipes a generated script into a login shell on the cluster via the local ssh client. BatchMode makes ssh fail
 * instead of waiting for a password prompt nobody can answer.
 */
export function runOnCluster(cluster: string, script: string, opts: RunOptions): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(opts.sshPath, ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', cluster, 'bash -l -s'], {
			stdio: ['pipe', 'pipe', 'pipe'],
			signal: opts.signal,
		});
		const values: [string, string][] = [];
		let stdout = '';
		let stderr = '';
		const handleLine = (line: string) => {
			const kv = parseMarkedLine(line);
			if (kv) {
				values.push(kv);
				opts.onValue?.(kv[0], kv[1]);
			}
		};
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			stdout += chunk;
			const lines = stdout.split('\n');
			stdout = lines.pop() ?? '';
			lines.forEach(handleLine);
		});
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', err => {
			reject(err.name === 'AbortError' ? err : new RemoteError(`Could not run ${opts.sshPath}: ${err.message}`));
		});
		child.on('close', code => {
			if (stdout) {
				handleLine(stdout);
			}
			resolve({ code, values, stderr });
		});
		child.stdin.on('error', () => { /* reported via close/error */ });
		child.stdin.end(script);
	});
}

/** Last value of `key`. */
export function lastValue(result: RunResult, key: string): string | undefined {
	return result.values.filter(([k]) => k === key).pop()?.[1];
}

/** Throws a readable error unless the script succeeded. */
export function checkResult(cluster: string, result: RunResult): RunResult {
	const error = lastValue(result, 'error');
	if (result.code === 0 && !error) {
		return result;
	}
	if (error) {
		throw new RemoteError(error, result);
	}
	if (result.code === 255) {
		const detail = result.stderr.trim().split('\n').pop() ?? '';
		throw new RemoteError(`ssh ${cluster} failed: ${detail}. Make sure "ssh ${cluster}" works without a password prompt (SSH key or ControlMaster).`, result);
	}
	throw new RemoteError(`Command on ${cluster} failed with exit code ${result.code}: ${result.stderr.trim()}`, result);
}
