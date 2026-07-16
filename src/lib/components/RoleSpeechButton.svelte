<script context="module" lang="ts">
	let activeButton: symbol | null = null;
</script>

<script lang="ts">
	import { AlertTriangle, Square, Volume2 } from '@lucide/svelte';
	import { onDestroy, onMount } from 'svelte';
	import type { KokoroModelStatus } from '$lib/shared/types';
	export let text: string;
	export let subject = 'role';
	const buttonId = Symbol('speech-button');
	let state: 'unavailable' | 'idle' | 'loading' | 'playing' | 'error' = 'unavailable';
	let title = 'Speech unavailable';
	let progress = 0;
	let cached = false;
	let unsubscribe: (() => void) | undefined;
	onMount(() => {
		void refresh();
		unsubscribe = window.reviewApi.onSpeechEvent((event) => {
			if (event.type === 'model') void refresh(event.status);
			else if (event.type === 'cache-changed') {
				if (!event.text || event.text === text) void refresh();
			} else if (event.state === 'stopped') {
				progress = 0;
				void refresh();
			} else if (activeButton === buttonId) {
				state = event.state === 'paused' ? 'playing' : event.state;
				progress = event.progress ?? progress;
				title = event.message ?? title;
			}
		});
		return () => unsubscribe?.();
	});
	onDestroy(() => unsubscribe?.());
	async function refresh(status?: KokoroModelStatus) {
		const [settings, model, siri, voicebox, isCached] = await Promise.all([
			window.reviewApi.getSpeechSettings(),
			status ? Promise.resolve(status) : window.reviewApi.getKokoroModelStatus(),
			window.reviewApi.getSiriStatus(),
			window.reviewApi.getVoiceboxStatus(),
			window.reviewApi.isSpeechCached(text)
		]);
		cached = isCached;
		const unavailable =
			settings.engine === 'kokoro'
				? model.state !== 'ready'
				: settings.engine === 'voicebox'
					? !voicebox.available
					: !siri.available;
		state = unavailable ? 'unavailable' : 'idle';
		title = unavailable
			? settings.engine === 'kokoro'
				? 'Download the Kokoro model in Speech settings'
				: settings.engine === 'voicebox'
					? (voicebox.reason ?? 'Voicebox is unavailable')
					: (siri.reason ?? 'Siri is unavailable')
			: 'Read role aloud';
	}
	async function toggle() {
		if (state === 'loading' || state === 'playing') {
			await window.reviewApi.stopSpeech();
			return;
		}
		activeButton = buttonId;
		state = 'loading';
		try {
			await window.reviewApi.playRole(text);
		} catch (error) {
			if (activeButton !== buttonId) return;
			state = 'error';
			title = error instanceof Error ? error.message : String(error);
		}
	}
</script>

<button
	class:error={state === 'error'}
	class:loading={state === 'loading'}
	class:cached
	style={`--speech-progress:${Math.round(progress * 360)}deg`}
	type="button"
	onclick={toggle}
	disabled={state === 'unavailable'}
	aria-label={state === 'loading' || state === 'playing'
		? `Stop reading ${subject}`
		: `Read ${subject} aloud`}
	{title}
>
	{#if state === 'playing'}<Square size={9} />{:else if state === 'error'}<AlertTriangle
			size={11}
		/>{:else}<Volume2 size={11} />{/if}
</button>

<style>
	button {
		position: relative;
		isolation: isolate;
		flex: 0 0 20px;
		width: 20px;
		height: 20px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 50%;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	button.loading {
		border-color: transparent;
		background: conic-gradient(var(--accent) var(--speech-progress), var(--border) 0);
		color: var(--accent-text);
	}
	button.loading::before {
		content: '';
		position: absolute;
		inset: 1px;
		z-index: -1;
		border-radius: 50%;
		background: var(--surface-2);
	}
	button:hover:not(:disabled) {
		color: var(--accent-text);
		border-color: var(--selection-border);
	}
	button:disabled {
		opacity: 0.38;
		cursor: not-allowed;
	}
	button.error {
		color: var(--danger);
	}
	button.cached:not(.error):not(.loading) {
		color: #b8f5cc;
	}
	button :global(svg) {
		display: block;
	}
</style>
