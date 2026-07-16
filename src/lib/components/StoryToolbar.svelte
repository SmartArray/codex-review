<script lang="ts">
	import { ArrowLeft, ArrowRight, BookOpen, LoaderCircle, Pause, Play, X } from '@lucide/svelte';
	import type { StoryState } from '$lib/shared/types';

	export let story: StoryState;
	export let onPrevious: () => void = () => undefined;
	export let onNext: () => void = () => undefined;
	export let onStop: () => void = () => undefined;
	export let audioState: 'idle' | 'loading' | 'playing' | 'paused' | 'error' = 'idle';
	export let onToggleAudio: () => void = () => undefined;
	$: stepLabel =
		story.step?.overviewPart === 'role'
			? 'Role'
			: story.step?.overviewPart === 'whyChanged'
				? 'Why it changed'
				: story.step?.overviewPart === 'howChanged'
					? 'How it changed'
					: story.step?.hunkId
						? 'Hunk explanation'
						: 'Overview';
	$: audioLabel =
		audioState === 'loading'
			? 'Cancel audio preparation (Space)'
			: audioState === 'playing'
				? 'Pause audio (Space)'
				: 'Play audio (Space)';
</script>

{#if story.active}
	<nav class="story-toolbar" aria-label="Story navigation">
		<div class="title"><BookOpen size={14} /><span>{story.plan?.title ?? 'Story Mode'}</span></div>
		<div class="step">
			{stepLabel} · {story.step?.index ?? 0} of {story.step?.total ?? 0}
		</div>
		<div class="controls">
			<button
				type="button"
				class:loading={audioState === 'loading'}
				onclick={onToggleAudio}
				title={audioLabel}
				aria-label={audioLabel}
				disabled={audioState === 'error'}
				>{#if audioState === 'loading'}<LoaderCircle
						size={14}
					/>{:else if audioState === 'paused' || audioState === 'idle'}<Play
						size={14}
					/>{:else}<Pause size={14} />{/if}</button
			>
			<button
				type="button"
				onclick={onPrevious}
				disabled={!story.step || story.step.index <= 1}
				title="Previous (←)"><ArrowLeft size={15} /></button
			>
			<button
				type="button"
				onclick={onNext}
				disabled={!story.step || story.step.index >= story.step.total}
				title="Next (→)"><ArrowRight size={15} /></button
			>
			<button type="button" onclick={onStop} title="Stop (Esc)"><X size={15} /></button>
		</div>
	</nav>
{/if}

<style>
	.story-toolbar {
		position: fixed;
		z-index: 70;
		left: 50%;
		bottom: 22px;
		transform: translateX(-50%);
		height: 42px;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 0 6px 0 13px;
		border: 1px solid var(--border-strong);
		border-radius: 21px;
		background: color-mix(in srgb, var(--surface-2) 94%, transparent);
		box-shadow: var(--shadow-lg);
		backdrop-filter: blur(18px);
	}

	.title {
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 220px;
		color: var(--accent-text);
	}

	.title span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10px;
		font-weight: 650;
	}

	.step {
		padding-left: 12px;
		border-left: 1px solid var(--border);
		font: 10px/1 var(--font-mono);
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.controls {
		display: flex;
		gap: 3px;
	}
	.controls button {
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}
	.controls button:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-primary);
	}
	.controls button:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.controls button.loading :global(svg) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
