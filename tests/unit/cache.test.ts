import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	hunkCacheKey,
	overviewCacheKey,
	ReviewCache,
	storyCacheKey,
	type AnalysisCacheContext
} from '../../electron/backend/cache.js';

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function cache(): Promise<ReviewCache> {
	const directory = await mkdtemp(path.join(tmpdir(), 'codex-explain-cache-test-'));
	directories.push(directory);
	return new ReviewCache(path.join(directory, 'cache.sqlite3'));
}

const context: AnalysisCacheContext = {
	repositoryIdentity: 'repo',
	baselineSessionId: 'session',
	baselineTurnId: 'turn',
	oldRevision: 'old',
	newRevision: 'new',
	model: 'model',
	detailLevel: 2
};

describe('ReviewCache', () => {
	it('uses deterministic, context-sensitive analysis keys', () => {
		const file = { oldPath: 'a.ts', newPath: 'a.ts', oldHash: '1', newHash: '2' };
		expect(overviewCacheKey(context, file)).toBe(overviewCacheKey({ ...context }, { ...file }));
		expect(overviewCacheKey(context, file)).not.toBe(
			overviewCacheKey({ ...context, baselineTurnId: 'other' }, file)
		);
		expect(hunkCacheKey(context, file, 'h1')).not.toBe(hunkCacheKey(context, file, 'h2'));
		expect(storyCacheKey(context, ['a', 'b'])).not.toBe(storyCacheKey(context, ['b', 'a']));
	});

	it('persists structured entries and Q&A without source blobs', async () => {
		const store = await cache();
		store.set('overview', 'key', {
			role: 'Router',
			whyChanged: 'New flow',
			howChanged: 'Adds a route'
		});
		expect(store.get('key')).toEqual({
			role: 'Router',
			whyChanged: 'New flow',
			howChanged: 'Adds a route'
		});
		store.ensureQaConversation('hunk');
		store.upsertQaMessage('hunk', {
			id: 'message',
			role: 'user',
			content: 'Why?',
			createdAt: new Date(0).toISOString(),
			status: 'complete'
		});
		expect(store.getQaConversation('hunk').messages[0].content).toBe('Why?');
		expect(store.info().entryCount).toBe(1);
		expect(store.clear().entryCount).toBe(0);
		store.close();
	});

	it('records child threads for crash-recovery archiving', async () => {
		const store = await cache();
		store.recordThread({ id: 'baseline', reviewId: 'review', kind: 'baseline' });
		store.recordThread({ id: 'child', reviewId: 'review', kind: 'file', parentThreadId: 'base' });
		expect(new Set(store.listUnarchivedThreads('review'))).toEqual(new Set(['baseline', 'child']));
		store.markThreadArchived('baseline');
		store.markThreadArchived('child');
		expect(store.listUnarchivedThreads('review')).toEqual([]);
		store.recordThread({ id: 'baseline', reviewId: 'next-review', kind: 'baseline' });
		expect(store.listUnarchivedThreads('next-review')).toEqual(['baseline']);
		store.close();
	});
});
