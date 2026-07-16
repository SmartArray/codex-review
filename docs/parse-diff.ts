export interface DiffHunk {
	file: string;
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: string[];
}

export function parseHunks(diff: string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	const lines = diff.split(/\r?\n/);

	let currentFile = '';
	let currentHunk: DiffHunk | undefined;

	for (const line of lines) {
		if (line.startsWith('+++ ')) {
			currentFile = line.slice(4);
			continue;
		}

		const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

		if (match) {
			currentHunk = {
				file: currentFile,
				header: line,
				oldStart: Number(match[1]),
				oldCount: match[2] === undefined ? 1 : Number(match[2]),
				newStart: Number(match[3]),
				newCount: match[4] === undefined ? 1 : Number(match[4]),
				lines: []
			};

			hunks.push(currentHunk);
			continue;
		}

		if (
			currentHunk &&
			(line.startsWith('+') ||
				line.startsWith('-') ||
				line.startsWith(' ') ||
				line === '\\ No newline at end of file')
		) {
			currentHunk.lines.push(line);
		}
	}

	return hunks;
}
