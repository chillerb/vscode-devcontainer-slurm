import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkResult, lastValue, RemoteError, runOnCluster } from '../../remote';

suite('remote', () => {
	let tmp: string;
	let fakeSsh: string;

	setup(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdc-remote-'));
		fakeSsh = path.join(tmp, 'ssh');
		// Ignores the ssh options and runs the script locally; the host "down" simulates a connection failure.
		fs.writeFileSync(fakeSsh, '#!/bin/bash\nfor a in "$@"; do [ "$a" = down ] && { echo "ssh: connect to host down: refused" >&2; exit 255; }; done\nSSH_ARGS="$*" exec bash -s\n', { mode: 0o755 });
	});

	teardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

	test('streams marked values and ignores other output', async () => {
		const seen: string[] = [];
		const result = await runOnCluster('cluster', 'echo noise\nprintf "@@sdc:a=1\\n@@sdc:b=x=y\\n"\nprintf "@@sdc:c=last"', {
			sshPath: fakeSsh, onValue: (k, v) => seen.push(`${k}:${v}`),
		});
		assert.strictEqual(result.code, 0);
		assert.deepStrictEqual(seen, ['a:1', 'b:x=y', 'c:last']);
		assert.strictEqual(lastValue(result, 'b'), 'x=y');
	});

	test('passes batch mode and keepalive options to ssh', async () => {
		const result = await runOnCluster('cluster', 'printf "@@sdc:args=%s\\n" "$SSH_ARGS"', { sshPath: fakeSsh });
		assert.strictEqual(lastValue(result, 'args'), '-T -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=30 -o ServerAliveCountMax=4 cluster bash -l -s');
	});

	test('turns failures into readable errors', async () => {
		const failed = await runOnCluster('cluster', 'echo "@@sdc:error=nope"; exit 3', { sshPath: fakeSsh });
		assert.throws(() => checkResult('cluster', failed), (e: RemoteError) => e.message === 'nope');
		const down = await runOnCluster('down', 'true', { sshPath: fakeSsh });
		assert.throws(() => checkResult('down', down), /ssh down failed: ssh: connect to host down: refused/);
		await assert.rejects(runOnCluster('cluster', 'true', { sshPath: path.join(tmp, 'missing') }), RemoteError);
	});

	test('can be cancelled', async () => {
		const controller = new AbortController();
		const run = runOnCluster('cluster', 'sleep 10', { sshPath: fakeSsh, signal: controller.signal });
		controller.abort();
		await assert.rejects(run, { name: 'AbortError' });
	});
});
