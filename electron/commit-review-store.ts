import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface StoredCommitReviews {
	version: 1;
	repositories: Record<string, string[]>;
}

export class CommitReviewStore {
	private readonly filePath: string;
	private mutation: Promise<void> = Promise.resolve();

	constructor(userDataPath: string) {
		this.filePath = path.join(userDataPath, 'commit-review-state.json');
	}

	async list(repositoryIdentity: string): Promise<Set<string>> {
		const stored = await this.read();
		return new Set(stored.repositories[repositoryIdentity] ?? []);
	}

	async set(repositoryIdentity: string, itemId: string, reviewed: boolean): Promise<void> {
		const update = this.mutation.then(async () => {
			const stored = await this.read();
			const items = new Set(stored.repositories[repositoryIdentity] ?? []);
			if (reviewed) items.add(itemId);
			else items.delete(itemId);
			if (items.size > 0) stored.repositories[repositoryIdentity] = [...items];
			else delete stored.repositories[repositoryIdentity];
			await this.write(stored);
		});
		this.mutation = update.catch(() => undefined);
		await update;
	}

	private async read(): Promise<StoredCommitReviews> {
		try {
			const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
			if (!value || typeof value !== 'object') return emptyStore();
			const candidate = value as { version?: unknown; repositories?: unknown };
			if (
				candidate.version !== 1 ||
				!candidate.repositories ||
				typeof candidate.repositories !== 'object'
			)
				return emptyStore();
			const repositories: Record<string, string[]> = {};
			for (const [repository, entries] of Object.entries(candidate.repositories)) {
				if (!Array.isArray(entries)) continue;
				const valid = entries.filter(
					(entry): entry is string =>
						typeof entry === 'string' &&
						entry.length > 0 &&
						entry.length <= 192 &&
						!entry.includes('\0')
				);
				if (valid.length > 0) repositories[repository] = [...new Set(valid)];
			}
			return { version: 1, repositories };
		} catch {
			return emptyStore();
		}
	}

	private async write(value: StoredCommitReviews): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp`;
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, this.filePath);
	}
}

function emptyStore(): StoredCommitReviews {
	return { version: 1, repositories: {} };
}
