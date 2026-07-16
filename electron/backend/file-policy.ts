import path from 'node:path';

const GENERATED_NAMES = new Set([
	'package-lock.json',
	'yarn.lock',
	'pnpm-lock.yaml',
	'bun.lock',
	'bun.lockb',
	'cargo.lock',
	'composer.lock',
	'poetry.lock',
	'gemfile.lock',
	'go.sum'
]);

const VENDORED_SEGMENTS = new Set([
	'node_modules',
	'vendor',
	'vendored',
	'third_party',
	'third-party',
	'dist',
	'build',
	'coverage',
	'.svelte-kit'
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	'.c': 'C',
	'.cc': 'C++',
	'.cpp': 'C++',
	'.css': 'CSS',
	'.go': 'Go',
	'.graphql': 'GraphQL',
	'.h': 'C',
	'.hpp': 'C++',
	'.html': 'HTML',
	'.java': 'Java',
	'.js': 'JavaScript',
	'.jsx': 'JavaScript JSX',
	'.json': 'JSON',
	'.kt': 'Kotlin',
	'.md': 'Markdown',
	'.mjs': 'JavaScript',
	'.php': 'PHP',
	'.py': 'Python',
	'.rb': 'Ruby',
	'.rs': 'Rust',
	'.scss': 'SCSS',
	'.sh': 'Shell',
	'.sql': 'SQL',
	'.svelte': 'Svelte',
	'.swift': 'Swift',
	'.toml': 'TOML',
	'.ts': 'TypeScript',
	'.tsx': 'TypeScript JSX',
	'.vue': 'Vue',
	'.xml': 'XML',
	'.yaml': 'YAML',
	'.yml': 'YAML',
	'.zsh': 'Shell'
};

export const ANALYSIS_LIMITS = {
	maxSideBytes: 2 * 1024 * 1024,
	maxPatchLines: 5_000,
	maxHunks: 100
} as const;

export function languageForPath(filePath: string): string {
	const name = path.posix.basename(filePath).toLowerCase();
	if (name === 'dockerfile') return 'Dockerfile';
	if (name === 'makefile') return 'Makefile';
	return LANGUAGE_BY_EXTENSION[path.posix.extname(name)] ?? 'Plain text';
}

export function generatedReasonForPath(filePath: string): string | undefined {
	const normalized = filePath.replaceAll('\\', '/').toLowerCase();
	const name = path.posix.basename(normalized);
	if (GENERATED_NAMES.has(name)) return 'Lockfile';
	if (normalized.endsWith('.map')) return 'Source map';
	if (/\.(?:min|bundle)(?:\.[a-z0-9]+)?\.(?:js|css)$/.test(normalized)) return 'Minified bundle';
	if (normalized.split('/').some((part) => VENDORED_SEGMENTS.has(part)))
		return 'Vendored or built output';
	if (/\b(?:generated|autogen|auto-generated)\b/.test(name)) return 'Generated filename';
	return undefined;
}

export function analysisSkipReason(input: {
	binary: boolean;
	submodule: boolean;
	generatedReason?: string;
	oldSize: number;
	newSize: number;
	patchLineCount: number;
	hunkCount: number;
}): string | undefined {
	if (input.submodule) return 'Submodule gitlinks are not analyzed';
	if (input.binary) return 'Binary file';
	if (input.generatedReason) return input.generatedReason;
	if (Math.max(input.oldSize, input.newSize) > ANALYSIS_LIMITS.maxSideBytes)
		return 'File exceeds 2 MiB';
	if (input.patchLineCount > ANALYSIS_LIMITS.maxPatchLines) return 'Patch exceeds 5,000 lines';
	if (input.hunkCount > ANALYSIS_LIMITS.maxHunks) return 'File has more than 100 hunks';
	return undefined;
}

export function isProbablyBinary(content: Uint8Array): boolean {
	const sample = content.subarray(0, Math.min(content.byteLength, 8192));
	for (const byte of sample) if (byte === 0) return true;
	return false;
}
