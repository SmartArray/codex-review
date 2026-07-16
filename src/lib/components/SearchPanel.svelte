<script lang="ts">
	import { CaseSensitive, FileSearch, LoaderCircle, Regex, WholeWord, X } from '@lucide/svelte';
	import { onDestroy, onMount } from 'svelte';
	import type { SearchOptions, SearchResponse, SearchResult } from '$lib/shared/types';

	export let response: SearchResponse | null = null;
	export let busy = false;
	export let onSearch: (options: SearchOptions) => void = () => undefined;
	export let onSelect: (result: SearchResult) => void = () => undefined;
	export let onClose: () => void = () => undefined;

	let query = '';
	let caseSensitive = false;
	let wholeWord = false;
	let regex = false;
	let diffOnly = false;
	let input: HTMLInputElement;
	let debounce: ReturnType<typeof setTimeout> | undefined;

	$: options = {
		query,
		caseSensitive,
		wholeWord,
		regex,
		diffOnly,
		page: 0,
		pageSize: 200
	} satisfies SearchOptions;
	$: groups = groupResults(response?.results ?? []);
	$: scheduleSearch(options);

	onMount(() => input.focus());
	onDestroy(() => debounce && clearTimeout(debounce));

	function scheduleSearch(value: SearchOptions) {
		if (debounce) clearTimeout(debounce);
		if (!value.query) return;
		debounce = setTimeout(() => onSearch(value), 220);
	}

	function groupResults(results: SearchResult[]): Array<{ path: string; values: SearchResult[] }> {
		const map = new Map<string, SearchResult[]>();
		for (const result of results) {
			const values = map.get(result.path) ?? [];
			values.push(result);
			map.set(result.path, values);
		}
		return [...map].map(([path, values]) => ({ path, values }));
	}
</script>

<aside class="search-panel" aria-label="Search project">
	<header>
		<div><FileSearch size={15} /><strong>Search</strong></div>
		<button type="button" onclick={onClose} aria-label="Close search"><X size={15} /></button>
	</header>
	<div class="query-row">
		<input
			bind:this={input}
			bind:value={query}
			placeholder="Search tracked files…"
			aria-label="Search query"
		/>
		{#if busy}<span class="spin"><LoaderCircle size={14} /></span>{/if}
	</div>
	<div class="toggles">
		<button
			type="button"
			class:active={caseSensitive}
			onclick={() => (caseSensitive = !caseSensitive)}
			title="Match case"><CaseSensitive size={15} /></button
		>
		<button
			type="button"
			class:active={wholeWord}
			onclick={() => (wholeWord = !wholeWord)}
			title="Whole word"><WholeWord size={15} /></button
		>
		<button
			type="button"
			class:active={regex}
			onclick={() => (regex = !regex)}
			title="Regular expression"><Regex size={15} /></button
		>
		<label><input type="checkbox" bind:checked={diffOnly} /> Search only in diff</label>
	</div>
	<div class="summary">
		{#if response?.error}<span class="error">{response.error}</span>
		{:else if query && response}<span>{response.total.toLocaleString()} matches</span>
		{:else}<span>Literal search across the new snapshot</span>{/if}
	</div>
	<div class="results">
		{#if groups.length}
			{#each groups as group (group.path)}
				<section>
					<h3>{group.path}<span>{group.values.length}</span></h3>
					{#each group.values as result (result.line + ':' + result.column)}
						<button type="button" onclick={() => onSelect(result)}>
							<code>{result.line}:{result.column}</code>
							<span>{result.snippet || ' '}</span>
						</button>
					{/each}
				</section>
			{/each}
		{:else if query && !busy}
			<div class="empty">No matches in the selected scope</div>
		{/if}
	</div>
</aside>

<style>
	.search-panel {
		position: absolute;
		z-index: 35;
		top: 0;
		left: 0;
		bottom: 0;
		width: min(410px, 42vw);
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border-strong);
		background: color-mix(in srgb, var(--surface-1) 97%, transparent);
		box-shadow: var(--shadow-lg);
		backdrop-filter: blur(18px);
	}

	header {
		height: 42px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 12px;
		border-bottom: 1px solid var(--border);
	}

	header div {
		display: flex;
		align-items: center;
		gap: 7px;
	}

	header strong {
		font-size: 11px;
	}

	header button,
	.toggles button {
		display: grid;
		place-items: center;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.query-row {
		height: 48px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 10px;
	}

	.query-row input {
		width: 100%;
		height: 33px;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		outline: none;
		background: var(--surface-0);
		color: var(--text-primary);
		font: 11px/1 var(--font-mono);
	}

	.query-row input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--selection-soft);
	}

	.toggles {
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 0 10px 8px;
		border-bottom: 1px solid var(--border);
	}

	.toggles button {
		width: 27px;
		height: 25px;
		border-radius: 5px;
	}

	.toggles button:hover,
	.toggles button.active {
		background: var(--selection-soft);
		color: var(--accent-text);
	}

	.toggles label {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 9px;
		color: var(--text-secondary);
	}

	.summary {
		padding: 7px 12px;
		font-size: 9px;
		color: var(--text-muted);
		background: var(--surface-0);
	}

	.summary .error {
		color: var(--danger);
	}

	.results {
		flex: 1;
		overflow: auto;
		padding-bottom: 30px;
	}

	.results section h3 {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		justify-content: space-between;
		margin: 0;
		padding: 9px 11px 5px;
		background: var(--surface-1);
		font: 600 10px/1.2 var(--font-mono);
		color: var(--text-secondary);
	}

	.results section h3 span {
		color: var(--text-muted);
	}

	.results section button {
		width: 100%;
		display: grid;
		grid-template-columns: 48px 1fr;
		gap: 7px;
		padding: 6px 11px;
		border: 0;
		background: transparent;
		color: var(--text-secondary);
		text-align: left;
		cursor: pointer;
	}

	.results section button:hover {
		background: var(--selection-soft);
	}

	.results code {
		font: 9px/1.4 var(--font-mono);
		color: var(--accent-text);
	}

	.results section button span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 10px/1.4 var(--font-mono);
	}

	.empty {
		padding: 35px 20px;
		text-align: center;
		font-size: 11px;
		color: var(--text-muted);
	}

	.spin {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
