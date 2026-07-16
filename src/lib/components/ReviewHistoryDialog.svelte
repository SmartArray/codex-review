<script lang="ts">
	import { Clock3, GitCompareArrows, Trash2, X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { ReviewConfig, ReviewHistoryEntry } from '$lib/shared/types';

	export let entries: ReviewHistoryEntry[] = [];
	export let loading = false;
	export let onSelect: (config: ReviewConfig) => void = () => undefined;
	export let onClear: () => Promise<void> = async () => undefined;
	export let onClose: () => void = () => undefined;

	let dialog: HTMLDialogElement;
	let holding = false;
	let clearing = false;
	let clearError = '';
	let holdTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => dialog.showModal());

	function beginClear() {
		if (clearing || entries.length === 0 || holding) return;
		holding = true;
		clearError = '';
		holdTimer = setTimeout(() => void confirmClear(), 1200);
	}

	function cancelClear() {
		if (holdTimer) clearTimeout(holdTimer);
		holdTimer = undefined;
		holding = false;
	}

	async function confirmClear() {
		holdTimer = undefined;
		holding = false;
		clearing = true;
		try {
			await onClear();
		} catch (error) {
			clearError = error instanceof Error ? error.message : 'Could not clear review history.';
		} finally {
			clearing = false;
		}
	}

	function select(config: ReviewConfig) {
		onSelect(config);
		onClose();
	}

	function comparisonLabel(mode: ReviewConfig['mode']): string {
		return mode === 'commit' ? 'Selected commit only' : 'Revision → working HEAD';
	}

	function detailLabel(level: number): string {
		return (
			['Very small', 'Compact', 'Medium', 'Detailed', 'Very detailed'][level - 1] ?? `${level}/5`
		);
	}

	function contextLabel(config: ReviewConfig): string {
		return config.sessionId
			? `Session · ${config.sessionId}`
			: `Context · ${config.contextMessage}`;
	}

	function formatDate(value: string): string {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(new Date(value));
	}
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="history-title"
	onclose={onClose}
	oncancel={(event) => {
		event.preventDefault();
		onClose();
	}}
>
	<header>
		<div class="heading-icon"><Clock3 size={18} /></div>
		<div>
			<h2 id="history-title">Recent reviews</h2>
			<p>Choose a previous configuration to restore it.</p>
		</div>
		<button type="button" class="close" aria-label="Close review history" onclick={onClose}
			><X size={17} /></button
		>
	</header>

	<div class="history-list" aria-busy={loading}>
		{#if loading}
			<div class="empty"><Clock3 size={22} /> Loading recent reviews…</div>
		{:else if entries.length === 0}
			<div class="empty"><Clock3 size={22} /> No recent reviews yet.</div>
		{:else}
			{#each entries as entry (entry.id)}
				<button class="history-entry" type="button" onclick={() => select(entry.config)}>
					<div class="entry-title">
						<GitCompareArrows size={15} />
						<div class="root-detail">
							<span>Root directory</span>
							<strong title={entry.config.root}>{entry.config.root}</strong>
						</div>
						<time datetime={entry.lastOpenedAt}>{formatDate(entry.lastOpenedAt)}</time>
					</div>
					<dl>
						<div>
							<dt>Git revision</dt>
							<dd>{entry.config.revision}</dd>
						</div>
						<div>
							<dt>Comparison mode</dt>
							<dd>{comparisonLabel(entry.config.mode)}</dd>
						</div>
						<div>
							<dt>Analysis model</dt>
							<dd>{entry.config.model}</dd>
						</div>
						<div class="wide">
							<dt>Session ID / context</dt>
							<dd title={contextLabel(entry.config)}>{contextLabel(entry.config)}</dd>
						</div>
						<div>
							<dt>Explanation size</dt>
							<dd>{entry.config.detailLevel}/5 · {detailLabel(entry.config.detailLevel)}</dd>
						</div>
					</dl>
				</button>
			{/each}
		{/if}
	</div>

	<footer>
		{#if clearError}<p role="alert">{clearError}</p>{/if}
		<button
			type="button"
			class="clear"
			class:holding
			disabled={entries.length === 0 || clearing}
			aria-label="Hold to clear all review history"
			onpointerdown={beginClear}
			onpointerup={cancelClear}
			onpointercancel={cancelClear}
			onlostpointercapture={cancelClear}
			onkeydown={(event) => {
				if (event.key === ' ' || event.key === 'Enter') beginClear();
			}}
			onkeyup={(event) => {
				if (event.key === ' ' || event.key === 'Enter') cancelClear();
			}}
			onblur={cancelClear}
		>
			<span class="hold-fill"></span>
			<span class="clear-label"
				><Trash2 size={13} /> {clearing ? 'Clearing…' : 'Hold to clear history'}</span
			>
		</button>
	</footer>
</dialog>

<style>
	dialog {
		width: min(820px, calc(100vw - 48px));
		max-height: min(760px, calc(100vh - 64px));
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--border-strong);
		border-radius: 16px;
		background: color-mix(in srgb, var(--surface-1) 96%, transparent);
		color: var(--text-primary);
		box-shadow: var(--shadow-xl);
		backdrop-filter: blur(24px);
	}
	dialog::backdrop {
		background: color-mix(in srgb, var(--surface-0) 70%, transparent);
		backdrop-filter: blur(12px);
	}
	header {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 18px 20px;
		border-bottom: 1px solid var(--border);
	}
	.heading-icon {
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border-radius: 9px;
		background: var(--selection-soft);
		color: var(--accent-text);
	}
	h2,
	p {
		margin: 0;
	}
	h2 {
		font-size: 15px;
	}
	header p {
		margin-top: 2px;
		font-size: 10px;
		color: var(--text-muted);
	}
	.close {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		margin-left: auto;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}
	.close:hover {
		background: var(--surface-3);
		color: var(--text-primary);
	}
	.history-list {
		max-height: min(600px, calc(100vh - 210px));
		display: grid;
		gap: 9px;
		padding: 14px;
		overflow: auto;
	}
	.empty {
		min-height: 180px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 9px;
		color: var(--text-muted);
		font-size: 12px;
	}
	.history-entry {
		width: 100%;
		display: grid;
		gap: 12px;
		padding: 14px 15px;
		border: 1px solid var(--border);
		border-radius: 11px;
		background: var(--surface-0);
		color: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 120ms ease,
			background 120ms ease,
			transform 120ms ease;
	}
	.history-entry:hover,
	.history-entry:focus-visible {
		border-color: var(--selection-border);
		background: var(--selection-soft);
		transform: translateY(-1px);
		outline: none;
	}
	.entry-title {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		color: var(--accent-text);
	}
	.root-detail {
		min-width: 0;
		display: grid;
		gap: 2px;
	}
	.root-detail span {
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.root-detail strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 650 12px/1.3 var(--font-mono);
	}
	time {
		margin-left: auto;
		flex: none;
		font-size: 9px;
		color: var(--text-muted);
	}
	dl {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px 18px;
		margin: 0;
	}
	dl div {
		min-width: 0;
	}
	dl .wide {
		grid-column: span 2;
	}
	dt {
		margin-bottom: 3px;
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 10px/1.3 var(--font-mono);
		color: var(--text-secondary);
	}
	footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 12px;
		padding: 12px 14px;
		border-top: 1px solid var(--border);
	}
	footer p {
		margin-right: auto;
		font-size: 10px;
		color: var(--danger);
	}
	.clear {
		position: relative;
		height: 31px;
		min-width: 155px;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
		border-radius: 7px;
		background: var(--surface-0);
		color: var(--danger);
		cursor: pointer;
	}
	.clear:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.hold-fill {
		position: absolute;
		inset: 0 auto 0 0;
		width: 0;
		background: color-mix(in srgb, var(--danger) 18%, transparent);
	}
	.clear.holding .hold-fill {
		width: 100%;
		transition: width 1.2s linear;
	}
	.clear-label {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		font: 650 10px/1 var(--font-sans);
	}
	@media (max-width: 680px) {
		dl {
			grid-template-columns: 1fr 1fr;
		}
		dl .wide {
			grid-column: 1 / -1;
		}
	}
</style>
