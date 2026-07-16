import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const TARGETS: Record<string, { packageName: string; triple: string }> = {
	'darwin-arm64': { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
	'darwin-x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
	'linux-arm64': { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
	'linux-x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
	'win32-arm64': { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
	'win32-x64': { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' }
};

export function resolveCodexBinary(): string {
	const target = TARGETS[`${process.platform}-${process.arch}`];
	if (!target) throw new Error(`Codex is not packaged for ${process.platform} ${process.arch}.`);
	const require = createRequire(import.meta.url);
	let packageJson: string;
	try {
		packageJson = require.resolve(`${target.packageName}/package.json`);
	} catch {
		throw new Error(
			`The packaged Codex binary (${target.packageName}) is missing. Reinstall the application.`
		);
	}
	let executable = path.join(
		path.dirname(packageJson),
		'vendor',
		target.triple,
		'bin',
		process.platform === 'win32' ? 'codex.exe' : 'codex'
	);
	if (!existsSync(executable) && executable.includes(`${path.sep}app.asar${path.sep}`)) {
		executable = executable.replace(
			`${path.sep}app.asar${path.sep}`,
			`${path.sep}app.asar.unpacked${path.sep}`
		);
	}
	if (!existsSync(executable)) throw new Error('The native Codex executable could not be found.');
	return executable;
}
