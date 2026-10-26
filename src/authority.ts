const SSH_REMOTE = 'ssh-remote+';

/**
 * Turns `[user@]host:port` into `ssh://[user@]host:port`, the only form with a port that works both as an ssh
 * destination and as a ProxyJump target. Aliases and `user@host` are returned unchanged.
 */
export function sshDestination(host: string): string {
	const m = /^((?:[^@:/\s]+@)?[^:@/\s]+):(\d+)$/.exec(host);
	return m ? `ssh://${m[1]}:${m[2]}` : host;
}

/**
 * Extracts the SSH host from a Remote-SSH authority (`ssh-remote+<alias>`). Hosts typed into Remote-SSH as
 * `user@host:port` are encoded as hex JSON (`{"hostName":…,"user":…,"port":…}`); they are returned as an ssh
 * destination (see {@link sshDestination}).
 */
export function sshHostFromAuthority(authority: string): string | undefined {
	if (!authority.startsWith(SSH_REMOTE)) {
		return undefined;
	}
	const host = authority.slice(SSH_REMOTE.length);
	if (/^([0-9a-f]{2})+$/i.test(host)) {
		try {
			const decoded: unknown = JSON.parse(Buffer.from(host, 'hex').toString('utf8'));
			if (typeof decoded === 'object' && decoded !== null && typeof (decoded as { hostName?: unknown }).hostName === 'string') {
				const { hostName, user, port } = decoded as { hostName: string; user?: string; port?: number };
				return sshDestination(`${user ? `${user}@` : ''}${hostName}${port ? `:${port}` : ''}`);
			}
		} catch {
			// not hex JSON, a plain alias that happens to look like hex
		}
	}
	return host || undefined;
}

export function sshAuthority(host: string): string {
	return SSH_REMOTE + host;
}
