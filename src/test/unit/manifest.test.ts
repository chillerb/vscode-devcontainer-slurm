import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** The repository's package.json (tests run from `out/test/unit`). */
const MANIFEST = path.resolve(__dirname, '..', '..', '..', 'package.json');

suite('manifest', () => {
	test('settings can be set in the local user settings', () => {
		// The extension runs locally (extensionKind "ui"), so its settings describe the user's computer. Machine-scoped
		// settings can't be set in the local user settings of a Remote-SSH window (only in the remote settings).
		const properties: Record<string, { scope?: string }> = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).contributes.configuration.properties;
		for (const [name, property] of Object.entries(properties)) {
			assert.ok(!property.scope?.startsWith('machine'), `${name} has scope ${property.scope}`);
		}
	});
});
