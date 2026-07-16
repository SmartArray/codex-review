<script lang="ts">
	export let text = '';

	type Token = { kind: 'text' | 'code'; value: string };

	$: tokens = tokenize(text);

	function tokenize(value: string): Token[] {
		const tokens: Token[] = [];
		const pattern = /`([^`\n]+)`/g;
		let cursor = 0;
		for (const match of value.matchAll(pattern)) {
			const index = match.index ?? 0;
			if (index > cursor) tokens.push({ kind: 'text', value: value.slice(cursor, index) });
			tokens.push({ kind: 'code', value: match[1] });
			cursor = index + match[0].length;
		}
		if (cursor < value.length) tokens.push({ kind: 'text', value: value.slice(cursor) });
		return tokens;
	}
</script>

{#each tokens as token, index (`${index}:${token.kind}`)}
	{#if token.kind === 'code'}<code class="inline-code">{token.value}</code>{:else}{token.value}{/if}
{/each}

<style>
	.inline-code {
		padding: 0 3px;
		border-radius: 3px;
		background: color-mix(in srgb, var(--accent-2) 10%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-2) 25%, transparent);
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace;
		font-size: 0.94em;
		font-variant-ligatures: none;
		line-height: inherit;
		box-decoration-break: clone;
		-webkit-box-decoration-break: clone;
	}

	@media (prefers-color-scheme: dark) {
		.inline-code {
			background: color-mix(in srgb, var(--accent-2) 20%, transparent);
			box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-2) 42%, transparent);
		}
	}
</style>
