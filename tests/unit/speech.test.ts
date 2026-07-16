import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SpeechService,
	DEFAULT_SPEECH_SETTINGS,
	type SpeechTaskProcess
} from '../../electron/speech-service';
import {
	kokoroVoiceSchema,
	speechSettingsSchema,
	speechTextSchema
} from '../../src/lib/shared/schemas';

describe('speech settings', () => {
	afterEach(() => vi.unstubAllGlobals());
	it('defaults to Kokoro, Michael, and 1.0x when no settings exist', async () => {
		const service = new SpeechService(await temporaryDirectory(), () => undefined);
		await service.initialize();
		expect(service.getSettings()).toEqual(DEFAULT_SPEECH_SETTINGS);
		expect(service.getModelStatus().state).toBe('missing');
	});

	it('persists valid settings across service instances', async () => {
		const directory = await temporaryDirectory();
		const first = new SpeechService(directory, () => undefined);
		await first.initialize();
		await first.setSettings({ engine: 'kokoro', voice: 'af_sarah', speed: 1.4 });
		const second = new SpeechService(directory, () => undefined);
		await second.initialize();
		expect(second.getSettings()).toEqual({ engine: 'kokoro', voice: 'af_sarah', speed: 1.4 });
	});

	it('falls back safely when persisted settings are malformed', async () => {
		const directory = await temporaryDirectory();
		await writeFile(
			path.join(directory, 'speech-settings.json'),
			JSON.stringify({ engine: 'kokoro', voice: 'not-approved', speed: 9 })
		);
		const service = new SpeechService(directory, () => undefined);
		await service.initialize();
		expect(service.getSettings()).toEqual(DEFAULT_SPEECH_SETTINGS);
	});

	it('accepts only approved voices and constrained tenth-step speeds', () => {
		expect(
			['am_michael', 'am_echo', 'af_sarah', 'af_heart'].every(
				(voice) => kokoroVoiceSchema.safeParse(voice).success
			)
		).toBe(true);
		expect(kokoroVoiceSchema.safeParse('am_adam').success).toBe(false);
		expect(
			speechSettingsSchema.safeParse({ engine: 'kokoro', voice: 'am_michael', speed: 0.5 }).success
		).toBe(true);
		expect(
			speechSettingsSchema.safeParse({ engine: 'kokoro', voice: 'am_michael', speed: 2 }).success
		).toBe(true);
		expect(
			speechSettingsSchema.safeParse({ engine: 'kokoro', voice: 'am_michael', speed: 2.1 }).success
		).toBe(false);
		expect(
			speechSettingsSchema.safeParse({ engine: 'kokoro', voice: 'am_michael', speed: 1.05 }).success
		).toBe(false);
		expect(
			speechSettingsSchema.safeParse({
				engine: 'voicebox',
				voice: 'am_michael',
				speed: 1,
				voiceboxProfileId: 'profile-1'
			}).success
		).toBe(true);
		expect(
			speechSettingsSchema.safeParse({ engine: 'voicebox', voice: 'am_michael', speed: 1 }).success
		).toBe(false);
	});

	it('discovers Voicebox profiles and caches generated audio locally', async () => {
		const requests: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requests.push(url);
				if (url.endsWith('/profiles'))
					return Response.json([{ id: 'profile-1', name: 'Morgan', language: 'en' }]);
				if (url.endsWith('/generate')) {
					expect(JSON.parse(String(init?.body))).toMatchObject({
						text: 'Voicebox narration',
						profile_id: 'profile-1'
					});
					return Response.json({ id: 'generation-1' });
				}
				if (url.endsWith('/audio/generation-1'))
					return new Response(Buffer.alloc(100), {
						headers: { 'Content-Type': 'audio/wav' }
					});
				return new Response('Not found', { status: 404 });
			})
		);
		const service = new SpeechService(await temporaryDirectory(), () => undefined);
		await service.initialize();
		expect(await service.getVoiceboxStatus()).toEqual({
			available: true,
			profiles: [{ id: 'profile-1', name: 'Morgan', language: 'en' }]
		});
		await service.setSettings({
			engine: 'voicebox',
			voice: 'am_michael',
			speed: 1,
			voiceboxProfileId: 'profile-1'
		});
		await service.playRole('Voicebox narration');
		expect(await service.isCached('Voicebox narration')).toBe(true);
		expect(requests).toContain('http://127.0.0.1:17493/generate');
		await service.stop();
	});

	it('rejects malformed or excessively long role requests', () => {
		expect(speechTextSchema.safeParse('The routing entry point').success).toBe(true);
		expect(speechTextSchema.safeParse('').success).toBe(false);
		expect(speechTextSchema.safeParse('x'.repeat(2001)).success).toBe(false);
	});

	it('cancels isolated Kokoro inference without terminating the application thread', async () => {
		const directory = await temporaryDirectory();
		await installValidModel(directory);
		let started: (() => void) | undefined;
		const didStart = new Promise<void>((resolve) => (started = resolve));
		const terminate = vi.fn(async () => {
			for (const listener of exitListeners) listener(143);
		});
		const exitListeners: Array<(code: number) => void> = [];
		const task: SpeechTaskProcess = {
			postMessage: () => started?.(),
			onMessage: () => undefined,
			onError: () => undefined,
			onExit: (listener) => exitListeners.push(listener),
			terminate
		};
		const service = new SpeechService(
			directory,
			() => undefined,
			() => task
		);
		await service.initialize();

		const playback = service.playRole('Cancel this narration safely');
		await didStart;
		await service.stop();
		await playback;

		expect(terminate).toHaveBeenCalledOnce();
		expect(service.getModelStatus().state).toBe('ready');
	});

	it('writes settings as private JSON', async () => {
		const directory = await temporaryDirectory();
		const service = new SpeechService(directory, () => undefined);
		await service.initialize();
		await service.setSettings({ engine: 'kokoro', voice: 'am_echo', speed: 0.8 });
		expect(
			JSON.parse(await readFile(path.join(directory, 'speech-settings.json'), 'utf8'))
		).toEqual({ engine: 'kokoro', voice: 'am_echo', speed: 0.8 });
	});

	it('reports, clears, and removes incomplete persistent audio cache entries', async () => {
		const directory = await temporaryDirectory();
		const audioDirectory = path.join(directory, 'speech-audio');
		const text = 'A cached narration';
		const key = createHash('sha256')
			.update(JSON.stringify({ ...DEFAULT_SPEECH_SETTINGS, text }))
			.digest('hex');
		await mkdir(audioDirectory);
		await writeFile(path.join(audioDirectory, `${key}.wav`), Buffer.alloc(100));
		await writeFile(path.join(audioDirectory, 'cancelled.part.wav'), Buffer.alloc(60));
		const service = new SpeechService(directory, () => undefined);

		await service.initialize();
		expect(await service.isCached(text)).toBe(true);
		expect(await service.isCached('Not cached')).toBe(false);
		expect(await service.cacheInfo()).toEqual({ entryCount: 1, sizeBytes: 100 });
		expect(await service.clearAudioCache()).toEqual({ entryCount: 0, sizeBytes: 0 });
	});
});

async function temporaryDirectory(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), 'codex-explain-speech-'));
}

async function installValidModel(directory: string): Promise<void> {
	const modelDirectory = path.join(directory, 'kokoro-82m');
	const model = Buffer.from('test model');
	await mkdir(modelDirectory);
	await writeFile(path.join(modelDirectory, 'model.onnx'), model);
	await writeFile(
		path.join(modelDirectory, 'validated.json'),
		JSON.stringify({
			model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
			files: [
				{
					path: 'model.onnx',
					size: model.length,
					sha256: createHash('sha256').update(model).digest('hex')
				}
			]
		})
	);
}
