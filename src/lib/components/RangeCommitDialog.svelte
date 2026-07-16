<script lang="ts">
	import { Check, GitCommitHorizontal, LoaderCircle, RotateCcw, X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { RangeReviewState } from '$lib/shared/types';

	export let state: RangeReviewState;
	export let openingId: string | null = null;
	export let onOpen: (itemId: string) => Promise<void> = async () => undefined;
	export let onReviewed: (itemId: string, reviewed: boolean) => Promise<void> = async () =>
		undefined;
	export let onClose: () => void = () => undefined;

	let dialog: HTMLDialogElement;
	let updating = new Set<string>();
	let error = '';

	onMount(() => dialog.showModal());

	async function updateReviewed(itemId: string, reviewed: boolean): Promise<void> {
		if (updating.has(itemId)) return;
		error = '';
		updating = new Set([...updating, itemId]);
		try {
			await onReviewed(itemId, reviewed);
		} catch (value) {
			error = value instanceof Error ? value.message : 'Could not update the reviewed state.';
		} finally {
			updating.delete(itemId);
			updating = new Set(updating);
		}
	}
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="range-commits-title"
	onclose={onClose}
	oncancel={(event) => {
		event.preventDefault();
		onClose();
	}}
	onclick={(event) => {
		if (event.target === dialog && !openingId) dialog.close();
	}}
>
	<header>
		<div class="heading-icon"><GitCommitHorizontal size={18} /></div>
		<div>
			<small>Range review</small>
			<h2 id="range-commits-title">Commits</h2>
			<p>{state.reviewedCount} of {state.totalCount} reviewed · oldest first</p>
		</div>
		<div class="header-actions">
			{#if state.activeItemId !== 'aggregate'}
				<button
					type="button"
					class="aggregate"
					disabled={Boolean(openingId)}
					onclick={() => onOpen('aggregate')}
				>
					{#if openingId === 'aggregate'}<LoaderCircle class="spin" size={13} />{:else}<RotateCcw
							size={13}
						/>{/if}
					View full range
				</button>
			{/if}
			<button
				type="button"
				class="close"
				disabled={Boolean(openingId)}
				aria-label="Close commits"
				onclick={() => dialog.close()}><X size={17} /></button
			>
		</div>
	</header>

	{#if error}<div class="error" role="alert">{error}</div>{/if}
	<div class="commit-list">
		{#if state.items.length === 0}
			<div class="empty">
				<GitCommitHorizontal size={22} /> No commits or working changes in this range.
			</div>
		{:else}
			{#each state.items as item, index (item.id)}
				<div
					class="commit-row"
					class:active={state.activeItemId === item.id}
					class:reviewed={item.reviewed}
				>
					<button
						type="button"
						class="commit-content"
						disabled={Boolean(openingId)}
						onclick={() => onOpen(item.id)}
					>
						<div class="rail">
							<span class="dot"
								>{#if openingId === item.id}<LoaderCircle
										class="spin"
										size={12}
									/>{:else}<GitCommitHorizontal size={12} />{/if}</span
							>
							{#if index < state.items.length - 1}<span class="line"></span>{/if}
						</div>
						<div class="details">
							<div class="title-row">
								<strong>{item.title}</strong>
								{#if item.commitHash}<code>{item.commitHash.slice(0, 8)}</code>{/if}
								{#if state.activeItemId === item.id}<em>Open</em>{/if}
							</div>
							<p>{item.description}</p>
						</div>
					</button>
					<label
						class="review-toggle"
						title={item.reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
					>
						<input
							type="checkbox"
							checked={item.reviewed}
							disabled={updating.has(item.id)}
							onchange={(event) => updateReviewed(item.id, event.currentTarget.checked)}
						/>
						<span
							>{#if updating.has(item.id)}<LoaderCircle class="spin" size={13} />{:else}<Check
									size={14}
								/>{/if}</span
						>
						<span class="sr-only"
							>{item.reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}: {item.title}</span
						>
					</label>
				</div>
			{/each}
		{/if}
	</div>
</dialog>

<style>
	dialog {
		width: min(780px, calc(100vw - 48px));
		max-height: min(800px, calc(100vh - 64px));
		margin: auto;
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--border-strong);
		border-radius: 16px;
		background: color-mix(in srgb, var(--surface-1) 97%, transparent);
		color: var(--text-primary);
		box-shadow: var(--shadow-xl);
	}
	dialog::backdrop {
		background: color-mix(in srgb, var(--surface-0) 64%, transparent);
		backdrop-filter: blur(16px);
	}
	header {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 18px 20px;
		border-bottom: 1px solid var(--border);
	}
	.heading-icon {
		width: 35px;
		height: 35px;
		display: grid;
		place-items: center;
		flex: none;
		border-radius: 9px;
		background: var(--selection-soft);
		color: var(--accent-text);
	}
	header small {
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--accent-text);
	}
	h2,
	p {
		margin: 0;
	}
	h2 {
		margin-top: 2px;
		font-size: 16px;
	}
	header p {
		margin-top: 3px;
		font-size: 10px;
		color: var(--text-secondary);
	}
	.header-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.aggregate,
	.close {
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}
	.aggregate {
		height: 31px;
		gap: 6px;
		padding: 0 10px;
		font: 600 10px/1 inherit;
	}
	.close {
		width: 31px;
		height: 31px;
		border-color: transparent;
	}
	.aggregate:hover:not(:disabled),
	.close:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-primary);
	}
	.error {
		margin: 12px 14px 0;
		padding: 9px 11px;
		border-radius: 7px;
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 11px;
	}
	.commit-list {
		max-height: min(650px, calc(100vh - 180px));
		padding: 12px 14px 16px;
		overflow: auto;
	}
	.empty {
		min-height: 190px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		color: var(--text-secondary);
		font-size: 12px;
	}
	.commit-row {
		display: flex;
		align-items: stretch;
		border: 1px solid transparent;
		border-radius: 10px;
		transition:
			background 120ms ease,
			border-color 120ms ease;
	}
	.commit-row:hover {
		background: var(--surface-hover);
	}
	.commit-row.active {
		border-color: var(--selection-border);
		background: var(--selection-soft);
	}
	.commit-row.reviewed:not(.active) {
		background: color-mix(in srgb, var(--success) 10%, transparent);
	}
	.commit-content {
		min-width: 0;
		flex: 1;
		display: flex;
		align-items: stretch;
		padding: 11px 8px 11px 10px;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}
	.rail {
		width: 29px;
		position: relative;
		display: flex;
		justify-content: center;
		flex: none;
	}
	.dot {
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		position: relative;
		z-index: 1;
		border: 1px solid var(--border-strong);
		border-radius: 50%;
		background: var(--surface-2);
		color: var(--accent-text);
	}
	.line {
		width: 1px;
		position: absolute;
		top: 22px;
		bottom: -23px;
		background: var(--border-strong);
	}
	.details {
		min-width: 0;
		flex: 1;
		padding: 2px 8px 0;
	}
	.title-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.title-row strong {
		font-size: 12px;
	}
	.title-row code {
		font: 9px/1 var(--font-mono);
		color: var(--text-secondary);
	}
	.title-row em {
		margin-left: auto;
		font: 700 8px/1 var(--font-sans);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--accent-text);
	}
	.details p {
		margin-top: 5px;
		white-space: pre-wrap;
		font-size: 10.5px;
		line-height: 1.45;
		color: var(--text-secondary);
	}
	.review-toggle {
		width: 48px;
		position: relative;
		display: grid;
		place-items: center;
		flex: none;
		cursor: pointer;
	}
	.review-toggle input {
		position: absolute;
		width: 25px;
		height: 25px;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.review-toggle > span:not(.sr-only) {
		width: 25px;
		height: 25px;
		display: grid;
		place-items: center;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--surface-1);
		color: transparent;
		pointer-events: none;
		transition:
			background 120ms ease,
			border-color 120ms ease,
			color 120ms ease;
	}
	.review-toggle input:focus-visible + span {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.review-toggle input:checked + span {
		border-color: color-mix(in srgb, var(--success) 70%, var(--border));
		background: var(--success);
		color: white;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	:global(.spin) {
		animation: spin 1s linear infinite;
	}
	button:disabled,
	input:disabled + span {
		opacity: 0.6;
		cursor: wait;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
