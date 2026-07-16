import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReviewHistoryStore } from '../../electron/review-history.js';
import type { ReviewConfig } from '../../src/lib/shared/types.js';

let directory: string | undefined;

afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

describe('review history', () => {
	it('persists successful configurations, newest first, and deduplicates repeats', async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'codex-explain-history-'));
		const store = new ReviewHistoryStore(directory);
		await store.add(config({ revision: 'HEAD~1', sessionId: 'session-1' }));
		await store.add(config({ revision: 'HEAD', contextMessage: 'Explain the current changes.' }));
		await store.add(config({ revision: 'HEAD~1', sessionId: 'session-1' }));

		const entries = await new ReviewHistoryStore(directory).list();
		expect(entries).toHaveLength(2);
		expect(entries.map((entry) => entry.config.revision)).toEqual(['HEAD~1', 'HEAD']);
		expect(entries[0].config.sessionId).toBe('session-1');
	});

	it('ignores malformed stored entries and clears the persisted list', async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'codex-explain-history-'));
		await writeFile(
			path.join(directory, 'review-history.json'),
			JSON.stringify([
				{ id: 'bad', lastOpenedAt: 'not-a-date', config: {} },
				{
					id: 'valid',
					lastOpenedAt: '2026-07-15T12:00:00.000Z',
					config: config({ sessionId: 'session-1' })
				}
			])
		);
		const store = new ReviewHistoryStore(directory);
		const entries = await store.list();
		expect(entries).toHaveLength(1);
		expect(entries[0].config.compactSession).toBe(false);
		await store.clear();
		expect(await store.list()).toEqual([]);
	});
});

function config(overrides: Partial<ReviewConfig>): ReviewConfig {
	return {
		root: '/repo',
		revision: 'HEAD',
		mode: 'commit',
		model: 'gpt-5.4-mini',
		detailLevel: 2,
		fullPreparation: false,
		compactSession: false,
		...overrides
	};
}
