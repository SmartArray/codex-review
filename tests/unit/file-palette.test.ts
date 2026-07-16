import { describe, expect, it } from 'vitest';
import { fileMatchScore } from '../../src/lib/components/file-palette.js';

describe('file palette ranking', () => {
	it('ranks filename, path, and fuzzy matches in explicit case-aware bands', () => {
		const paths = [
			'w/i/d/g/e/t/fuzzy.ts',
			'widget/src/other.ts',
			'Widget/src/unrelated.ts',
			'lib/mywidget.ts',
			'lib/MyWidget.ts'
		];

		expect(
			paths.sort((left, right) => fileMatchScore(right, 'Widget') - fileMatchScore(left, 'Widget'))
		).toEqual([
			'lib/MyWidget.ts',
			'lib/mywidget.ts',
			'Widget/src/unrelated.ts',
			'widget/src/other.ts',
			'w/i/d/g/e/t/fuzzy.ts'
		]);
	});

	it('keeps case-insensitive and fuzzy-only paths searchable', () => {
		expect(fileMatchScore('SRC/APP.TS', 'app')).toBeGreaterThanOrEqual(0);
		expect(fileMatchScore('src/a-long-path.ts', 'alpt')).toBeGreaterThanOrEqual(0);
		expect(fileMatchScore('src/other.ts', 'missing')).toBe(-1);
	});
});
