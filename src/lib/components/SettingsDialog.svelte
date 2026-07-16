<script lang="ts">
	import { Database, Music2, Trash2, Volume2, X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { CacheInfo, SpeechCacheInfo } from '$lib/shared/types';
	import SpeechSettings from './SpeechSettings.svelte';

	export let onClose: () => void = () => undefined;
	let dialog: HTMLDialogElement;
	let codeCache: CacheInfo | null = null;
	let audioCache: SpeechCacheInfo | null = null;
	let codeBusy = false;
	let audioBusy = false;
	let error = '';
	let unsubscribe: (() => void) | undefined;
	type SettingsSection = 'speech' | 'code' | 'audio';
	let activeSection: SettingsSection = 'speech';

	onMount(() => {
		dialog.showModal();
		void refreshCaches();
		unsubscribe = window.reviewApi.onSpeechEvent((event) => {
			if (event.type === 'cache-changed') void refreshAudioCache();
		});
		return () => unsubscribe?.();
	});

	async function refreshCaches() {
		try {
			[codeCache, audioCache] = await Promise.all([
				window.reviewApi.getCacheInfo(),
				window.reviewApi.getSpeechCacheInfo()
			]);
		} catch (value) {
			error = messageOf(value);
		}
	}
	async function refreshAudioCache() {
		audioCache = await window.reviewApi.getSpeechCacheInfo();
	}
	async function clearCodeCache() {
		codeBusy = true;
		error = '';
		try {
			codeCache = await window.reviewApi.clearCache();
		} catch (value) {
			error = messageOf(value);
		} finally {
			codeBusy = false;
		}
	}
	async function clearAudioCache() {
		audioBusy = true;
		error = '';
		try {
			audioCache = await window.reviewApi.clearSpeechCache();
		} catch (value) {
			error = messageOf(value);
		} finally {
			audioBusy = false;
		}
	}
	function messageOf(value: unknown) {
		return value instanceof Error ? value.message : String(value);
	}
	function formatBytes(value: number) {
		if (value < 1024) return `${value} B`;
		if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
		return `${(value / 1024 / 1024).toFixed(1)} MB`;
	}
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="settings-title"
	onclose={onClose}
	onclick={(event) => {
		if (event.target === dialog) dialog.close();
	}}
>
	<div class="window">
		<header>
			<div>
				<small>Codex Explain</small>
				<h2 id="settings-title">Settings</h2>
			</div>
			<button type="button" onclick={() => dialog.close()} aria-label="Close settings"
				><X size={17} /></button
			>
		</header>

		<div class="content">
			<nav aria-label="Settings sections">
				<button
					type="button"
					class:active={activeSection === 'speech'}
					aria-current={activeSection === 'speech' ? 'page' : undefined}
					onclick={() => (activeSection = 'speech')}
				>
					<Volume2 size={15} /> Speech Settings
				</button>
				<button
					type="button"
					class:active={activeSection === 'code'}
					aria-current={activeSection === 'code' ? 'page' : undefined}
					onclick={() => (activeSection = 'code')}
				>
					<Database size={15} /> Code Cache
				</button>
				<button
					type="button"
					class:active={activeSection === 'audio'}
					aria-current={activeSection === 'audio' ? 'page' : undefined}
					onclick={() => (activeSection = 'audio')}
				>
					<Music2 size={15} /> Audio Cache
				</button>
			</nav>

			<div class="panel">
				{#if activeSection === 'speech'}
					<section>
						<div class="section-heading">
							<div class="section-icon"><Volume2 size={16} /></div>
							<div>
								<h3>Speech Settings</h3>
								<p>Choose how review explanations are spoken.</p>
							</div>
						</div>
						<div class="section-body"><SpeechSettings /></div>
					</section>
				{:else if activeSection === 'code'}
					<section>
						<div class="section-heading">
							<div class="section-icon"><Database size={16} /></div>
							<div>
								<h3>Code Cache</h3>
								<p>Generated file, hunk, story, and Q&amp;A data.</p>
							</div>
						</div>
						<div class="cache-action">
							<div>
								<strong>{codeCache?.entryCount ?? 0} entries</strong><span
									>{formatBytes(codeCache?.sizeBytes ?? 0)}</span
								>
							</div>
							<button
								type="button"
								onclick={clearCodeCache}
								disabled={codeBusy || !codeCache?.entryCount}
								><Trash2 size={13} /> {codeBusy ? 'Clearing…' : 'Clear Code Cache'}</button
							>
						</div>
					</section>
				{:else}
					<section>
						<div class="section-heading">
							<div class="section-icon"><Music2 size={16} /></div>
							<div>
								<h3>Audio Cache</h3>
								<p>Prepared narration shared across reviews.</p>
							</div>
						</div>
						<div class="cache-action">
							<div>
								<strong>{audioCache?.entryCount ?? 0} files</strong><span
									>{formatBytes(audioCache?.sizeBytes ?? 0)}</span
								>
							</div>
							<button
								type="button"
								onclick={clearAudioCache}
								disabled={audioBusy || !audioCache?.entryCount}
								><Trash2 size={13} /> {audioBusy ? 'Clearing…' : 'Clear Audio Cache'}</button
							>
						</div>
					</section>
				{/if}
				{#if error}<div class="error" role="alert">{error}</div>{/if}
			</div>
		</div>
	</div>
</dialog>

<style>
	dialog {
		width: min(900px, calc(100vw - 44px));
		max-height: min(820px, calc(100vh - 44px));
		margin: auto;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		overflow: visible;
	}
	dialog::backdrop {
		background: color-mix(in srgb, var(--surface-0) 58%, transparent);
		backdrop-filter: blur(16px);
	}
	.window {
		max-height: min(820px, calc(100vh - 44px));
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-strong);
		border-radius: 16px;
		background: color-mix(in srgb, var(--surface-1) 97%, transparent);
		box-shadow: var(--shadow-xl);
		overflow: hidden;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 19px 21px 16px;
		border-bottom: 1px solid var(--border);
	}
	header small {
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--accent-text);
	}
	header h2 {
		margin: 3px 0 0;
		font-size: 20px;
		letter-spacing: -0.02em;
	}
	header button {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	header button:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}
	.content {
		min-height: min(520px, calc(100vh - 150px));
		display: grid;
		grid-template-columns: 190px minmax(0, 1fr);
		overflow: hidden;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 14px 10px;
		border-right: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-0) 65%, var(--surface-1));
	}
	nav button {
		min-height: 36px;
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 0 10px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-secondary);
		font: 600 10px/1 var(--font-sans);
		text-align: left;
		cursor: pointer;
	}
	nav button:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}
	nav button.active {
		background: var(--selection-soft);
		color: var(--accent-text);
	}
	.panel {
		--panel-subtle-text: color-mix(in srgb, var(--text-secondary) 78%, var(--text-primary));
		min-width: 0;
		padding: 18px;
		overflow: auto;
	}
	section {
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: 11px;
		background: var(--surface-2);
	}
	.section-heading {
		display: flex;
		align-items: center;
		gap: 11px;
	}
	.section-icon {
		width: 31px;
		height: 31px;
		display: grid;
		place-items: center;
		flex: none;
		border-radius: 8px;
		background: var(--selection-soft);
		color: var(--accent-text);
	}
	h3,
	p {
		margin: 0;
	}
	h3 {
		font-size: 14px;
	}
	p {
		margin-top: 4px;
		font-size: 11px;
		line-height: 1.4;
		color: var(--panel-subtle-text);
	}
	.section-body,
	.cache-action {
		margin-top: 15px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}
	.cache-action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
	}
	.cache-action > div {
		display: grid;
		gap: 3px;
	}
	.cache-action strong {
		font-size: 13px;
	}
	.cache-action span {
		font: 10.5px/1.3 var(--font-mono);
		color: var(--panel-subtle-text);
	}
	.cache-action button {
		height: 30px;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary);
		font: 11px/1 inherit;
		cursor: pointer;
	}
	.cache-action button:hover:not(:disabled) {
		border-color: var(--selection-border);
		color: var(--text-primary);
	}
	.cache-action button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.error {
		margin-top: 12px;
		padding: 9px 11px;
		border-radius: 7px;
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 11px;
	}

	@media (max-width: 680px) {
		.content {
			grid-template-columns: 1fr;
			grid-template-rows: auto minmax(0, 1fr);
		}
		nav {
			flex-direction: row;
			padding: 8px;
			border-right: 0;
			border-bottom: 1px solid var(--border);
		}
		nav button {
			flex: 1;
			justify-content: center;
			padding: 0 6px;
		}
	}
</style>
