/** Quotes a string for safe use as a single word in bash. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A bash snippet writing `content` verbatim to `target` (a shell expression). */
export function writeFileSnippet(target: string, content: string, mode?: string): string {
	let delimiter = 'SLURM_DEVCONTAINER_EOF';
	while (content.split('\n').includes(delimiter)) {
		delimiter += '_';
	}
	const body = content.endsWith('\n') ? content : `${content}\n`;
	const chmod = mode ? `\nchmod ${mode} ${target}` : '';
	return `cat > ${target} <<'${delimiter}'\n${body}${delimiter}${chmod}`;
}
