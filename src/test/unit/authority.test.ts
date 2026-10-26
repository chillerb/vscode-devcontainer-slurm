import * as assert from 'assert';
import { sshAuthority, sshDestination, sshHostFromAuthority } from '../../authority';

suite('authority', () => {
	test('parses Remote-SSH authorities', () => {
		assert.strictEqual(sshHostFromAuthority('ssh-remote+marburg'), 'marburg');
		assert.strictEqual(sshHostFromAuthority('ssh-remote+cafe'), 'cafe');
		const hex = Buffer.from(JSON.stringify({ hostName: 'login.example.org', user: 'jdoe', port: 2222 })).toString('hex');
		assert.strictEqual(sshHostFromAuthority(`ssh-remote+${hex}`), 'ssh://jdoe@login.example.org:2222');
		const hexNoPort = Buffer.from(JSON.stringify({ hostName: 'login', user: 'jdoe' })).toString('hex');
		assert.strictEqual(sshHostFromAuthority(`ssh-remote+${hexNoPort}`), 'jdoe@login');
		assert.strictEqual(sshHostFromAuthority('wsl+Ubuntu'), undefined);
		assert.strictEqual(sshHostFromAuthority('ssh-remote+'), undefined);
		assert.strictEqual(sshAuthority('a'), 'ssh-remote+a');
	});

	test('normalizes ssh destinations with a port', () => {
		assert.strictEqual(sshDestination('cluster'), 'cluster');
		assert.strictEqual(sshDestination('jdoe@login'), 'jdoe@login');
		assert.strictEqual(sshDestination('login:2222'), 'ssh://login:2222');
		assert.strictEqual(sshDestination('jdoe@login.example.org:2222'), 'ssh://jdoe@login.example.org:2222');
		assert.strictEqual(sshDestination('ssh://jdoe@login:2222'), 'ssh://jdoe@login:2222');
	});
});
