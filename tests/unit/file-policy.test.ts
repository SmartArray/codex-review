import { describe, expect, it } from 'vitest';
import {
	analysisSkipReason,
	generatedReasonForPath,
	isProbablyBinary,
	languageForPath
} from '../../electron/backend/file-policy.js';

describe('file analysis policy', () => {
	it('classifies languages and common generated paths', () => {
		expect(languageForPath('src/App.svelte')).toBe('Svelte');
		expect(languageForPath('Dockerfile')).toBe('Dockerfile');
		expect(generatedReasonForPath('yarn.lock')).toBe('Lockfile');
		expect(generatedReasonForPath('vendor/library.js')).toContain('Vendored');
		expect(generatedReasonForPath('src/app.ts')).toBeUndefined();
	});

	it('enforces binary, size, patch, and hunk limits', () => {
		const base = {
			binary: false,
			submodule: false,
			oldSize: 1,
			newSize: 1,
			patchLineCount: 1,
			hunkCount: 1
		};
		expect(analysisSkipReason(base)).toBeUndefined();
		expect(analysisSkipReason({ ...base, binary: true })).toBe('Binary file');
		expect(analysisSkipReason({ ...base, newSize: 2 * 1024 * 1024 + 1 })).toContain('2 MiB');
		expect(analysisSkipReason({ ...base, patchLineCount: 5001 })).toContain('5,000');
		expect(analysisSkipReason({ ...base, hunkCount: 101 })).toContain('100 hunks');
	});

	it('detects NUL bytes without rejecting normal UTF-8', () => {
		expect(isProbablyBinary(Buffer.from('hello\0world'))).toBe(true);
		expect(isProbablyBinary(Buffer.from('naïve text'))).toBe(false);
	});
});
