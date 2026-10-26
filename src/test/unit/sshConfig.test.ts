import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	addInclude, hasInclude, LocalSsh, listHosts, parseHostBlocks, removeHostBlock, upsertHostBlock, upsertKnownHost,
} from '../../sshConfig';

suite('sshConfig', () => {
	test('upserts and removes host blocks', () => {
		let text = upsertHostBlock('', 'a', { HostName: 'n1', Port: '2222' });
		text = upsertHostBlock(text, 'b', { HostName: 'n2', IdentityFile: 'C:/Users/J Doe/key' });
		assert.match(text, /^# Managed by/);
		assert.match(text, /Host a\n {2}HostName n1\n {2}Port 2222\n\nHost b\n {2}HostName n2\n {2}IdentityFile "C:\/Users\/J Doe\/key"\n$/);
		text = upsertHostBlock(text, 'a', { HostName: 'n3' });
		assert.deepStrictEqual([...parseHostBlocks(text)], [['a', { HostName: 'n3' }], ['b', { HostName: 'n2', IdentityFile: 'C:/Users/J Doe/key' }]]);
		text = removeHostBlock(removeHostBlock(text, 'a'), 'b');
		assert.deepStrictEqual([...parseHostBlocks(text)], []);
	});

	test('detects and adds the Include line', () => {
		const home = '/home/jdoe';
		assert.ok(!hasInclude('Host x\n  HostName y\n', home));
		assert.ok(hasInclude('Include ~/.ssh/slurm-devcontainer/config\n', home));
		assert.ok(hasInclude('  include "/home/jdoe/.ssh/slurm-devcontainer/config"\n', home));
		assert.ok(hasInclude('Include other slurm-devcontainer/config\n', home));
		const updated = addInclude('Host x\n');
		assert.ok(hasInclude(updated, home));
		assert.ok(updated.indexOf('Include') < updated.indexOf('Host x'));
	});

	test('lists concrete hosts of the user config', () => {
		const text = 'Host *\n  User x\nHost cluster cluster-b\nhost !bad slurm-devcontainer-cluster-p other?\nMatch host foo\n';
		assert.deepStrictEqual(listHosts(text), ['cluster', 'cluster-b']);
	});

	test('pins host keys per alias', () => {
		let text = upsertKnownHost('', 'slurm-devcontainer-a', 'ssh-ed25519 AAAA1 comment');
		text = upsertKnownHost(text, 'other', 'ssh-ed25519 BBBB');
		text = upsertKnownHost(text, 'slurm-devcontainer-a', 'ssh-ed25519 AAAA2');
		assert.strictEqual(text, 'other ssh-ed25519 BBBB\nslurm-devcontainer-a ssh-ed25519 AAAA2\n');
	});

	test('LocalSsh manages only its own files unless asked', async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdc-ssh-'));
		try {
			const ssh = new LocalSsh('ssh', home);
			const pub = await ssh.ensureKey();
			assert.match(pub, /^ssh-ed25519 /);
			assert.strictEqual(await ssh.ensureKey(), pub);
			await ssh.writeHost('h', { HostName: 'n', Port: '2222', ProxyJump: 'cluster', IdentityFile: '~/.ssh/slurm-devcontainer/id_ed25519', IdentitiesOnly: 'yes' });
			const resolved = spawnSync('ssh', ['-G', '-F', path.join(home, '.ssh', 'slurm-devcontainer', 'config'), 'h'], { encoding: 'utf8' });
			assert.strictEqual(resolved.status, 0, resolved.stderr);
			assert.match(resolved.stdout, /^port 2222$/m);
			assert.match(resolved.stdout, /^proxyjump cluster$/m);
			await ssh.pinHostKey('k', 'ssh-ed25519 AAAA');
			assert.ok(!fs.existsSync(path.join(home, '.ssh', 'config')));
			assert.ok(!await ssh.userConfigHasInclude());

			fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host cluster\n  HostName login\n');
			await ssh.addIncludeToUserConfig();
			await ssh.addIncludeToUserConfig();
			const userConfig = fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8');
			assert.strictEqual(userConfig.match(/Include/g)?.length, 1);
			assert.ok(userConfig.endsWith('Host cluster\n  HostName login\n'));
			assert.deepStrictEqual(await ssh.listUserHosts(), ['cluster']);
			await ssh.removeHost('h');
			assert.deepStrictEqual([...parseHostBlocks(fs.readFileSync(path.join(home, '.ssh', 'slurm-devcontainer', 'config'), 'utf8'))], []);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});
