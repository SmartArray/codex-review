<script lang="ts">
	import { CircleHelp, Clock3, LoaderCircle, RotateCcw, Sparkles, X } from '@lucide/svelte';
	import InlineCodeText from './InlineCodeText.svelte';
	import RoleSpeechButton from './RoleSpeechButton.svelte';
	import type { DiffHunk } from '$lib/shared/types';

	export let hunk: DiffHunk;
	export let anchor: { x: number; y: number };
	export let pinned = false;
	export let translucent = false;
	export let onClose: () => void = () => undefined;
	export let onAsk: () => void = () => undefined;
	export let onRetry: () => void = () => undefined;
	export let onPrepare: () => void = () => undefined;

	$: left = Math.max(12, Math.min(anchor.x, window.innerWidth - 390));
	$: top = Math.max(64, Math.min(anchor.y, window.innerHeight - 430));
</script>

<aside
	class="popover"
	class:pinned
	class:translucent
	style={`left:${left}px; top:${top}px`}
	aria-label="Hunk explanation"
	aria-live="polite"
>
	<header>
		<div class="eyebrow"><Sparkles size={12} /> Hunk {hunk.index + 1}</div>
		{#if pinned}<button type="button" class="icon" onclick={onClose} aria-label="Close explanation"
				><X size={14} /></button
			>{/if}
	</header>
	{#if hunk.explanation}
		<h3><InlineCodeText text={hunk.explanation.title} /></h3>
		<p>
			<InlineCodeText text={hunk.explanation.expandedExplanation} />
		</p>
		{#if pinned}
			<div class="explanation-audio">
				<RoleSpeechButton text={hunk.explanation.expandedExplanation} subject="hunk explanation" />
			</div>
		{/if}
		{#if pinned}
			<div class="actions">
				<button type="button" class="primary" onclick={onAsk}
					><CircleHelp size={13} /> Ask about this hunk</button
				>
			</div>
		{/if}
	{:else if hunk.analysis.state === 'failed'}
		<div class="state error">
			<strong>Explanation unavailable</strong>
			<p>{hunk.analysis.reason ?? 'Codex could not prepare this hunk.'}</p>
			{#if pinned}<button type="button" onclick={onRetry}><RotateCcw size={13} /> Retry</button
				>{/if}
		</div>
	{:else if hunk.analysis.state === 'skipped'}
		<div class="state">
			<strong>Analysis skipped</strong>
			<p>{hunk.analysis.reason ?? 'This file is excluded by the generated or size policy.'}</p>
		</div>
	{:else if hunk.analysis.state === 'idle'}
		<div class="state">
			<strong>Explanation available on demand</strong>
			<p>Generate a focused explanation for this hunk only.</p>
			{#if pinned}<button type="button" onclick={onPrepare}
					><Sparkles size={13} /> Prepare hunk explanation</button
				>{/if}
		</div>
	{:else}
		<div class="state preparing">
			{#if hunk.analysis.state === 'running'}<i class="spin"><LoaderCircle size={16} /></i
				>{:else}<Clock3 size={16} />{/if}
			<div>
				<strong>Preparing explanation…</strong>
				<p>
					{#if hunk.analysis.state === 'running'}Reading this change now
					{:else if hunk.analysis.queuePosition}Queue position {hunk.analysis.queuePosition}
					{:else}Promote it by selecting the hunk{/if}
				</p>
			</div>
		</div>
	{/if}
</aside>

<style>
	.popover {
		position: fixed;
		z-index: 80;
		width: 360px;
		max-height: min(480px, calc(100vh - 80px));
		overflow: auto;
		padding: 15px;
		border: 1px solid var(--border-strong);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface-2) 96%, transparent);
		box-shadow: var(--shadow-lg);
		backdrop-filter: blur(18px);
		pointer-events: none;
		transition: opacity 160ms ease;
	}

	.popover.pinned {
		pointer-events: auto;
	}

	.popover.pinned.translucent {
		opacity: 0.4;
	}

	.popover.pinned.translucent:hover,
	.popover.pinned.translucent:focus-within {
		opacity: 1;
	}

	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
	}

	.eyebrow {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--accent-text);
	}

	h3 {
		font-size: 14px;
		line-height: 1.35;
		margin: 0 0 7px;
	}

	p {
		margin: 0;
		font-size: 12px;
		line-height: 1.55;
		color: var(--text-secondary);
		white-space: pre-wrap;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 13px;
	}

	.explanation-audio {
		margin-top: 7px;
	}

	button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 28px;
		padding: 0 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-1);
		color: var(--text-secondary);
		font: 600 10px/1 inherit;
		cursor: pointer;
	}

	button:hover {
		color: var(--text-primary);
		border-color: var(--border-strong);
	}

	button.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: white;
	}

	button.icon {
		width: 25px;
		height: 25px;
		min-height: 0;
		padding: 0;
		justify-content: center;
		border: 0;
		background: transparent;
	}

	.state {
		padding: 8px 0 2px;
	}

	.state strong {
		display: block;
		font-size: 12px;
		margin-bottom: 4px;
	}

	.state button {
		margin-top: 10px;
	}

	.state.preparing {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		color: var(--warning);
	}

	.state.error strong {
		color: var(--danger);
	}
	.spin {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.popover {
			transition: none;
		}
	}
</style>
