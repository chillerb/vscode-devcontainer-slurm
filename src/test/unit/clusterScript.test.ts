import * as assert from 'assert';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	clusterPaths, jobScript, launchScript, logScript, parseMarkedLine, probeScript, sbatchDirectives, stopScript,
} from '../../clusterScript';
import { CONFIG_FILE, parseConfig } from '../../config';
import { sshdStrategy } from '../../connection/sshd';
import { JobContext } from '../../connection/types';

function bash(script: string, env: Record<string, string>, args: string[] = ['-s']) {
	return spawnSync('bash', args, { input: script, env: { ...process.env, ...env }, encoding: 'utf8' });
}

function marked(stdout: string): [string, string][] {
	return stdout.split('\n').map(parseMarkedLine).filter((x): x is [string, string] => x !== undefined);
}

function writeExecutable(file: string, content: string) {
	fs.writeFileSync(file, content, { mode: 0o755 });
}

async function waitFor(condition: () => boolean, timeoutMs: number) {
	const end = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > end) {
			throw new Error('timeout');
		}
		await new Promise(r => setTimeout(r, 100));
	}
}

suite('clusterScript', function () {
	this.timeout(20000);
	let tmp: string;
	let home: string;
	let bin: string;
	let project: string;
	let ctx: JobContext;

	setup(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdc-test-'));
		home = path.join(tmp, 'home');
		bin = path.join(tmp, 'bin');
		project = path.join(home, 'my project');
		fs.mkdirSync(path.join(project, '.slurm-devcontainer'), { recursive: true });
		fs.mkdirSync(bin);
		writeExecutable(path.join(bin, 'apptainer'), `#!/bin/bash
printf '%s\\n' "$@" >> "$HOME/apptainer.log"
echo "FOO=$APPTAINERENV_FOO"
printf 'ARG:%s\\n' "$@"
`);
		writeExecutable(path.join(bin, 'fake-sshd'), '#!/bin/bash\necho "sshd $*"\nexec sleep 30\n');
		const config = parseConfig(JSON.stringify({
			image: 'ubuntu:24.04',
			containerEnv: { FOO: "it's here" },
			mounts: ['source=/scratch,target=/scratch,readonly'],
			slurm: { partition: 'gpu', gpus: 1, time: '01:00:00', sbatchArgs: ['--qos=short'] },
			apptainer: { binary: path.join(bin, 'apptainer'), runArgs: ['--nv'] },
			connection: { sshdPath: path.join(bin, 'fake-sshd') },
		}), { localWorkspaceFolder: project, localEnv: {} });
		ctx = {
			session: 'my-project', jobName: 'slurm-devcontainer-my-project', projectPath: project, config,
			...clusterPaths(home, 'my-project'),
		};
	});

	teardown(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('generated scripts are valid bash', () => {
		const scripts = [
			probeScript(project),
			launchScript({ ctx, strategy: sshdStrategy, authorizedKey: 'ssh-ed25519 AAAA test', timeoutSeconds: 5, pollSeconds: 1 }),
			jobScript(ctx, sshdStrategy),
			sshdStrategy.sessionFiles(ctx)['enter.sh'].content,
			stopScript(ctx.jobName),
			logScript(ctx.session),
		];
		for (const script of scripts) {
			const result = bash(script, {}, ['-n']);
			assert.strictEqual(result.status, 0, result.stderr + script);
		}
	});

	test('sshd accepts the generated config', function () {
		const sshd = '/usr/sbin/sshd';
		if (!fs.existsSync(sshd)) {
			this.skip();
		}
		fs.mkdirSync(path.join(ctx.baseDir, 'ssh'), { recursive: true });
		spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(ctx.baseDir, 'ssh', 'host_ed25519')]);
		const config = path.join(tmp, 'sshd_config');
		fs.writeFileSync(config, sshdStrategy.sessionFiles(ctx)['sshd_config'].content);
		const result = spawnSync(sshd, ['-t', '-f', config], { encoding: 'utf8' });
		assert.strictEqual(result.status, 0, result.stderr);
	});

	test('sbatch directives', () => {
		assert.deepStrictEqual(sbatchDirectives('job', '/log', ctx.config), [
			'#SBATCH --job-name=job', '#SBATCH --output=/log', '#SBATCH --nodes=1', '#SBATCH --ntasks=1',
			'#SBATCH --partition=gpu', '#SBATCH --time=01:00:00', '#SBATCH --gpus=1', '#SBATCH --qos=short',
		]);
	});

	test('probe reports home, env and config', () => {
		fs.writeFileSync(path.join(project, CONFIG_FILE), '{ "image": "x" }');
		const result = bash(`echo "motd noise"\n${probeScript(project)}`, { HOME: home, PATH: `${bin}:${process.env.PATH}`, MARKER_TEST: 'a\nb' });
		const values = new Map(marked(result.stdout));
		assert.strictEqual(values.get('home'), home);
		assert.strictEqual(Buffer.from(values.get('config')!, 'base64').toString(), '{ "image": "x" }');
		const env = Buffer.from(values.get('env')!, 'base64').toString().split('\0');
		assert.ok(env.includes('MARKER_TEST=a\nb'));
		assert.strictEqual(values.get('error'), 'sbatch not found on the login node');
	});

	test('launch submits a job and waits for the connection', () => {
		writeExecutable(path.join(bin, 'squeue'), `#!/bin/bash
if [[ " $* " == *" -n "* ]]; then
	[[ " $* " == *" -t PENDING,CONFIGURING,RUNNING,SUSPENDED "* ]] || { echo "missing state filter" >&2; exit 1; }
	cat "$HOME/existing" 2>/dev/null
	exit 0
fi
echo RUNNING
`);
		writeExecutable(path.join(bin, 'sbatch'), `#!/bin/bash
sdir=$(dirname "$2")
printf 'job=42\\nnode=n1\\napptainer=/x\\nport=2222\\n' > "$sdir/connection"
echo "42;cluster"
`);
		const script = launchScript({ ctx, strategy: sshdStrategy, authorizedKey: 'ssh-ed25519 AAAA test', timeoutSeconds: 5, pollSeconds: 1 });
		const env = { HOME: home, PATH: `${bin}:${process.env.PATH}` };
		const result = bash(script, env);
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		const values = new Map(marked(result.stdout));
		assert.strictEqual(values.get('submitted'), '42');
		assert.strictEqual(values.get('node'), 'n1');
		assert.strictEqual(values.get('port'), '2222');
		assert.match(values.get('hostkey')!, /^ssh-ed25519 /);
		for (const f of ['job.sh', 'enter.sh', 'sshd_config', 'project']) {
			assert.ok(fs.existsSync(path.join(ctx.sessionDir, f)), f);
		}
		assert.strictEqual(fs.readFileSync(path.join(ctx.baseDir, 'ssh', 'authorized_keys'), 'utf8'), 'ssh-ed25519 AAAA test\n');

		// A second launch reuses the job and does not duplicate the key.
		fs.writeFileSync(path.join(home, 'existing'), '42\n43\n');
		const again = new Map(marked(bash(script, env).stdout));
		assert.strictEqual(again.get('reusing'), '42');
		assert.strictEqual(fs.readFileSync(path.join(ctx.baseDir, 'ssh', 'authorized_keys'), 'utf8'), 'ssh-ed25519 AAAA test\n');

		// Another project must not take over the session.
		const other = launchScript({ ctx: { ...ctx, projectPath: '/elsewhere' }, strategy: sshdStrategy, authorizedKey: 'k', timeoutSeconds: 5, pollSeconds: 1 });
		const conflict = bash(other, env);
		assert.strictEqual(conflict.status, 3);
		assert.match(new Map(marked(conflict.stdout)).get('error')!, /in use by .*my project \(job 42\)/);

		// Once that job has ended, the other project takes the session over.
		fs.rmSync(path.join(home, 'existing'));
		const takeover = bash(other, env);
		assert.strictEqual(takeover.status, 0, takeover.stdout + takeover.stderr);
		assert.strictEqual(fs.readFileSync(path.join(ctx.sessionDir, 'project'), 'utf8'), '/elsewhere\n');
	});

	test('launch reports a job that ended', () => {
		writeExecutable(path.join(bin, 'squeue'), '#!/bin/bash\nexit 0\n');
		writeExecutable(path.join(bin, 'sbatch'), '#!/bin/bash\nsdir=$(dirname "$2")\necho "boom" > "$sdir/job.log"\necho 43\n');
		const result = bash(launchScript({ ctx, strategy: sshdStrategy, authorizedKey: 'k', timeoutSeconds: 5, pollSeconds: 1 }), { HOME: home, PATH: `${bin}:${process.env.PATH}` });
		assert.strictEqual(result.status, 4);
		const lines = marked(result.stdout);
		assert.ok(lines.some(([k, v]) => k === 'error' && v.includes('no longer active')));
		assert.ok(lines.some(([k, v]) => k === 'log' && v === 'boom'));
	});

	test('job starts the container and sshd, enter.sh runs commands inside it', async () => {
		fs.mkdirSync(ctx.sessionDir, { recursive: true });
		for (const [name, file] of Object.entries(sshdStrategy.sessionFiles(ctx))) {
			fs.writeFileSync(path.join(ctx.sessionDir, name), file.content, { mode: file.executable ? 0o700 : 0o600 });
		}
		const jobFile = path.join(tmp, 'job.sh');
		fs.writeFileSync(jobFile, jobScript(ctx, sshdStrategy));
		let job: ChildProcess | undefined;
		try {
			job = spawn('bash', [jobFile], { env: { ...process.env, HOME: home, SLURM_JOB_ID: '7', SLURMD_NODENAME: 'n7' }, stdio: 'ignore' });
			const connection = path.join(ctx.sessionDir, 'connection');
			await waitFor(() => fs.existsSync(connection), 10000);
			const values = Object.fromEntries(fs.readFileSync(connection, 'utf8').trim().split('\n').map(l => l.split('=')));
			assert.strictEqual(values.job, '7');
			assert.strictEqual(values.node, 'n7');
			assert.match(values.port, /^\d+$/);
			const started = fs.readFileSync(path.join(home, 'apptainer.log'), 'utf8').split('\n');
			assert.deepStrictEqual(started.slice(0, 10), [
				'instance', 'start', '--nv', '--bind', `${project}:/workspaces/my project`, '--bind', '/scratch:/scratch:ro',
				'docker://ubuntu:24.04', 'slurm-devcontainer-7', '',
			]);

			const enter = spawnSync(path.join(ctx.sessionDir, 'enter.sh'), { env: { ...process.env, HOME: home, SSH_ORIGINAL_COMMAND: 'echo hi' }, encoding: 'utf8' });
			assert.strictEqual(enter.status, 0, enter.stderr);
			assert.ok(enter.stdout.includes("FOO=it's here"), enter.stdout);
			const args = enter.stdout.split('\n').filter(l => l.startsWith('ARG:')).map(l => l.slice(4));
			assert.deepStrictEqual(args.slice(0, 5), ['exec', '--pwd', '/workspaces/my project', 'instance://slurm-devcontainer-7', '/bin/sh']);
			assert.strictEqual(args[args.length - 1], 'echo hi');

			const exited = new Promise(resolve => job!.on('exit', resolve));
			job.kill('SIGTERM');
			await exited;
			assert.ok(!fs.existsSync(connection), 'connection file removed on exit');
			assert.match(fs.readFileSync(path.join(home, 'apptainer.log'), 'utf8'), /instance\nstop\nslurm-devcontainer-7/);
		} finally {
			job?.kill('SIGKILL');
		}
	});
});
