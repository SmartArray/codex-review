import type { CodexUsageSummary } from './types.js';

export const EMPTY_CODEX_USAGE: Readonly<CodexUsageSummary> = Object.freeze({
	invocationCount: 0,
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	reasoningOutputTokens: 0,
	totalTokens: 0
});

export function addCodexUsage(
	current: CodexUsageSummary,
	next: CodexUsageSummary
): CodexUsageSummary {
	return {
		invocationCount: current.invocationCount + next.invocationCount,
		inputTokens: current.inputTokens + next.inputTokens,
		cachedInputTokens: current.cachedInputTokens + next.cachedInputTokens,
		outputTokens: current.outputTokens + next.outputTokens,
		reasoningOutputTokens: current.reasoningOutputTokens + next.reasoningOutputTokens,
		totalTokens: current.totalTokens + next.totalTokens
	};
}
