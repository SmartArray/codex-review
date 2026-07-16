import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommitReviewStore } from '../../electron/commit-review-store.js';

let directory: string | undefined;

afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

describe('commit review state', () => {
	it('persists reviewed commits by repository and removes unchecked entries', async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'codex-explain-commit-review-'));
		const store = new CommitReviewStore(directory);
		await store.set('repository-a', 'commit-a', true);
		await store.set('repository-a', 'working-tree:fingerprint', true);
		await store.set('repository-b', 'commit-b', true);

		expect([...(await new CommitReviewStore(directory).list('repository-a'))]).toEqual([
			'commit-a',
			'working-tree:fingerprint'
		]);
		expect([...(await store.list('repository-b'))]).toEqual(['commit-b']);

		await store.set('repository-a', 'commit-a', false);
		expect([...(await store.list('repository-a'))]).toEqual(['working-tree:fingerprint']);
		expect(
			(await readFile(path.join(directory, 'commit-review-state.json'), 'utf8')).endsWith('\n')
		).toBe(true);
	});

	it('falls back safely when persisted state is malformed', async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'codex-explain-commit-review-'));
		await writeFile(path.join(directory, 'commit-review-state.json'), '{not json');
		const store = new CommitReviewStore(directory);
		expect(await store.list('repository')).toEqual(new Set());
		await store.set('repository', 'commit', true);
		expect([...(await store.list('repository'))]).toEqual(['commit']);
	});
});
