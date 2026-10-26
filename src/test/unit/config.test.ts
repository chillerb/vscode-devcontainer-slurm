import * as assert from 'assert';
import { ConfigError, configTemplate, parseConfig, resolveImage, substitute } from '../../config';

const vars = { localWorkspaceFolder: '/home/jdoe/projects/my-project', localEnv: { USER: 'jdoe', HOME: '/home/jdoe' } };

suite('config', () => {
	test('applies defaults for a minimal config', () => {
		const config = parseConfig('{ "image": "ubuntu:24.04" }', vars);
		assert.strictEqual(config.image, 'docker://ubuntu:24.04');
		assert.strictEqual(config.workspaceFolder, '/workspaces/my-project');
		assert.deepStrictEqual(config.mounts, []);
		assert.deepStrictEqual(config.extensions, []);
		assert.deepStrictEqual(config.slurm, {
			partition: undefined, time: undefined, cpusPerTask: undefined, mem: undefined, gpus: undefined,
			account: undefined, qos: undefined, constraint: undefined, sbatchArgs: [],
		});
		assert.deepStrictEqual(config.apptainer, { binary: 'apptainer', modules: [], runArgs: [], persistentWorkdir: false, persistentWorkdirPath: undefined });
		assert.deepStrictEqual(config.connection, { type: 'sshd', sshdPath: '/usr/sbin/sshd' });
	});

	test('parses comments, trailing commas and all sections', () => {
		const config = parseConfig(`{
			// comment
			"name": "demo",
			"image": "docker://python:3.12",
			"workspaceFolder": "/work/\${localWorkspaceFolderBasename}",
			"containerEnv": { "DATA": "/scratch/\${localEnv:USER}", "WS": "\${containerWorkspaceFolder}" },
			"mounts": [
				"source=/scratch/\${localEnv:USER},target=/scratch,type=bind,readonly",
				{ "source": "/data", "target": "/data" },
			],
			"customizations": { "vscode": { "extensions": ["ms-python.python"] } },
			"slurm": { "partition": "gpu", "gpus": 2, "cpusPerTask": 8, "sbatchArgs": ["--qos=short"] },
			"apptainer": { "modules": ["apptainer/1.3"], "runArgs": ["--nv"] },
		}`, vars);
		assert.strictEqual(config.name, 'demo');
		assert.strictEqual(config.workspaceFolder, '/work/my-project');
		assert.deepStrictEqual(config.containerEnv, { DATA: '/scratch/jdoe', WS: '/work/my-project' });
		assert.deepStrictEqual(config.mounts, [
			{ source: '/scratch/jdoe', target: '/scratch', readonly: true },
			{ source: '/data', target: '/data', readonly: false },
		]);
		assert.deepStrictEqual(config.extensions, ['ms-python.python']);
		assert.strictEqual(config.slurm.gpus, '2');
		assert.strictEqual(config.slurm.cpusPerTask, 8);
		assert.deepStrictEqual(config.apptainer.runArgs, ['--nv']);
	});

	test('parses the persistent workdir options', () => {
		const apptainer = (options: object) => parseConfig(JSON.stringify({ image: 'x', apptainer: options }), vars).apptainer;
		assert.strictEqual(apptainer({ persistentWorkdir: true }).persistentWorkdir, true);
		assert.strictEqual(apptainer({ persistentWorkdir: true }).persistentWorkdirPath, undefined);
		assert.strictEqual(apptainer({ persistentWorkdir: true, persistentWorkdirPath: '~/c/${localWorkspaceFolderBasename}' }).persistentWorkdirPath, '~/c/my-project');
		assert.strictEqual(apptainer({ persistentWorkdir: true, persistentWorkdirPath: '/scratch/${localEnv:USER}/w' }).persistentWorkdirPath, '/scratch/jdoe/w');
		assert.throws(() => apptainer({ persistentWorkdirPath: '/x' }), /requires "apptainer.persistentWorkdir": true/);
		assert.throws(() => apptainer({ persistentWorkdir: true, persistentWorkdirPath: 'rel/x' }), /absolute path or start with ~\//);
		assert.throws(() => apptainer({ persistentWorkdir: 'yes' }), /must be true or false/);
	});

	test('rejects a --workdir in runArgs together with persistentWorkdir', () => {
		const apptainer = (options: object) => parseConfig(JSON.stringify({ image: 'x', apptainer: options }), vars).apptainer;
		for (const runArgs of [['--workdir', '/w'], ['--workdir=/w'], ['-W', '/w']]) {
			assert.throws(() => apptainer({ persistentWorkdir: true, runArgs }), /conflicts with "apptainer.persistentWorkdir"/, runArgs.join(' '));
			assert.deepStrictEqual(apptainer({ persistentWorkdir: false, runArgs }).runArgs, runArgs);
		}
	});

	test('points users of the 0.2.0 persistentHome option to its replacement', () => {
		const apptainer = (options: object) => parseConfig(JSON.stringify({ image: 'x', apptainer: options }), vars).apptainer;
		assert.throws(() => apptainer({ persistentHome: true }), /"apptainer.persistentHome" was replaced by "apptainer.persistentWorkdir"/);
		assert.throws(() => apptainer({ persistentHomePath: '/x' }), /replaced by .*"apptainer.persistentWorkdirPath"/);
	});


	test('rejects invalid configs', () => {
		assert.throws(() => parseConfig('{', vars), ConfigError);
		assert.throws(() => parseConfig('[]', vars), /expected a JSON object/);
		assert.throws(() => parseConfig('{}', vars), /"image" is required/);
		assert.throws(() => parseConfig('{ "image": "x", "workspaceFolder": "rel" }', vars), /absolute/);
		assert.throws(() => parseConfig('{ "image": "x", "mounts": ["source=a,target=b,type=volume"] }', vars), /only bind mounts/);
		assert.throws(() => parseConfig('{ "image": "x", "slurm": { "cpusPerTask": "4" } }', vars), /must be a number/);
		assert.throws(() => parseConfig('{ "image": "x", "containerEnv": { "A-B": "1" } }', vars), /invalid variable name/);
		assert.throws(() => parseConfig('{ "image": "x", "connection": { "type": "tunnel" } }', vars), /unsupported/);
	});

	test('substitutes variables like the Dev Containers spec', () => {
		assert.strictEqual(substitute('${a}/${localEnv:X}/${localEnv:Y:def}/${unknown}', { a: 'A' }, { X: 'x' }), 'A/x/def/${unknown}');
		assert.strictEqual(substitute('${localEnv:MISSING}', {}, {}), '');
	});

	test('resolves image references', () => {
		const ws = '/home/jdoe/p';
		assert.strictEqual(resolveImage('ubuntu', ws), 'docker://ubuntu');
		assert.strictEqual(resolveImage('oras://ghcr.io/x/y:1', ws), 'oras://ghcr.io/x/y:1');
		assert.strictEqual(resolveImage('/images/a.sif', ws), '/images/a.sif');
		assert.strictEqual(resolveImage('./a.sif', ws), '/home/jdoe/p/.slurm-devcontainer/a.sif');
		assert.strictEqual(resolveImage('../images/a.sif', ws), '/home/jdoe/p/images/a.sif');
	});

	test('template is a valid config', () => {
		const config = parseConfig(configTemplate('demo'), vars);
		assert.strictEqual(config.name, 'demo');
		assert.strictEqual(config.workspaceFolder, '/workspaces/my-project');
	});
});
