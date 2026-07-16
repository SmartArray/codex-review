import type {
	DiffFile,
	DiffHunk,
	FileContent,
	FileOverview,
	HunkExplanation,
	QaConversation,
	QaMessage,
	CodexUsageSummary,
	RangeReviewState,
	ReviewConfig,
	ReviewEvent,
	ReviewManifest,
	ReviewProgress,
	SearchOptions,
	SearchResponse,
	StartReviewResult,
	StoryPlan,
	StoryState,
	StoryStep,
	ValidationResult
} from '../../src/lib/shared/types.js';
import { addCodexUsage, EMPTY_CODEX_USAGE } from '../../src/lib/shared/codex-usage.js';
import {
	fileIdSchema,
	hunkIdSchema,
	prioritizeSchema,
	questionSchema,
	reviewConfigSchema,
	searchOptionsSchema,
	storyDirectionSchema,
	targetSchema
} from '../../src/lib/shared/schemas.js';
import { PrioritizedAnalysisQueue, type AnalysisJob } from './analysis-queue.js';
import {
	ANALYSIS_VERSION,
	hunkCacheKey,
	overviewCacheKey,
	ReviewCache,
	storyCacheKey,
	type AnalysisCacheContext
} from './cache.js';
import { CodexAdapter, contextBaselinePrompt, type ChildThread } from './codex-adapter.js';
import { resolveCodexBinary } from './codex-binary.js';
import {
	FrozenGitSnapshot,
	prepareComparison,
	prepareRangeReview,
	prepareRangeReviewItem,
	type PreparedComparison,
	type PreparedRangeReview,
	validateReviewConfig
} from './git-snapshot.js';

interface HunkLocation {
	file: DiffFile;
	hunk: DiffHunk;
}

const TERMINAL_STATES = new Set(['ready', 'cached', 'skipped', 'failed']);

export class ReviewService {
	private readonly cache: ReviewCache;
	private snapshot?: FrozenGitSnapshot;
	private manifest?: ReviewManifest;
	private config?: ReviewConfig;
	private adapter?: CodexAdapter;
	private analysisInitialization?: Promise<void>;
	private analysisController?: AbortController;
	private baselineReady = false;
	private queue?: PrioritizedAnalysisQueue;
	private fileThreads = new Map<string, ChildThread>();
	private hunkThreads = new Map<string, ChildThread>();
	private qaThreads = new Map<string, ChildThread>();
	private qaControllers = new Map<string, AbortController>();
	private searchController?: AbortController;
	private staleTimer?: NodeJS.Timeout;
	private initialSourceFingerprint?: string;
	private stale = false;
	private stopped = false;
	private story?: StoryPlan;
	private storyState: StoryState = { active: false };
	private storySequence: Array<{
		fileId: string;
		hunkId?: string;
		overviewPart?: StoryStep['overviewPart'];
	}> = [];
	private storyCursor = 0;
	private storyGenerating = false;
	private currentStoryKey?: string;
	private overviewKeys = new Map<string, string>();
	private hunkKeys = new Map<string, string>();
	private codexUsage: CodexUsageSummary = { ...EMPTY_CODEX_USAGE };
	private rangeReview?: PreparedRangeReview;
	private activeRangeItemId = 'aggregate';

	constructor(
		databasePath: string,
		private readonly emitEvent: (event: ReviewEvent) => void
	) {
		this.cache = new ReviewCache(databasePath);
	}

	async validateConfig(config: ReviewConfig): Promise<ValidationResult> {
		return validateReviewConfig(reviewConfigSchema.parse(config) as ReviewConfig);
	}

	async startReview(configInput: ReviewConfig): Promise<StartReviewResult> {
		const config = reviewConfigSchema.parse(configInput) as ReviewConfig;
		await this.closeReview();
		const prepared =
			config.mode === 'range'
				? (this.rangeReview = await prepareRangeReview(config)).base
				: await prepareComparison(config);
		this.activeRangeItemId = 'aggregate';
		return this.startPreparedReview(prepared);
	}

	private async startPreparedReview(prepared: PreparedComparison): Promise<StartReviewResult> {
		this.stopped = false;
		this.config = prepared.config;
		this.codexUsage = { ...EMPTY_CODEX_USAGE };
		this.emitEvent({ type: 'codex-usage', usage: this.codexUsage });
		this.emitProgress({ phase: 'indexing', completed: 0, total: 1, label: 'Indexing' });
		const { snapshot, manifest } = await FrozenGitSnapshot.createPrepared(prepared, (message) => {
			this.emitProgress({
				phase: 'indexing',
				completed: 0,
				total: 1,
				label: `Indexing — ${message}`
			});
		});
		this.snapshot = snapshot;
		this.manifest = manifest;
		this.initialSourceFingerprint = await snapshot.currentSourceFingerprint();
		this.emitEvent({ type: 'manifest', manifest });
		this.startStaleMonitor();

		const initialization = this.initializeAnalysis().catch((error) =>
			this.failAnalysisInitialization(error)
		);
		const trackedInitialization = initialization.finally(() => {
			if (this.analysisInitialization === trackedInitialization)
				this.analysisInitialization = undefined;
		});
		this.analysisInitialization = trackedInitialization;
		return { manifest, warnings: [] };
	}

	async reloadReview(): Promise<StartReviewResult> {
		if (!this.config) throw new Error('No review is open.');
		if (this.rangeReview) {
			const originalConfig = { ...this.rangeReview.base.config };
			const previousItemId = this.activeRangeItemId;
			await this.closeReview();
			this.rangeReview = await prepareRangeReview(originalConfig);
			const itemId = previousItemId.startsWith('working-tree:')
				? (this.rangeReview.items.find((item) => item.kind === 'working-tree')?.id ?? 'aggregate')
				: this.rangeReview.items.some((item) => item.id === previousItemId)
					? previousItemId
					: 'aggregate';
			this.activeRangeItemId = itemId;
			return this.startPreparedReview(await prepareRangeReviewItem(this.rangeReview, itemId));
		}
		const config = { ...this.config };
		return this.startReview(config);
	}

	async closeReview(): Promise<void> {
		await this.closeActiveReview();
		this.config = undefined;
		this.rangeReview = undefined;
		this.activeRangeItemId = 'aggregate';
	}

	private async closeActiveReview(): Promise<void> {
		this.stopped = true;
		this.analysisController?.abort();
		this.analysisController = undefined;
		await this.analysisInitialization?.catch(() => undefined);
		this.analysisInitialization = undefined;
		this.queue?.stop();
		this.queue = undefined;
		for (const controller of this.qaControllers.values()) controller.abort();
		this.qaControllers.clear();
		this.searchController?.abort();
		this.searchController = undefined;
		if (this.staleTimer) clearInterval(this.staleTimer);
		this.staleTimer = undefined;
		const adapter = this.adapter;
		this.adapter = undefined;
		if (adapter) await adapter.close();
		const snapshot = this.snapshot;
		this.snapshot = undefined;
		if (snapshot) await snapshot.dispose();
		this.manifest = undefined;
		this.baselineReady = false;
		this.fileThreads.clear();
		this.hunkThreads.clear();
		this.qaThreads.clear();
		this.overviewKeys.clear();
		this.hunkKeys.clear();
		this.story = undefined;
		this.storyState = { active: false };
		this.storySequence = [];
		this.storyGenerating = false;
		this.currentStoryKey = undefined;
		this.stale = false;
	}

	getRangeReviewState(): RangeReviewState | null {
		if (!this.rangeReview) return null;
		return {
			activeItemId: this.activeRangeItemId,
			items: this.rangeReview.items.map((item) => ({ ...item })),
			reviewedCount: 0,
			totalCount: this.rangeReview.items.length
		};
	}

	async openRangeReviewItem(itemId: string): Promise<StartReviewResult> {
		if (!this.rangeReview) throw new Error('Commit navigation is only available in range mode.');
		const prepared = await prepareRangeReviewItem(this.rangeReview, itemId);
		await this.closeActiveReview();
		this.activeRangeItemId = itemId;
		return this.startPreparedReview(prepared);
	}

	getManifest(): ReviewManifest | null {
		return this.manifest ?? null;
	}

	async loadFile(fileIdInput: string): Promise<FileContent> {
		const fileId = fileIdSchema.parse(fileIdInput);
		return this.requireSnapshot().loadFile(fileId);
	}

	private async initializeAnalysis(): Promise<void> {
		const controller = new AbortController();
		this.analysisController = controller;
		const snapshot = this.requireSnapshot();
		const manifest = this.requireManifest();
		const binaryPath = resolveCodexBinary();
		const adapter = new CodexAdapter({
			binaryPath,
			snapshotDirectory: snapshot.snapshotDirectory,
			sourceRoot: snapshot.sourceRoot,
			sourceCommonDirectory: snapshot.commonDirectory,
			reviewId: manifest.reviewId,
			cache: this.cache,
			model: snapshot.config.model,
			onUsage: (usage) => this.recordCodexUsage(usage)
		});
		this.adapter = adapter;
		this.emitProgress({
			phase: 'overview',
			completed: 0,
			total: 1,
			label: snapshot.config.sessionId ? 'Validating Codex session' : 'Preparing context message'
		});
		try {
			const baseline = snapshot.config.sessionId
				? await adapter.validateBaseline(snapshot.config.sessionId)
				: await adapter.createBaseline(
						contextBaselinePrompt(snapshot.config.contextMessage!, manifest.comparison),
						controller.signal
					);
			if (this.stopped || this.adapter !== adapter) return;
			this.baselineReady = true;
			manifest.comparison.baselineSessionId = baseline.threadId;
			manifest.comparison.baselineTurnId = baseline.lastTurnId;
			this.hydrateAndQueueAnalysis();
		} finally {
			if (this.analysisController === controller) this.analysisController = undefined;
		}
	}

	private failAnalysisInitialization(error: unknown): void {
		if (this.stopped || !this.manifest) return;
		const message = error instanceof Error ? error.message : 'Codex analysis is unavailable.';
		for (const file of this.touchedFiles()) {
			if (!TERMINAL_STATES.has(file.overviewAnalysis.state)) {
				file.overviewAnalysis = { state: 'failed', reason: message, attempts: 1 };
			}
			for (const hunk of file.hunks) {
				if (!TERMINAL_STATES.has(hunk.analysis.state)) {
					hunk.analysis = { state: 'failed', reason: message, attempts: 1 };
				}
			}
		}
		this.emitEvent({ type: 'manifest', manifest: this.manifest });
		this.emitProgress({
			phase: 'error',
			completed: 0,
			total: 0,
			label: 'AI unavailable — diff browsing remains available',
			error: message,
			canBuildWithGaps: true
		});
	}

	private cacheContext(): AnalysisCacheContext {
		const manifest = this.requireManifest();
		const baseline = this.requireAdapter().getBaseline();
		return {
			repositoryIdentity: manifest.comparison.repositoryIdentity,
			baselineSessionId: baseline.cacheSessionId,
			baselineTurnId: baseline.cacheTurnId,
			oldRevision: manifest.comparison.oldRevision,
			newRevision: manifest.comparison.newRevision,
			model: baseline.model,
			detailLevel: this.config?.detailLevel ?? 2
		};
	}

	private hydrateAndQueueAnalysis(): void {
		const context = this.cacheContext();
		this.queue = new PrioritizedAnalysisQueue({
			maxConcurrentFiles: 3,
			canRun: (job) => {
				if (this.stale) return false;
				if (job.kind === 'overview' || !this.config?.fullPreparation) return true;
				const file = this.requireManifest().files.find((candidate) => candidate.id === job.fileId);
				return Boolean(file && TERMINAL_STATES.has(file.overviewAnalysis.state));
			},
			run: (job, signal) => this.runAnalysisJob(job, signal),
			onChange: (jobs) => this.emitQueuePositions(jobs)
		});

		for (const file of this.touchedFiles()) {
			if (file.skipReason) continue;
			const overviewKey = overviewCacheKey(context, file);
			this.overviewKeys.set(file.id, overviewKey);
			const cachedOverview = this.cache.get<FileOverview>(overviewKey);
			if (cachedOverview) {
				file.overview = cachedOverview;
				file.overviewAnalysis = { state: 'cached' };
			} else {
				file.overviewAnalysis = { state: this.config?.fullPreparation ? 'queued' : 'idle' };
				if (this.config?.fullPreparation)
					this.queue.add({ id: overviewJobId(file.id), fileId: file.id, kind: 'overview' });
			}

			for (const hunk of file.hunks) {
				const key = hunkCacheKey(context, file, hunk.hash);
				this.hunkKeys.set(hunk.id, key);
				const cached = this.cache.get<HunkExplanation>(key);
				if (cached) {
					hunk.explanation = cached;
					hunk.analysis = { state: 'cached' };
				} else {
					hunk.analysis = { state: this.config?.fullPreparation ? 'queued' : 'idle' };
					if (this.config?.fullPreparation)
						this.queue.add({
							id: hunkJobId(hunk.id),
							fileId: file.id,
							kind: 'hunk',
							hunkId: hunk.id
						});
				}
			}
		}
		this.emitEvent({ type: 'manifest', manifest: this.requireManifest() });
		this.updateProgress();
	}

	private async runAnalysisJob(job: AnalysisJob, signal: AbortSignal): Promise<void> {
		const file = this.fileById(job.fileId);
		try {
			if (job.kind === 'overview') await this.runFileOverview(file, signal);
			else if (job.hunkId)
				await this.runHunkExplanation(file, this.hunkById(job.hunkId).hunk, signal);
		} finally {
			this.updateProgress();
		}
	}

	private async runFileOverview(file: DiffFile, signal: AbortSignal): Promise<void> {
		file.overviewAnalysis = { state: 'running', attempts: 1 };
		this.emitEvent({ type: 'file-updated', file });
		try {
			const thread = await this.ensureFileThread(file.id);
			const overview = await this.requireAdapter().explainFile(
				thread,
				fileOverviewPrompt(file, this.requireManifest(), this.config?.detailLevel ?? 2),
				signal
			);
			file.overview = overview;
			file.overviewAnalysis = { state: 'ready', attempts: 1 };
			const key = this.overviewKeys.get(file.id);
			if (key) this.cache.set('overview', key, overview, { analysisVersion: ANALYSIS_VERSION });
			this.emitEvent({ type: 'file-updated', file });
		} catch (error) {
			file.overviewAnalysis = {
				state: 'failed',
				reason: error instanceof Error ? error.message : 'Overview analysis failed',
				attempts: 3
			};
			this.emitEvent({ type: 'file-updated', file });
			throw error;
		}
	}

	private async runHunkExplanation(
		file: DiffFile,
		hunk: DiffHunk,
		signal: AbortSignal
	): Promise<void> {
		hunk.analysis = { state: 'running', attempts: 1 };
		this.emitEvent({ type: 'hunk-updated', fileId: file.id, hunk });
		try {
			const thread = await this.ensureHunkThread(hunk.id);
			const explanation = await this.requireAdapter().explainHunk(
				thread,
				hunkExplanationPrompt(file, hunk, this.requireManifest(), this.config?.detailLevel ?? 2),
				signal
			);
			hunk.explanation = explanation;
			hunk.analysis = { state: 'ready', attempts: 1 };
			const key = this.hunkKeys.get(hunk.id);
			if (key) this.cache.set('hunk', key, explanation, { analysisVersion: ANALYSIS_VERSION });
			this.emitEvent({ type: 'hunk-updated', fileId: file.id, hunk });
		} catch (error) {
			hunk.analysis = {
				state: 'failed',
				reason: error instanceof Error ? error.message : 'Hunk analysis failed',
				attempts: 3
			};
			this.emitEvent({ type: 'hunk-updated', fileId: file.id, hunk });
			throw error;
		}
	}

	private async ensureFileThread(fileId: string): Promise<ChildThread> {
		const existing = this.fileThreads.get(fileId);
		if (existing) return existing;
		const child = await this.requireAdapter().fork('file');
		this.fileThreads.set(fileId, child);
		return child;
	}

	private async ensureHunkThread(hunkId: string): Promise<ChildThread> {
		const existing = this.hunkThreads.get(hunkId);
		if (existing) return existing;
		const child = await this.requireAdapter().fork('hunk');
		this.hunkThreads.set(hunkId, child);
		return child;
	}

	private emitQueuePositions(jobs: AnalysisJob[]): void {
		const pending = jobs
			.filter((job) => job.state === 'pending')
			.sort((left, right) => right.priority - left.priority || left.enqueuedAt - right.enqueuedAt);
		for (const [index, job] of pending.entries()) {
			this.emitEvent({
				type: 'queue-updated',
				fileId: job.fileId,
				hunkId: job.hunkId,
				position: index + 1
			});
		}
	}

	async prioritizeHunk(
		hunkIdInput: string,
		reasonInput: 'hover' | 'select' | 'story' | 'question'
	): Promise<void> {
		const { hunkId, reason } = prioritizeSchema.parse({ hunkId: hunkIdInput, reason: reasonInput });
		const location = this.hunkById(hunkId);
		this.queue?.prioritize(overviewJobId(location.file.id), reason === 'hover' ? 'hover' : reason);
		this.queue?.prioritize(hunkJobId(hunkId), reason);
	}

	async prioritizeFile(fileIdInput: string): Promise<void> {
		const fileId = fileIdSchema.parse(fileIdInput);
		this.fileById(fileId);
		this.queue?.prioritizeFile(fileId, 'current-file');
	}

	async analyzeAnyway(fileIdInput: string): Promise<void> {
		const fileId = fileIdSchema.parse(fileIdInput);
		const file = this.fileById(fileId);
		if (!this.baselineReady || !this.queue)
			throw new Error('Codex is unavailable for this review.');
		file.skipReason = undefined;
		file.overviewAnalysis = { state: 'queued' };
		const context = this.cacheContext();
		const overviewKey = overviewCacheKey(context, file);
		this.overviewKeys.set(file.id, overviewKey);
		this.cache.delete(overviewKey);
		this.queue.add({ id: overviewJobId(file.id), fileId: file.id, kind: 'overview' });
		this.queue.requeue(overviewJobId(file.id), 'select');
		for (const hunk of file.hunks) {
			hunk.analysis = { state: this.config?.fullPreparation ? 'queued' : 'idle' };
			const key = hunkCacheKey(context, file, hunk.hash);
			this.hunkKeys.set(hunk.id, key);
			if (this.config?.fullPreparation) {
				this.cache.delete(key);
				this.queue.add({ id: hunkJobId(hunk.id), fileId: file.id, kind: 'hunk', hunkId: hunk.id });
				this.queue.requeue(hunkJobId(hunk.id), 'select');
			}
		}
		if (this.currentStoryKey) this.cache.delete(this.currentStoryKey);
		this.story = undefined;
		this.emitEvent({ type: 'file-updated', file });
		this.updateProgress();
	}

	async retryAnalysis(targetInput: { fileId: string; hunkId?: string }): Promise<void> {
		const target = targetSchema.parse(targetInput);
		const file = this.fileById(target.fileId);
		if (!this.queue) throw new Error('Analysis queue is unavailable.');
		if (target.hunkId) {
			const { hunk } = this.hunkById(target.hunkId);
			hunk.analysis = { state: 'queued' };
			this.queue.add({ id: hunkJobId(hunk.id), fileId: file.id, kind: 'hunk', hunkId: hunk.id });
			this.queue.requeue(hunkJobId(hunk.id), 'select');
			this.emitEvent({ type: 'hunk-updated', fileId: file.id, hunk });
		} else {
			file.overviewAnalysis = { state: 'queued' };
			this.queue.add({ id: overviewJobId(file.id), fileId: file.id, kind: 'overview' });
			this.queue.requeue(overviewJobId(file.id), 'select');
			this.emitEvent({ type: 'file-updated', file });
		}
		this.updateProgress();
	}

	async search(optionsInput: SearchOptions): Promise<SearchResponse> {
		const options = searchOptionsSchema.parse(optionsInput) as SearchOptions;
		this.searchController?.abort();
		const controller = new AbortController();
		this.searchController = controller;
		try {
			return await this.requireSnapshot().search(options, controller.signal);
		} finally {
			if (this.searchController === controller) this.searchController = undefined;
		}
	}

	cancelSearch(requestId: string): void {
		void requestId;
		this.searchController?.abort();
	}

	getQa(hunkIdInput: string): QaConversation {
		const hunkId = hunkIdSchema.parse(hunkIdInput);
		this.hunkById(hunkId);
		return this.cache.getQaConversation(hunkId);
	}

	async askHunk(hunkIdInput: string, questionInput: string): Promise<void> {
		const { hunkId, question } = questionSchema.parse({
			hunkId: hunkIdInput,
			question: questionInput
		});
		if (this.qaControllers.has(hunkId))
			throw new Error('A response is already being prepared for this hunk.');
		const location = this.hunkById(hunkId);
		const userMessage: QaMessage = {
			id: `qa-user-${crypto.randomUUID()}`,
			role: 'user',
			content: question,
			createdAt: new Date().toISOString(),
			status: 'complete'
		};
		this.cache.ensureQaConversation(hunkId, !TERMINAL_STATES.has(location.hunk.analysis.state));
		this.cache.upsertQaMessage(hunkId, userMessage);
		this.emitEvent({ type: 'qa-updated', conversation: this.cache.getQaConversation(hunkId) });

		if (!TERMINAL_STATES.has(location.hunk.analysis.state)) {
			if (location.hunk.analysis.state === 'idle')
				await this.retryAnalysis({ fileId: location.file.id, hunkId });
			await this.prioritizeHunk(hunkId, 'question');
			await waitFor(() => TERMINAL_STATES.has(location.hunk.analysis.state), 5 * 60_000);
		}
		const controller = new AbortController();
		this.qaControllers.set(hunkId, controller);
		const assistantMessage: QaMessage = {
			id: `qa-assistant-${crypto.randomUUID()}`,
			role: 'assistant',
			content: '',
			createdAt: new Date().toISOString(),
			status: 'streaming'
		};
		this.cache.upsertQaMessage(hunkId, assistantMessage);
		try {
			const thread = await this.ensureQaThread(location);
			await this.requireAdapter().streamQuestion(
				thread,
				questionPrompt(location.file, location.hunk, question),
				(delta) => {
					assistantMessage.content += delta;
					this.cache.upsertQaMessage(hunkId, assistantMessage);
					this.emitEvent({ type: 'qa-delta', hunkId, messageId: assistantMessage.id, delta });
				},
				controller.signal
			);
			assistantMessage.status = 'complete';
		} catch (error) {
			assistantMessage.status = controller.signal.aborted ? 'cancelled' : 'failed';
			if (!assistantMessage.content && !controller.signal.aborted) {
				assistantMessage.content =
					error instanceof Error ? error.message : 'The answer could not be prepared.';
			}
		} finally {
			this.qaControllers.delete(hunkId);
			this.cache.upsertQaMessage(hunkId, assistantMessage);
			this.emitEvent({ type: 'qa-updated', conversation: this.cache.getQaConversation(hunkId) });
		}
	}

	private async ensureQaThread(location: HunkLocation): Promise<ChildThread> {
		const existing = this.qaThreads.get(location.hunk.id);
		if (existing) return existing;
		const cachedConversation = this.cache.getQaConversation(location.hunk.id);
		if (cachedConversation.threadId) {
			try {
				const resumed = await this.requireAdapter().resumeExisting(cachedConversation.threadId);
				this.qaThreads.set(location.hunk.id, resumed);
				return resumed;
			} catch {
				// Fall through to a new pinned child when the persisted thread no longer exists.
			}
		}
		const explanationThread =
			this.hunkThreads.get(location.hunk.id) ?? this.fileThreads.get(location.file.id);
		let child: ChildThread;
		if (explanationThread) {
			const turnId = await this.requireAdapter().lastCompletedTurn(explanationThread.id);
			child = turnId
				? await this.requireAdapter().fork('qa', {
						threadId: explanationThread.id,
						lastTurnId: turnId
					})
				: await this.requireAdapter().fork('qa');
		} else {
			child = await this.requireAdapter().fork('qa');
		}
		this.qaThreads.set(location.hunk.id, child);
		this.cache.setQaThread(location.hunk.id, child.id);
		return child;
	}

	cancelQa(hunkIdInput: string): void {
		const hunkId = hunkIdSchema.parse(hunkIdInput);
		this.qaControllers.get(hunkId)?.abort();
	}

	async buildStory(withGaps = false): Promise<StoryPlan> {
		if (this.stale) throw new Error('Reload the stale review before building a story.');
		if (this.storyGenerating) throw new Error('Story preparation is already in progress.');
		return this.generateStory(withGaps);
	}

	private async generateStory(withGaps: boolean): Promise<StoryPlan> {
		if (this.story && (!this.story.generatedWithGaps || withGaps)) return this.story;
		this.storyGenerating = true;
		const files = this.touchedFiles();
		this.emitProgress({ phase: 'story', completed: 0, total: 1, label: 'Preparing story' });
		try {
			const fallback = fallbackStory(files, withGaps);
			if (!this.baselineReady || !this.adapter || files.length === 0) {
				this.finishStory(fallback);
				return fallback;
			}
			const analysisKeys = storyAnalysisKeys(files, this.overviewKeys, this.hunkKeys);
			const key = storyCacheKey(this.cacheContext(), analysisKeys);
			this.currentStoryKey = key;
			const cached = this.cache.get<StoryPlan>(key);
			if (cached && isValidStoryOrder(cached.fileIds, files)) {
				cached.generatedWithGaps = withGaps || cached.generatedWithGaps;
				this.finishStory(cached);
				return cached;
			}

			let plan: StoryPlan;
			try {
				const thread = await this.requireAdapter().fork('story');
				plan = await this.requireAdapter().planStory(thread, storyPrompt(files, withGaps));
				if (!isValidStoryOrder(plan.fileIds, files)) {
					plan = await this.requireAdapter().planStory(
						thread,
						storyRepairPrompt(files, plan.fileIds, withGaps)
					);
				}
				if (!isValidStoryOrder(plan.fileIds, files)) plan = fallback;
			} catch {
				plan = fallback;
			}
			plan.generatedWithGaps = withGaps;
			this.cache.set('story', key, plan, { analysisVersion: ANALYSIS_VERSION });
			this.finishStory(plan);
			return plan;
		} finally {
			this.storyGenerating = false;
		}
	}

	private finishStory(plan: StoryPlan): void {
		this.story = plan;
		this.storyState = { active: false, plan };
		this.storySequence = makeStorySequence(plan, this.requireManifest().files);
		this.storyCursor = 0;
		this.emitEvent({ type: 'story-updated', story: this.storyState });
		this.emitProgress({ phase: 'complete', completed: 1, total: 1, label: 'Story Mode' });
	}

	async enterStory(): Promise<StoryState> {
		if (!this.story) await this.generateStory(false);
		this.storyCursor = 0;
		this.storyState = {
			active: true,
			plan: this.story,
			step: this.storyStepAt(this.storyCursor)
		};
		this.emitEvent({ type: 'story-updated', story: this.storyState });
		const hunkId = this.storyState.step?.hunkId;
		if (hunkId) await this.prioritizeHunk(hunkId, 'story');
		return this.storyState;
	}

	async navigateStory(directionInput: 'previous' | 'next'): Promise<StoryState> {
		const direction = storyDirectionSchema.parse(directionInput);
		if (!this.storyState.active) throw new Error('Story Mode is not active.');
		this.storyCursor = Math.max(
			0,
			Math.min(this.storySequence.length - 1, this.storyCursor + (direction === 'next' ? 1 : -1))
		);
		this.storyState = { active: true, plan: this.story, step: this.storyStepAt(this.storyCursor) };
		this.emitEvent({ type: 'story-updated', story: this.storyState });
		const hunkId = this.storyState.step?.hunkId;
		if (hunkId) await this.prioritizeHunk(hunkId, 'story');
		return this.storyState;
	}

	stopStory(): void {
		this.storyState = { active: false, plan: this.story };
		this.emitEvent({ type: 'story-updated', story: this.storyState });
	}

	private storyStepAt(cursor: number): StoryStep | undefined {
		const value = this.storySequence[cursor];
		if (!value) return undefined;
		return { index: cursor + 1, total: this.storySequence.length, ...value };
	}

	getCacheInfo() {
		return this.cache.info();
	}

	clearCache() {
		return this.cache.clear();
	}

	private updateProgress(): void {
		if (!this.manifest || this.storyGenerating) return;
		const files = this.touchedFiles();
		if (!this.config?.fullPreparation) {
			const requestedOverviews = files.filter((file) => file.overviewAnalysis.state !== 'idle');
			const requestedHunks = files
				.flatMap((file) => file.hunks)
				.filter((hunk) => hunk.analysis.state !== 'idle');
			const overviewDone = requestedOverviews.filter((file) =>
				TERMINAL_STATES.has(file.overviewAnalysis.state)
			).length;
			const detailsDone = requestedHunks.filter((hunk) =>
				TERMINAL_STATES.has(hunk.analysis.state)
			).length;
			if (overviewDone < requestedOverviews.length) {
				this.emitProgress({
					phase: 'overview',
					completed: overviewDone,
					total: requestedOverviews.length,
					label: `Preparing requested overview (${overviewDone}/${requestedOverviews.length})`
				});
			} else if (detailsDone < requestedHunks.length) {
				this.emitProgress({
					phase: 'details',
					completed: detailsDone,
					total: requestedHunks.length,
					label: `Preparing requested hunk (${detailsDone}/${requestedHunks.length})`
				});
			} else {
				this.emitProgress({
					phase: 'idle',
					completed: 0,
					total: 0,
					label: 'Review ready · analysis on demand'
				});
			}
			return;
		}
		const overviewDone = files.filter((file) =>
			TERMINAL_STATES.has(file.overviewAnalysis.state)
		).length;
		const hunks = files.flatMap((file) => file.hunks);
		const detailsDone = hunks.filter((hunk) => TERMINAL_STATES.has(hunk.analysis.state)).length;
		const failed = files.some(
			(file) =>
				file.overviewAnalysis.state === 'failed' ||
				file.hunks.some((hunk) => hunk.analysis.state === 'failed')
		);
		if (overviewDone < files.length) {
			this.emitProgress({
				phase: 'overview',
				completed: overviewDone,
				total: files.length,
				label: `Preparing overview (${overviewDone}/${files.length})`,
				warning: this.stale ? 'Source changed — reload to continue' : undefined
			});
			return;
		}
		if (detailsDone < hunks.length) {
			this.emitProgress({
				phase: 'details',
				completed: detailsDone,
				total: hunks.length,
				label: `Preparing details (${detailsDone}/${hunks.length})`,
				warning: this.stale ? 'Source changed — reload to continue' : undefined
			});
			return;
		}
		if (failed) {
			this.emitProgress({
				phase: 'error',
				completed: detailsDone,
				total: hunks.length,
				label: 'Analysis finished with gaps',
				warning: 'Retry failed items or build the story with explicit gaps.',
				canBuildWithGaps: true
			});
			return;
		}
		if (!this.story && !this.storyGenerating && !this.stale) void this.generateStory(false);
	}

	private emitProgress(progress: ReviewProgress): void {
		this.emitEvent({ type: 'progress', progress });
	}

	private recordCodexUsage(usage: CodexUsageSummary): void {
		this.codexUsage = addCodexUsage(this.codexUsage, usage);
		this.emitEvent({ type: 'codex-usage', usage: this.codexUsage });
	}

	private startStaleMonitor(): void {
		if (this.staleTimer) clearInterval(this.staleTimer);
		let checking = false;
		this.staleTimer = setInterval(() => {
			if (checking || this.stopped || this.stale || !this.snapshot) return;
			checking = true;
			void this.snapshot
				.currentSourceFingerprint()
				.then((fingerprint) => {
					if (this.initialSourceFingerprint && fingerprint !== this.initialSourceFingerprint) {
						this.stale = true;
						if (this.manifest) this.manifest.stale = true;
						this.queue?.setPaused(true);
						this.emitEvent({
							type: 'stale',
							stale: true,
							reason:
								'HEAD, the index, or tracked working files changed after this snapshot was created.'
						});
						this.updateProgress();
					}
				})
				.catch(() => undefined)
				.finally(() => {
					checking = false;
				});
		}, 1_500);
		this.staleTimer.unref();
	}

	private requireSnapshot(): FrozenGitSnapshot {
		if (!this.snapshot) throw new Error('No review is open.');
		return this.snapshot;
	}

	private requireManifest(): ReviewManifest {
		if (!this.manifest) throw new Error('No review is open.');
		return this.manifest;
	}

	private requireAdapter(): CodexAdapter {
		if (!this.adapter || !this.baselineReady)
			throw new Error('Codex is unavailable for this review.');
		return this.adapter;
	}

	private touchedFiles(): DiffFile[] {
		return this.requireManifest().files.filter((file) => file.status !== 'unchanged');
	}

	private fileById(fileId: string): DiffFile {
		const file = this.requireManifest().files.find((candidate) => candidate.id === fileId);
		if (!file) throw new Error('Unknown file ID.');
		return file;
	}

	private hunkById(hunkId: string): HunkLocation {
		for (const file of this.requireManifest().files) {
			const hunk = file.hunks.find((candidate) => candidate.id === hunkId);
			if (hunk) return { file, hunk };
		}
		throw new Error('Unknown hunk ID.');
	}

	dispose(): void {
		void this.closeReview().finally(() => this.cache.close());
	}
}

function overviewJobId(fileId: string): string {
	return `overview:${fileId}`;
}

function hunkJobId(hunkId: string): string {
	return `hunk:${hunkId}`;
}

function fileOverviewPrompt(file: DiffFile, manifest: ReviewManifest, detailLevel: number): string {
	return `Explain the role of one changed file and summarize why and how it changed.

Repository comparison: ${manifest.comparison.oldRevision} -> ${manifest.comparison.newRevision}
Status: ${file.status}
Old path: ${file.oldPath ?? '(none)'}
New path: ${file.newPath ?? '(none)'}
Language: ${file.language}
Git hunks: ${file.hunks.length}

Inspect the frozen repository and this file's Git diff as needed. "role" should describe the file's place in the project. "whyChanged" should describe the intent evident in this comparison. "howChanged" should concisely describe the implementation mechanics.

${detailInstruction(detailLevel, 'overview')}
Explain only; do not review for defects.`;
}

function hunkExplanationPrompt(
	file: DiffFile,
	hunk: DiffHunk,
	manifest: ReviewManifest,
	detailLevel: number
): string {
	const patch =
		hunk.canonicalPatch.length > 200_000
			? `${hunk.canonicalPatch.slice(0, 200_000)}\n[truncated]`
			: hunk.canonicalPatch;
	return `Explain this single Git hunk. The prompt is self-contained and must not depend on other hunk turns.

Comparison: ${manifest.comparison.oldRevision} -> ${manifest.comparison.newRevision}
File: ${file.path}
Status: ${file.status}
File role: ${file.overview?.role ?? 'Overview unavailable'}
File change intent: ${file.overview?.whyChanged ?? 'Overview unavailable'}
Hunk: ${hunk.header}

${patch}

Return a short title, a summary covering purpose and mechanics, and an expanded explanation.
${detailInstruction(detailLevel, 'hunk')}
Explain only and do not report findings.`;
}

function detailInstruction(level: number, kind: 'overview' | 'hunk'): string {
	const instructions =
		kind === 'overview'
			? [
					'Use fragments where clear. Keep each field to at most 8 words.',
					'Keep each field to one concise sentence of roughly 12–20 words.',
					'Keep each field to one or two short sentences.',
					'Use up to three sentences per field when useful.',
					'Provide comprehensive detail, using several sentences per field when useful.'
				]
			: [
					'Use a one-sentence summary and an expanded explanation of at most 30 words.',
					'Use a one- or two-sentence summary and an expanded explanation of roughly 40–70 words.',
					'Use a two-to-four sentence summary and a focused expanded explanation.',
					'Use a detailed summary and expanded explanation covering relevant mechanics and context.',
					'Provide a comprehensive summary and expanded explanation with all useful context and mechanics.'
				];
	return `Explanation size is ${level}/5. ${instructions[Math.max(1, Math.min(5, level)) - 1]}`;
}

function questionPrompt(file: DiffFile, hunk: DiffHunk, question: string): string {
	const patch =
		hunk.canonicalPatch.length > 200_000
			? `${hunk.canonicalPatch.slice(0, 200_000)}\n[truncated]`
			: hunk.canonicalPatch;
	return `Answer a question about one changed hunk. Stay explanation-only and grounded in the frozen snapshot.

File: ${file.path}
File role: ${file.overview?.role ?? 'Unavailable'}
Change summary: ${file.overview?.whyChanged ?? 'Unavailable'}
Hunk explanation: ${hunk.explanation?.expandedExplanation ?? 'Unavailable'}
Patch:
${patch}

Question: ${question}`;
}

function storyPrompt(files: DiffFile[], withGaps: boolean): string {
	const descriptions = files.map((file) => ({
		id: file.id,
		path: file.path,
		status: file.status,
		role: file.overview?.role ?? '[overview unavailable]',
		why: file.overview?.whyChanged ?? '[change summary unavailable]',
		hunks: file.hunks.map((hunk) => hunk.explanation?.title ?? `[${hunk.analysis.state} hunk]`)
	}));
	return `Create a teaching order for all touched files in this change. Include every supplied file ID exactly once and no other IDs. Prefer foundations/configuration/schemas/shared types, then core behavior, integrations/callers/routes/UI, tests, and documentation/generated artifacts. Provide a short transition into each file. ${withGaps ? 'Some analysis is unavailable; retain those files and explicitly bridge the gap.' : ''}

Files:
${JSON.stringify(descriptions)}`;
}

function storyRepairPrompt(files: DiffFile[], invalidOrder: string[], withGaps: boolean): string {
	return `Repair the previous story order. It was invalid: ${JSON.stringify(invalidOrder)}. Return each of these IDs exactly once and no others: ${JSON.stringify(files.map((file) => file.id))}. ${withGaps ? 'Keep files with missing analysis.' : ''}`;
}

function isValidStoryOrder(order: string[], files: DiffFile[]): boolean {
	const expected = new Set(files.map((file) => file.id));
	return (
		order.length === expected.size &&
		new Set(order).size === expected.size &&
		order.every((id) => expected.has(id))
	);
}

function fallbackStory(files: DiffFile[], withGaps: boolean): StoryPlan {
	const ordered = [...files].sort((left, right) => {
		const group = storyGroup(left.path) - storyGroup(right.path);
		return group || left.path.localeCompare(right.path, undefined, { numeric: true });
	});
	return {
		title: 'A guided tour of this change',
		summary: withGaps
			? 'A deterministic walkthrough of every touched file, including explicit analysis gaps.'
			: 'A dependency-aware walkthrough from foundations through behavior, integration, tests, and documentation.',
		fileIds: ordered.map((file) => file.id),
		transitions: ordered.map((file, index) => ({
			fromFileId: index ? ordered[index - 1].id : undefined,
			toFileId: file.id,
			text: file.overview?.role ?? `Continue with ${file.path}.`
		})),
		generatedWithGaps: withGaps
	};
}

function storyGroup(filePath: string): number {
	const lower = filePath.toLowerCase();
	if (
		/(^|\/)(?:package\.json|.*config|schema|types?|migrations?|constants?)(?:\.|\/|$)/.test(lower)
	)
		return 0;
	if (/(^|\/)(?:test|tests|__tests__|spec|e2e)(\/|\.|$)|\.(?:test|spec)\./.test(lower)) return 3;
	if (/(^|\/)(?:docs?|readme|changelog)(\/|\.|$)|\.md$/.test(lower)) return 4;
	if (
		/(^|\/)(?:routes?|components?|ui|views?|pages?)(\/|\.|$)|\.(?:svelte|vue|tsx|jsx)$/.test(lower)
	)
		return 2;
	return 1;
}

function storyAnalysisKeys(
	files: DiffFile[],
	overviewKeys: Map<string, string>,
	hunkKeys: Map<string, string>
): string[] {
	const keys: string[] = [];
	for (const file of files) {
		keys.push(overviewKeys.get(file.id) ?? `${file.id}:${file.overviewAnalysis.state}`);
		for (const hunk of file.hunks)
			keys.push(hunkKeys.get(hunk.id) ?? `${hunk.id}:${hunk.analysis.state}`);
	}
	return keys;
}

function makeStorySequence(
	plan: StoryPlan,
	files: DiffFile[]
): Array<{ fileId: string; hunkId?: string; overviewPart?: StoryStep['overviewPart'] }> {
	const byId = new Map(files.map((file) => [file.id, file]));
	const sequence: Array<{
		fileId: string;
		hunkId?: string;
		overviewPart?: StoryStep['overviewPart'];
	}> = [];
	for (const fileId of plan.fileIds) {
		const file = byId.get(fileId);
		if (!file) continue;
		sequence.push({ fileId, overviewPart: 'role' });
		sequence.push({ fileId, overviewPart: 'whyChanged' });
		sequence.push({ fileId, overviewPart: 'howChanged' });
		for (const hunk of file.hunks) sequence.push({ fileId, hunkId: hunk.id });
	}
	return sequence;
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const timer = setInterval(() => {
			if (predicate()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				reject(new Error('Timed out while preparing hunk context.'));
			}
		}, 100);
	});
}
