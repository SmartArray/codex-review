import { describe, expect, it } from 'vitest';
import { parseLaunchArguments } from '../../src/lib/shared/launch-config.js';
import { reviewConfigSchema } from '../../src/lib/shared/schemas.js';

describe('launch arguments', () => {
	it('defaults to the fast model with medium reasoning configured by the adapter', () => {
		expect(parseLaunchArguments([])).toEqual({
			mode: 'commit',
			model: 'gpt-5.4-mini',
			detailLevel: 2,
			fullPreparation: false
		});
	});

	it('accepts a free-form model override', () => {
		expect(
			parseLaunchArguments([
				'--root',
				'/repo',
				'--commit',
				'HEAD~2',
				'--session',
				'session-1',
				'--mode',
				'range',
				'--model',
				'custom-fast-model'
			])
		).toEqual({
			root: '/repo',
			revision: 'HEAD~2',
			sessionId: 'session-1',
			mode: 'range',
			model: 'custom-fast-model',
			detailLevel: 2,
			fullPreparation: false
		});
	});

	it('enables eager analysis only with the full-preparation flag', () => {
		expect(parseLaunchArguments([]).fullPreparation).toBe(false);
		expect(parseLaunchArguments(['--full-preparation']).fullPreparation).toBe(true);
	});

	it('accepts a context message instead of a session ID', () => {
		expect(parseLaunchArguments(['--context', 'Focus on the migration intent.'])).toMatchObject({
			contextMessage: 'Focus on the migration intent.'
		});
	});

	it('requires exactly one analysis context source', () => {
		const base = {
			root: '/repo',
			revision: 'HEAD',
			mode: 'commit',
			model: 'gpt-5.4-mini',
			detailLevel: 2,
			fullPreparation: false
		};
		expect(reviewConfigSchema.safeParse({ ...base, sessionId: 'session' }).success).toBe(true);
		expect(
			reviewConfigSchema.safeParse({ ...base, contextMessage: 'Why this changed' }).success
		).toBe(true);
		expect(reviewConfigSchema.safeParse(base).success).toBe(false);
		expect(
			reviewConfigSchema.safeParse({
				...base,
				sessionId: 'session',
				contextMessage: 'Why this changed'
			}).success
		).toBe(false);
	});

	it('accepts only detail levels from one to five', () => {
		expect(parseLaunchArguments(['--detail-level', '1']).detailLevel).toBe(1);
		expect(parseLaunchArguments(['--detail-level', '5']).detailLevel).toBe(5);
		expect(parseLaunchArguments(['--detail-level', '9']).detailLevel).toBe(2);
	});
});
