import { describe, expect, it } from 'vitest';
import { codexUsageSummary } from '../../electron/backend/codex-adapter.js';
import { addCodexUsage, EMPTY_CODEX_USAGE } from '../../src/lib/shared/codex-usage.js';

describe('Codex token usage', () => {
	it('normalizes SDK usage without double-counting cached or reasoning subsets', () => {
		const usage = codexUsageSummary({
			input_tokens: 1_000,
			cached_input_tokens: 600,
			output_tokens: 250,
			reasoning_output_tokens: 175
		});
		expect(usage).toEqual({
			invocationCount: 1,
			inputTokens: 1_000,
			cachedInputTokens: 600,
			outputTokens: 250,
			reasoningOutputTokens: 175,
			totalTokens: 1_250
		});
	});

	it('aggregates every completed Codex SDK invocation', () => {
		const first = codexUsageSummary({
			input_tokens: 1_000,
			cached_input_tokens: 600,
			output_tokens: 250,
			reasoning_output_tokens: 175
		});
		const second = codexUsageSummary({
			input_tokens: 400,
			cached_input_tokens: 100,
			output_tokens: 75,
			reasoning_output_tokens: 25
		});
		expect(addCodexUsage(addCodexUsage({ ...EMPTY_CODEX_USAGE }, first), second)).toEqual({
			invocationCount: 2,
			inputTokens: 1_400,
			cachedInputTokens: 700,
			outputTokens: 325,
			reasoningOutputTokens: 200,
			totalTokens: 1_725
		});
	});
});
