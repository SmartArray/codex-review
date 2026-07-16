<script lang="ts">
	import { FileCode2, Search, X } from '@lucide/svelte';
	import { onMount, tick } from 'svelte';
	import { fileMatchScore } from './file-palette';
	import type { DiffFile } from '$lib/shared/types';

	export let files: DiffFile[];
	export let onSelect: (fileId: string) => void = () => undefined;
	export let onPreview: (fileId: string) => void = () => undefined;
	export let onClose: () => void = () => undefined;

	let query = '';
	let input: HTMLInputElement;
	let results: HTMLDivElement;
	let activeIndex = 0;
	$: normalizedQuery = query.trim();
	$: matches = files
		.map((file) => ({ file, score: fileMatchScore(file.path, normalizedQuery) }))
		.filter((item) => item.score >= 0)
		.sort(
			(left, right) =>
				(normalizedQuery
					? right.score - left.score
					: Number(isChanged(right.file)) - Number(isChanged(left.file))) ||
				left.file.path.localeCompare(right.file.path)
		)
		.slice(0, 100);

	onMount(() => input?.focus());

	function isChanged(file: DiffFile): boolean {
		return file.status !== 'unchanged';
	}

	async function queryChanged() {
		activeIndex = 0;
		await tick();
		previewActive();
	}

	async function moveActive(direction: -1 | 1) {
		if (!matches.length) return;
		activeIndex = Math.max(0, Math.min(matches.length - 1, activeIndex + direction));
		await tick();
		results
			?.querySelector<HTMLElement>('[data-active="true"]')
			?.scrollIntoView({ block: 'nearest' });
		previewActive();
	}

	function previewActive() {
		const active = matches[activeIndex];
		if (active) onPreview(active.file.id);
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopPropagation();
			void moveActive(event.key === 'ArrowDown' ? 1 : -1);
			return;
		}
		if (event.key === 'Enter' && matches[activeIndex]) {
			event.preventDefault();
			event.stopPropagation();
			onSelect(matches[activeIndex].file.id);
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onClose();
		}
	}
</script>

<div
	class="backdrop"
	role="presentation"
	onclick={(event) => event.target === event.currentTarget && onClose()}
>
	<div class="palette" role="dialog" aria-modal="true" aria-label="Open file">
		<div class="search-row">
			<Search size={18} />
			<input
				bind:this={input}
				bind:value={query}
				oninput={() => void queryChanged()}
				onkeydown={keydown}
				placeholder="Go to file…"
				aria-label="File name"
			/>
			<kbd>⌘P</kbd>
			<button type="button" onclick={onClose} aria-label="Close"><X size={15} /></button>
		</div>
		<div class="results" bind:this={results}>
			{#each matches as item, index (item.file.id)}
				<button
					type="button"
					class:active={index === activeIndex}
					class:changed={isChanged(item.file)}
					class:added={item.file.status === 'added'}
					data-active={index === activeIndex}
					onclick={() => onSelect(item.file.id)}
				>
					<FileCode2 size={14} />
					{#if isChanged(item.file)}<i class="change-dot" aria-hidden="true"></i>{/if}
					<span class="filename">{item.file.path}</span>
					{#if isChanged(item.file)}<em>{item.file.status}</em>{/if}
				</button>
			{:else}
				<div class="empty">No matching file</div>
			{/each}
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 120;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: min(18vh, 160px);
		background: color-mix(in srgb, var(--surface-0) 22%, transparent);
		backdrop-filter: blur(1px);
	}

	.palette {
		width: min(640px, calc(100vw - 40px));
		border: 1px solid var(--border-strong);
		border-radius: 13px;
		background: var(--surface-2);
		box-shadow: var(--shadow-xl);
		overflow: hidden;
	}

	.search-row {
		height: 54px;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 14px;
		border-bottom: 1px solid var(--border);
		color: var(--text-muted);
	}

	input {
		flex: 1;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--text-primary);
		font: 14px/1.2 var(--font-sans);
	}

	kbd {
		padding: 3px 6px;
		border: 1px solid var(--border);
		border-radius: 5px;
		font: 10px/1 var(--font-mono);
	}

	.search-row button {
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		border: 0;
		background: transparent;
		color: var(--text-muted);
	}

	.results {
		max-height: min(440px, 60vh);
		overflow: auto;
		padding: 7px;
	}

	.results button {
		width: 100%;
		height: 34px;
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 0 10px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary);
		font: 12px/1 var(--font-mono);
		text-align: left;
		cursor: pointer;
	}

	.results button:hover,
	.results button.active {
		background: var(--selection-soft);
		color: var(--text-primary);
	}

	.results button .filename {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.results button.changed .filename {
		font-weight: 700;
		color: var(--text-primary);
	}

	.change-dot {
		width: 6px;
		height: 6px;
		flex: none;
		border-radius: 50%;
		background: var(--warning);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--warning) 14%, transparent);
	}

	.results button.added .change-dot {
		background: var(--success);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--success) 14%, transparent);
	}

	.results em {
		font: 600 9px/1 var(--font-sans);
		color: var(--warning);
		font-style: normal;
	}

	.results button.added em {
		color: var(--success);
	}

	.empty {
		padding: 30px;
		text-align: center;
		font-size: 12px;
		color: var(--text-muted);
	}
</style>
