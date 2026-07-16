import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
type Request =
	| { action: 'download'; cacheDir: string }
	| {
			action: 'generate';
			cacheDir: string;
			text: string;
			voice: 'am_michael' | 'am_echo' | 'af_sarah' | 'af_heart';
			speed: number;
			output: string;
	  };

const parentPort = process.parentPort;

if (!parentPort) throw new Error('Speech synthesis must run in an Electron utility process.');

parentPort.once('message', async (event) => {
	const request = event.data as Request;
	try {
		env.cacheDir = request.cacheDir;
		env.allowRemoteModels = request.action === 'download';
		post(0.05, request.action === 'download' ? 'Connecting…' : 'Loading Kokoro…');
		const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
			dtype: 'q8',
			device: 'cpu',
			progress_callback: (item) => {
				if (request.action !== 'download') return;
				const value = item as { progress?: number; file?: string };
				const progress =
					typeof value.progress === 'number'
						? Math.max(0.05, Math.min(0.95, value.progress / 100))
						: 0.05;
				post(
					progress,
					value.file ? `Downloading ${value.file.split('/').at(-1)}` : 'Downloading model…'
				);
			}
		});
		if (request.action === 'generate') {
			post(0.25, 'Preparing speech…');
			const audio = await tts.generate(request.text, {
				voice: request.voice,
				speed: request.speed
			});
			post(0.9, 'Preparing audio…');
			await audio.save(request.output);
		}
		parentPort.postMessage({ type: 'complete' });
	} catch (error) {
		parentPort.postMessage({
			type: 'error',
			message: error instanceof Error ? error.message : 'Speech worker failed.'
		});
	}
	setImmediate(() => process.exit(0));
});

function post(progress: number, message: string): void {
	parentPort.postMessage({ type: 'progress', progress, message });
}
