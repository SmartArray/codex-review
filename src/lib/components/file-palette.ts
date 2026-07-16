const FUZZY_SCORE_CEILING = 999;

export function fileMatchScore(path: string, query: string): number {
	if (!query) return 1;
	const filename = basename(path);
	const filenameCaseSensitive = filename.indexOf(query);
	if (filenameCaseSensitive >= 0) return directScore(5, filenameCaseSensitive, filename.length);

	const queryLower = query.toLowerCase();
	const filenameCaseInsensitive = filename.toLowerCase().indexOf(queryLower);
	if (filenameCaseInsensitive >= 0) return directScore(4, filenameCaseInsensitive, filename.length);

	const pathCaseSensitive = path.indexOf(query);
	if (pathCaseSensitive >= 0) return directScore(3, pathCaseSensitive, path.length);

	const pathLower = path.toLowerCase();
	const pathCaseInsensitive = pathLower.indexOf(queryLower);
	if (pathCaseInsensitive >= 0) return directScore(2, pathCaseInsensitive, path.length);

	let position = -1;
	let score = 0;
	for (let index = 0; index < queryLower.length; index += 1) {
		const next = pathLower.indexOf(queryLower[index], position + 1);
		if (next < 0) return -1;
		score += next === position + 1 ? 8 : 2;
		if (next === 0 || '/._-'.includes(pathLower[next - 1])) score += 10;
		if (path[next] === query[index]) score += 4;
		position = next;
	}
	return Math.max(0, Math.min(FUZZY_SCORE_CEILING, score - path.length * 0.02));
}

function basename(path: string): string {
	const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return path.slice(separator + 1);
}

function directScore(tier: number, index: number, length: number): number {
	return tier * 1_000 + 900 - Math.min(index, 500) - Math.min(length, 1_000) * 0.01;
}
