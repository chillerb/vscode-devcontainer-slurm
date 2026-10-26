import * as assert from 'assert';
import { Registry, StateStore } from '../../registry';

class MemoryStore implements StateStore {
	private readonly data = new Map<string, unknown>();
	get<T>(key: string, defaultValue: T): T {
		return (this.data.get(key) as T) ?? defaultValue;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.data.set(key, JSON.parse(JSON.stringify(value)));
	}
}

suite('registry', () => {
	test('registers projects with unique session names per cluster', async () => {
		const registry = new Registry(new MemoryStore());
		const a = await registry.register('marburg', '/home/j/My Project/', 1);
		assert.deepStrictEqual(a, {
			cluster: 'marburg', projectPath: '/home/j/My Project', session: 'my-project',
			alias: 'slurm-devcontainer-marburg-my-project', name: 'My Project', lastUsed: 1,
		});
		const again = await registry.register('marburg', '/home/j/My Project', 2);
		assert.strictEqual(again.session, 'my-project');
		assert.strictEqual(again.lastUsed, 2);
		const clash = await registry.register('marburg', '/scratch/my-project', 3);
		assert.strictEqual(clash.session, 'my-project-2');
		const otherCluster = await registry.register('juwels', '/scratch/my-project', 4);
		assert.strictEqual(otherCluster.alias, 'slurm-devcontainer-juwels-my-project');
		assert.deepStrictEqual(registry.list().map(e => e.lastUsed), [4, 3, 2]);
	});

	test('updates, finds and removes entries', async () => {
		const registry = new Registry(new MemoryStore());
		const a = await registry.register('c', '/p', 1);
		await registry.update(a.alias, { lastJobId: '42' });
		assert.strictEqual(registry.findByAlias(a.alias)?.lastJobId, '42');
		await registry.remove(a.alias);
		assert.strictEqual(registry.findByAlias(a.alias), undefined);
		await assert.rejects(registry.update(a.alias, {}), /Unknown/);
	});
});
