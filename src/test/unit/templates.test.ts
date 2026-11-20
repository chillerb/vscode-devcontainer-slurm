import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseConfig } from '../../config';
import { listTemplates, templateFiles, validConfigName } from '../../templates';

/** The repository's `templates/` folder (tests run from `out/test/unit`). */
const BUILTIN = path.resolve(__dirname, '..', '..', '..', 'templates');

suite('templates', () => {
	let tmp: string;

	setup(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdc-templates-'));
	});

	teardown(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	function write(file: string, content = '{}') {
		fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
		fs.writeFileSync(path.join(tmp, file), content);
	}

	test('built-in templates are valid configurations', async () => {
		const templates = await listTemplates(BUILTIN, []);
		assert.deepStrictEqual(templates.map(t => [t.name, t.source]), [['default', 'built-in'], ['gpu', 'built-in']]);
		const vars = { localWorkspaceFolder: '/home/jdoe/my-project', localEnv: {} };
		const defaults = parseConfig(fs.readFileSync(path.join(BUILTIN, 'default', 'slurmtainer.json'), 'utf8'), vars);
		assert.strictEqual(defaults.name, 'my-project');
		assert.deepStrictEqual([defaults.apptainer.runArgs, defaults.apptainer.persistentWorkdir], [['--containall'], true]);
		const gpu = parseConfig(fs.readFileSync(path.join(BUILTIN, 'gpu', 'slurmtainer.json'), 'utf8'), vars);
		assert.deepStrictEqual([gpu.name, gpu.slurm.gpus, gpu.apptainer.runArgs], ['my-project (GPU)', '1', ['--containall', '--nv']]);
	});

	test('user templates come first and override built-in ones', async () => {
		write('builtin/default/slurmtainer.json');
		write('builtin/gpu/slurmtainer.json');
		write('mine/gpu/slurmtainer.json');
		write('mine/torch/slurmtainer.json');
		write('mine/no-config/README.md');
		write('mine/loose-file.json');
		const errors: string[] = [];
		const templates = await listTemplates(path.join(tmp, 'builtin'), [path.join(tmp, 'mine'), path.join(tmp, 'missing')], e => errors.push(e));
		assert.deepStrictEqual(templates.map(t => [t.name, t.source]), [
			['gpu', path.join(tmp, 'mine')], ['torch', path.join(tmp, 'mine')], ['default', 'built-in'],
		]);
		assert.strictEqual(templates[0].dir, path.join(tmp, 'mine', 'gpu'));
		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /missing/);
	});

	test('lists all files of a template, the configuration first', async () => {
		write('t/slurmtainer.json');
		write('t/a.def');
		write('t/scripts/setup.sh');
		assert.deepStrictEqual(await templateFiles(path.join(tmp, 't')), ['slurmtainer.json', 'a.def', 'scripts/setup.sh']);
	});

	test('validates configuration names', () => {
		for (const ok of ['gpu', 'cpu-only', 'v1.2', 'A_b']) {
			assert.strictEqual(validConfigName(ok), undefined, ok);
		}
		for (const bad of ['', '.hidden', 'a/b', 'with space', '-x']) {
			assert.ok(validConfigName(bad), bad);
		}
	});
});
