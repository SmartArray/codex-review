export type ReviewMode = 'commit' | 'range';

export interface ReviewConfig {
	root: string;
	revision: string;
	sessionId?: string;
	contextMessage?: string;
	mode: ReviewMode;
	model: string;
	detailLevel: number;
	fullPreparation: boolean;
}

export interface ReviewHistoryEntry {
	id: string;
	lastOpenedAt: string;
	config: ReviewConfig;
}

export interface RangeReviewItem {
	id: string;
	kind: 'commit' | 'working-tree';
	commitHash?: string;
	title: string;
	description: string;
	reviewed: boolean;
}

export interface RangeReviewState {
	activeItemId: 'aggregate' | string;
	items: RangeReviewItem[];
	reviewedCount: number;
	totalCount: number;
}

export interface ValidationIssue {
	field: 'root' | 'revision' | 'sessionId' | 'contextMessage' | 'mode' | 'model' | 'general';
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	issues: ValidationIssue[];
	resolved?: ResolvedComparison;
}

export interface ResolvedComparison {
	mode: ReviewMode;
	repositoryName: string;
	repositoryIdentity: string;
	root: string;
	revisionExpression: string;
	oldRevision: string;
	newRevision: string;
	oldLabel: string;
	newLabel: string;
	dirty: boolean;
	dirtyFingerprint?: string;
	baselineSessionId?: string;
	baselineTurnId?: string;
}

export type ChangeStatus =
	| 'unchanged'
	| 'added'
	| 'deleted'
	| 'modified'
	| 'renamed'
	| 'copied'
	| 'type-changed'
	| 'unmerged';

export type AnalysisState =
	'idle' | 'queued' | 'running' | 'ready' | 'cached' | 'skipped' | 'failed';

export interface AnalysisStatus {
	state: AnalysisState;
	reason?: string;
	queuePosition?: number;
	attempts?: number;
}

export interface DiffLine {
	type: 'context' | 'addition' | 'deletion' | 'no-newline';
	content: string;
	oldLine: number | null;
	newLine: number | null;
}

export interface FileOverview {
	role: string;
	whyChanged: string;
	howChanged: string;
}

export interface HunkExplanation {
	title: string;
	summary: string;
	expandedExplanation: string;
}

export interface DiffHunk {
	id: string;
	fileId: string;
	index: number;
	header: string;
	section?: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
	canonicalPatch: string;
	hash: string;
	analysis: AnalysisStatus;
	explanation?: HunkExplanation;
}

export interface DiffFile {
	id: string;
	path: string;
	oldPath?: string;
	newPath?: string;
	status: ChangeStatus;
	oldHash?: string;
	newHash?: string;
	oldMode?: string;
	newMode?: string;
	language: string;
	binary: boolean;
	submodule: boolean;
	generated: boolean;
	generatedReason?: string;
	oldSize: number;
	newSize: number;
	patchLineCount: number;
	hunks: DiffHunk[];
	overviewAnalysis: AnalysisStatus;
	overview?: FileOverview;
	skipReason?: string;
}

export interface FileTreeNode {
	id: string;
	name: string;
	path: string;
	type: 'directory' | 'file';
	children?: FileTreeNode[];
	fileId?: string;
	status?: ChangeStatus;
	analysis?: AnalysisState;
	deleted?: boolean;
}

export interface ReviewManifest {
	reviewId: string;
	comparison: ResolvedComparison;
	files: DiffFile[];
	tree: FileTreeNode[];
	touchedFileCount: number;
	textualHunkCount: number;
	createdAt: string;
	stale: boolean;
}

export interface FileContent {
	fileId: string;
	oldText: string;
	newText: string;
	oldAvailable: boolean;
	newAvailable: boolean;
	truncated: boolean;
	encoding: 'utf-8';
}

export type ReviewPhase =
	'idle' | 'indexing' | 'overview' | 'details' | 'story' | 'complete' | 'error';

export interface ReviewProgress {
	phase: ReviewPhase;
	completed: number;
	total: number;
	label: string;
	warning?: string;
	error?: string;
	canBuildWithGaps?: boolean;
}

export interface CodexUsageSummary {
	invocationCount: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
}

export interface StoryTransition {
	fromFileId?: string;
	toFileId: string;
	text: string;
}

export interface StoryPlan {
	title: string;
	summary: string;
	fileIds: string[];
	transitions: StoryTransition[];
	generatedWithGaps: boolean;
}

export interface StoryStep {
	index: number;
	total: number;
	fileId: string;
	hunkId?: string;
	overviewPart?: 'role' | 'whyChanged' | 'howChanged';
}

export interface StoryState {
	active: boolean;
	plan?: StoryPlan;
	step?: StoryStep;
}

export interface SearchOptions {
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	regex: boolean;
	diffOnly: boolean;
	page?: number;
	pageSize?: number;
}

export interface SearchResult {
	fileId: string;
	path: string;
	line: number;
	column: number;
	length: number;
	snippet: string;
}

export interface SearchResponse {
	requestId: string;
	results: SearchResult[];
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
	error?: string;
}

export interface QaMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	createdAt: string;
	status: 'streaming' | 'complete' | 'cancelled' | 'failed';
}

export interface QaConversation {
	hunkId: string;
	threadId?: string;
	messages: QaMessage[];
	preparingContext: boolean;
}

export interface CacheInfo {
	entryCount: number;
	sizeBytes: number;
	databasePath: string;
	oldestEntry?: string;
}

export type SpeechEngine = 'kokoro' | 'voicebox' | 'siri';
export type KokoroVoice = 'am_michael' | 'am_echo' | 'af_sarah' | 'af_heart';
export interface SpeechSettings {
	engine: SpeechEngine;
	voice: KokoroVoice;
	speed: number;
	voiceboxProfileId?: string;
}
export interface KokoroModelStatus {
	state: 'missing' | 'downloading' | 'ready' | 'failed';
	progress?: number;
	message?: string;
}
export interface SiriStatus {
	visible: boolean;
	available: boolean;
	voice?: string;
	reason?: string;
}
export interface VoiceboxProfile {
	id: string;
	name: string;
	language?: string;
}
export interface VoiceboxStatus {
	available: boolean;
	profiles: VoiceboxProfile[];
	reason?: string;
}
export type SpeechEvent =
	| { type: 'model'; status: KokoroModelStatus }
	| { type: 'cache-changed'; text?: string }
	| {
			type: 'playback';
			state: 'loading' | 'playing' | 'paused' | 'stopped' | 'error';
			progress?: number;
			message?: string;
	  };
export interface SpeechCacheInfo {
	entryCount: number;
	sizeBytes: number;
}

export type ReviewEvent =
	| { type: 'progress'; progress: ReviewProgress }
	| { type: 'codex-usage'; usage: CodexUsageSummary }
	| { type: 'manifest'; manifest: ReviewManifest }
	| { type: 'file-updated'; file: DiffFile }
	| { type: 'hunk-updated'; fileId: string; hunk: DiffHunk }
	| { type: 'queue-updated'; fileId: string; hunkId?: string; position: number }
	| { type: 'qa-updated'; conversation: QaConversation }
	| { type: 'qa-delta'; hunkId: string; messageId: string; delta: string }
	| { type: 'story-updated'; story: StoryState }
	| { type: 'stale'; stale: boolean; reason?: string }
	| { type: 'warning'; message: string }
	| { type: 'fatal-error'; message: string; detail?: string };

export interface StartReviewResult {
	manifest: ReviewManifest;
	warnings: string[];
}

export interface OpenRangeReviewResult {
	review: StartReviewResult;
	range: RangeReviewState;
}

export interface ReviewApi {
	platform: string;
	initialConfig(): Promise<Partial<ReviewConfig>>;
	getReviewHistory(): Promise<ReviewHistoryEntry[]>;
	clearReviewHistory(): Promise<void>;
	getRangeReviewState(): Promise<RangeReviewState | null>;
	openRangeReviewItem(itemId: string): Promise<OpenRangeReviewResult>;
	setRangeReviewItemReviewed(itemId: string, reviewed: boolean): Promise<RangeReviewState>;
	chooseRoot(): Promise<string | null>;
	validateConfig(config: ReviewConfig): Promise<ValidationResult>;
	startReview(config: ReviewConfig): Promise<StartReviewResult>;
	reloadReview(): Promise<StartReviewResult>;
	closeReview(): Promise<void>;
	getManifest(): Promise<ReviewManifest | null>;
	loadFile(fileId: string): Promise<FileContent>;
	prioritizeHunk(hunkId: string, reason: 'hover' | 'select' | 'story' | 'question'): Promise<void>;
	prioritizeFile(fileId: string): Promise<void>;
	analyzeAnyway(fileId: string): Promise<void>;
	retryAnalysis(target: { fileId: string; hunkId?: string }): Promise<void>;
	search(options: SearchOptions): Promise<SearchResponse>;
	cancelSearch(requestId: string): Promise<void>;
	getQa(hunkId: string): Promise<QaConversation>;
	askHunk(hunkId: string, question: string): Promise<void>;
	cancelQa(hunkId: string): Promise<void>;
	buildStory(withGaps?: boolean): Promise<StoryPlan>;
	enterStory(): Promise<StoryState>;
	navigateStory(direction: 'previous' | 'next'): Promise<StoryState>;
	stopStory(): Promise<void>;
	getCacheInfo(): Promise<CacheInfo>;
	clearCache(): Promise<CacheInfo>;
	getSpeechSettings(): Promise<SpeechSettings>;
	setSpeechSettings(settings: SpeechSettings): Promise<SpeechSettings>;
	getKokoroModelStatus(): Promise<KokoroModelStatus>;
	downloadKokoroModel(): Promise<KokoroModelStatus>;
	getSiriStatus(): Promise<SiriStatus>;
	getVoiceboxStatus(): Promise<VoiceboxStatus>;
	playRole(text: string): Promise<void>;
	prepareSpeech(texts: string[]): Promise<void>;
	isSpeechCached(text: string): Promise<boolean>;
	stopSpeech(): Promise<void>;
	pauseSpeech(): Promise<void>;
	resumeSpeech(): Promise<void>;
	getSpeechCacheInfo(): Promise<SpeechCacheInfo>;
	clearSpeechCache(): Promise<SpeechCacheInfo>;
	onSpeechEvent(listener: (event: SpeechEvent) => void): () => void;
	onEvent(listener: (event: ReviewEvent) => void): () => void;
}

declare global {
	interface Window {
		reviewApi: ReviewApi;
	}
}
