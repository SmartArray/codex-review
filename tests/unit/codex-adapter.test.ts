import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
	CodexAdapter,
	contextBaselinePrompt,
	sessionWorkspaceMatchesRepository,
	type BaselineContext
} from '../../electron/backend/codex-adapter.js';
import type { ReviewCache } from '../../electron/backend/cache.js';

const exec = promisify(execFile);

describe('Codex session repository matching', () => {
	it('wraps a startup context message with the pinned comparison', () => {
		const prompt = contextBaselinePrompt('Focus on compatibility.', {
			oldRevision: 'old-hash',
			newRevision: 'new-tree',
			revisionExpression: 'HEAD~2',
			mode: 'range',
			dirty: true
		});
		expect(prompt).toContain('Analyze the recent changes');
		expect(prompt).toContain('git diff --find-renames old-hash new-tree');
		expect(prompt).toContain('git diff --cached');
		expect(prompt).toContain('Focus on compatibility.');
	});

	it('accepts a non-Git workspace that contains the selected repository', async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), 'codex-explain-workspace-'));
		const repository = path.join(workspace, 'nested-repository');
		await mkdir(repository);
		await exec('git', ['init', '--quiet'], { cwd: repository });
		const commonDirectory = await realpath(path.join(repository, '.git'));

		await expect(
			sessionWorkspaceMatchesRepository(workspace, repository, commonDirectory)
		).resolves.toBe(true);
	});

	it('rejects an unrelated non-Git workspace', async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), 'codex-explain-workspace-'));
		const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'codex-explain-repository-'));
		await exec('git', ['init', '--quiet'], { cwd: elsewhere });
		const commonDirectory = await realpath(path.join(elsewhere, '.git'));

		await expect(
			sessionWorkspaceMatchesRepository(workspace, elsewhere, commonDirectory)
		).resolves.toBe(false);
	});
});

describe('Codex compacted baselines', () => {
	it('compacts a review-owned fork and reports its invocation usage', async () => {
		const usage = vi.fn();
		const records: Array<{ id: string; parentThreadId?: string }> = [];
		const cache = {
			recordThread: (record: { id: string; parentThreadId?: string }) => records.push(record),
			listUnarchivedThreads: () => records.map((record) => record.id),
			markThreadArchived: vi.fn()
		} as unknown as ReviewCache;
		const adapter = new CodexAdapter({
			binaryPath: '/unused/codex',
			snapshotDirectory: '/snapshot',
			sourceRoot: '/source',
			sourceCommonDirectory: '/source/.git',
			reviewId: 'review-1',
			cache,
			model: 'gpt-5.4-mini',
			onUsage: usage
		});
		const source = baseline();
		setBaseline(adapter, source);
		const forkThread = vi.fn(async () => ({
			threadId: 'review-fork',
			model: 'gpt-5.4-mini',
			modelProvider: 'openai'
		}));
		const compactThread = vi.fn(async () => ({
			turnId: 'compact-turn',
			usage: {
				inputTokens: 100,
				cachedInputTokens: 60,
				outputTokens: 15,
				reasoningOutputTokens: 4,
				totalTokens: 115
			}
		}));
		setAppServer(adapter, {
			forkThread,
			compactThread,
			readThread: async () => ({
				id: 'review-fork',
				cwd: '/snapshot',
				status: { type: 'idle' },
				turns: [{ id: 'compact-turn', status: 'completed' }]
			})
		});

		const result = await adapter.compactBaseline();
		expect(result.warning).toBeUndefined();
		expect(result.baseline).toMatchObject({
			threadId: 'review-fork',
			lastTurnId: 'compact-turn',
			cacheSessionId: 'source-session',
			ownedByReview: true
		});
		expect(result.baseline.cacheTurnId).toContain('native-compact-v1:source-turn');
		expect(forkThread).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: 'source-session', lastTurnId: 'source-turn' })
		);
		expect(compactThread).toHaveBeenCalledWith('review-fork', undefined);
		expect(records).toContainEqual(
			expect.objectContaining({ id: 'review-fork', parentThreadId: 'source-session' })
		);
		expect(usage).toHaveBeenCalledWith(
			expect.objectContaining({ invocationCount: 1, totalTokens: 115 })
		);
	});

	it('keeps the uncompacted review fork when native compaction fails', async () => {
		const cache = {
			recordThread: vi.fn(),
			listUnarchivedThreads: () => [],
			markThreadArchived: vi.fn()
		} as unknown as ReviewCache;
		const adapter = new CodexAdapter({
			binaryPath: '/unused/codex',
			snapshotDirectory: '/snapshot',
			sourceRoot: '/source',
			sourceCommonDirectory: '/source/.git',
			reviewId: 'review-1',
			cache,
			model: 'gpt-5.4-mini'
		});
		setBaseline(adapter, baseline());
		setAppServer(adapter, {
			forkThread: async () => ({
				threadId: 'review-fork',
				model: 'gpt-5.4-mini',
				modelProvider: 'openai'
			}),
			compactThread: async () => {
				throw new Error('provider unavailable');
			}
		});

		const result = await adapter.compactBaseline();
		expect(result.warning).toContain('continuing with the uncompacted review fork');
		expect(result.baseline).toMatchObject({
			threadId: 'review-fork',
			lastTurnId: 'source-turn',
			ownedByReview: true
		});
		expect(result.baseline.cacheTurnId).toContain('native-compact-fallback-v1');
	});
});

function baseline(): BaselineContext {
	return {
		threadId: 'source-session',
		lastTurnId: 'source-turn',
		cwd: '/source',
		model: 'gpt-5.4-mini',
		cacheSessionId: 'source-session',
		cacheTurnId: 'source-turn',
		ownedByReview: false
	};
}

function setBaseline(adapter: CodexAdapter, value: BaselineContext): void {
	(adapter as unknown as { baseline: BaselineContext }).baseline = value;
}

function setAppServer(adapter: CodexAdapter, value: object): void {
	Object.defineProperty(adapter, 'appServer', { configurable: true, value });
}
