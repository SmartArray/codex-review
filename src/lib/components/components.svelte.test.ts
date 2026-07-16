import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import FilePalette from './FilePalette.svelte';
import FileTree from './FileTree.svelte';
import HunkPopover from './HunkPopover.svelte';
import ProgressControl from './ProgressControl.svelte';
import RangeCommitDialog from './RangeCommitDialog.svelte';
import ReviewHistoryDialog from './ReviewHistoryDialog.svelte';
import SetupScreen from './SetupScreen.svelte';
import StatusBar from './StatusBar.svelte';
import type {
	DiffFile,
	DiffHunk,
	FileTreeNode,
	RangeReviewState,
	ReviewApi
} from '$lib/shared/types';

beforeEach(() => {
	const api = {
		getReviewHistory: async () => [],
		clearReviewHistory: async () => undefined,
		getSpeechSettings: async () => ({
			engine: 'kokoro' as const,
			voice: 'am_michael' as const,
			speed: 1
		}),
		getKokoroModelStatus: async () => ({ state: 'ready' as const }),
		getSiriStatus: async () => ({ visible: false, available: false }),
		getVoiceboxStatus: async () => ({ available: false, profiles: [] }),
		isSpeechCached: async () => false,
		onSpeechEvent: () => () => undefined
	} as unknown as ReviewApi;
	Object.defineProperty(window, 'reviewApi', { configurable: true, writable: true, value: api });
});

const hunk: DiffHunk = {
	id: 'hunk-1',
	fileId: 'file-1',
	index: 0,
	header: '@@ -1 +1 @@',
	oldStart: 1,
	oldCount: 1,
	newStart: 1,
	newCount: 1,
	lines: [],
	canonicalPatch: '@@ -1 +1 @@\n-old\n+new',
	hash: 'hash',
	analysis: { state: 'queued', queuePosition: 2 }
};

describe('review components', () => {
	it('opens range commits independently from their reviewed toggles', async () => {
		const open = vi.fn(async () => undefined);
		const reviewed = vi.fn(async () => undefined);
		const state: RangeReviewState = {
			activeItemId: 'aggregate',
			reviewedCount: 1,
			totalCount: 2,
			items: [
				{
					id: 'a'.repeat(40),
					kind: 'commit',
					commitHash: 'a'.repeat(40),
					title: 'First commit',
					description: 'The commit description.',
					reviewed: false
				},
				{
					id: 'working-tree:fingerprint',
					kind: 'working-tree',
					title: 'Working changes',
					description: 'Tracked changes after HEAD.',
					reviewed: true
				}
			]
		};
		const screen = render(RangeCommitDialog, { state, onOpen: open, onReviewed: reviewed });

		await expect.element(screen.getByText('The commit description.')).toBeVisible();
		await screen.getByRole('checkbox', { name: /Mark as reviewed: First commit/ }).click();
		expect(reviewed).toHaveBeenCalledWith('a'.repeat(40), true);
		expect(open).not.toHaveBeenCalled();

		await screen.getByRole('button', { name: /First commit/ }).click();
		expect(open).toHaveBeenCalledWith('a'.repeat(40));
		await expect
			.element(screen.getByRole('checkbox', { name: /Mark as not reviewed: Working changes/ }))
			.toBeChecked();
	});

	it('puts changed files first in an empty file palette and marks them consistently', async () => {
		const select = vi.fn();
		const changed = makeFile('changed', 'z-changed.ts', 'modified');
		const added = makeFile('added', 'y-added.ts', 'added');
		const stable = makeFile('stable', 'a-stable.ts', 'unchanged');
		const screen = render(FilePalette, { files: [stable, changed, added], onSelect: select });

		const changedRow = screen.getByRole('button', { name: /z-changed\.ts modified/ });
		await expect.element(changedRow).toHaveClass(/changed/);
		await expect
			.element(screen.getByRole('button', { name: /y-added\.ts added/ }))
			.toHaveClass(/added/);
		await expect.element(screen.getByText('z-changed.ts')).toHaveClass(/filename/);
		await screen.getByLabelText('File name').click();
		await userEvent.keyboard('{Enter}');
		expect(select).toHaveBeenCalledWith(added.id);
	});

	it('previews query and arrow-key selections but not mouse hover', async () => {
		const preview = vi.fn();
		const close = vi.fn();
		const changed = makeFile('changed', 'z-changed.ts', 'modified');
		const added = makeFile('added', 'y-added.ts', 'added');
		const stable = makeFile('stable', 'a-stable.ts', 'unchanged');
		const screen = render(FilePalette, {
			files: [stable, changed, added],
			onPreview: preview,
			onClose: close
		});
		const input = screen.getByLabelText('File name');

		await userEvent.hover(screen.getByRole('button', { name: /z-changed\.ts modified/ }));
		expect(preview).not.toHaveBeenCalled();

		await input.click();
		await userEvent.keyboard('{ArrowDown}');
		expect(preview).toHaveBeenLastCalledWith(changed.id);

		await input.fill('stable');
		await expect.element(screen.getByText('a-stable.ts')).toBeVisible();
		expect(preview).toHaveBeenLastCalledWith(stable.id);

		await userEvent.keyboard('{Escape}');
		expect(close).toHaveBeenCalledOnce();
	});

	it('prefers matching case in file searches without excluding other casing', async () => {
		const select = vi.fn();
		const upper = makeFile('upper', 'src/App.ts', 'unchanged');
		const lower = makeFile('lower', 'src/app.ts', 'unchanged');
		const screen = render(FilePalette, { files: [lower, upper], onSelect: select });
		const input = screen.getByLabelText('File name');

		await input.fill('App');
		await expect.element(screen.getByText('src/app.ts', { exact: true })).toBeVisible();
		await userEvent.keyboard('{Enter}');
		expect(select).toHaveBeenLastCalledWith(upper.id);

		await input.fill('app');
		await expect.element(screen.getByText('src/App.ts', { exact: true })).toBeVisible();
		await userEvent.keyboard('{Enter}');
		expect(select).toHaveBeenLastCalledWith(lower.id);
	});

	it('defaults the editable model picker and exposes predefined choices', async () => {
		const screen = render(SetupScreen);
		const model = screen.getByRole('combobox', { name: 'Analysis model' });
		await expect.element(model).toHaveValue('gpt-5.4-mini');

		await screen.getByRole('button', { name: 'Choose a predefined model' }).click();
		await expect.element(screen.getByRole('option', { name: 'gpt-5.3-codex' })).toBeVisible();

		await model.fill('custom-fast-model');
		await expect.element(model).toHaveValue('custom-fast-model');
	});

	it('starts from either a session or a new context message', async () => {
		const validate = vi.fn();
		const screen = render(SetupScreen, {
			initial: { root: '/repo', revision: 'HEAD' },
			onValidate: validate
		});
		await screen.getByRole('radio', { name: 'New context message' }).click();
		await screen.getByRole('textbox', { name: 'Context message' }).fill('Focus on compatibility.');
		await screen.getByRole('button', { name: /Preview comparison/ }).click();
		expect(validate).toHaveBeenCalledWith(
			expect.objectContaining({
				root: '/repo',
				revision: 'HEAD',
				contextMessage: 'Focus on compatibility.'
			})
		);
		expect(validate.mock.calls[0][0]).not.toHaveProperty('sessionId');
	});

	it('offers session compaction only for an existing session', async () => {
		const validate = vi.fn();
		const screen = render(SetupScreen, {
			initial: { root: '/repo', revision: 'HEAD', sessionId: 'session-1' },
			onValidate: validate
		});
		const compact = screen.getByRole('checkbox', {
			name: /Compact session before analysis/
		});
		await expect.element(compact).not.toBeChecked();
		await compact.click();
		await screen.getByRole('button', { name: /Preview comparison/ }).click();
		expect(validate).toHaveBeenCalledWith(expect.objectContaining({ compactSession: true }));

		await screen.getByRole('radio', { name: 'New context message' }).click();
		await expect.element(compact).not.toBeInTheDocument();
	});

	it('restores a recent review into the setup form without submitting it', async () => {
		const validate = vi.fn();
		const clear = vi.fn(async () => undefined);
		const api = window.reviewApi as unknown as Record<string, unknown>;
		api.getReviewHistory = async () => [
			{
				id: 'history-1',
				lastOpenedAt: '2026-07-15T12:00:00.000Z',
				config: {
					root: '/projects/auralis',
					revision: 'feature/history',
					mode: 'range' as const,
					model: 'gpt-5.3-codex',
					contextMessage: 'Focus on the startup flow.',
					detailLevel: 4,
					fullPreparation: true,
					compactSession: false
				}
			}
		];
		api.clearReviewHistory = clear;

		const screen = render(SetupScreen, { onValidate: validate });
		await screen.getByRole('button', { name: 'Open recent reviews' }).click();
		await expect.element(screen.getByRole('dialog', { name: 'Recent reviews' })).toBeVisible();
		await expect.element(screen.getByText('feature/history')).toBeVisible();
		await screen.getByRole('button', { name: /projects\/auralis/ }).click();

		await expect
			.element(screen.getByRole('textbox', { name: 'Root directory' }))
			.toHaveValue('/projects/auralis');
		await expect
			.element(screen.getByRole('textbox', { name: 'Git revision' }))
			.toHaveValue('feature/history');
		await expect
			.element(screen.getByRole('combobox', { name: 'Comparison mode' }))
			.toHaveValue('range');
		await expect
			.element(screen.getByRole('combobox', { name: 'Analysis model' }))
			.toHaveValue('gpt-5.3-codex');
		await expect.element(screen.getByRole('radio', { name: 'New context message' })).toBeChecked();
		await expect
			.element(screen.getByRole('textbox', { name: 'Context message' }))
			.toHaveValue('Focus on the startup flow.');
		await expect
			.element(screen.getByLabelText('Explanation size', { exact: true }))
			.toHaveValue('4');
		expect(validate).not.toHaveBeenCalled();
	});

	it('requires a long press before clearing review history', async () => {
		const clear = vi.fn(async () => undefined);
		const entry = {
			id: 'history-1',
			lastOpenedAt: '2026-07-15T12:00:00.000Z',
			config: {
				root: '/repo',
				revision: 'HEAD',
				sessionId: 'session-1',
				mode: 'commit' as const,
				model: 'gpt-5.4-mini',
				detailLevel: 2,
				fullPreparation: false,
				compactSession: false
			}
		};
		const screen = render(ReviewHistoryDialog, { entries: [entry], onClear: clear });
		await expect
			.element(screen.getByRole('button', { name: 'Hold to clear all review history' }))
			.toBeVisible();
		const button = document.querySelector<HTMLButtonElement>(
			'button[aria-label="Hold to clear all review history"]'
		)!;

		button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		expect(clear).not.toHaveBeenCalled();

		button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 1250));
		expect(clear).toHaveBeenCalledOnce();
	});

	it('shows aggregate Codex token usage in the bottom status presentation', async () => {
		const screen = render(StatusBar, {
			usage: {
				invocationCount: 3,
				inputTokens: 12_000,
				cachedInputTokens: 8_000,
				outputTokens: 1_500,
				reasoningOutputTokens: 900,
				totalTokens: 13_500
			}
		});
		await expect
			.element(
				screen.getByLabelText('Codex tokens used: 12,000 input, 1,500 output, across 3 calls')
			)
			.toBeVisible();
		await expect.element(screen.getByText('13,500')).not.toBeInTheDocument();
		await expect.element(screen.getByText('12,000')).toBeVisible();
		await expect.element(screen.getByText('1,500')).toBeVisible();
	});

	it('morphs completed progress into the Story Mode button', async () => {
		const enter = vi.fn();
		const screen = render(ProgressControl, {
			progress: { phase: 'complete', completed: 1, total: 1, label: 'Story Mode' },
			story: { active: false },
			onEnterStory: enter
		});
		await screen.getByRole('button', { name: 'Story Mode' }).click();
		expect(enter).toHaveBeenCalledOnce();
	});

	it('opens live preparation steps from the overview progress control', async () => {
		const screen = render(ProgressControl, {
			progress: { phase: 'overview', completed: 2, total: 5, label: 'Preparing overview (2/5)' },
			story: { active: false }
		});
		await screen
			.getByRole('button', { name: /Preparing overview.*Show review preparation steps/ })
			.click();
		await expect
			.element(screen.getByRole('dialog', { name: 'Preparing overview (2/5)' }))
			.toBeVisible();
		await expect.element(screen.getByText('2 of 5 complete')).toBeVisible();
		await expect.element(screen.getByText('Prepare file overviews')).toBeVisible();
	});

	it('shows queue state and then a structured hunk explanation', async () => {
		const screen = render(HunkPopover, { props: { hunk, anchor: { x: 10, y: 10 }, pinned: true } });
		await expect.element(screen.getByText('Queue position 2')).toBeVisible();
		await screen.rerender({
			hunk: {
				...hunk,
				analysis: { state: 'ready' },
				explanation: {
					title: 'Use the `newValue`',
					summary: 'This replaces `oldValue` while preserving the surrounding flow.',
					expandedExplanation: 'A detailed explanation of `newDetail`.'
				}
			},
			anchor: { x: 10, y: 10 },
			pinned: false
		});
		await expect.element(screen.getByText('newValue')).toHaveClass(/inline-code/);
		await expect.element(screen.getByText('newDetail')).toHaveClass(/inline-code/);
		await expect.element(screen.getByText('oldValue')).not.toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: /Expand explanation/ }))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: /Ask about this hunk/ }))
			.not.toBeInTheDocument();

		await screen.rerender({
			hunk: {
				...hunk,
				analysis: { state: 'ready' },
				explanation: {
					title: 'Use the new value',
					summary: 'This replaces the old value while preserving the surrounding flow.',
					expandedExplanation: 'A detailed explanation.'
				}
			},
			anchor: { x: 10, y: 10 },
			pinned: true
		});
		await expect
			.element(screen.getByRole('button', { name: /Expand explanation/ }))
			.not.toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /Ask about this hunk/ })).toBeVisible();
		await expect
			.element(screen.getByLabelText('Hunk explanation', { exact: true }))
			.not.toHaveClass(/translucent/);
		await screen.rerender({
			hunk: {
				...hunk,
				analysis: { state: 'ready' },
				explanation: {
					title: 'Use the new value',
					summary: 'This replaces the old value while preserving the surrounding flow.',
					expandedExplanation: 'A detailed explanation.'
				}
			},
			anchor: { x: 10, y: 10 },
			pinned: true,
			translucent: true
		});
		await expect
			.element(screen.getByLabelText('Hunk explanation', { exact: true }))
			.toHaveClass(/translucent/);
	});

	it('renders change and AI states in the full file tree', async () => {
		const file: DiffFile = {
			id: 'file-1',
			path: 'src/app.ts',
			oldPath: 'src/app.ts',
			newPath: 'src/app.ts',
			status: 'modified',
			language: 'TypeScript',
			binary: false,
			submodule: false,
			generated: false,
			oldSize: 1,
			newSize: 1,
			patchLineCount: 2,
			hunks: [hunk],
			overviewAnalysis: { state: 'running' }
		};
		const tree: FileTreeNode[] = [
			{
				id: 'dir-src',
				name: 'src',
				path: 'src',
				type: 'directory',
				children: [
					{ id: 'tree-file-1', name: 'app.ts', path: 'src/app.ts', type: 'file', fileId: file.id }
				]
			}
		];
		const screen = render(FileTree, {
			reviewId: 'review',
			tree,
			files: [file],
			selectedFileId: file.id
		});
		const changedFile = screen.getByRole('treeitem', { name: /app.ts/ });
		await expect.element(changedFile).toBeVisible();
		await expect.element(changedFile).toHaveClass(/touched/);
		await expect.element(screen.getByText('M')).toBeVisible();
	});
});

function makeFile(id: string, path: string, status: DiffFile['status']): DiffFile {
	return {
		id,
		path,
		status,
		language: 'TypeScript',
		binary: false,
		submodule: false,
		generated: false,
		oldSize: 1,
		newSize: 1,
		patchLineCount: status === 'unchanged' ? 0 : 2,
		hunks: [],
		overviewAnalysis: { state: 'idle' }
	};
}
