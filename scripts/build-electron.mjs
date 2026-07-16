import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

const production = process.env.NODE_ENV === 'production';

await mkdir('.electron', { recursive: true });

const shared = {
	bundle: true,
	platform: 'node',
	target: 'node24',
	sourcemap: production ? false : 'inline',
	minify: false,
	packages: 'external',
	logLevel: 'info'
};

await Promise.all([
	build({
		...shared,
		entryPoints: ['electron/main.ts'],
		outfile: '.electron/main.js',
		format: 'esm',
		external: ['electron']
	}),
	build({
		...shared,
		entryPoints: ['electron/preload.ts'],
		outfile: '.electron/preload.cjs',
		format: 'cjs',
		external: ['electron']
	}),
	build({
		...shared,
		entryPoints: ['electron/worker.ts'],
		outfile: '.electron/worker.js',
		format: 'esm',
		external: ['electron']
	}),
	build({
		...shared,
		entryPoints: ['electron/speech-worker.ts'],
		outfile: '.electron/speech-worker.js',
		format: 'esm',
		external: ['electron']
	})
]);
