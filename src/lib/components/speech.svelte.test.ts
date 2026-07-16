import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { ReviewApi, SpeechEvent } from '$lib/shared/types';
import RoleSpeechButton from './RoleSpeechButton.svelte';
import SettingsDialog from './SettingsDialog.svelte';
import SpeechSettings from './SpeechSettings.svelte';

describe('speech controls', () => {
	it('shows failed downloads and allows an explicit retry', async () => {
		let listener: ((event: SpeechEvent) => void) | undefined;
		const download = vi.fn(async () => ({ state: 'ready' as const, progress: 1 }));
		installApi({
			getKokoroModelStatus: async () => ({ state: 'failed', message: 'Network unavailable' }),
			downloadKokoroModel: download,
			onSpeechEvent: (next) => {
				listener = next;
				return () => undefined;
			}
		});
		const screen = render(SpeechSettings);
		await expect.element(screen.getByText('Network unavailable')).toBeVisible();
		await screen.getByRole('button', { name: 'Retry download' }).click();
		expect(download).toHaveBeenCalledOnce();
		listener?.({ type: 'model', status: { state: 'downloading', progress: 0.4 } });
		await expect.element(screen.getByLabelText('Model download progress')).toHaveValue(0.4);
	});

	it('speaks only its Role value and toggles Play to Stop', async () => {
		let listener: ((event: SpeechEvent) => void) | undefined;
		const play = vi.fn(async () => undefined);
		const stop = vi.fn(async () => undefined);
		installApi({
			playRole: play,
			stopSpeech: stop,
			onSpeechEvent: (next) => {
				listener = next;
				return () => undefined;
			}
		});
		const screen = render(RoleSpeechButton, { text: 'Routes requests to review handlers' });
		const playButton = screen.getByRole('button', { name: 'Read role aloud' });
		await expect.element(playButton).toBeEnabled();
		await playButton.click();
		expect(play).toHaveBeenCalledWith('Routes requests to review handlers');
		listener?.({ type: 'playback', state: 'playing' });
		await screen.getByRole('button', { name: 'Stop reading role' }).click();
		expect(stop).toHaveBeenCalledOnce();
	});

	it('renders the audio glyph in light green when its narration is cached', async () => {
		installApi({ isSpeechCached: async () => true });
		const screen = render(RoleSpeechButton, { text: 'Already prepared' });
		await expect
			.element(screen.getByRole('button', { name: 'Read role aloud' }))
			.toHaveClass(/cached/);
	});

	it('selects a Voicebox profile from the local service', async () => {
		const setSettings = vi.fn(
			async (settings: Parameters<ReviewApi['setSpeechSettings']>[0]) => settings
		);
		installApi({
			setSpeechSettings: setSettings,
			getVoiceboxStatus: async () => ({
				available: true,
				profiles: [{ id: 'profile-1', name: 'Morgan', language: 'en' }]
			})
		});
		const screen = render(SpeechSettings);
		await screen.getByLabelText('Speech engine').selectOptions('voicebox');
		expect(setSettings).toHaveBeenCalledWith(
			expect.objectContaining({ engine: 'voicebox', voiceboxProfileId: 'profile-1' })
		);
		await expect.element(screen.getByLabelText('Voicebox profile')).toBeVisible();
	});

	it('navigates Speech, Code Cache, and Audio Cache from the settings sidebar', async () => {
		const screen = render(SettingsDialog);
		await expect
			.element(screen.getByRole('navigation', { name: 'Settings sections' }))
			.toBeVisible();
		await expect.element(screen.getByRole('heading', { name: 'Speech Settings' })).toBeVisible();
		await screen.getByRole('button', { name: 'Code Cache' }).click();
		await expect.element(screen.getByRole('heading', { name: 'Code Cache' })).toBeVisible();
		await screen.getByRole('button', { name: 'Audio Cache' }).click();
		await expect.element(screen.getByRole('heading', { name: 'Audio Cache' })).toBeVisible();
	});
});

function installApi(overrides: Partial<ReviewApi>): void {
	const api = {
		getSpeechSettings: async () => ({
			engine: 'kokoro' as const,
			voice: 'am_michael' as const,
			speed: 1
		}),
		setSpeechSettings: async (settings: Parameters<ReviewApi['setSpeechSettings']>[0]) => settings,
		getKokoroModelStatus: async () => ({ state: 'ready' as const }),
		downloadKokoroModel: async () => ({ state: 'ready' as const }),
		getSiriStatus: async () => ({ visible: false, available: false }),
		getVoiceboxStatus: async () => ({ available: false, profiles: [], reason: 'Not running' }),
		getCacheInfo: async () => ({ entryCount: 0, sizeBytes: 0, databasePath: '/cache' }),
		clearCache: async () => ({ entryCount: 0, sizeBytes: 0, databasePath: '/cache' }),
		getSpeechCacheInfo: async () => ({ entryCount: 0, sizeBytes: 0 }),
		clearSpeechCache: async () => ({ entryCount: 0, sizeBytes: 0 }),
		playRole: async () => undefined,
		isSpeechCached: async () => false,
		stopSpeech: async () => undefined,
		onSpeechEvent: () => () => undefined,
		...overrides
	} as ReviewApi;
	Object.defineProperty(window, 'reviewApi', { configurable: true, writable: true, value: api });
}
