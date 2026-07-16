<script lang="ts">
	import { tick } from 'svelte';
	import {
		Braces,
		ChevronDown,
		ChevronRight,
		File,
		FileCode2,
		FileJson,
		FileText,
		Folder,
		FolderOpen
	} from '@lucide/svelte';
	import type { DiffFile, FileTreeNode } from '$lib/shared/types';

	export let reviewId: string;
	export let tree: FileTreeNode[];
	export let files: DiffFile[];
	export let selectedFileId: string | null = null;
	export let storyFileId: string | null = null;
	export let onOpen: (fileId: string) => void = () => undefined;

	type Row = { node: FileTreeNode; depth: number };
	let expanded = new Set<string>();
	let initializedReview = '';
	let fileMap = new Map<string, DiffFile>();

	$: fileMap = new Map(files.map((file) => [file.id, file]));
	$: if (reviewId !== initializedReview) initializeExpanded();
	$: rows = flatten(tree, expanded);

	function initializeExpanded() {
		initializedReview = reviewId;
		const next = new Set<string>();
		const visit = (nodes: FileTreeNode[], depth: number) => {
			for (const node of nodes) {
				if (node.type === 'directory' && depth < 2) next.add(node.id);
				if (node.children) visit(node.children, depth + 1);
			}
		};
		visit(tree, 0);
		expanded = next;
	}

	function flatten(nodes: FileTreeNode[], open: Set<string>, depth = 0, output: Row[] = []): Row[] {
		for (const node of nodes) {
			output.push({ node, depth });
			if (node.type === 'directory' && open.has(node.id) && node.children)
				flatten(node.children, open, depth + 1, output);
		}
		return output;
	}

	function activate(node: FileTreeNode) {
		if (node.type === 'directory') {
			const next = new Set(expanded);
			if (next.has(node.id)) next.delete(node.id);
			else next.add(node.id);
			expanded = next;
		} else if (node.fileId) onOpen(node.fileId);
	}

	export async function revealFile(fileId: string): Promise<void> {
		const ancestors: string[] = [];
		function find(nodes: FileTreeNode[], parents: string[]): boolean {
			for (const node of nodes) {
				if (node.fileId === fileId) {
					ancestors.push(...parents);
					return true;
				}
				if (
					node.type === 'directory' &&
					node.children &&
					find(node.children, [...parents, node.id])
				)
					return true;
			}
			return false;
		}
		if (!find(tree, [])) return;
		expanded = new Set([...expanded, ...ancestors]);
		await tick();
		const row = Array.from(container.querySelectorAll<HTMLElement>('[data-file-id]')).find(
			(element) => element.dataset.fileId === fileId
		);
		row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}

	let container: HTMLDivElement;

	function statusLetter(file: DiffFile | undefined): string {
		if (!file || file.status === 'unchanged') return '';
		return {
			added: 'A',
			deleted: 'D',
			modified: 'M',
			renamed: 'R',
			copied: 'C',
			'type-changed': 'T',
			unmerged: 'U'
		}[file.status];
	}

	function iconKind(name: string): 'code' | 'json' | 'text' | 'braces' | 'file' {
		const extension = name.split('.').pop()?.toLowerCase();
		if (
			['ts', 'tsx', 'js', 'jsx', 'svelte', 'vue', 'py', 'rb', 'go', 'rs', 'java', 'swift'].includes(
				extension ?? ''
			)
		)
			return 'code';
		if (['json', 'jsonc'].includes(extension ?? '')) return 'json';
		if (['css', 'scss', 'html', 'xml', 'yaml', 'yml', 'toml'].includes(extension ?? ''))
			return 'braces';
		if (['md', 'txt', 'rst'].includes(extension ?? '')) return 'text';
		return 'file';
	}
</script>

<div class="tree" bind:this={container} role="tree" aria-label="Project files">
	{#each rows as row (row.node.id)}
		{@const node = row.node}
		{@const file = node.fileId ? fileMap.get(node.fileId) : undefined}
		<button
			type="button"
			class:touched={file?.status !== undefined && file.status !== 'unchanged'}
			class:selected={node.fileId === selectedFileId}
			class:story={node.fileId === storyFileId}
			class:deleted={file?.status === 'deleted'}
			class="tree-row"
			style={`--depth: ${row.depth}`}
			role="treeitem"
			aria-selected={node.fileId === selectedFileId}
			aria-expanded={node.type === 'directory' ? expanded.has(node.id) : undefined}
			data-file-id={node.fileId}
			onclick={() => activate(node)}
			title={node.path}
		>
			<span class="chevron">
				{#if node.type === 'directory'}
					{#if expanded.has(node.id)}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
				{/if}
			</span>
			<span class="file-icon">
				{#if node.type === 'directory'}
					{#if expanded.has(node.id)}<FolderOpen size={15} />{:else}<Folder size={15} />{/if}
				{:else if iconKind(node.name) === 'code'}
					<FileCode2 size={15} />
				{:else if iconKind(node.name) === 'json'}
					<FileJson size={15} />
				{:else if iconKind(node.name) === 'text'}
					<FileText size={15} />
				{:else if iconKind(node.name) === 'braces'}
					<Braces size={15} />
				{:else}<File size={15} />{/if}
			</span>
			<span class="name">{node.name}</span>
			{#if file && file.status !== 'unchanged'}
				<span
					class:added={file.status === 'added'}
					class:removed={file.status === 'deleted'}
					class="status"
				>
					{statusLetter(file)}
				</span>
				<span
					class={`analysis ${file.overviewAnalysis.state}`}
					title={`AI: ${file.overviewAnalysis.state}`}
				></span>
			{/if}
		</button>
	{/each}
</div>

<style>
	.tree {
		padding: 6px 7px 20px;
		min-width: 220px;
	}

	.tree-row {
		width: 100%;
		height: 28px;
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 0 7px 0 calc(4px + var(--depth) * 14px);
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary);
		font: inherit;
		font-size: 12px;
		text-align: left;
		cursor: default;
	}

	.tree-row:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	.tree-row.touched {
		border-left-color: var(--warning);
		background: var(--warning-soft);
	}

	.tree-row.touched .name {
		font-weight: 600;
	}

	.tree-row.selected {
		background: var(--selection-soft);
		border-color: var(--selection-border);
		color: var(--text-primary);
	}

	.tree-row.touched.selected {
		border-left-color: var(--warning);
	}

	.tree-row.story {
		box-shadow: inset 3px 0 var(--accent);
		background: var(--story-soft);
		color: var(--text-primary);
	}

	.tree-row.deleted .name {
		text-decoration: line-through;
		opacity: 0.7;
	}

	.chevron {
		width: 13px;
		height: 15px;
		display: grid;
		place-items: center;
		color: var(--text-muted);
		flex: none;
	}

	.file-icon {
		display: grid;
		place-items: center;
		color: var(--icon);
		flex: none;
	}

	.name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}

	.status {
		font: 600 10px/1 var(--font-mono);
		color: var(--warning);
	}

	.status.added {
		color: var(--success);
	}

	.status.removed {
		color: var(--danger);
	}

	.analysis {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-muted);
		flex: none;
	}

	.analysis.ready,
	.analysis.cached {
		background: var(--success);
	}

	.analysis.running {
		background: var(--accent);
		box-shadow: 0 0 0 3px var(--selection-soft);
	}

	.analysis.queued {
		background: var(--warning);
	}

	.analysis.failed {
		background: var(--danger);
	}
</style>
