import * as assert from 'assert';
import { extensionsToInstall, Registry, StateStore } from '../../registry';

class MemoryStore implements StateStore {
	private readonly data = new Map<string, unknown>();
	get<T>(key: string, defaultValue: T): T {
		return (this.data.get(key) as T) ?? defaultValue;
	}
	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.data.delete(key);
		} else {
			this.data.set(key, JSON.parse(JSON.stringify(value)));
		}
	}
}

suite('registry', () => {
	test('registers projects with unique session names per cluster', async () => {
		const registry = new Registry(new MemoryStore());
		const a = await registry.register('cluster-a', '/home/j/My Project/', '', 1);
		assert.deepStrictEqual(a, {
			cluster: 'cluster-a', projectPath: '/home/j/My Project', config: '', session: 'my-project',
			alias: 'slurmtainer-cluster-a-my-project', name: 'My Project', lastUsed: 1,
		});
		const again = await registry.register('cluster-a', '/home/j/My Project', '', 2);
		assert.strictEqual(again.session, 'my-project');
		assert.strictEqual(again.lastUsed, 2);
		const clash = await registry.register('cluster-a', '/scratch/my-project', '', 3);
		assert.strictEqual(clash.session, 'my-project-2');
		const otherCluster = await registry.register('cluster-b', '/scratch/my-project', '', 4);
		assert.strictEqual(otherCluster.alias, 'slurmtainer-cluster-b-my-project');
		assert.deepStrictEqual(registry.list().map(e => e.lastUsed), [4, 3, 2]);
	});

	test('each configuration of a project is a separate entry', async () => {
		const registry = new Registry(new MemoryStore());
		const root = await registry.register('c', '/p/proj', '', 1);
		const gpu = await registry.register('c', '/p/proj', 'gpu', 2);
		assert.strictEqual(root.session, 'proj');
		assert.deepStrictEqual([gpu.session, gpu.alias, gpu.name], ['proj-gpu', 'slurmtainer-c-proj-gpu', 'proj (gpu)']);
		assert.strictEqual((await registry.register('c', '/p/proj', 'gpu', 3)).alias, gpu.alias);
		const clash = await registry.register('c', '/other/proj-gpu', '', 4);
		assert.strictEqual(clash.session, 'proj-gpu-2');
	});

	test('drops the entries of versions before the rename', async () => {
		const store = new MemoryStore();
		await store.update('remoteSlurmContainers.entries', [{ alias: 'slurm-devcontainer-c-p' }]);
		const registry = new Registry(store);
		await registry.register('c', '/p', '', 1);
		assert.strictEqual(await registry.dropLegacyEntries(), true);
		assert.strictEqual(store.get('remoteSlurmContainers.entries', undefined), undefined);
		assert.strictEqual(await registry.dropLegacyEntries(), false);
		assert.deepStrictEqual(registry.list().map(e => e.alias), ['slurmtainer-c-p']);
	});

	test('updates, finds and removes entries', async () => {
		const registry = new Registry(new MemoryStore());
		const a = await registry.register('c', '/p', '', 1);
		await registry.update(a.alias, { lastJobId: '42' });
		assert.strictEqual(registry.findByAlias(a.alias)?.lastJobId, '42');
		await registry.remove(a.alias);
		assert.strictEqual(registry.findByAlias(a.alias), undefined);
		await assert.rejects(registry.update(a.alias, {}), /Unknown/);
	});

	test('installs only extensions that were not installed before', async () => {
		const registry = new Registry(new MemoryStore());
		const a = await registry.register('c', '/p', '', 1);
		assert.deepStrictEqual(extensionsToInstall(a), []);
		const configured = await registry.update(a.alias, { extensions: ['ms-python.python', 'Foo.Bar'] });
		assert.deepStrictEqual(extensionsToInstall(configured), ['ms-python.python', 'Foo.Bar']);
		const installed = await registry.update(a.alias, { installedExtensions: ['foo.bar'] });
		assert.deepStrictEqual(extensionsToInstall(installed), ['ms-python.python']);
	});
});
