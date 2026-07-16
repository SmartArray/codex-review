<script lang="ts">
	import { Download, LoaderCircle, RefreshCw, RotateCcw } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type {
		KokoroModelStatus,
		SiriStatus,
		SpeechSettings,
		VoiceboxStatus
	} from '$lib/shared/types';

	let settings: SpeechSettings = { engine: 'kokoro', voice: 'am_michael', speed: 1 };
	let model: KokoroModelStatus = { state: 'missing' };
	let siri: SiriStatus = { visible: false, available: false };
	let voicebox: VoiceboxStatus = { available: false, profiles: [] };
	let error = '';
	let unsubscribe: (() => void) | undefined;

	onMount(() => {
		void Promise.all([
			window.reviewApi.getSpeechSettings(),
			window.reviewApi.getKokoroModelStatus(),
			window.reviewApi.getSiriStatus(),
			window.reviewApi.getVoiceboxStatus()
		])
			.then(([a, b, c, d]) => {
				settings = a;
				model = b;
				siri = c;
				voicebox = d;
			})
			.catch((value) => (error = messageOf(value)));
		unsubscribe = window.reviewApi.onSpeechEvent((event) => {
			if (event.type === 'model') model = event.status;
		});
		return () => unsubscribe?.();
	});

	async function update(patch: Partial<SpeechSettings>) {
		error = '';
		try {
			settings = await window.reviewApi.setSpeechSettings({ ...settings, ...patch });
		} catch (value) {
			error = messageOf(value);
		}
	}
	async function selectEngine(engine: SpeechSettings['engine']) {
		if (engine === 'voicebox') {
			voicebox = await window.reviewApi.getVoiceboxStatus();
			if (!voicebox.available) {
				error = voicebox.reason ?? 'Voicebox is unavailable.';
				return;
			}
			await update({
				engine,
				voiceboxProfileId: settings.voiceboxProfileId ?? voicebox.profiles[0]?.id
			});
			return;
		}
		await update({ engine });
	}
	async function download() {
		error = '';
		try {
			model = await window.reviewApi.downloadKokoroModel();
		} catch (value) {
			error = messageOf(value);
		}
	}
	async function refreshVoicebox() {
		error = '';
		voicebox = await window.reviewApi.getVoiceboxStatus();
		if (!voicebox.available) error = voicebox.reason ?? 'Voicebox is unavailable.';
	}
	function messageOf(value: unknown) {
		return value instanceof Error ? value.message : String(value);
	}
</script>

<div class="speech-section">
	<label
		>Engine
		<select
			aria-label="Speech engine"
			value={settings.engine}
			onchange={(event) => selectEngine(event.currentTarget.value as SpeechSettings['engine'])}
		>
			<option value="kokoro">Kokoro</option>
			<option value="voicebox" disabled={!voicebox.available}>Voicebox</option>
			{#if siri.visible}<option value="siri" disabled={!siri.available}>Siri</option>{/if}
		</select>
	</label>
	{#if siri.visible && !siri.available}<small class="hint">{siri.reason}</small>{/if}
	{#if !voicebox.available}
		<div class="service-hint">
			<small>{voicebox.reason ?? 'Checking the local Voicebox server…'}</small>
			<button type="button" onclick={refreshVoicebox} aria-label="Refresh Voicebox"
				><RefreshCw size={12} /></button
			>
		</div>
	{/if}
	{#if settings.engine === 'kokoro'}
		<label
			>Voice
			<select
				aria-label="Kokoro voice"
				value={settings.voice}
				onchange={(event) =>
					update({ voice: event.currentTarget.value as SpeechSettings['voice'] })}
			>
				<option value="am_michael">Michael</option><option value="am_echo">Echo</option><option
					value="af_sarah">Sarah</option
				><option value="af_heart">Heart</option>
			</select>
		</label>
		<div class="model-row">
			<span>Model</span><em
				>{model.state === 'ready'
					? 'Ready'
					: model.state === 'downloading'
						? `${Math.round((model.progress ?? 0) * 100)}%`
						: model.state === 'failed'
							? 'Failed'
							: 'Not downloaded'}</em
			>
		</div>
		{#if model.state === 'downloading'}<progress
				max="1"
				value={model.progress ?? 0}
				aria-label="Model download progress"
			></progress>{/if}
		{#if model.message}<small class:error={model.state === 'failed'}>{model.message}</small>{/if}
		{#if model.state !== 'ready' && model.state !== 'downloading'}
			<button class="download" type="button" onclick={download}
				>{#if model.state === 'failed'}<RotateCcw size={12} /> Retry download{:else}<Download
						size={12}
					/> Download model{/if}</button
			>
		{:else if model.state === 'downloading'}<div class="downloading">
				<LoaderCircle size={12} /> Downloading Kokoro 82M…
			</div>{/if}
	{:else if settings.engine === 'voicebox'}
		<label
			>Profile
			<select
				aria-label="Voicebox profile"
				value={settings.voiceboxProfileId ?? ''}
				onchange={(event) => update({ voiceboxProfileId: event.currentTarget.value })}
			>
				{#each voicebox.profiles as profile (profile.id)}
					<option value={profile.id}
						>{profile.name}{profile.language ? ` · ${profile.language}` : ''}</option
					>
				{/each}
			</select>
		</label>
		<small
			>Uses Voicebox’s local server at 127.0.0.1:17493 and stores a private copy in the audio cache.</small
		>
	{/if}
	<label
		>Speed <output>{settings.speed.toFixed(1)}x</output>
		<input
			aria-label="Speech speed"
			type="range"
			min="0.5"
			max="2"
			step="0.1"
			value={settings.speed}
			onchange={(event) => update({ speed: Number(event.currentTarget.value) })}
		/>
	</label>
	{#if error}<small class="error">{error}</small>{/if}
</div>

<style>
	.speech-section {
		--speech-subtle-text: color-mix(in srgb, var(--text-secondary) 78%, var(--text-primary));
		display: grid;
		gap: 12px;
	}
	.model-row,
	.downloading {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--speech-subtle-text);
		font-size: 11px;
		font-weight: 650;
	}
	label {
		display: grid;
		grid-template-columns: 64px 1fr;
		align-items: center;
		gap: 8px;
		font-size: 11px;
		color: var(--speech-subtle-text);
	}
	select {
		min-width: 0;
		height: 31px;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--surface-0);
		color: var(--text-primary);
		font: 11px inherit;
	}
	output {
		justify-self: end;
		color: var(--text-secondary);
	}
	input {
		grid-column: 1 / -1;
		width: 100%;
		accent-color: var(--accent);
	}
	.model-row span {
		flex: 1;
	}
	.model-row em {
		font-style: normal;
		color: var(--text-secondary);
	}
	progress {
		width: 100%;
		height: 4px;
		accent-color: var(--accent);
	}
	small {
		font-size: 10px;
		line-height: 1.45;
		color: var(--speech-subtle-text);
	}
	small.error {
		color: var(--danger);
	}
	.download {
		min-height: 31px !important;
		justify-content: center;
		border: 1px solid var(--border) !important;
	}
	.downloading :global(svg) {
		animation: spin 1s linear infinite;
	}
	.service-hint {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.service-hint small {
		flex: 1;
	}
	.service-hint button {
		width: 29px;
		height: 29px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: transparent;
		color: var(--speech-subtle-text);
		cursor: pointer;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
