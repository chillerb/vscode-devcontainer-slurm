const SSH_REMOTE = 'ssh-remote+';

/**
 * Extracts the SSH host from a Remote-SSH authority (`ssh-remote+<alias>`). Hosts typed into Remote-SSH as
 * `user@host:port` are encoded as hex JSON (`{"hostName":…,"user":…,"port":…}`); they are returned in the
 * `[user@]host[:port]` form that ssh's ProxyJump understands.
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
				return `${user ? `${user}@` : ''}${hostName}${port ? `:${port}` : ''}`;
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
