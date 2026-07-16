<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		LanguageDescription,
		defaultHighlightStyle,
		syntaxHighlighting
	} from '@codemirror/language';
	import { languages } from '@codemirror/language-data';
	import { MergeView } from '@codemirror/merge';
	import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
	import {
		Decoration,
		EditorView,
		drawSelection,
		highlightActiveLine,
		highlightActiveLineGutter,
		keymap,
		lineNumbers,
		type DecorationSet
	} from '@codemirror/view';
	import { searchKeymap } from '@codemirror/search';
	import type { DiffFile, DiffHunk, FileContent } from '$lib/shared/types';

	export let file: DiffFile;
	export let content: FileContent;
	export let selectedHunkId: string | null = null;
	export let onSelectHunk: (hunk: DiffHunk, anchor: { x: number; y: number }) => void = () =>
		undefined;

	let container: HTMLDivElement;
	let mergeView: MergeView | undefined;
	let singleView: EditorView | undefined;
	let mountedKey = '';
	let currentFile = file;
	let lastSelected: string | null = null;
	let buildToken = 0;

	const setSelectedHunk = StateEffect.define<string | null>();

	$: currentFile = file;
	$: editorKey = `${file.id}:${file.oldHash ?? ''}:${file.newHash ?? ''}:${content.oldText.length}:${content.newText.length}`;
	$: if (container && editorKey !== mountedKey) void mountEditor(editorKey);
	$: if (selectedHunkId !== lastSelected) updateSelection(selectedHunkId);

	onMount(() => {
		void mountEditor(editorKey);
	});

	onDestroy(destroyEditor);

	function destroyEditor() {
		buildToken += 1;
		mergeView?.destroy();
		singleView?.destroy();
		mergeView = undefined;
		singleView = undefined;
		if (container) container.replaceChildren();
	}

	async function mountEditor(key: string) {
		const token = ++buildToken;
		mergeView?.destroy();
		singleView?.destroy();
		mergeView = undefined;
		singleView = undefined;
		container.replaceChildren();

		const language = await loadLanguage(file.path);
		if (token !== buildToken) return;
		mountedKey = key;
		lastSelected = selectedHunkId;
		if (file.status === 'unchanged') {
			singleView = new EditorView({
				parent: container,
				state: EditorState.create({
					doc: content.newText,
					extensions: commonExtensions(language, 'b')
				})
			});
		} else {
			mergeView = new MergeView({
				parent: container,
				a: { doc: content.oldText, extensions: commonExtensions(language, 'a') },
				b: { doc: content.newText, extensions: commonExtensions(language, 'b') },
				orientation: 'a-b',
				highlightChanges: true,
				gutter: true,
				diffConfig: { scanLimit: 10_000, timeout: 1_500 }
			});
		}
	}

	async function loadLanguage(filePath: string): Promise<Extension | null> {
		try {
			const description = LanguageDescription.matchFilename(languages, filePath);
			return description ? await description.load() : null;
		} catch {
			return null;
		}
	}

	function commonExtensions(language: Extension | null, side: 'a' | 'b'): Extension[] {
		return [
			lineNumbers(),
			highlightActiveLineGutter(),
			drawSelection(),
			highlightActiveLine(),
			EditorState.readOnly.of(true),
			EditorView.editable.of(false),
			keymap.of(searchKeymap),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			...(language ? [language] : []),
			hunkField(side),
			EditorView.domEventHandlers({
				click: (event, view) => {
					const hunk = hunkAtEvent(event, view, side);
					if (!hunk) return false;
					onSelectHunk(hunk, { x: event.clientX + 12, y: event.clientY + 12 });
					return false;
				}
			}),
			EditorView.theme({
				'&': { height: '100%', backgroundColor: 'transparent' },
				'.cm-scroller': {
					fontFamily: 'var(--font-mono)',
					fontSize: '12.5px',
					lineHeight: '1.65',
					overflow: 'auto'
				},
				'.cm-content': { padding: '12px 0 80px' },
				'.cm-gutters': {
					backgroundColor: 'var(--surface-1)',
					borderRight: '1px solid var(--border)'
				},
				'.cm-lineNumbers .cm-gutterElement': { minWidth: '42px', padding: '0 12px 0 6px' },
				'.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--cm-active)' },
				'.cm-git-hunk': {
					boxShadow: 'inset 2px 0 var(--accent-muted)',
					cursor: 'pointer'
				},
				'.cm-git-hunk-pending': { boxShadow: 'inset 2px 0 var(--warning)' },
				'.cm-git-hunk-selected': {
					backgroundColor: 'var(--selection-soft) !important',
					boxShadow: 'inset 3px 0 var(--accent)'
				}
			})
		];
	}

	function hunkField(side: 'a' | 'b') {
		return StateField.define<DecorationSet>({
			create: (state) => buildHunkDecorations(state, side, selectedHunkId),
			update: (decorations, transaction) => {
				let selected = lastSelected;
				for (const effect of transaction.effects)
					if (effect.is(setSelectedHunk)) selected = effect.value;
				return transaction.docChanged ||
					transaction.effects.some((effect) => effect.is(setSelectedHunk))
					? buildHunkDecorations(transaction.state, side, selected)
					: decorations.map(transaction.changes);
			},
			provide: (field) => EditorView.decorations.from(field)
		});
	}

	function buildHunkDecorations(
		state: EditorState,
		side: 'a' | 'b',
		selected: string | null
	): DecorationSet {
		const ranges = [];
		for (const hunk of currentFile.hunks) {
			const start = side === 'a' ? hunk.oldStart : hunk.newStart;
			const count = side === 'a' ? hunk.oldCount : hunk.newCount;
			if (!count || state.doc.lines === 0) continue;
			const first = Math.max(1, Math.min(state.doc.lines, start));
			const last = Math.max(first, Math.min(state.doc.lines, start + count - 1));
			const pending = hunk.analysis.state === 'queued' || hunk.analysis.state === 'running';
			const className = [
				'cm-git-hunk',
				pending ? 'cm-git-hunk-pending' : '',
				selected === hunk.id ? 'cm-git-hunk-selected' : ''
			]
				.filter(Boolean)
				.join(' ');
			for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
				ranges.push(
					Decoration.line({ class: className, attributes: { 'data-hunk-id': hunk.id } }).range(
						state.doc.line(lineNumber).from
					)
				);
			}
		}
		return Decoration.set(ranges, true);
	}

	function hunkAtEvent(event: MouseEvent, view: EditorView, side: 'a' | 'b'): DiffHunk | undefined {
		const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
		if (position === null) return undefined;
		const line = view.state.doc.lineAt(position).number;
		return currentFile.hunks.find((hunk) => {
			const start = side === 'a' ? hunk.oldStart : hunk.newStart;
			const count = side === 'a' ? hunk.oldCount : hunk.newCount;
			return count > 0 && line >= start && line < start + count;
		});
	}

	function updateSelection(value: string | null) {
		lastSelected = value;
		for (const view of [mergeView?.a, mergeView?.b, singleView]) {
			if (view) view.dispatch({ effects: setSelectedHunk.of(value) });
		}
	}

	export function revealHunk(hunkId: string, smooth = false) {
		const hunk = currentFile.hunks.find((candidate) => candidate.id === hunkId);
		if (!hunk) return;
		const view = hunk.newCount > 0 ? (mergeView?.b ?? singleView) : mergeView?.a;
		if (!view) return;
		const lineNumber = Math.max(
			1,
			Math.min(view.state.doc.lines, hunk.newCount > 0 ? hunk.newStart : hunk.oldStart)
		);
		const position = view.state.doc.line(lineNumber).from;
		const scrollElement = mergeView?.dom ?? view.scrollDOM;
		if (smooth) scrollElement.style.scrollBehavior = 'smooth';
		view.dispatch({
			selection: { anchor: position },
			effects: [
				setSelectedHunk.of(hunkId),
				EditorView.scrollIntoView(position, { y: 'center', yMargin: 120 })
			]
		});
		if (smooth) setTimeout(() => (scrollElement.style.scrollBehavior = ''), 500);
		view.focus();
	}

	export function revealLine(line: number) {
		const view = mergeView?.b ?? singleView ?? mergeView?.a;
		if (!view) return;
		const lineNumber = Math.max(1, Math.min(view.state.doc.lines, line));
		const position = view.state.doc.line(lineNumber).from;
		view.dispatch({
			selection: { anchor: position },
			effects: EditorView.scrollIntoView(position, { y: 'center' })
		});
		view.focus();
	}
</script>

<div class="diff-viewer" bind:this={container} aria-label={`Read-only diff for ${file.path}`}></div>

<style>
	.diff-viewer {
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background: var(--surface-0);
	}

	:global(.diff-viewer .cm-mergeView) {
		height: 100%;
		overflow: auto;
		background: var(--surface-0);
	}

	:global(.diff-viewer .cm-mergeViewEditors) {
		min-height: 100%;
	}

	:global(.diff-viewer .cm-mergeViewEditor) {
		min-width: 0;
	}

	:global(.diff-viewer .cm-mergeViewEditor:first-child) {
		border-right: 1px solid var(--border);
	}

	:global(.diff-viewer .cm-deletedChunk) {
		background: var(--diff-delete);
	}

	:global(.diff-viewer .cm-insertedChunk) {
		background: var(--diff-add);
	}

	:global(.diff-viewer .cm-deletedText) {
		background: var(--diff-delete-strong);
		text-decoration: none;
	}

	:global(.diff-viewer .cm-insertedText) {
		background: var(--diff-add-strong);
	}

	:global(.diff-viewer .cm-changeGutter) {
		width: 4px;
	}
</style>
