<script lang="ts">
	import { Sparkles } from '@lucide/svelte';
	import type { CodexUsageSummary } from '$lib/shared/types';

	export let usage: CodexUsageSummary;

	$: invocationLabel = usage.invocationCount === 1 ? 'call' : 'calls';
	$: detail = [
		`Input: ${format(usage.inputTokens)}`,
		`Cached input: ${format(usage.cachedInputTokens)}`,
		`Output: ${format(usage.outputTokens)}`,
		`Reasoning output: ${format(usage.reasoningOutputTokens)}`
	].join(' · ');

	function format(value: number): string {
		return value.toLocaleString();
	}
</script>

<footer class="status-bar" aria-label="Review status">
	<div
		class="codex-usage"
		title={detail}
		aria-label={`Codex tokens used: ${format(usage.inputTokens)} input, ${format(usage.outputTokens)} output, across ${usage.invocationCount} ${invocationLabel}`}
	>
		<Sparkles size={10} />
		<span>Codex</span>
		<strong>{format(usage.inputTokens)}</strong>
		<span>in ·</span>
		<strong>{format(usage.outputTokens)}</strong>
		<span>out · {usage.invocationCount} {invocationLabel}</span>
	</div>
</footer>

<style>
	.status-bar {
		position: relative;
		grid-row: 4;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		min-width: 0;
		padding: 0 10px;
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 96%, transparent);
		color: var(--text-muted);
		backdrop-filter: blur(16px);
	}
	.codex-usage {
		display: flex;
		align-items: center;
		gap: 5px;
		white-space: nowrap;
		font: 9px/1 var(--font-mono);
	}
	.codex-usage :global(svg) {
		color: var(--accent-text);
	}
	.codex-usage strong {
		color: var(--text-secondary);
		font-weight: 650;
	}
</style>
