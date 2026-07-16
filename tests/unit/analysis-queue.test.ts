import { describe, expect, it } from 'vitest';
import { PrioritizedAnalysisQueue } from '../../electron/backend/analysis-queue.js';

describe('PrioritizedAnalysisQueue', () => {
	it('runs at most three files concurrently and serializes each file lane', async () => {
		let active = 0;
		let maxActive = 0;
		const activeByFile = new Map<string, number>();
		let sameFileOverlap = false;
		const queue = new PrioritizedAnalysisQueue({
			maxConcurrentFiles: 3,
			canRun: () => true,
			run: async (job) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				const fileActive = (activeByFile.get(job.fileId) ?? 0) + 1;
				activeByFile.set(job.fileId, fileActive);
				if (fileActive > 1) sameFileOverlap = true;
				await delay(25);
				active -= 1;
				activeByFile.set(job.fileId, fileActive - 1);
			}
		});
		for (let index = 0; index < 8; index += 1) {
			queue.add({
				id: `job-${index}`,
				fileId: `file-${index % 4}`,
				kind: index < 4 ? 'overview' : 'hunk'
			});
		}
		await waitFor(() => queue.list().every((job) => job.state === 'completed'));
		expect(maxActive).toBeLessThanOrEqual(3);
		expect(maxActive).toBeGreaterThan(1);
		expect(sameFileOverlap).toBe(false);
	});

	it('promotes selected work ahead of background FIFO', async () => {
		const order: string[] = [];
		const queue = new PrioritizedAnalysisQueue({
			maxConcurrentFiles: 1,
			canRun: () => true,
			run: async (job) => {
				order.push(job.id);
			}
		});
		queue.setPaused(true);
		queue.add({ id: 'background-a', fileId: 'a', kind: 'hunk' });
		queue.add({ id: 'background-b', fileId: 'b', kind: 'hunk' });
		queue.add({ id: 'selected', fileId: 'c', kind: 'hunk' });
		queue.prioritize('selected', 'select');
		queue.setPaused(false);
		await waitFor(() => queue.list().every((job) => job.state === 'completed'));
		expect(order[0]).toBe('selected');
	});
});

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeout) throw new Error('Timed out');
		await delay(10);
	}
}
