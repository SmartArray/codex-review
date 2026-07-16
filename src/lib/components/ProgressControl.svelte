<script lang="ts">
	import { tick } from 'svelte';
	import { BookOpen, Check, ChevronDown, Circle, Octagon, RefreshCw, X } from '@lucide/svelte';
	import type { DiffFile, ReviewProgress, StoryState } from '$lib/shared/types';

	export let progress: ReviewProgress;
	export let story: StoryState;
	export let files: DiffFile[] = [];
	export let onEnterStory: () => void = () => undefined;
	export let onStopStory: () => void = () => undefined;
	export let onBuildWithGaps: () => void = () => undefined;
	let detailsOpen = false;
	let modal: HTMLDialogElement;
	let expanded: ReviewProgress['phase'][] = [];
	const steps: Array<{ phase: ReviewProgress['phase']; label: string; description: string }> = [
		{
			phase: 'indexing',
			label: 'Index repository',
			description: 'Freeze and inspect the selected comparison.'
		},
		{
			phase: 'overview',
			label: 'Prepare file overviews',
			description: 'Generate each file’s role, intent, and implementation summary.'
		},
		{
			phase: 'details',
			label: 'Explain changed hunks',
			description: 'Prepare focused explanations for individual changes.'
		},
		{
			phase: 'story',
			label: 'Build story',
			description: 'Order the completed analysis into a guided walkthrough.'
		}
	];

	$: fraction =
		progress.total > 0
			? Math.min(1, progress.completed / progress.total)
			: progress.phase === 'complete'
				? 1
				: 0.08;
	const dash = 2 * Math.PI * 17;
	$: currentIndex = steps.findIndex((step) => step.phase === progress.phase);
	function statusAt(index: number): 'done' | 'current' | 'waiting' {
		if (progress.phase === 'complete') return 'done';
		if (progress.phase === 'error') return index < 3 ? 'done' : 'waiting';
		if (currentIndex < 0) return 'waiting';
		return index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'waiting';
	}
	function toggleGroup(phase: ReviewProgress['phase']): void {
		expanded = expanded.includes(phase)
			? expanded.filter((value) => value !== phase)
			: [...expanded, phase];
	}
	async function openDetails(): Promise<void> {
		detailsOpen = true;
		await tick();
		if (!modal.open) modal.showModal();
	}
	function closeDetails(): void {
		if (modal?.open) modal.close();
		detailsOpen = false;
	}
	function fileState(file: DiffFile, phase: 'overview' | 'details') {
		if (phase === 'overview') {
			const state = file.overviewAnalysis.state;
			return {
				label:
					state === 'running'
						? 'Preparing now'
						: state === 'cached'
							? 'Cached'
							: state === 'ready'
								? 'Complete'
								: state === 'failed'
									? 'Failed'
									: state === 'skipped'
										? 'Skipped'
										: state === 'queued'
											? 'Queued'
											: 'Waiting',
				current: state === 'running',
				done: ['ready', 'cached', 'failed', 'skipped'].includes(state)
			};
		}
		const complete = file.hunks.filter((hunk) =>
			['ready', 'cached', 'failed', 'skipped'].includes(hunk.analysis.state)
		).length;
		const current = file.hunks.some((hunk) => hunk.analysis.state === 'running');
		return {
			label: current
				? `${complete}/${file.hunks.length} · Preparing now`
				: `${complete}/${file.hunks.length} hunks`,
			current,
			done: complete === file.hunks.length
		};
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape') closeDetails();
	}}
/>

{#if story.active}
	<button
		class="story-button stop"
		type="button"
		onclick={onStopStory}
		title="Exit Story Mode (Esc)"
	>
		<Octagon size={15} />
		<span>Stop</span>
	</button>
{:else if progress.phase === 'complete'}
	<button
		class="story-button"
		type="button"
		onclick={onEnterStory}
		title="Start a guided walkthrough"
	>
		<BookOpen size={15} />
		<span>Story Mode</span>
	</button>
{:else if progress.canBuildWithGaps}
	<button
		class="story-button gaps"
		type="button"
		onclick={onBuildWithGaps}
		title="Create a story with placeholders"
	>
		<BookOpen size={15} />
		<span>Build story with gaps</span>
	</button>
{:else}
	<button
		class="progress-pill"
		type="button"
		title={`${progress.warning ?? progress.label} · Show review preparation steps`}
		aria-label={`${progress.label}. Show review preparation steps`}
		onclick={openDetails}
	>
		<div class="ring">
			<svg viewBox="0 0 40 40" aria-hidden="true">
				<circle class="track" cx="20" cy="20" r="17"></circle>
				<circle
					class="value"
					cx="20"
					cy="20"
					r="17"
					stroke-dasharray={dash}
					stroke-dashoffset={dash * (1 - fraction)}
				></circle>
			</svg>
			<span class:spin={progress.phase !== 'idle'}><RefreshCw size={12} /></span>
		</div>
		<div class="labels">
			<span>{progress.label}</span>
			{#if progress.warning}<small>{progress.warning}</small>{/if}
		</div>
	</button>
{/if}

{#if detailsOpen}
	<dialog
		bind:this={modal}
		class="progress-modal"
		aria-labelledby="progress-title"
		onclose={() => (detailsOpen = false)}
		onclick={(event) => {
			if (event.target === event.currentTarget) closeDetails();
		}}
	>
		<div class="modal-surface">
			<header>
				<div>
					<small>Review preparation</small>
					<h2 id="progress-title">{progress.label}</h2>
				</div>
				<button
					class="close"
					type="button"
					aria-label="Close preparation steps"
					onclick={closeDetails}><X size={16} /></button
				>
			</header>
			<div class="overall">
				<div><span>Overall progress</span><strong>{Math.round(fraction * 100)}%</strong></div>
				<progress max="1" value={fraction}></progress>
			</div>
			<ol>
				{#each steps as step, index (step.label)}
					{@const status = statusAt(index)}
					<li class:current={status === 'current'} class:done={status === 'done'}>
						<div class="step-icon">
							{#if status === 'done'}<Check size={13} />{:else if status === 'current'}<RefreshCw
									size={13}
								/>{:else}<Circle size={11} />{/if}
						</div>
						<div class="step-content">
							{#if (step.phase === 'overview' || step.phase === 'details') && files.length}
								<button
									class="group-toggle"
									type="button"
									aria-expanded={expanded.includes(step.phase)}
									onclick={() => toggleGroup(step.phase)}
								>
									<strong>{step.label}</strong><ChevronDown size={13} />
								</button>
							{:else}
								<strong>{step.label}</strong>
							{/if}
							<p>{step.description}</p>
							{#if status === 'current'}<em>{progress.completed} of {progress.total} complete</em
								>{/if}
							{#if expanded.includes(step.phase) && (step.phase === 'overview' || step.phase === 'details')}
								<ul class="file-progress">
									{#each files.filter((file) => file.status !== 'unchanged') as file (file.id)}
										{@const fileStatus = fileState(file, step.phase)}
										<li class:file-current={fileStatus.current} class:file-done={fileStatus.done}>
											<span title={file.path}>{file.path}</span><small>{fileStatus.label}</small>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
			{#if progress.warning}<div class="modal-warning">{progress.warning}</div>{/if}
		</div>
	</dialog>
{/if}

<style>
	.progress-pill,
	.story-button {
		height: 36px;
		display: flex;
		align-items: center;
		gap: 8px;
		border: 1px solid var(--border-strong);
		border-radius: 18px;
		background: color-mix(in srgb, var(--surface-2) 90%, transparent);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
	}

	.progress-pill {
		padding: 0 13px 0 3px;
		max-width: 300px;
		font: inherit;
		cursor: pointer;
		text-align: left;
	}
	.progress-pill:hover {
		border-color: var(--selection-border);
	}

	.ring {
		width: 32px;
		height: 32px;
		position: relative;
		display: grid;
		place-items: center;
		flex: none;
	}

	.ring svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		transform: rotate(-90deg);
	}

	.ring > span {
		display: grid;
		place-items: center;
	}

	.ring circle {
		fill: none;
		stroke-width: 2.5;
	}

	.track {
		stroke: var(--border);
	}

	.value {
		stroke: var(--accent);
		stroke-linecap: round;
		transition: stroke-dashoffset 300ms ease;
	}

	.spin {
		animation: spin 1.8s linear infinite;
	}

	.labels {
		min-width: 0;
		display: flex;
		flex-direction: column;
		line-height: 1.2;
	}

	.labels span {
		font-size: 11px;
		font-weight: 600;
		white-space: nowrap;
	}

	.labels small {
		font-size: 9px;
		color: var(--warning);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.story-button {
		padding: 0 15px;
		font: 600 12px/1 inherit;
		cursor: pointer;
		background: linear-gradient(135deg, var(--accent), var(--accent-2));
		border-color: transparent;
		color: white;
	}

	.story-button:hover {
		filter: brightness(1.08);
	}

	.story-button.stop {
		background: var(--danger);
	}

	.story-button.gaps {
		background: var(--surface-2);
		border-color: var(--warning);
		color: var(--warning-text);
	}

	.progress-modal {
		width: min(640px, calc(100vw - 48px));
		max-height: calc(100vh - 64px);
		margin: auto;
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: 14px;
		background: var(--surface-2);
		color: var(--text-primary);
		box-shadow: var(--shadow-xl);
	}
	.progress-modal::backdrop {
		background: color-mix(in srgb, #05070a 58%, transparent);
		backdrop-filter: blur(18px);
	}
	.modal-surface {
		max-height: calc(100vh - 66px);
		overflow: auto;
		padding: 24px;
	}
	.progress-modal header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}
	.progress-modal header small {
		color: var(--accent-text);
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.progress-modal h2 {
		margin: 4px 0 0;
		font-size: 17px;
	}
	.close {
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.close:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}
	.overall {
		margin: 18px 0 15px;
	}
	.overall div {
		display: flex;
		justify-content: space-between;
		margin-bottom: 7px;
		font-size: 10px;
		color: var(--text-muted);
	}
	.overall strong {
		color: var(--text-secondary);
	}
	.overall progress {
		display: block;
		width: 100%;
		height: 5px;
		accent-color: var(--accent);
	}
	ol {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		grid-template-columns: 28px 1fr;
		gap: 9px;
		padding: 10px 8px;
		border-radius: 8px;
		opacity: 0.55;
	}
	li.current {
		background: var(--selection);
		opacity: 1;
	}
	li.done {
		opacity: 0.82;
	}
	.step-icon {
		width: 24px;
		height: 24px;
		display: grid;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 50%;
		color: var(--text-muted);
	}
	li.current .step-icon {
		border-color: var(--selection-border);
		color: var(--accent-text);
	}
	li.current .step-icon :global(svg) {
		animation: spin 1.8s linear infinite;
	}
	li.done .step-icon {
		border-color: color-mix(in srgb, var(--success) 45%, var(--border));
		color: var(--success);
	}
	li strong {
		display: block;
		margin-top: 2px;
		font-size: 11px;
	}
	li p {
		margin: 3px 0 0;
		font-size: 9px;
		line-height: 1.4;
		color: var(--text-muted);
	}
	li em {
		display: block;
		margin-top: 5px;
		color: var(--accent-text);
		font-size: 9px;
		font-style: normal;
	}
	.step-content {
		min-width: 0;
	}
	.group-toggle {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
		text-align: left;
	}
	.group-toggle :global(svg) {
		transition: transform 150ms ease;
	}
	.group-toggle[aria-expanded='true'] :global(svg) {
		transform: rotate(180deg);
	}
	.file-progress {
		display: grid;
		gap: 3px;
		margin: 8px 0 0;
		padding: 6px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-0);
		list-style: none;
	}
	.file-progress li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-width: 0;
		padding: 5px 6px;
		border-radius: 4px;
		opacity: 0.65;
	}
	.file-progress li.file-current {
		background: var(--selection);
		opacity: 1;
	}
	.file-progress li.file-done {
		opacity: 0.85;
	}
	.file-progress span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 9px/1.3 var(--font-mono);
		color: var(--text-secondary);
	}
	.file-progress small {
		flex: none;
		font-size: 8px;
		color: var(--text-muted);
	}
	.file-progress li.file-current small {
		color: var(--accent-text);
	}
	.modal-warning {
		margin-top: 12px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--warning-soft);
		color: var(--warning-text);
		font-size: 9px;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spin {
			animation: none;
		}
	}
</style>
