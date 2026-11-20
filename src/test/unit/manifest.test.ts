import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** The repository's package.json (tests run from `out/test/unit`). */
const MANIFEST = path.resolve(__dirname, '..', '..', '..', 'package.json');

/**
 * Settings that only the user may set: they choose local programs or folders, or make the local SSH agent
 * usable on the cluster. In a Remote-SSH window, workspace settings come from the project on the cluster.
 */
const USER_ONLY = ['sshPath', 'templateDirectories', 'forwardSshAgent'];

suite('manifest', () => {
	const properties: Record<string, { scope?: string }> = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).contributes.configuration.properties;

	test('settings can be set in the local user settings', () => {
		// The extension runs locally (extensionKind "ui"), so its settings describe the user's computer. Machine-scoped
		// settings can't be set in the local user settings of a Remote-SSH window (only in the remote settings).
		for (const [name, property] of Object.entries(properties)) {
			assert.ok(!property.scope?.startsWith('machine'), `${name} has scope ${property.scope}`);
		}
	});

	test('security-relevant settings cannot be set by a workspace', () => {
		for (const name of USER_ONLY) {
			assert.strictEqual(properties[`remoteSlurmContainers.${name}`]?.scope, 'application', name);
		}
	});
});
