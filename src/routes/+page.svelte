<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import {
		AlertTriangle,
		Binary,
		Braces,
		ChevronRight,
		CircleEllipsis,
		FileCode2,
		FolderTree,
		GitCompareArrows,
		GitCommitHorizontal,
		LoaderCircle,
		PanelLeftClose,
		PanelLeftOpen,
		RotateCcw,
		Search,
		Settings2,
		Sparkles,
		X
	} from '@lucide/svelte';
	import DiffViewer from '$lib/components/DiffViewer.svelte';
	import FilePalette from '$lib/components/FilePalette.svelte';
	import FileTree from '$lib/components/FileTree.svelte';
	import HunkPopover from '$lib/components/HunkPopover.svelte';
	import InlineCodeText from '$lib/components/InlineCodeText.svelte';
	import ProgressControl from '$lib/components/ProgressControl.svelte';
	import RangeCommitDialog from '$lib/components/RangeCommitDialog.svelte';
	import QaPanel from '$lib/components/QaPanel.svelte';
	import SearchPanel from '$lib/components/SearchPanel.svelte';
	import SettingsDialog from '$lib/components/SettingsDialog.svelte';
	import SetupScreen from '$lib/components/SetupScreen.svelte';
	import StoryToolbar from '$lib/components/StoryToolbar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import RoleSpeechButton from '$lib/components/RoleSpeechButton.svelte';
	import { DEFAULT_MODEL } from '$lib/shared/models';
	import { EMPTY_CODEX_USAGE } from '$lib/shared/codex-usage';
	import type {
		DiffFile,
		DiffHunk,
		FileContent,
		QaConversation,
		ReviewConfig,
		ReviewEvent,
		ReviewManifest,
		ReviewProgress,
		RangeReviewState,
		SearchOptions,
		SearchResponse,
		SearchResult,
		StoryState,
		ValidationResult,
		CodexUsageSummary
	} from '$lib/shared/types';

	const EMPTY_PROGRESS: ReviewProgress = {
		phase: 'idle',
		completed: 0,
		total: 1,
		label: 'Indexing'
	};

	let booting = true;
	let bootLabel = 'Opening Codex Review';
	let setupVisible = true;
	let initialConfig: Partial<ReviewConfig> = {
		mode: 'commit',
		model: DEFAULT_MODEL,
		detailLevel: 2,
		fullPreparation: false
	};
	let validation: ValidationResult | null = null;
	let validating = false;
	let starting = false;
	let manifest: ReviewManifest | null = null;
	let progress = EMPTY_PROGRESS;
	let codexUsage: CodexUsageSummary = { ...EMPTY_CODEX_USAGE };
	let story: StoryState = { active: false };
	let selectedFileId: string | null = null;
	let fileContent: FileContent | null = null;
	let fileLoading = false;
	let fileError = '';
	let viewer: DiffViewer;
	let fileTree: FileTree;
	let fileHeader: HTMLElement;
	let sidebarWidth = 286;
	let sidebarCollapsed = false;
	let paletteOpen = false;
	let paletteOriginalFileId: string | null = null;
	let searchOpen = false;
	let searchBusy = false;
	let searchResponse: SearchResponse | null = null;
	let reviewMenuOpen = false;
	let settingsDialogOpen = false;
	let rangeDialogOpen = false;
	let rangeReviewState: RangeReviewState | null = null;
	let openingRangeItemId: string | null = null;
	let selectedHunkId: string | null = null;
	let popoverHunk: DiffHunk | null = null;
	let popoverAnchor = { x: 0, y: 0 };
	let popoverPinned = false;
	let popoverTranslucent = false;
	let qaOpen = false;
	let qaConversation: QaConversation | null = null;
	let qaBusy = false;
	let staleReason = '';
	let fatalError = '';
	let banner: { path: string; role?: string } | null = null;
	let bannerTimer: ReturnType<typeof setTimeout> | undefined;
	let storyNavigationKey = '';
	let storyNavigationPending = false;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeSpeech: (() => void) | undefined;
	let storyAudioState: 'idle' | 'loading' | 'playing' | 'paused' | 'error' = 'idle';
	let storyAudioPaused = false;
	let openToken = 0;
	const contentCache = new Map<string, FileContent>();

	$: selectedFile = manifest?.files.find((file) => file.id === selectedFileId) ?? null;
	$: selectedHunk = selectedFile?.hunks.find((hunk) => hunk.id === selectedHunkId) ?? null;
	$: storyFileId = story.active ? (story.step?.fileId ?? null) : null;

	onMount(() => {
		window.addEventListener('keydown', globalKeydown);
		void initialize();
	});

	onDestroy(() => {
		unsubscribe?.();
		unsubscribeSpeech?.();
		window.removeEventListener('keydown', globalKeydown);
		if (bannerTimer) clearTimeout(bannerTimer);
		void window.reviewApi?.stopSpeech();
	});

	async function initialize() {
		if (!window.reviewApi) {
			fatalError = 'Codex Review must run inside its Electron desktop shell.';
			booting = false;
			return;
		}
		unsubscribe = window.reviewApi.onEvent(handleEvent);
		unsubscribeSpeech = window.reviewApi.onSpeechEvent((event) => {
			if (event.type === 'playback' && story.active)
				storyAudioState = event.state === 'stopped' ? 'idle' : event.state;
		});
		try {
			initialConfig = await window.reviewApi.initialConfig();
			if (
				initialConfig.root &&
				initialConfig.revision &&
				(initialConfig.sessionId || initialConfig.contextMessage)
			) {
				const config = completeConfig(initialConfig);
				bootLabel = 'Validating comparison';
				validating = true;
				validation = await window.reviewApi.validateConfig(config);
				validating = false;
				if (validation.valid) {
					bootLabel = 'Preparing review...';
					await startReview(config);
				}
			}
		} catch (error) {
			fatalError = messageOf(error);
		} finally {
			validating = false;
			booting = false;
		}
	}

	function completeConfig(value: Partial<ReviewConfig>): ReviewConfig {
		return {
			root: value.root ?? '',
			revision: value.revision ?? '',
			sessionId: value.sessionId,
			contextMessage: value.contextMessage,
			mode: value.mode ?? 'commit',
			model: value.model ?? DEFAULT_MODEL,
			detailLevel: value.detailLevel ?? 2,
			fullPreparation: value.fullPreparation ?? false
		};
	}

	async function validate(config: ReviewConfig) {
		validating = true;
		fatalError = '';
		try {
			validation = await window.reviewApi.validateConfig(config);
		} catch (error) {
			validation = { valid: false, issues: [{ field: 'general', message: messageOf(error) }] };
		} finally {
			validating = false;
		}
	}

	async function startReview(config: ReviewConfig) {
		starting = true;
		fatalError = '';
		initialConfig = config;
		codexUsage = { ...EMPTY_CODEX_USAGE };
		try {
			const result = await window.reviewApi.startReview(config);
			manifest = result.manifest;
			rangeReviewState = await window.reviewApi.getRangeReviewState();
			setupVisible = false;
			const first =
				result.manifest.files.find((file) => file.status !== 'unchanged') ??
				result.manifest.files[0];
			if (first) await openFile(first.id);
		} catch (error) {
			fatalError = messageOf(error);
		} finally {
			starting = false;
		}
	}

	function handleEvent(event: ReviewEvent) {
		switch (event.type) {
			case 'progress':
				progress = event.progress;
				break;
			case 'codex-usage':
				codexUsage = event.usage;
				break;
			case 'manifest':
				manifest = event.manifest;
				if (selectedFileId && !manifest.files.some((file) => file.id === selectedFileId))
					selectedFileId = null;
				break;
			case 'file-updated':
				updateFile(event.file);
				break;
			case 'hunk-updated':
				updateHunk(event.fileId, event.hunk);
				break;
			case 'queue-updated':
				if (event.hunkId) updateQueuePosition(event.fileId, event.hunkId, event.position);
				break;
			case 'qa-updated':
				if (
					qaConversation?.hunkId === event.conversation.hunkId ||
					selectedHunkId === event.conversation.hunkId
				) {
					qaConversation = event.conversation;
				}
				break;
			case 'qa-delta':
				applyQaDelta(event.hunkId, event.messageId, event.delta);
				break;
			case 'story-updated':
				story = event.story;
				if (story.active) void followStoryStep(story);
				break;
			case 'stale':
				staleReason = event.stale ? (event.reason ?? 'The source repository changed.') : '';
				break;
			case 'warning':
				fatalError = event.message;
				break;
			case 'fatal-error':
				fatalError = event.detail ? `${event.message} ${event.detail}` : event.message;
				break;
		}
	}

	function updateFile(file: DiffFile) {
		if (!manifest) return;
		manifest = {
			...manifest,
			files: manifest.files.map((candidate) => (candidate.id === file.id ? file : candidate))
		};
		if (popoverHunk && file.id === selectedFileId)
			popoverHunk = file.hunks.find((hunk) => hunk.id === popoverHunk?.id) ?? null;
	}

	function updateHunk(fileId: string, hunk: DiffHunk) {
		if (!manifest) return;
		manifest = {
			...manifest,
			files: manifest.files.map((file) =>
				file.id === fileId
					? {
							...file,
							hunks: file.hunks.map((candidate) => (candidate.id === hunk.id ? hunk : candidate))
						}
					: file
			)
		};
		if (popoverHunk?.id === hunk.id) popoverHunk = hunk;
	}

	function updateQueuePosition(fileId: string, hunkId: string, position: number) {
		if (!manifest) return;
		const file = manifest.files.find((candidate) => candidate.id === fileId);
		const hunk = file?.hunks.find((candidate) => candidate.id === hunkId);
		if (!file || !hunk || hunk.analysis.queuePosition === position) return;
		updateHunk(fileId, { ...hunk, analysis: { ...hunk.analysis, queuePosition: position } });
	}

	function applyQaDelta(hunkId: string, messageId: string, delta: string) {
		if (!qaConversation || qaConversation.hunkId !== hunkId) return;
		const existing = qaConversation.messages.find((message) => message.id === messageId);
		if (existing) {
			qaConversation = {
				...qaConversation,
				messages: qaConversation.messages.map((message) =>
					message.id === messageId ? { ...message, content: message.content + delta } : message
				)
			};
		} else {
			qaConversation = {
				...qaConversation,
				messages: [
					...qaConversation.messages,
					{
						id: messageId,
						role: 'assistant',
						content: delta,
						createdAt: new Date().toISOString(),
						status: 'streaming'
					}
				]
			};
		}
	}

	async function openFile(fileId: string) {
		if (!story.active && selectedFileId && selectedFileId !== fileId)
			void window.reviewApi.stopSpeech();
		const token = ++openToken;
		selectedFileId = fileId;
		fileError = '';
		if (!story.active) closePopover();
		void window.reviewApi.prioritizeFile(fileId).catch(() => undefined);
		const cached = contentCache.get(fileId);
		if (cached) {
			fileContent = cached;
			fileLoading = false;
			return;
		}
		fileLoading = true;
		fileContent = null;
		try {
			const content = await window.reviewApi.loadFile(fileId);
			contentCache.set(fileId, content);
			if (token === openToken) fileContent = content;
		} catch (error) {
			if (token === openToken) fileError = messageOf(error);
		} finally {
			if (token === openToken) fileLoading = false;
		}
	}

	function selectHunk(hunk: DiffHunk, anchor: { x: number; y: number }) {
		selectedHunkId = hunk.id;
		popoverHunk = hunk;
		popoverAnchor = anchor;
		popoverPinned = true;
		popoverTranslucent = true;
		void window.reviewApi.prioritizeHunk(hunk.id, 'select');
		if (qaOpen) void loadQa(hunk.id);
	}

	function closePopover() {
		popoverPinned = false;
		popoverTranslucent = false;
		popoverHunk = null;
		if (!story.active) selectedHunkId = null;
	}

	async function openQa() {
		if (!popoverHunk) return;
		qaOpen = true;
		selectedHunkId = popoverHunk.id;
		await loadQa(popoverHunk.id);
	}

	async function loadQa(hunkId: string) {
		try {
			qaConversation = await window.reviewApi.getQa(hunkId);
		} catch (error) {
			fatalError = messageOf(error);
		}
	}

	async function askQuestion(question: string) {
		if (!selectedHunkId) return;
		qaBusy = true;
		try {
			await window.reviewApi.askHunk(selectedHunkId, question);
		} catch (error) {
			fatalError = messageOf(error);
		} finally {
			qaBusy = false;
		}
	}

	function cancelQuestion() {
		if (selectedHunkId) void window.reviewApi.cancelQa(selectedHunkId);
	}

	async function runSearch(options: SearchOptions) {
		searchBusy = true;
		try {
			searchResponse = await window.reviewApi.search(options);
		} catch (error) {
			if (!messageOf(error).toLowerCase().includes('cancel')) fatalError = messageOf(error);
		} finally {
			searchBusy = false;
		}
	}

	async function selectSearchResult(result: SearchResult) {
		await openFile(result.fileId);
		await tick();
		setTimeout(() => viewer?.revealLine(result.line), 80);
	}

	async function enterStory() {
		try {
			story = await window.reviewApi.enterStory();
			await followStoryStep(story);
		} catch (error) {
			fatalError = messageOf(error);
		}
	}

	async function buildStoryWithGaps() {
		try {
			await window.reviewApi.buildStory(true);
			await enterStory();
		} catch (error) {
			fatalError = messageOf(error);
		}
	}

	async function navigateStory(direction: 'previous' | 'next') {
		if (storyNavigationPending) return;
		storyNavigationPending = true;
		try {
			story = await window.reviewApi.navigateStory(direction);
			await followStoryStep(story);
		} catch (error) {
			fatalError = messageOf(error);
		} finally {
			storyNavigationPending = false;
		}
	}

	function stopStory() {
		void window.reviewApi.stopStory();
		void window.reviewApi.stopSpeech();
		storyAudioState = 'idle';
		storyAudioPaused = false;
		story = { active: false, plan: story.plan };
		banner = null;
		closePopover();
	}

	async function followStoryStep(nextStory: StoryState) {
		const step = nextStory.step;
		if (!nextStory.active || !step || !manifest) return;
		const key = `${step.fileId}:${step.hunkId ?? step.overviewPart ?? 'overview'}`;
		if (key === storyNavigationKey) return;
		storyNavigationKey = key;
		const file = manifest.files.find((candidate) => candidate.id === step.fileId);
		if (!file) return;
		const changedFile = selectedFileId !== file.id;
		if (changedFile) {
			banner = { path: file.path, role: file.overview?.role };
			if (bannerTimer) clearTimeout(bannerTimer);
			bannerTimer = setTimeout(() => (banner = null), 3_000);
		}
		await openFile(file.id);
		await tick();
		if (changedFile) {
			sidebarCollapsed = false;
			await tick();
			await fileTree?.revealFile(file.id);
		}
		fileHeader?.scrollIntoView({ block: 'start', behavior: 'auto' });
		if (step.hunkId) {
			const hunk = file.hunks.find((candidate) => candidate.id === step.hunkId);
			if (hunk) {
				selectedHunkId = hunk.id;
				popoverHunk = hunk;
				popoverPinned = true;
				popoverTranslucent = false;
				popoverAnchor = { x: Math.max(340, window.innerWidth - 410), y: 118 };
			}
			const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			setTimeout(
				() => viewer?.revealHunk(step.hunkId as string, true),
				reduced ? 0 : changedFile ? 420 : 80
			);
		} else {
			closePopover();
		}
		await window.reviewApi.stopSpeech();
		const narration = storyNarration(step);
		if (narration && !storyAudioPaused) {
			storyAudioState = 'loading';
			try {
				await window.reviewApi.playRole(narration);
			} catch (error) {
				if (storyNavigationKey === key) {
					storyAudioState = 'error';
					fatalError = messageOf(error);
				}
			}
		}
		if (storyNavigationKey !== key) return;
		const upcoming = upcomingStoryNarrations(step.index, 5);
		if (upcoming.length) void window.reviewApi.prepareSpeech(upcoming).catch(() => undefined);
	}

	function storyNarration(step: NonNullable<StoryState['step']>): string | undefined {
		const file = manifest?.files.find((candidate) => candidate.id === step.fileId);
		if (!file) return undefined;
		if (step.overviewPart) return file.overview?.[step.overviewPart];
		if (step.hunkId) {
			const explanation = file.hunks.find((hunk) => hunk.id === step.hunkId)?.explanation;
			return explanation?.expandedExplanation ?? explanation?.summary;
		}
	}

	function allStoryNarrations(): string[] {
		if (!manifest || !story.plan) return [];
		const result: string[] = [];
		for (const fileId of story.plan.fileIds) {
			const file = manifest.files.find((candidate) => candidate.id === fileId);
			if (!file) continue;
			result.push(
				file.overview?.role ?? '',
				file.overview?.whyChanged ?? '',
				file.overview?.howChanged ?? ''
			);
			for (const hunk of file.hunks)
				result.push(hunk.explanation?.expandedExplanation ?? hunk.explanation?.summary ?? '');
		}
		return result;
	}
	function upcomingStoryNarrations(currentIndex: number, count: number): string[] {
		return allStoryNarrations()
			.slice(currentIndex, currentIndex + count)
			.filter(Boolean);
	}
	async function toggleStoryAudio() {
		if (storyAudioState === 'paused') {
			storyAudioPaused = false;
			await window.reviewApi.resumeSpeech();
		} else if (storyAudioState === 'loading') {
			storyAudioPaused = true;
			await window.reviewApi.stopSpeech();
			storyAudioState = 'idle';
		} else if (storyAudioState === 'playing') {
			storyAudioPaused = true;
			await window.reviewApi.pauseSpeech();
		} else if (story.step) {
			storyAudioPaused = false;
			const text = storyNarration(story.step);
			if (text) await window.reviewApi.playRole(text);
		}
	}

	async function reloadReview() {
		staleReason = '';
		contentCache.clear();
		fileContent = null;
		progress = EMPTY_PROGRESS;
		codexUsage = { ...EMPTY_CODEX_USAGE };
		try {
			const result = await window.reviewApi.reloadReview();
			manifest = result.manifest;
			rangeReviewState = await window.reviewApi.getRangeReviewState();
			const first = manifest.files.find((file) => file.status !== 'unchanged') ?? manifest.files[0];
			if (first) await openFile(first.id);
		} catch (error) {
			fatalError = messageOf(error);
		}
	}

	async function newReview() {
		reviewMenuOpen = false;
		settingsDialogOpen = false;
		rangeDialogOpen = false;
		await window.reviewApi.closeReview();
		manifest = null;
		rangeReviewState = null;
		selectedFileId = null;
		fileContent = null;
		validation = null;
		progress = EMPTY_PROGRESS;
		setupVisible = true;
	}

	function openFilePalette() {
		if (paletteOpen) return;
		paletteOriginalFileId = selectedFileId;
		paletteOpen = true;
	}

	async function commitFilePalette(fileId: string) {
		paletteOpen = false;
		paletteOriginalFileId = null;
		if (selectedFileId !== fileId) await openFile(fileId);
		sidebarCollapsed = false;
		await tick();
		await fileTree?.revealFile(fileId);
	}

	function cancelFilePalette() {
		const originalFileId = paletteOriginalFileId;
		paletteOpen = false;
		paletteOriginalFileId = null;
		if (originalFileId && selectedFileId !== originalFileId) {
			void openFile(originalFileId);
		} else if (!originalFileId && selectedFileId) {
			openToken += 1;
			selectedFileId = null;
			fileContent = null;
			fileLoading = false;
		}
	}

	function openSettings() {
		reviewMenuOpen = false;
		settingsDialogOpen = true;
	}

	async function openRangeDialog() {
		fatalError = '';
		try {
			rangeReviewState = await window.reviewApi.getRangeReviewState();
			if (rangeReviewState) rangeDialogOpen = true;
		} catch (error) {
			fatalError = messageOf(error);
		}
	}

	async function openRangeItem(itemId: string) {
		if (openingRangeItemId) return;
		openingRangeItemId = itemId;
		fatalError = '';
		try {
			await window.reviewApi.stopSpeech();
			if (story.active) await window.reviewApi.stopStory();
			story = { active: false };
			storyAudioState = 'idle';
			searchOpen = false;
			qaOpen = false;
			closePopover();
			contentCache.clear();
			selectedFileId = null;
			fileContent = null;
			progress = EMPTY_PROGRESS;
			codexUsage = { ...EMPTY_CODEX_USAGE };
			const result = await window.reviewApi.openRangeReviewItem(itemId);
			manifest = result.review.manifest;
			rangeReviewState = result.range;
			const first = manifest.files.find((file) => file.status !== 'unchanged') ?? manifest.files[0];
			if (first) await openFile(first.id);
			rangeDialogOpen = false;
		} catch (error) {
			fatalError = messageOf(error);
		} finally {
			openingRangeItemId = null;
		}
	}

	async function setRangeItemReviewed(itemId: string, reviewed: boolean) {
		rangeReviewState = await window.reviewApi.setRangeReviewItemReviewed(itemId, reviewed);
	}

	function beginSidebarResize(event: PointerEvent) {
		const startX = event.clientX;
		const startWidth = sidebarWidth;
		const move = (moveEvent: PointerEvent) => {
			sidebarWidth = Math.max(220, Math.min(480, startWidth + moveEvent.clientX - startX));
		};
		const end = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', end);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', end, { once: true });
	}

	function globalKeydown(event: KeyboardEvent) {
		const modifier = event.metaKey || event.ctrlKey;
		if (modifier && !event.shiftKey && event.key.toLowerCase() === 'p') {
			event.preventDefault();
			openFilePalette();
			return;
		}
		if (modifier && event.shiftKey && event.key.toLowerCase() === 'f') {
			event.preventDefault();
			searchOpen = true;
			return;
		}
		if (event.key === 'Escape') {
			if (settingsDialogOpen || rangeDialogOpen) return;
			if (paletteOpen) cancelFilePalette();
			else if (searchOpen) searchOpen = false;
			else if (popoverPinned) closePopover();
			else if (story.active) stopStory();
			return;
		}
		if (story.active && !isTyping(event.target)) {
			if (event.code === 'Space') {
				event.preventDefault();
				void toggleStoryAudio();
				return;
			}
			if (event.key === 'ArrowLeft') {
				event.preventDefault();
				void navigateStory('previous');
			} else if (event.key === 'ArrowRight') {
				event.preventDefault();
				void navigateStory('next');
			}
		}
	}

	function isTyping(target: EventTarget | null): boolean {
		return (
			target instanceof HTMLElement &&
			(['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
		);
	}

	function messageOf(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
</script>

<svelte:head
	><title
		>{manifest ? `${manifest.comparison.repositoryName} — Codex Review` : 'Codex Review'}</title
	></svelte:head
>

{#if booting}
	<div class="boot">
		<GitCompareArrows size={25} /><span>{bootLabel}</span><i class="spin"
			><LoaderCircle size={15} /></i
		>
	</div>
{:else if setupVisible}
	<SetupScreen
		initial={initialConfig}
		{validation}
		{validating}
		{starting}
		onChooseRoot={() => window.reviewApi.chooseRoot()}
		onValidate={validate}
		onStart={startReview}
	/>
	{#if fatalError}<div class="setup-error">
			<AlertTriangle size={14} />{fatalError}<button onclick={() => (fatalError = '')}
				><X size={13} /></button
			>
		</div>{/if}
{:else if manifest}
	<div class="app-shell" style={`--sidebar-width:${sidebarCollapsed ? 0 : sidebarWidth}px`}>
		<header class="topbar">
			<div class="traffic-space"></div>
			<div class="brand">
				<div class="brand-mark"><GitCompareArrows size={15} /></div>
				<strong>Codex Review</strong>
			</div>
			<div class="separator"></div>
			<div class="repository">
				<span>{manifest.comparison.repositoryName}</span>
				<small
					>{manifest.comparison.oldRevision.slice(0, 7)}
					<ChevronRight size={9} />
					{manifest.comparison.newRevision.slice(0, 7)}</small
				>
			</div>
			<button class="top-action" type="button" onclick={openFilePalette}
				><FileCode2 size={14} /><span>Go to file</span><kbd>⌘P</kbd></button
			>
			<button class="top-action" type="button" onclick={() => (searchOpen = !searchOpen)}
				><Search size={14} /><span>Search</span><kbd>⇧⌘F</kbd></button
			>
			<div class="top-spacer"></div>
			{#if rangeReviewState}
				<button
					class="commit-selector"
					type="button"
					onclick={openRangeDialog}
					title="Browse commits in this range"
				>
					<GitCommitHorizontal size={14} />
					<span>Commits</span>
					<small>{rangeReviewState.reviewedCount}/{rangeReviewState.totalCount}</small>
				</button>
			{/if}
			<ProgressControl
				{progress}
				{story}
				files={manifest.files}
				onEnterStory={enterStory}
				onStopStory={stopStory}
				onBuildWithGaps={buildStoryWithGaps}
			/>
			<div class="settings-wrap">
				<button
					class="icon-button"
					type="button"
					onclick={() => (reviewMenuOpen = !reviewMenuOpen)}
					aria-label="Review menu"
					aria-expanded={reviewMenuOpen}><CircleEllipsis size={17} /></button
				>
				{#if reviewMenuOpen}
					<div class="settings-menu">
						<button type="button" onclick={newReview}
							><GitCompareArrows size={13} /> Open another review</button
						>
						<button type="button" onclick={openSettings}><Settings2 size={13} /> Settings</button>
					</div>
				{/if}
			</div>
		</header>

		{#if staleReason}
			<div class="stale-banner">
				<AlertTriangle size={14} /><span><strong>Snapshot is stale.</strong> {staleReason}</span
				><button type="button" onclick={reloadReview}><RotateCcw size={13} /> Reload Review</button>
			</div>
		{/if}

		<div class="workspace">
			<aside class:collapsed={sidebarCollapsed} class="sidebar">
				<div class="sidebar-header">
					<div>
						<FolderTree size={14} /><strong>Files</strong><span>{manifest.files.length}</span>
					</div>
					<button
						type="button"
						onclick={() => (sidebarCollapsed = true)}
						aria-label="Collapse sidebar"><PanelLeftClose size={14} /></button
					>
				</div>
				<div class="tree-scroll">
					<FileTree
						bind:this={fileTree}
						reviewId={manifest.reviewId}
						tree={manifest.tree}
						files={manifest.files}
						{selectedFileId}
						{storyFileId}
						onOpen={(id) => void openFile(id)}
					/>
				</div>
				<button
					type="button"
					class="resize-handle"
					aria-label="Resize file tree"
					onpointerdown={beginSidebarResize}
				></button>
			</aside>

			{#if sidebarCollapsed}
				<button
					class="expand-sidebar"
					type="button"
					onclick={() => (sidebarCollapsed = false)}
					aria-label="Open files"
					title="Open files sidebar"><PanelLeftOpen size={15} /></button
				>
			{/if}

			<main class="review-pane">
				{#if selectedFile}
					<section class="file-surface">
						<header class="file-header" bind:this={fileHeader}>
							<div class="file-heading">
								<div class="path"><Braces size={15} /><span>{selectedFile.path}</span></div>
								<div class="file-badges">
									<span class={`change ${selectedFile.status}`}>{selectedFile.status}</span>
									<span>{selectedFile.language}</span>
									{#if selectedFile.hunks.length}<span
											>{selectedFile.hunks.length}
											{selectedFile.hunks.length === 1 ? 'hunk' : 'hunks'}</span
										>{/if}
								</div>
							</div>

							{#if selectedFile.status === 'unchanged'}
								<div class="unchanged-note">
									Not part of this comparison. Showing the file from the new snapshot.
								</div>
							{:else if selectedFile.skipReason}
								<div class="skip-note">
									<AlertTriangle size={14} /><span
										><strong>AI analysis skipped:</strong> {selectedFile.skipReason}</span
									><button
										type="button"
										onclick={() => window.reviewApi.analyzeAnyway(selectedFile.id)}
										>Analyze anyway</button
									>
								</div>
							{:else if selectedFile.overview}
								<div class="overview">
									<div
										class="role"
										class:story-active={story.active &&
											story.step?.fileId === selectedFile.id &&
											story.step?.overviewPart === 'role'}
									>
										<span>Role</span>
										<div class="role-value">
											<strong><InlineCodeText text={selectedFile.overview.role} /></strong
											><RoleSpeechButton text={selectedFile.overview.role} />
										</div>
									</div>
									<div
										class:story-active={story.active &&
											story.step?.fileId === selectedFile.id &&
											story.step?.overviewPart === 'whyChanged'}
									>
										<span>Why it changed</span>
										<div class="overview-copy">
											<p><InlineCodeText text={selectedFile.overview.whyChanged} /></p>
											<RoleSpeechButton
												text={selectedFile.overview.whyChanged}
												subject="why it changed"
											/>
										</div>
									</div>
									<div
										class:story-active={story.active &&
											story.step?.fileId === selectedFile.id &&
											story.step?.overviewPart === 'howChanged'}
									>
										<span>How it changed</span>
										<div class="overview-copy">
											<p><InlineCodeText text={selectedFile.overview.howChanged} /></p>
											<RoleSpeechButton
												text={selectedFile.overview.howChanged}
												subject="how it changed"
											/>
										</div>
									</div>
								</div>
							{:else if selectedFile.overviewAnalysis.state === 'failed'}
								<div class="overview-error">
									<AlertTriangle size={13} /><span>{selectedFile.overviewAnalysis.reason}</span
									><button
										type="button"
										onclick={() => window.reviewApi.retryAnalysis({ fileId: selectedFile.id })}
										>Retry</button
									>
								</div>
							{:else if selectedFile.overviewAnalysis.state === 'idle'}
								<div class="overview-request">
									<button
										type="button"
										onclick={() => window.reviewApi.retryAnalysis({ fileId: selectedFile.id })}
										><Sparkles size={13} /> Prepare file overview</button
									>
									<span>Generate this file’s role and change summary on demand.</span>
								</div>
							{:else}
								<div class="overview-loading">
									<i class="spin"><LoaderCircle size={15} /></i><span
										>Preparing this file’s role and change summary…</span
									>
								</div>
							{/if}
						</header>

						<div class="editor-region">
							{#if selectedFile.status !== 'unchanged' && !selectedFile.binary && !selectedFile.submodule}
								<div class="side-labels">
									<span>Old · {selectedFile.oldPath ?? 'empty'}</span><span
										>New · {selectedFile.newPath ?? 'empty'}</span
									>
								</div>
							{/if}
							{#if fileLoading}
								<div class="file-state">
									<i class="spin"><LoaderCircle size={18} /></i><span>Loading file snapshot…</span>
								</div>
							{:else if fileError}
								<div class="file-state error">
									<AlertTriangle size={20} /><span>{fileError}</span>
								</div>
							{:else if selectedFile.binary || selectedFile.submodule}
								<div class="file-state binary">
									<Binary size={26} /><strong
										>{selectedFile.submodule ? 'Submodule gitlink' : 'Binary file'}</strong
									><span
										>Contents are not rendered, but the file remains part of this review’s
										navigation and story.</span
									>
								</div>
							{:else if fileContent}
								<DiffViewer
									bind:this={viewer}
									file={selectedFile}
									content={fileContent}
									{selectedHunkId}
									onSelectHunk={selectHunk}
								/>
							{/if}
						</div>
					</section>
				{:else}
					<div class="no-file">
						<FileCode2 size={28} /><strong>Choose a file</strong><span
							>Use the tree or press ⌘P.</span
						>
					</div>
				{/if}

				{#if searchOpen}
					<SearchPanel
						response={searchResponse}
						busy={searchBusy}
						onSearch={runSearch}
						onSelect={selectSearchResult}
						onClose={() => (searchOpen = false)}
					/>
				{/if}

				{#if qaOpen && qaConversation && selectedHunk && selectedFile}
					<QaPanel
						conversation={qaConversation}
						hunk={selectedHunk}
						filePath={selectedFile.path}
						busy={qaBusy}
						onAsk={askQuestion}
						onCancel={cancelQuestion}
						onClose={() => (qaOpen = false)}
					/>
				{/if}
			</main>
		</div>

		{#if popoverHunk}
			<HunkPopover
				hunk={popoverHunk}
				anchor={popoverAnchor}
				pinned={popoverPinned}
				translucent={popoverTranslucent}
				onClose={closePopover}
				onAsk={openQa}
				onRetry={() =>
					selectedFile &&
					window.reviewApi.retryAnalysis({ fileId: selectedFile.id, hunkId: popoverHunk?.id })}
				onPrepare={() =>
					selectedFile &&
					window.reviewApi.retryAnalysis({ fileId: selectedFile.id, hunkId: popoverHunk?.id })}
			/>
		{/if}

		{#if paletteOpen}
			<FilePalette
				files={manifest.files}
				onSelect={commitFilePalette}
				onPreview={(id) => void openFile(id)}
				onClose={cancelFilePalette}
			/>
		{/if}

		<StoryToolbar
			{story}
			audioState={storyAudioState}
			onToggleAudio={() => void toggleStoryAudio()}
			onPrevious={() => void navigateStory('previous')}
			onNext={() => void navigateStory('next')}
			onStop={stopStory}
		/>

		{#if settingsDialogOpen}
			<SettingsDialog onClose={() => (settingsDialogOpen = false)} />
		{/if}

		{#if rangeDialogOpen && rangeReviewState}
			<RangeCommitDialog
				state={rangeReviewState}
				openingId={openingRangeItemId}
				onOpen={openRangeItem}
				onReviewed={setRangeItemReviewed}
				onClose={() => (rangeDialogOpen = false)}
			/>
		{/if}

		{#if banner}
			<div class="file-banner">
				<GitCompareArrows size={14} />
				<div>
					<strong>File changed: {banner.path}</strong>{#if banner.role}<span>{banner.role}</span
						>{/if}
				</div>
			</div>
		{/if}

		{#if fatalError}
			<div class="toast error">
				<AlertTriangle size={14} /><span>{fatalError}</span><button
					type="button"
					onclick={() => (fatalError = '')}><X size={13} /></button
				>
			</div>
		{/if}

		<StatusBar usage={codexUsage} />
	</div>
{/if}

<style>
	.boot {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 11px;
		background: var(--surface-0);
		color: var(--text-secondary);
		font-size: 12px;
	}

	.app-shell {
		height: 100vh;
		display: grid;
		grid-template-rows: 52px auto minmax(0, 1fr) 23px;
		overflow: hidden;
		background: var(--surface-0);
	}

	.topbar {
		grid-row: 1;
		position: relative;
		z-index: 45;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 11px;
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 94%, transparent);
		-webkit-app-region: drag;
		backdrop-filter: blur(20px);
	}

	.traffic-space {
		width: 62px;
		flex: none;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.brand-mark {
		width: 25px;
		height: 25px;
		display: grid;
		place-items: center;
		border-radius: 7px;
		color: white;
		background: linear-gradient(145deg, var(--accent), var(--accent-2));
	}
	.brand strong {
		font-size: 11px;
		white-space: nowrap;
	}
	.separator {
		width: 1px;
		height: 22px;
		background: var(--border);
		margin: 0 3px;
	}
	.repository {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 110px;
	}
	.repository > span {
		font-size: 10px;
		font-weight: 650;
	}
	.repository small {
		display: flex;
		align-items: center;
		gap: 2px;
		font: 8px/1 var(--font-mono);
		color: var(--text-muted);
	}

	.top-action,
	.commit-selector,
	.icon-button,
	.sidebar-header button,
	.expand-sidebar {
		-webkit-app-region: no-drag;
	}

	.top-action {
		height: 29px;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 7px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary);
		font: 10px/1 inherit;
		cursor: pointer;
	}
	.top-action:hover {
		border-color: var(--border);
		background: var(--surface-hover);
		color: var(--text-primary);
	}
	.top-action kbd {
		padding: 2px 4px;
		border: 1px solid var(--border);
		border-radius: 3px;
		font: 8px/1 var(--font-mono);
		color: var(--text-muted);
	}
	.top-spacer {
		flex: 1;
	}
	.commit-selector {
		height: 32px;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 16px;
		background: color-mix(in srgb, var(--surface-2) 90%, transparent);
		box-shadow: var(--shadow-sm);
		color: var(--text-secondary);
		font: 600 10px/1 inherit;
		cursor: pointer;
	}
	.commit-selector:hover {
		border-color: var(--selection-border);
		color: var(--text-primary);
	}
	.commit-selector small {
		padding: 2px 5px;
		border-radius: 8px;
		background: var(--selection-soft);
		color: var(--accent-text);
		font: 8px/1 var(--font-mono);
	}
	.settings-wrap {
		position: relative;
		-webkit-app-region: no-drag;
	}
	.icon-button {
		width: 31px;
		height: 31px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.icon-button:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	.settings-menu {
		position: absolute;
		top: 38px;
		right: 0;
		width: 210px;
		padding: 7px;
		border: 1px solid var(--border-strong);
		border-radius: 10px;
		background: var(--surface-2);
		box-shadow: var(--shadow-lg);
	}
	.settings-menu button {
		width: 100%;
		min-height: 30px;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 0 7px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text-secondary);
		font: 10px/1 inherit;
		text-align: left;
	}
	.settings-menu button:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	.stale-banner {
		grid-row: 2;
		position: relative;
		z-index: 40;
		min-height: 35px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 12px 5px calc(var(--sidebar-width) + 14px);
		border-bottom: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border));
		background: var(--warning-soft);
		color: var(--warning-text);
		font-size: 10px;
	}
	.stale-banner span {
		flex: 1;
	}
	.stale-banner button {
		display: flex;
		align-items: center;
		gap: 5px;
		height: 25px;
		padding: 0 8px;
		border: 1px solid currentColor;
		border-radius: 5px;
		background: transparent;
		color: inherit;
		font: 600 9px/1 inherit;
		cursor: pointer;
	}

	.workspace {
		grid-row: 3;
		position: relative;
		min-height: 0;
		display: grid;
		grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
		transition: grid-template-columns 160ms ease;
	}
	.sidebar {
		position: relative;
		min-width: 0;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border);
		background: var(--surface-1);
		overflow: hidden;
	}
	.sidebar.collapsed {
		border-right: 0;
	}
	.sidebar-header {
		height: 38px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 8px 0 11px;
		border-bottom: 1px solid var(--border);
	}
	.sidebar-header > div {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.sidebar-header strong {
		font-size: 10px;
	}
	.sidebar-header span {
		min-width: 18px;
		padding: 2px 4px;
		border-radius: 8px;
		background: var(--surface-3);
		color: var(--text-muted);
		font: 8px/1 var(--font-mono);
		text-align: center;
	}
	.sidebar-header button {
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		border: 0;
		background: transparent;
		color: var(--text-muted);
	}
	.tree-scroll {
		flex: 1;
		overflow: auto;
	}
	.resize-handle {
		position: absolute;
		z-index: 5;
		top: 0;
		right: -3px;
		bottom: 0;
		width: 6px;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: col-resize;
	}
	.resize-handle:hover {
		background: color-mix(in srgb, var(--accent) 35%, transparent);
	}
	.expand-sidebar {
		position: absolute;
		z-index: 30;
		top: 8px;
		left: 8px;
		width: 29px;
		height: 29px;
		display: grid;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-2);
		color: var(--text-muted);
		box-shadow: var(--shadow-sm);
		cursor: pointer;
	}
	.expand-sidebar:hover {
		border-color: var(--border-strong);
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	.review-pane {
		position: relative;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
	.file-surface {
		height: 100%;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
	}
	.file-header {
		position: relative;
		z-index: 4;
		padding: 13px 18px 14px;
		border-bottom: 1px solid var(--border);
		background: var(--surface-1);
	}
	.file-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
	}
	.path {
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.path :global(svg) {
		color: var(--accent-text);
		flex: none;
	}
	.path span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 600 12px/1.2 var(--font-mono);
	}
	.file-badges {
		display: flex;
		gap: 5px;
		flex: none;
	}
	.file-badges span {
		padding: 3px 6px;
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--text-muted);
		font: 8px/1 var(--font-mono);
		text-transform: capitalize;
	}
	.file-badges .change.added {
		border-color: color-mix(in srgb, var(--success) 45%, var(--border));
		color: var(--success);
	}
	.file-badges .change.deleted {
		border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
		color: var(--danger);
	}
	.file-badges .change.modified,
	.file-badges .change.renamed {
		border-color: var(--selection-border);
		color: var(--accent-text);
	}

	.overview {
		display: grid;
		grid-template-columns: minmax(170px, 0.8fr) minmax(220px, 1fr) minmax(220px, 1fr);
		gap: 24px;
		margin-top: 13px;
	}
	.overview > div {
		min-width: 0;
		padding-left: 10px;
		border-left: 2px solid var(--border);
	}
	.overview .role {
		border-left-color: var(--accent);
	}
	.overview > div {
		transition:
			color 180ms ease,
			background-color 180ms ease;
	}
	.overview > div.story-active {
		border-radius: 6px;
		background: var(--selection-soft);
		color: white;
	}
	.overview > div.story-active span,
	.overview > div.story-active p {
		color: white;
	}
	.role-value {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
	}
	.role-value strong {
		flex: 1;
		min-width: 0;
	}
	.overview-copy {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
	}
	.overview span {
		display: block;
		margin-bottom: 4px;
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.overview strong {
		display: block;
		font-size: 11px;
		line-height: 1.4;
	}
	.overview p {
		margin: 0;
		font-size: 10px;
		line-height: 1.45;
		color: var(--text-secondary);
	}
	.unchanged-note,
	.overview-request,
	.overview-loading,
	.overview-error,
	.skip-note {
		margin-top: 12px;
		min-height: 30px;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 6px 9px;
		border-radius: 6px;
		font-size: 10px;
		color: var(--text-secondary);
		background: var(--surface-0);
	}
	.skip-note {
		border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border));
		background: var(--warning-soft);
		color: var(--warning-text);
	}
	.skip-note span {
		flex: 1;
	}
	.skip-note button,
	.overview-error button {
		height: 23px;
		padding: 0 7px;
		border: 1px solid currentColor;
		border-radius: 4px;
		background: transparent;
		color: inherit;
		font: 600 9px/1 inherit;
	}
	.overview-error {
		color: var(--danger);
		background: var(--danger-soft);
	}
	.overview-error span {
		flex: 1;
	}
	.overview-loading {
		color: var(--accent-text);
	}
	.overview-request span {
		color: var(--text-muted);
	}
	.overview-request button {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 25px;
		padding: 0 9px;
		border: 1px solid var(--selection-border);
		border-radius: 5px;
		background: var(--selection);
		color: var(--accent-text);
		font: 600 9px/1 inherit;
		cursor: pointer;
	}

	.editor-region {
		position: relative;
		min-height: 0;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		overflow: hidden;
	}
	.side-labels {
		height: 26px;
		display: grid;
		grid-template-columns: 1fr 1fr;
		border-bottom: 1px solid var(--border);
		background: var(--surface-1);
	}
	.side-labels span {
		display: flex;
		align-items: center;
		padding: 0 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 8px/1 var(--font-mono);
		color: var(--text-muted);
	}
	.side-labels span:first-child {
		border-right: 1px solid var(--border);
	}
	.file-state,
	.no-file {
		min-height: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		color: var(--text-muted);
	}
	.file-state span,
	.no-file span {
		max-width: 430px;
		text-align: center;
		font-size: 10px;
		line-height: 1.5;
	}
	.file-state strong,
	.no-file strong {
		font-size: 12px;
		color: var(--text-secondary);
	}
	.file-state.error {
		color: var(--danger);
	}
	.file-state.binary {
		background: radial-gradient(circle at center, var(--surface-2), var(--surface-0) 55%);
	}
	.no-file {
		height: 100%;
	}

	.file-banner {
		position: fixed;
		z-index: 75;
		top: 68px;
		left: 50%;
		transform: translateX(-50%);
		max-width: min(620px, calc(100vw - 40px));
		display: flex;
		align-items: flex-start;
		gap: 9px;
		padding: 10px 14px;
		border: 1px solid var(--selection-border);
		border-radius: 9px;
		background: color-mix(in srgb, var(--surface-2) 95%, transparent);
		box-shadow: var(--shadow-lg);
		color: var(--accent-text);
		backdrop-filter: blur(18px);
	}
	.file-banner div {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.file-banner strong {
		font: 600 10px/1.3 var(--font-mono);
		color: var(--text-primary);
	}
	.file-banner span {
		font-size: 9px;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.toast,
	.setup-error {
		position: fixed;
		z-index: 150;
		right: 18px;
		bottom: 18px;
		max-width: 520px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 9px 10px;
		border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
		border-radius: 8px;
		background: var(--surface-2);
		box-shadow: var(--shadow-lg);
		color: var(--danger);
		font-size: 10px;
	}
	.toast span {
		flex: 1;
	}
	.toast button,
	.setup-error button {
		width: 23px;
		height: 23px;
		display: grid;
		place-items: center;
		border: 0;
		background: transparent;
		color: inherit;
	}
	.spin {
		display: inline-grid;
		place-items: center;
		animation: spin 1s linear infinite;
		font-style: normal;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 1120px) {
		.top-action span,
		.top-action kbd {
			display: none;
		}
		.overview {
			grid-template-columns: 1fr 1fr;
		}
		.overview .role {
			grid-column: 1 / -1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.workspace {
			transition: none;
		}
		.overview-loading .spin {
			animation: none;
		}
	}
</style>
