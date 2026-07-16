import { describe, expect, it } from 'vitest';
import { decodeGitPath, parseUnifiedPatch } from '../../electron/backend/diff-parser.js';

describe('parseUnifiedPatch', () => {
	it('parses CRLF hunks, line numbers, sections, and stable semantic hashes', () => {
		const patch = [
			'diff --git a/src/example.ts b/src/example.ts',
			'index 1111111..2222222 100644',
			'--- a/src/example.ts',
			'+++ b/src/example.ts',
			'@@ -2,3 +2,4 @@ function example() {',
			' keep();',
			'-oldValue();',
			'+newValue();',
			'+extra();',
			' done();',
			''
		].join('\r\n');
		const identity = {
			fileId: 'file-1',
			oldPath: 'src/example.ts',
			newPath: 'src/example.ts',
			oldHash: '111',
			newHash: '222'
		};
		const parsed = parseUnifiedPatch(patch, identity);
		const repeated = parseUnifiedPatch(patch.replaceAll('\r\n', '\n'), identity);

		expect(parsed.hunks).toHaveLength(1);
		expect(parsed.hunks[0]).toMatchObject({
			oldStart: 2,
			oldCount: 3,
			newStart: 2,
			newCount: 4,
			section: 'function example() {'
		});
		expect(parsed.hunks[0].lines.map((line) => [line.type, line.oldLine, line.newLine])).toEqual([
			['context', 2, 2],
			['deletion', 3, null],
			['addition', null, 3],
			['addition', null, 4],
			['context', 4, 5]
		]);
		expect(parsed.hunks[0].hash).toBe(repeated.hunks[0].hash);
	});

	it('supports zero-count additions and missing-newline markers', () => {
		const parsed = parseUnifiedPatch(
			[
				'diff --git a/new.txt b/new.txt',
				'new file mode 100644',
				'--- /dev/null',
				'+++ b/new.txt',
				'@@ -0,0 +1,2 @@',
				'+first',
				'+second',
				'\\ No newline at end of file'
			].join('\n'),
			{ fileId: 'new', newPath: 'new.txt', newHash: 'abc' }
		);
		expect(parsed.newMode).toBe('100644');
		expect(parsed.hunks[0].oldCount).toBe(0);
		expect(parsed.hunks[0].lines.at(-1)?.type).toBe('no-newline');
	});

	it('recognizes binary and type metadata', () => {
		const parsed = parseUnifiedPatch(
			'diff --git a/image.png b/image.png\nold mode 100644\nnew mode 100755\nBinary files a/image.png and b/image.png differ\n',
			{ fileId: 'binary', oldPath: 'image.png', newPath: 'image.png' }
		);
		expect(parsed.binary).toBe(true);
		expect(parsed.oldMode).toBe('100644');
		expect(parsed.newMode).toBe('100755');
		expect(parsed.hunks).toEqual([]);
	});
});

describe('decodeGitPath', () => {
	it('decodes quoted UTF-8 octal escapes and common control escapes', () => {
		expect(decodeGitPath('"src/na\\303\\257ve\\tfile.ts"')).toBe('src/naïve\tfile.ts');
		expect(decodeGitPath('ordinary path.ts')).toBe('ordinary path.ts');
	});
});
