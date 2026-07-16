import type { DiffHunk, DiffLine } from '../../src/lib/shared/types.js';
import { sha256 } from './hash.js';

export interface PatchIdentity {
	fileId: string;
	oldPath?: string;
	newPath?: string;
	oldHash?: string;
	newHash?: string;
}

export interface ParsedPatch {
	hunks: DiffHunk[];
	binary: boolean;
	oldMode?: string;
	newMode?: string;
	patchLineCount: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s?(.*))?$/;

export function parseUnifiedPatch(patch: string, identity: PatchIdentity): ParsedPatch {
	const rawLines = patch.replace(/\r\n/g, '\n').split('\n');
	const hunks: DiffHunk[] = [];
	let oldMode: string | undefined;
	let newMode: string | undefined;
	let binary = false;

	for (let cursor = 0; cursor < rawLines.length; cursor += 1) {
		const line = rawLines[cursor];
		if (line.startsWith('old mode ')) oldMode = line.slice('old mode '.length);
		if (line.startsWith('new mode ')) newMode = line.slice('new mode '.length);
		if (line.startsWith('new file mode ')) newMode = line.slice('new file mode '.length);
		if (line.startsWith('deleted file mode ')) oldMode = line.slice('deleted file mode '.length);
		if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;

		const match = HUNK_HEADER.exec(line);
		if (!match) continue;

		const oldStart = Number(match[1]);
		const oldCount = match[2] === undefined ? 1 : Number(match[2]);
		const newStart = Number(match[3]);
		const newCount = match[4] === undefined ? 1 : Number(match[4]);
		const section = match[5]?.trim() || undefined;
		const lines: DiffLine[] = [];
		const canonicalLines = [line];
		let oldLine = oldStart;
		let newLine = newStart;

		for (cursor += 1; cursor < rawLines.length; cursor += 1) {
			const bodyLine = rawLines[cursor];
			if (HUNK_HEADER.test(bodyLine) || bodyLine.startsWith('diff --git ')) {
				cursor -= 1;
				break;
			}
			if (bodyLine.startsWith('\\ No newline at end of file')) {
				canonicalLines.push(bodyLine);
				lines.push({ type: 'no-newline', content: bodyLine, oldLine: null, newLine: null });
				continue;
			}
			const prefix = bodyLine[0];
			if (prefix === '+') {
				canonicalLines.push(bodyLine);
				lines.push({ type: 'addition', content: bodyLine.slice(1), oldLine: null, newLine });
				newLine += 1;
			} else if (prefix === '-') {
				canonicalLines.push(bodyLine);
				lines.push({ type: 'deletion', content: bodyLine.slice(1), oldLine, newLine: null });
				oldLine += 1;
			} else if (prefix === ' ') {
				canonicalLines.push(bodyLine);
				lines.push({ type: 'context', content: bodyLine.slice(1), oldLine, newLine });
				oldLine += 1;
				newLine += 1;
			} else if (bodyLine === '') {
				// A split-created trailing line is not part of the hunk unless its counts require it.
				if (oldLine >= oldStart + oldCount && newLine >= newStart + newCount) break;
			} else {
				cursor -= 1;
				break;
			}

			if (oldLine >= oldStart + oldCount && newLine >= newStart + newCount) {
				while (rawLines[cursor + 1]?.startsWith('\\ No newline at end of file')) {
					cursor += 1;
					canonicalLines.push(rawLines[cursor]);
					lines.push({
						type: 'no-newline',
						content: rawLines[cursor],
						oldLine: null,
						newLine: null
					});
				}
				break;
			}
		}

		const canonicalPatch = canonicalLines.join('\n');
		const hash = sha256(
			[
				identity.oldPath ?? '',
				identity.newPath ?? '',
				identity.oldHash ?? '',
				identity.newHash ?? '',
				canonicalPatch
			].join('\0')
		);
		hunks.push({
			id: `hunk-${hash.slice(0, 24)}`,
			fileId: identity.fileId,
			index: hunks.length,
			header: line,
			section,
			oldStart,
			oldCount,
			newStart,
			newCount,
			lines,
			canonicalPatch,
			hash,
			analysis: { state: 'idle' }
		});
	}

	return {
		hunks,
		binary,
		oldMode,
		newMode,
		patchLineCount: rawLines.filter((line) => /^[ +\-\\]/.test(line)).length
	};
}

/** Decode a path printed with Git's core.quotePath C-style quoting. */
export function decodeGitPath(value: string): string {
	if (!(value.startsWith('"') && value.endsWith('"'))) return value;
	const input = value.slice(1, -1);
	const bytes: number[] = [];
	for (let index = 0; index < input.length; index += 1) {
		const character = input[index];
		if (character !== '\\') {
			bytes.push(...Buffer.from(character, 'utf8'));
			continue;
		}
		const escaped = input[++index];
		if (escaped === undefined) break;
		const simple: Record<string, number> = {
			a: 7,
			b: 8,
			t: 9,
			n: 10,
			v: 11,
			f: 12,
			r: 13,
			'"': 34,
			'\\': 92
		};
		if (simple[escaped] !== undefined) {
			bytes.push(simple[escaped]);
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			let octal = escaped;
			for (let count = 0; count < 2 && /[0-7]/.test(input[index + 1] ?? ''); count += 1) {
				octal += input[++index];
			}
			bytes.push(Number.parseInt(octal, 8));
			continue;
		}
		bytes.push(...Buffer.from(escaped, 'utf8'));
	}
	return Buffer.from(bytes).toString('utf8');
}
