import * as assert from 'assert';
import { sshAuthority, sshHostFromAuthority } from '../../authority';

suite('authority', () => {
	test('parses Remote-SSH authorities', () => {
		assert.strictEqual(sshHostFromAuthority('ssh-remote+marburg'), 'marburg');
		assert.strictEqual(sshHostFromAuthority('ssh-remote+cafe'), 'cafe');
		const hex = Buffer.from(JSON.stringify({ hostName: 'login.example.org', user: 'jdoe', port: 2222 })).toString('hex');
		assert.strictEqual(sshHostFromAuthority(`ssh-remote+${hex}`), 'jdoe@login.example.org:2222');
		assert.strictEqual(sshHostFromAuthority('wsl+Ubuntu'), undefined);
		assert.strictEqual(sshHostFromAuthority('ssh-remote+'), undefined);
		assert.strictEqual(sshAuthority('a'), 'ssh-remote+a');
	});
});
