import { spawn } from 'node:child_process';
import electronPath from 'electron';

const root = new URL('../', import.meta.url);
const children = new Set();

function run(command, args, options = {}) {
	const child = spawn(command, args, {
		cwd: root,
		stdio: 'inherit',
		...options
	});
	children.add(child);
	child.once('exit', () => children.delete(child));
	return child;
}

function shutdown(signal = 'SIGTERM') {
	for (const child of children) {
		if (!child.killed) child.kill(signal);
	}
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

const build = run(process.execPath, ['scripts/build-electron.mjs']);
const buildCode = await new Promise((resolve) => build.once('exit', resolve));
if (buildCode !== 0) process.exit(buildCode ?? 1);

run('yarn', ['dev:web', '--port', '5173', '--strictPort']);

for (let attempt = 0; attempt < 100; attempt += 1) {
	try {
		const response = await fetch('http://127.0.0.1:5173');
		if (response.ok) break;
	} catch {
		// Vite is still starting.
	}
	await new Promise((resolve) => setTimeout(resolve, 100));
	if (attempt === 99) {
		shutdown();
		throw new Error('Timed out waiting for the Svelte development server');
	}
}

const electron = run(electronPath, ['.', ...process.argv.slice(2)], {
	env: {
		...process.env,
		CODEX_EXPLAIN_DEV_URL: 'http://127.0.0.1:5173'
	}
});

const exitCode = await new Promise((resolve) => electron.once('exit', resolve));
shutdown();
process.exit(exitCode ?? 0);
