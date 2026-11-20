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

	test('the built-in starter template is a valid configuration', async () => {
		const templates = await listTemplates(BUILTIN, []);
		assert.deepStrictEqual(templates.map(t => [t.name, t.source]), [['default', 'built-in']]);
		const vars = { localWorkspaceFolder: '/home/jdoe/my-project', localEnv: {} };
		const defaults = parseConfig(fs.readFileSync(path.join(BUILTIN, 'default', 'slurmtainer.json'), 'utf8'), vars);
		assert.strictEqual(defaults.name, 'my-project');
		assert.deepStrictEqual([defaults.apptainer.runArgs, defaults.apptainer.persistentWorkdir], [['--containall'], true]);
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

	test('follows symlinked templates and files', async () => {
		write('dotfiles/lab/slurmtainer.json');
		write('dotfiles/lab/image.def');
		write('dotfiles/shared.json');
		fs.mkdirSync(path.join(tmp, 'mine'));
		fs.symlinkSync(path.join(tmp, 'dotfiles', 'lab'), path.join(tmp, 'mine', 'lab'));
		write('mine/own/README.md');
		fs.symlinkSync(path.join(tmp, 'dotfiles', 'shared.json'), path.join(tmp, 'mine', 'own', 'slurmtainer.json'));
		fs.symlinkSync(path.join(tmp, 'missing'), path.join(tmp, 'mine', 'own', 'dangling'));
		const templates = await listTemplates(path.join(tmp, 'none'), [path.join(tmp, 'mine')]);
		assert.deepStrictEqual(templates.map(t => t.name), ['lab', 'own']);
		assert.deepStrictEqual(await templateFiles(path.join(tmp, 'mine', 'lab')), ['slurmtainer.json', 'image.def']);
		assert.deepStrictEqual(await templateFiles(path.join(tmp, 'mine', 'own')), ['slurmtainer.json', 'README.md']);
	});
});
