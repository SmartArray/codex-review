import type { ReviewConfig } from './types.js';
import { DEFAULT_MODEL } from './models.js';

export function parseLaunchArguments(argv: readonly string[]): Partial<ReviewConfig> {
	const output: Partial<ReviewConfig> = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const next = argv[index + 1];
		if (argument === '--root' && next) {
			output.root = next;
			index += 1;
		} else if (argument === '--commit' && next) {
			output.revision = next;
			index += 1;
		} else if ((argument === '--session' || argument === '--session-id') && next) {
			output.sessionId = next;
			index += 1;
		} else if ((argument === '--context' || argument === '--context-message') && next) {
			output.contextMessage = next;
			index += 1;
		} else if (argument === '--mode' && (next === 'commit' || next === 'range')) {
			output.mode = next;
			index += 1;
		} else if (argument === '--model' && next) {
			output.model = next;
			index += 1;
		} else if (argument === '--detail-level' && next && /^[1-5]$/.test(next)) {
			output.detailLevel = Number(next);
			index += 1;
		} else if (argument === '--full-preparation') {
			output.fullPreparation = true;
		} else if (argument === '--compact') {
			output.compactSession = true;
		}
	}
	output.mode ??= 'commit';
	output.model ??= DEFAULT_MODEL;
	output.detailLevel ??= 2;
	output.fullPreparation ??= false;
	output.compactSession ??= false;
	return output;
}
