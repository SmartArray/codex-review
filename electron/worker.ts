import path from 'node:path';
import { ReviewService } from './backend/review-service.js';

interface WorkerRequest {
	type: 'request';
	id: string;
	method: string;
	params?: unknown;
}

const cachePath =
	process.env.CODEX_EXPLAIN_CACHE_PATH ?? path.join(process.cwd(), 'codex-explain-cache.sqlite3');
const port = process.parentPort;

if (!port) throw new Error('Review worker must run as an Electron utility process.');

const service = new ReviewService(cachePath, (event) => {
	port.postMessage({ type: 'event', event });
});

port.on('message', ({ data }: { data: WorkerRequest }) => {
	if (!data || data.type !== 'request' || typeof data.id !== 'string') return;
	void dispatch(data.method, data.params)
		.then((result) => port.postMessage({ type: 'response', id: data.id, result }))
		.catch((error) =>
			port.postMessage({
				type: 'response',
				id: data.id,
				error: { message: error instanceof Error ? error.message : 'The review worker failed.' }
			})
		);
});

async function dispatch(method: string, params: unknown): Promise<unknown> {
	switch (method) {
		case 'validateConfig':
			return service.validateConfig(params as never);
		case 'startReview':
			return service.startReview(params as never);
		case 'reloadReview':
			return service.reloadReview();
		case 'closeReview':
			return service.closeReview();
		case 'getManifest':
			return service.getManifest();
		case 'getRangeReviewState':
			return service.getRangeReviewState();
		case 'openRangeReviewItem':
			return service.openRangeReviewItem(params as string);
		case 'loadFile':
			return service.loadFile(params as string);
		case 'prioritizeHunk': {
			const value = params as { hunkId: string; reason: 'hover' | 'select' | 'story' | 'question' };
			return service.prioritizeHunk(value.hunkId, value.reason);
		}
		case 'prioritizeFile':
			return service.prioritizeFile(params as string);
		case 'analyzeAnyway':
			return service.analyzeAnyway(params as string);
		case 'retryAnalysis':
			return service.retryAnalysis(params as never);
		case 'search':
			return service.search(params as never);
		case 'cancelSearch':
			return service.cancelSearch(params as string);
		case 'getQa':
			return service.getQa(params as string);
		case 'askHunk': {
			const value = params as { hunkId: string; question: string };
			return service.askHunk(value.hunkId, value.question);
		}
		case 'cancelQa':
			return service.cancelQa(params as string);
		case 'buildStory':
			return service.buildStory(Boolean(params));
		case 'enterStory':
			return service.enterStory();
		case 'navigateStory':
			return service.navigateStory(params as 'previous' | 'next');
		case 'stopStory':
			return service.stopStory();
		case 'getCacheInfo':
			return service.getCacheInfo();
		case 'clearCache':
			return service.clearCache();
		default:
			throw new Error('Unknown review worker method.');
	}
}

process.once('exit', () => service.dispose());
