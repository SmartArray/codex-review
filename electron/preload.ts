import { contextBridge, ipcRenderer } from 'electron';
import type { ReviewApi, ReviewEvent, SpeechEvent } from '../src/lib/shared/types.js';
import { IPC } from '../src/lib/shared/ipc.js';

const api: ReviewApi = {
	platform: process.platform,
	initialConfig: () => ipcRenderer.invoke(IPC.initialConfig),
	getReviewHistory: () => ipcRenderer.invoke(IPC.history),
	clearReviewHistory: () => ipcRenderer.invoke(IPC.clearHistory),
	getRangeReviewState: () => ipcRenderer.invoke(IPC.rangeState),
	openRangeReviewItem: (itemId) => ipcRenderer.invoke(IPC.rangeOpenItem, itemId),
	setRangeReviewItemReviewed: (itemId, reviewed) =>
		ipcRenderer.invoke(IPC.rangeSetReviewed, { itemId, reviewed }),
	chooseRoot: () => ipcRenderer.invoke(IPC.chooseRoot),
	validateConfig: (config) => ipcRenderer.invoke(IPC.validateConfig, config),
	startReview: (config) => ipcRenderer.invoke(IPC.start, config),
	reloadReview: () => ipcRenderer.invoke(IPC.reload),
	closeReview: () => ipcRenderer.invoke(IPC.close),
	getManifest: () => ipcRenderer.invoke(IPC.manifest),
	loadFile: (fileId) => ipcRenderer.invoke(IPC.loadFile, fileId),
	prioritizeHunk: (hunkId, reason) => ipcRenderer.invoke(IPC.prioritizeHunk, { hunkId, reason }),
	prioritizeFile: (fileId) => ipcRenderer.invoke(IPC.prioritizeFile, fileId),
	analyzeAnyway: (fileId) => ipcRenderer.invoke(IPC.analyzeAnyway, fileId),
	retryAnalysis: (target) => ipcRenderer.invoke(IPC.retry, target),
	search: (options) => ipcRenderer.invoke(IPC.search, options),
	cancelSearch: (requestId) => ipcRenderer.invoke(IPC.cancelSearch, requestId),
	getQa: (hunkId) => ipcRenderer.invoke(IPC.getQa, hunkId),
	askHunk: (hunkId, question) => ipcRenderer.invoke(IPC.askHunk, { hunkId, question }),
	cancelQa: (hunkId) => ipcRenderer.invoke(IPC.cancelQa, hunkId),
	buildStory: (withGaps) => ipcRenderer.invoke(IPC.buildStory, withGaps ?? false),
	enterStory: () => ipcRenderer.invoke(IPC.enterStory),
	navigateStory: (direction) => ipcRenderer.invoke(IPC.navigateStory, direction),
	stopStory: () => ipcRenderer.invoke(IPC.stopStory),
	getCacheInfo: () => ipcRenderer.invoke(IPC.cacheInfo),
	clearCache: () => ipcRenderer.invoke(IPC.clearCache),
	getSpeechSettings: () => ipcRenderer.invoke(IPC.speechGetSettings),
	setSpeechSettings: (settings) => ipcRenderer.invoke(IPC.speechSetSettings, settings),
	getKokoroModelStatus: () => ipcRenderer.invoke(IPC.speechModelStatus),
	downloadKokoroModel: () => ipcRenderer.invoke(IPC.speechDownloadModel),
	getSiriStatus: () => ipcRenderer.invoke(IPC.speechSiriStatus),
	getVoiceboxStatus: () => ipcRenderer.invoke(IPC.speechVoiceboxStatus),
	playRole: (text) => ipcRenderer.invoke(IPC.speechPlayRole, text),
	prepareSpeech: (texts) => ipcRenderer.invoke(IPC.speechPrepare, texts),
	isSpeechCached: (text) => ipcRenderer.invoke(IPC.speechIsCached, text),
	stopSpeech: () => ipcRenderer.invoke(IPC.speechStop),
	pauseSpeech: () => ipcRenderer.invoke(IPC.speechPause),
	resumeSpeech: () => ipcRenderer.invoke(IPC.speechResume),
	getSpeechCacheInfo: () => ipcRenderer.invoke(IPC.speechCacheInfo),
	clearSpeechCache: () => ipcRenderer.invoke(IPC.speechClearCache),
	onSpeechEvent: (listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, speechEvent: SpeechEvent) =>
			listener(speechEvent);
		ipcRenderer.on(IPC.speechEvent, wrapped);
		return () => ipcRenderer.removeListener(IPC.speechEvent, wrapped);
	},
	onEvent: (listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, reviewEvent: ReviewEvent) =>
			listener(reviewEvent);
		ipcRenderer.on(IPC.event, wrapped);
		return () => ipcRenderer.removeListener(IPC.event, wrapped);
	}
};

contextBridge.exposeInMainWorld('reviewApi', Object.freeze(api));
