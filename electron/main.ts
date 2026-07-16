import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	net,
	protocol,
	utilityProcess,
	type UtilityProcess,
	type IpcMainInvokeEvent
} from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
	OpenRangeReviewResult,
	RangeReviewState,
	ReviewEvent,
	ReviewManifest,
	StartReviewResult
} from '../src/lib/shared/types.js';
import { IPC } from '../src/lib/shared/ipc.js';
import { parseLaunchArguments } from '../src/lib/shared/launch-config.js';
import { SpeechService, type SpeechTaskProcess } from './speech-service.js';
import { ReviewHistoryStore } from './review-history.js';
import { CommitReviewStore } from './commit-review-store.js';
import {
	fileIdSchema,
	hunkIdSchema,
	prioritizeSchema,
	questionSchema,
	rangeReviewItemIdSchema,
	rangeReviewStatusSchema,
	reviewConfigSchema,
	searchOptionsSchema,
	storyDirectionSchema,
	speechSettingsSchema,
	speechTextSchema,
	targetSchema
} from '../src/lib/shared/schemas.js';

protocol.registerSchemesAsPrivileged([
	{
		scheme: 'app',
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
	}
]);

let mainWindow: BrowserWindow | null = null;
let quitting = false;
const initialConfig = parseLaunchArguments(process.argv);

interface PendingCall {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

class ReviewWorkerBroker {
	private worker?: UtilityProcess;
	private pending = new Map<string, PendingCall>();
	private shuttingDown = false;

	private ensureWorker(): UtilityProcess {
		if (this.worker) return this.worker;
		if (this.shuttingDown) throw new Error('The review service is shutting down.');
		const worker = utilityProcess.fork(path.join(import.meta.dirname, 'worker.js'), [], {
			serviceName: 'Codex Review Engine',
			cwd: app.getPath('temp'),
			stdio: ['ignore', 'ignore', 'ignore'],
			env: {
				...process.env,
				CODEX_EXPLAIN_CACHE_PATH: path.join(app.getPath('userData'), 'review-cache.sqlite3')
			}
		});
		this.worker = worker;
		worker.on('message', (message: unknown) => this.handleMessage(message));
		worker.on('exit', () => {
			if (this.worker === worker) this.worker = undefined;
			this.failAll(new Error('The isolated review engine stopped unexpectedly.'));
			this.sendEvent({
				type: 'fatal-error',
				message: 'The review engine stopped unexpectedly.',
				detail: 'Close and reopen the review to restart it.'
			});
		});
		return worker;
	}

	call(method: string, params?: unknown, timeoutMs = 10 * 60_000): Promise<unknown> {
		const worker = this.ensureWorker();
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Review operation timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			worker.postMessage({ type: 'request', id, method, params });
		});
	}

	private handleMessage(message: unknown): void {
		if (!message || typeof message !== 'object') return;
		const value = message as {
			type?: string;
			id?: string;
			result?: unknown;
			error?: { message?: string };
			event?: ReviewEvent;
		};
		if (value.type === 'event' && value.event) {
			this.sendEvent(value.event);
			return;
		}
		if (value.type !== 'response' || !value.id) return;
		const pending = this.pending.get(value.id);
		if (!pending) return;
		this.pending.delete(value.id);
		clearTimeout(pending.timer);
		if (value.error) pending.reject(new Error(value.error.message ?? 'Review operation failed.'));
		else pending.resolve(value.result);
	}

	private sendEvent(event: ReviewEvent): void {
		if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.event, event);
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (!this.worker) return;
		try {
			await this.call('closeReview', undefined, 20_000);
		} catch {
			// The utility process is terminated below even if graceful cleanup times out.
		}
		this.worker?.kill();
		this.worker = undefined;
	}
}

const broker = new ReviewWorkerBroker();
const history = new ReviewHistoryStore(app.getPath('userData'));
const commitReviews = new CommitReviewStore(app.getPath('userData'));
const speech = new SpeechService(
	app.getPath('userData'),
	(event) => {
		if (mainWindow && !mainWindow.isDestroyed())
			mainWindow.webContents.send(IPC.speechEvent, event);
	},
	launchSpeechTask
);

function launchSpeechTask(modulePath: string): SpeechTaskProcess {
	const child = utilityProcess.fork(modulePath, [], {
		serviceName: 'Codex Review Speech Engine',
		cwd: app.getPath('temp'),
		stdio: 'ignore',
		allowLoadingUnsignedLibraries: process.platform === 'darwin'
	});
	let exited = false;
	let terminationStarted = false;
	let resolveExit: (() => void) | undefined;
	const exitPromise = new Promise<void>((resolve) => (resolveExit = resolve));
	child.once('exit', () => {
		exited = true;
		resolveExit?.();
	});
	return {
		postMessage: (message) => child.postMessage(message),
		onMessage: (listener) => child.on('message', listener),
		onError: (listener) =>
			child.on('error', (type, location) =>
				listener(new Error(`Speech process failed (${type})${location ? ` at ${location}` : ''}.`))
			),
		onExit: (listener) => child.on('exit', listener),
		terminate: async () => {
			if (exited) return;
			if (!terminationStarted) {
				terminationStarted = true;
				const stop = () => {
					if (!exited) child.kill();
				};
				if (child.pid === undefined) child.once('spawn', stop);
				else stop();
			}
			await exitPromise;
		}
	};
}

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1440,
		height: 940,
		minWidth: 1040,
		minHeight: 680,
		title: 'Codex Review',
		backgroundColor: '#0f1115',
		show: false,
		titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
		trafficLightPosition: { x: 14, y: 13 },
		webPreferences: {
			preload: path.join(import.meta.dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			webviewTag: false,
			spellcheck: false
		}
	});

	mainWindow.once('ready-to-show', () => mainWindow?.show());
	mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	mainWindow.webContents.on('will-navigate', (event, url) => {
		if (!isAllowedRendererUrl(url)) event.preventDefault();
	});
	mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
	mainWindow.webContents.session.setPermissionRequestHandler(
		(_webContents, _permission, callback) => callback(false)
	);
	mainWindow.webContents.session.setPermissionCheckHandler(() => false);
	mainWindow.on('closed', () => {
		mainWindow = null;
		void broker.call('closeReview').catch(() => undefined);
	});

	const devUrl = process.env.CODEX_EXPLAIN_DEV_URL;
	if (devUrl) void mainWindow.loadURL(devUrl);
	else void mainWindow.loadURL('app://renderer/');
}

function isAllowedRendererUrl(url: string): boolean {
	if (url.startsWith('app://renderer/')) return true;
	const devUrl = process.env.CODEX_EXPLAIN_DEV_URL;
	return Boolean(devUrl && url.startsWith(devUrl));
}

function registerAppProtocol(): void {
	const buildRoot = path.resolve(import.meta.dirname, '../build');
	protocol.handle('app', async (request) => {
		const url = new URL(request.url);
		if (url.host !== 'renderer') return new Response('Not found', { status: 404 });
		let pathname: string;
		try {
			pathname = decodeURIComponent(url.pathname);
		} catch {
			return new Response('Invalid path', { status: 400 });
		}
		if (pathname === '/') pathname = '/index.html';
		const requested = path.resolve(buildRoot, `.${pathname}`);
		if (requested !== buildRoot && !requested.startsWith(`${buildRoot}${path.sep}`)) {
			return new Response('Forbidden', { status: 403 });
		}
		return net.fetch(pathToFileURL(requested).toString());
	});
}

function validateSender(event: IpcMainInvokeEvent): void {
	if (
		!mainWindow ||
		event.sender.id !== mainWindow.webContents.id ||
		!event.senderFrame ||
		!isAllowedRendererUrl(event.senderFrame.url)
	) {
		throw new Error('Rejected IPC request from an unexpected renderer.');
	}
}

function handle(channel: string, validator: (value: unknown) => unknown, method: string): void {
	ipcMain.handle(channel, (event, value) => {
		validateSender(event);
		return broker.call(method, validator(value));
	});
}

async function decoratedRangeState(): Promise<RangeReviewState | null> {
	const state = (await broker.call('getRangeReviewState')) as RangeReviewState | null;
	if (!state) return null;
	const manifest = (await broker.call('getManifest')) as ReviewManifest | null;
	if (!manifest) throw new Error('No review is open.');
	const reviewed = await commitReviews.list(manifest.comparison.repositoryIdentity);
	const items = state.items.map((item) => ({ ...item, reviewed: reviewed.has(item.id) }));
	return {
		...state,
		items,
		reviewedCount: items.filter((item) => item.reviewed).length,
		totalCount: items.length
	};
}

function registerIpc(): void {
	ipcMain.handle(IPC.initialConfig, (event) => {
		validateSender(event);
		return initialConfig;
	});
	ipcMain.handle(IPC.history, (event) => {
		validateSender(event);
		return history.list();
	});
	ipcMain.handle(IPC.clearHistory, async (event) => {
		validateSender(event);
		await history.clear();
	});
	ipcMain.handle(IPC.rangeState, async (event) => {
		validateSender(event);
		return decoratedRangeState();
	});
	ipcMain.handle(IPC.rangeOpenItem, async (event, value) => {
		validateSender(event);
		const itemId = rangeReviewItemIdSchema.parse(value);
		const review = (await broker.call('openRangeReviewItem', itemId)) as StartReviewResult;
		const range = await decoratedRangeState();
		if (!range) throw new Error('The active range was closed unexpectedly.');
		return { review, range } satisfies OpenRangeReviewResult;
	});
	ipcMain.handle(IPC.rangeSetReviewed, async (event, value) => {
		validateSender(event);
		const request = rangeReviewStatusSchema.parse(value);
		const state = await decoratedRangeState();
		const item = state?.items.find((candidate) => candidate.id === request.itemId);
		if (!state || !item) throw new Error('This commit is not part of the active range.');
		const manifest = (await broker.call('getManifest')) as ReviewManifest | null;
		if (!manifest) throw new Error('No review is open.');
		await commitReviews.set(
			manifest.comparison.repositoryIdentity,
			request.itemId,
			request.reviewed
		);
		const updated = await decoratedRangeState();
		if (!updated) throw new Error('The active range was closed unexpectedly.');
		return updated;
	});
	ipcMain.handle(IPC.chooseRoot, async (event) => {
		validateSender(event);
		const result = await dialog.showOpenDialog(mainWindow!, {
			title: 'Choose a Git repository',
			properties: ['openDirectory', 'createDirectory']
		});
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});
	handle(IPC.validateConfig, (value) => reviewConfigSchema.parse(value), 'validateConfig');
	ipcMain.handle(IPC.start, async (event, value) => {
		validateSender(event);
		const config = reviewConfigSchema.parse(value);
		const result = await broker.call('startReview', config);
		await history.add(config).catch(() => undefined);
		return result;
	});
	handle(IPC.reload, () => undefined, 'reloadReview');
	handle(IPC.close, () => undefined, 'closeReview');
	handle(IPC.manifest, () => undefined, 'getManifest');
	handle(IPC.loadFile, (value) => fileIdSchema.parse(value), 'loadFile');
	handle(IPC.prioritizeHunk, (value) => prioritizeSchema.parse(value), 'prioritizeHunk');
	handle(IPC.prioritizeFile, (value) => fileIdSchema.parse(value), 'prioritizeFile');
	handle(IPC.analyzeAnyway, (value) => fileIdSchema.parse(value), 'analyzeAnyway');
	handle(IPC.retry, (value) => targetSchema.parse(value), 'retryAnalysis');
	handle(IPC.search, (value) => searchOptionsSchema.parse(value), 'search');
	handle(IPC.cancelSearch, (value) => z.string().min(1).parse(value), 'cancelSearch');
	handle(IPC.getQa, (value) => hunkIdSchema.parse(value), 'getQa');
	handle(IPC.askHunk, (value) => questionSchema.parse(value), 'askHunk');
	handle(IPC.cancelQa, (value) => hunkIdSchema.parse(value), 'cancelQa');
	handle(IPC.buildStory, (value) => z.boolean().parse(value), 'buildStory');
	handle(IPC.enterStory, () => undefined, 'enterStory');
	handle(IPC.navigateStory, (value) => storyDirectionSchema.parse(value), 'navigateStory');
	handle(IPC.stopStory, () => undefined, 'stopStory');
	handle(IPC.cacheInfo, () => undefined, 'getCacheInfo');
	handle(IPC.clearCache, () => undefined, 'clearCache');
	ipcMain.handle(IPC.speechGetSettings, (event) => {
		validateSender(event);
		return speech.getSettings();
	});
	ipcMain.handle(IPC.speechSetSettings, (event, value) => {
		validateSender(event);
		return speech.setSettings(speechSettingsSchema.parse(value));
	});
	ipcMain.handle(IPC.speechModelStatus, (event) => {
		validateSender(event);
		return speech.getModelStatus();
	});
	ipcMain.handle(IPC.speechDownloadModel, (event) => {
		validateSender(event);
		return speech.downloadModel();
	});
	ipcMain.handle(IPC.speechSiriStatus, (event) => {
		validateSender(event);
		return speech.getSiriStatus();
	});
	ipcMain.handle(IPC.speechVoiceboxStatus, (event) => {
		validateSender(event);
		return speech.getVoiceboxStatus();
	});
	ipcMain.handle(IPC.speechPlayRole, (event, value) => {
		validateSender(event);
		return speech.playRole(speechTextSchema.parse(value));
	});
	ipcMain.handle(IPC.speechPrepare, (event, value) => {
		validateSender(event);
		return speech.prepare(z.array(speechTextSchema).max(5).parse(value));
	});
	ipcMain.handle(IPC.speechIsCached, (event, value) => {
		validateSender(event);
		return speech.isCached(speechTextSchema.parse(value));
	});
	ipcMain.handle(IPC.speechStop, (event) => {
		validateSender(event);
		return speech.stop();
	});
	ipcMain.handle(IPC.speechPause, (event) => {
		validateSender(event);
		return speech.pause();
	});
	ipcMain.handle(IPC.speechResume, (event) => {
		validateSender(event);
		return speech.resume();
	});
	ipcMain.handle(IPC.speechCacheInfo, (event) => {
		validateSender(event);
		return speech.cacheInfo();
	});
	ipcMain.handle(IPC.speechClearCache, (event) => {
		validateSender(event);
		return speech.clearAudioCache();
	});
}

app.whenReady().then(async () => {
	registerAppProtocol();
	await speech.initialize();
	registerIpc();
	createWindow();
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
	if (quitting) return;
	event.preventDefault();
	quitting = true;
	void speech
		.shutdown()
		.finally(() => broker.shutdown())
		.finally(() => app.exit(0));
});
