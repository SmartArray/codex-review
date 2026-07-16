import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
	KokoroModelStatus,
	SiriStatus,
	SpeechEvent,
	SpeechSettings,
	VoiceboxStatus
} from '../src/lib/shared/types.js';
import { speechSettingsSchema, speechTextSchema } from '../src/lib/shared/schemas.js';

const execFileAsync = promisify(execFile);
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICEBOX_URL = 'http://127.0.0.1:17493';
const DEFAULTS: SpeechSettings = { engine: 'kokoro', voice: 'am_michael', speed: 1 };

export interface SpeechTaskProcess {
	postMessage(message: object): void;
	onMessage(listener: (message: unknown) => void): void;
	onError(listener: (error: Error) => void): void;
	onExit(listener: (code: number) => void): void;
	terminate(): Promise<void>;
}

export type SpeechTaskLauncher = (modulePath: string) => SpeechTaskProcess;

export class SpeechService {
	private settings = DEFAULTS;
	private modelStatus: KokoroModelStatus = { state: 'missing' };
	private siriStatus?: SiriStatus;
	private player?: ChildProcess;
	private paused = false;
	private synthesisWorker?: SpeechTaskProcess;
	private synthesisProcess?: ChildProcess;
	private voiceboxController?: AbortController;
	private downloadWorker?: SpeechTaskProcess;
	private generation = 0;
	private download?: Promise<KokoroModelStatus>;
	private partialAudio = new Set<string>();

	constructor(
		private readonly userData: string,
		private readonly emit: (event: SpeechEvent) => void,
		private readonly launchSpeechTask?: SpeechTaskLauncher
	) {}

	private get settingsFile() {
		return path.join(this.userData, 'speech-settings.json');
	}
	private get cacheDir() {
		return path.join(this.userData, 'kokoro-82m');
	}
	private get markerFile() {
		return path.join(this.cacheDir, 'validated.json');
	}
	private get audioCacheDir() {
		return path.join(this.userData, 'speech-audio');
	}

	async initialize(): Promise<void> {
		await this.removeOrphanedAudio();
		try {
			this.settings = speechSettingsSchema.parse(
				JSON.parse(await readFile(this.settingsFile, 'utf8'))
			);
		} catch {
			this.settings = DEFAULTS;
		}
		this.modelStatus = (await this.validateModel()) ? { state: 'ready' } : { state: 'missing' };
	}

	getSettings(): SpeechSettings {
		return { ...this.settings };
	}
	async setSettings(value: unknown): Promise<SpeechSettings> {
		const next = speechSettingsSchema.parse(value);
		if (next.engine === 'siri' && !(await this.getSiriStatus()).available)
			throw new Error('A literal Siri voice is not publicly accessible on this Mac.');
		if (next.engine === 'voicebox') {
			const status = await this.getVoiceboxStatus();
			if (!status.available) throw new Error(status.reason ?? 'Voicebox is unavailable.');
			if (!status.profiles.some((profile) => profile.id === next.voiceboxProfileId))
				throw new Error('The selected Voicebox profile is unavailable.');
		}
		await this.stop();
		this.settings = next;
		await mkdir(this.userData, { recursive: true });
		await writeFile(this.settingsFile, JSON.stringify(next), { mode: 0o600 });
		this.emit({ type: 'cache-changed' });
		return this.getSettings();
	}

	getModelStatus(): KokoroModelStatus {
		return { ...this.modelStatus };
	}
	async downloadModel(): Promise<KokoroModelStatus> {
		if (this.modelStatus.state === 'ready') return this.getModelStatus();
		if (this.download) return this.download;
		this.download = this.performDownload().finally(() => {
			this.download = undefined;
		});
		return this.download;
	}

	private async performDownload(): Promise<KokoroModelStatus> {
		this.setModel({ state: 'downloading', progress: 0, message: 'Starting download…' });
		try {
			await mkdir(this.cacheDir, { recursive: true });
			await this.runWorker(
				{ action: 'download', cacheDir: this.cacheDir },
				(progress, message) => this.setModel({ state: 'downloading', progress, message }),
				(worker) => (this.downloadWorker = worker)
			);
			const files = await this.fileManifest();
			if (!files.length) throw new Error('The download completed without model files.');
			await writeFile(this.markerFile, JSON.stringify({ model: MODEL_ID, files }));
			if (!(await this.validateModel())) throw new Error('Downloaded model validation failed.');
			this.setModel({ state: 'ready', progress: 1, message: 'Kokoro 82M is ready.' });
		} catch (error) {
			this.setModel({
				state: 'failed',
				message: `Model download failed: ${messageOf(error)} Retry when your connection is available.`
			});
		}
		return this.getModelStatus();
	}

	async getSiriStatus(): Promise<SiriStatus> {
		if (process.platform !== 'darwin') return { visible: false, available: false };
		if (this.siriStatus) return this.siriStatus;
		try {
			const { stdout } = await execFileAsync('/usr/bin/say', ['-v', '?'], {
				timeout: 5000,
				maxBuffer: 1024 * 1024
			});
			const voice = stdout
				.split('\n')
				.map((line) => line.trim().split(/\s{2,}/)[0])
				.find((name) => /^Siri(?:\s|$)/i.test(name ?? ''));
			this.siriStatus = voice
				? { visible: true, available: true, voice }
				: {
						visible: true,
						available: false,
						reason: 'macOS does not expose a literal Siri voice through its public speech voices.'
					};
		} catch {
			this.siriStatus = {
				visible: true,
				available: false,
				reason: 'Siri voice availability could not be inspected.'
			};
		}
		return this.siriStatus;
	}

	async getVoiceboxStatus(): Promise<VoiceboxStatus> {
		try {
			const response = await fetch(`${VOICEBOX_URL}/profiles`, {
				signal: AbortSignal.timeout(3_000),
				headers: { 'X-Voicebox-Client-Id': 'codex-explain' }
			});
			if (!response.ok) throw new Error(`Voicebox returned HTTP ${response.status}.`);
			const value = await response.json();
			if (!Array.isArray(value)) throw new Error('Voicebox returned an invalid profile list.');
			const profiles = value.flatMap((item) => {
				if (!item || typeof item !== 'object') return [];
				const profile = item as { id?: unknown; name?: unknown; language?: unknown };
				if (typeof profile.id !== 'string' || typeof profile.name !== 'string') return [];
				return [
					{
						id: profile.id,
						name: profile.name,
						language: typeof profile.language === 'string' ? profile.language : undefined
					}
				];
			});
			return profiles.length
				? { available: true, profiles }
				: {
						available: false,
						profiles: [],
						reason: 'Voicebox is running but has no voice profiles. Create one in Voicebox first.'
					};
		} catch (error) {
			return {
				available: false,
				profiles: [],
				reason: `Voicebox is not available at ${VOICEBOX_URL}. Open Voicebox and start its local server. ${messageOf(error)}`
			};
		}
	}

	async playRole(value: unknown): Promise<void> {
		const text = speechTextSchema.parse(value);
		await this.stop();
		const id = ++this.generation;
		this.emit({ type: 'playback', state: 'loading', progress: 0 });
		try {
			const file = await this.ensureCached(text, (progress, message) => {
				if (id === this.generation)
					this.emit({ type: 'playback', state: 'loading', progress, message });
			});
			if (id !== this.generation) return;
			this.startPlayer(file, id);
		} catch (error) {
			if (id !== this.generation) return;
			if (id === this.generation)
				this.emit({ type: 'playback', state: 'error', message: messageOf(error) });
			throw error;
		}
	}

	async prepare(values: unknown[]): Promise<void> {
		for (const value of values) await this.ensureCached(speechTextSchema.parse(value));
	}
	async isCached(value: unknown): Promise<boolean> {
		const { output } = this.cacheTarget(speechTextSchema.parse(value));
		try {
			return (await stat(output)).size > 44;
		} catch {
			return false;
		}
	}

	private cacheTarget(text: string): { extension: string; key: string; output: string } {
		const extension = this.settings.engine === 'siri' ? 'aiff' : 'wav';
		const identity =
			this.settings.engine === 'kokoro'
				? {
						engine: this.settings.engine,
						voice: this.settings.voice,
						speed: this.settings.speed,
						text
					}
				: this.settings.engine === 'voicebox'
					? {
							engine: this.settings.engine,
							profile: this.settings.voiceboxProfileId,
							speed: this.settings.speed,
							text
						}
					: { engine: this.settings.engine, speed: this.settings.speed, text };
		const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
		return { extension, key, output: path.join(this.audioCacheDir, `${key}.${extension}`) };
	}

	private async ensureCached(
		text: string,
		progress: (progress: number, message: string) => void = () => undefined
	): Promise<string> {
		const { extension, key, output } = this.cacheTarget(text);
		try {
			if ((await stat(output)).size > 44) return output;
		} catch {
			/* Generate below. */
		}
		await mkdir(this.audioCacheDir, { recursive: true });
		const temporary = path.join(this.audioCacheDir, `${key}.${randomUUID()}.part.${extension}`);
		this.partialAudio.add(temporary);
		try {
			if (this.settings.engine === 'kokoro') {
				if (this.modelStatus.state !== 'ready')
					throw new Error('Download the Kokoro 82M model in Speech settings first.');
				await this.runWorker(
					{
						action: 'generate',
						cacheDir: this.cacheDir,
						text,
						voice: this.settings.voice,
						speed: this.settings.speed,
						output: temporary
					},
					progress,
					(worker) => (this.synthesisWorker = worker)
				);
			} else if (this.settings.engine === 'siri') {
				const siri = await this.getSiriStatus();
				if (!siri.available || !siri.voice)
					throw new Error(siri.reason ?? 'A literal Siri voice is unavailable.');
				await this.runSynthesisProcess('/usr/bin/say', [
					'-o',
					temporary,
					'-v',
					siri.voice,
					'-r',
					String(Math.round(175 * this.settings.speed)),
					text
				]);
			} else {
				await this.generateWithVoicebox(text, temporary, progress);
			}
			if ((await stat(temporary)).size <= 44)
				throw new Error('Speech generation produced no audio.');
			await rename(temporary, output);
			this.emit({ type: 'cache-changed', text });
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		} finally {
			this.partialAudio.delete(temporary);
		}
		return output;
	}

	async stop(): Promise<void> {
		this.generation++;
		this.voiceboxController?.abort();
		this.voiceboxController = undefined;
		if (this.synthesisWorker) await this.synthesisWorker.terminate().catch(() => undefined);
		this.synthesisWorker = undefined;
		if (this.synthesisProcess && !this.synthesisProcess.killed) {
			const process = this.synthesisProcess;
			await new Promise<void>((resolve) => {
				process.once('close', () => resolve());
				process.kill('SIGKILL');
			});
		}
		this.synthesisProcess = undefined;
		if (this.player && !this.player.killed) this.player.kill('SIGKILL');
		this.player = undefined;
		await Promise.all(
			[...this.partialAudio].map((file) => rm(file, { force: true }).catch(() => undefined))
		);
		this.partialAudio.clear();
		this.paused = false;
		this.emit({ type: 'playback', state: 'stopped' });
	}

	async pause(): Promise<void> {
		if (!this.player || this.paused || process.platform === 'win32') return;
		this.player.kill('SIGSTOP');
		this.paused = true;
		this.emit({ type: 'playback', state: 'paused' });
	}
	async resume(): Promise<void> {
		if (!this.player || !this.paused || process.platform === 'win32') return;
		this.player.kill('SIGCONT');
		this.paused = false;
		this.emit({ type: 'playback', state: 'playing' });
	}
	async cacheInfo() {
		try {
			const entries = await readdir(this.audioCacheDir, { withFileTypes: true });
			let sizeBytes = 0;
			let entryCount = 0;
			for (const entry of entries)
				if (entry.isFile()) {
					entryCount++;
					sizeBytes += (await stat(path.join(this.audioCacheDir, entry.name))).size;
				}
			return { entryCount, sizeBytes };
		} catch {
			return { entryCount: 0, sizeBytes: 0 };
		}
	}
	async clearAudioCache() {
		await this.stop();
		await rm(this.audioCacheDir, { recursive: true, force: true });
		this.emit({ type: 'cache-changed' });
		return this.cacheInfo();
	}

	async shutdown(): Promise<void> {
		await this.stop();
		if (this.downloadWorker) await this.downloadWorker.terminate().catch(() => undefined);
		this.downloadWorker = undefined;
	}

	private async removeOrphanedAudio(): Promise<void> {
		try {
			const entries = await readdir(this.audioCacheDir, { withFileTypes: true });
			await Promise.all(
				entries
					.filter((entry) => entry.isFile() && entry.name.includes('.part.'))
					.map((entry) =>
						rm(path.join(this.audioCacheDir, entry.name), { force: true }).catch(() => undefined)
					)
			);
		} catch {
			/* The audio cache has not been created yet. */
		}
	}

	private startPlayer(file: string, id: number): void {
		const rate = this.settings.engine === 'voicebox' ? this.settings.speed : 1;
		if (process.platform === 'darwin')
			this.startProcess(
				'/usr/bin/afplay',
				rate === 1 ? [file] : ['-r', String(rate), '-q', '1', file],
				id
			);
		else if (process.platform === 'win32')
			this.startProcess(
				'powershell.exe',
				[
					'-NoProfile',
					'-Command',
					`(New-Object Media.SoundPlayer '${file.replaceAll("'", "''")}').PlaySync()`
				],
				id
			);
		else
			this.startProcess(
				'ffplay',
				[
					'-nodisp',
					'-autoexit',
					'-loglevel',
					'quiet',
					...(rate === 1 ? [] : ['-af', `atempo=${rate}`]),
					file
				],
				id
			);
	}

	private async generateWithVoicebox(
		text: string,
		output: string,
		progress: (progress: number, message: string) => void
	): Promise<void> {
		const profileId = this.settings.voiceboxProfileId;
		if (!profileId) throw new Error('Choose a Voicebox profile in Speech settings.');
		const controller = new AbortController();
		this.voiceboxController = controller;
		try {
			progress(0.15, 'Sending text to Voicebox…');
			const generated = await fetch(`${VOICEBOX_URL}/generate`, {
				method: 'POST',
				signal: controller.signal,
				headers: {
					'Content-Type': 'application/json',
					'X-Voicebox-Client-Id': 'codex-explain'
				},
				body: JSON.stringify({ text, profile_id: profileId, language: 'en' })
			});
			if (!generated.ok)
				throw new Error(
					`Voicebox generation failed (${generated.status}): ${await responseDetail(generated)}`
				);
			const generation = (await generated.json()) as { id?: unknown };
			if (typeof generation.id !== 'string' || generation.id.length > 256)
				throw new Error('Voicebox returned an invalid generation ID.');
			progress(0.75, 'Fetching Voicebox audio…');
			const audio = await fetch(`${VOICEBOX_URL}/audio/${encodeURIComponent(generation.id)}`, {
				signal: controller.signal,
				headers: { 'X-Voicebox-Client-Id': 'codex-explain' }
			});
			if (!audio.ok)
				throw new Error(`Voicebox audio failed (${audio.status}): ${await responseDetail(audio)}`);
			const data = Buffer.from(await audio.arrayBuffer());
			if (data.length <= 44) throw new Error('Voicebox returned an empty audio file.');
			await writeFile(output, data, { mode: 0o600 });
			progress(0.95, 'Voicebox audio is ready.');
		} finally {
			if (this.voiceboxController === controller) this.voiceboxController = undefined;
		}
	}

	private runSynthesisProcess(command: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			const process = spawn(command, args, { stdio: 'ignore' });
			this.synthesisProcess = process;
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (this.synthesisProcess === process) this.synthesisProcess = undefined;
				if (error) reject(error);
				else resolve();
			};
			process.once('error', (error) => finish(error));
			process.once('exit', (code, signal) => {
				if (code === 0) finish();
				else
					finish(
						new Error(
							signal
								? `Speech synthesis was stopped (${signal}).`
								: `Speech synthesis exited with code ${code ?? 'unknown'}.`
						)
					);
			});
		});
	}

	private startProcess(command: string, args: string[], id: number): void {
		const player = spawn(command, args, { stdio: 'ignore' });
		this.player = player;
		this.paused = false;
		this.emit({ type: 'playback', state: 'playing' });
		player.once('error', (error) => {
			if (id === this.generation)
				this.emit({
					type: 'playback',
					state: 'error',
					message: `Audio playback failed: ${error.message}`
				});
		});
		player.once('exit', () => {
			if (this.player === player) this.player = undefined;
			this.paused = false;
			if (id === this.generation) this.emit({ type: 'playback', state: 'stopped' });
		});
	}

	private setModel(status: KokoroModelStatus): void {
		this.modelStatus = status;
		this.emit({ type: 'model', status });
	}
	private runWorker(
		request: object,
		onProgress: (progress: number, message: string) => void,
		assign: (worker: SpeechTaskProcess | undefined) => void
	): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.launchSpeechTask) {
				reject(new Error('The isolated speech process is unavailable. Restart Codex Explain.'));
				return;
			}
			let worker: SpeechTaskProcess;
			try {
				worker = this.launchSpeechTask(path.join(import.meta.dirname, 'speech-worker.js'));
			} catch (error) {
				reject(error);
				return;
			}
			assign(worker);
			let settled = false;
			let completed = false;
			let reportedError: Error | undefined;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				assign(undefined);
				if (error) reject(error);
				else resolve();
			};
			worker.onMessage((message: unknown) => {
				const value = message as { type?: string; progress?: number; message?: string };
				if (value.type === 'progress') onProgress(value.progress ?? 0, value.message ?? 'Working…');
				else if (value.type === 'complete') completed = true;
				else if (value.type === 'error') {
					reportedError = new Error(value.message ?? 'Speech process failed.');
					void worker.terminate();
				}
			});
			worker.onError((error) => {
				reportedError = error;
			});
			worker.onExit((code) => {
				if (reportedError) finish(reportedError);
				else if (completed && code === 0) finish();
				else
					finish(
						new Error(
							code === 0
								? 'Speech process stopped before completing.'
								: `Speech process exited unexpectedly with code ${code}.`
						)
					);
			});
			try {
				worker.postMessage(request);
			} catch (error) {
				void worker.terminate();
				finish(error instanceof Error ? error : new Error('Could not start speech process.'));
			}
		});
	}
	private async fileManifest(): Promise<Array<{ path: string; size: number; sha256: string }>> {
		const result: Array<{ path: string; size: number; sha256: string }> = [];
		const walk = async (directory: string) => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const full = path.join(directory, entry.name);
				if (full === this.markerFile) continue;
				if (entry.isDirectory()) await walk(full);
				else {
					const data = await readFile(full);
					result.push({
						path: path.relative(this.cacheDir, full),
						size: data.length,
						sha256: createHash('sha256').update(data).digest('hex')
					});
				}
			}
		};
		await walk(this.cacheDir);
		return result;
	}
	private async validateModel(): Promise<boolean> {
		try {
			const marker = JSON.parse(await readFile(this.markerFile, 'utf8')) as {
				model?: string;
				files?: Array<{ path: string; size: number; sha256: string }>;
			};
			if (marker.model !== MODEL_ID || !marker.files?.length) return false;
			for (const item of marker.files) {
				if (item.path.includes('..') || path.isAbsolute(item.path)) return false;
				const data = await readFile(path.join(this.cacheDir, item.path));
				if (
					(await stat(path.join(this.cacheDir, item.path))).size !== item.size ||
					createHash('sha256').update(data).digest('hex') !== item.sha256
				)
					return false;
			}
			return true;
		} catch {
			return false;
		}
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown error.';
}
async function responseDetail(response: Response): Promise<string> {
	try {
		const text = (await response.text()).trim();
		return text.slice(0, 500) || response.statusText || 'Unknown error.';
	} catch {
		return response.statusText || 'Unknown error.';
	}
}
export { DEFAULTS as DEFAULT_SPEECH_SETTINGS };
