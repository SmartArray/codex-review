import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewConfig, ReviewHistoryEntry } from '../src/lib/shared/types.js';
import { reviewConfigSchema } from '../src/lib/shared/schemas.js';

const MAX_HISTORY_ENTRIES = 30;

export class ReviewHistoryStore {
	private readonly filePath: string;

	constructor(userDataPath: string) {
		this.filePath = path.join(userDataPath, 'review-history.json');
	}

	async list(): Promise<ReviewHistoryEntry[]> {
		try {
			const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
			if (!Array.isArray(raw)) return [];
			return raw.flatMap((value) => {
				if (!value || typeof value !== 'object') return [];
				const candidate = value as { id?: unknown; lastOpenedAt?: unknown; config?: unknown };
				const config = reviewConfigSchema.safeParse(candidate.config);
				if (
					typeof candidate.id !== 'string' ||
					candidate.id.length < 1 ||
					candidate.id.length > 128 ||
					typeof candidate.lastOpenedAt !== 'string' ||
					!Number.isFinite(Date.parse(candidate.lastOpenedAt)) ||
					!config.success
				)
					return [];
				return [{ id: candidate.id, lastOpenedAt: candidate.lastOpenedAt, config: config.data }];
			});
		} catch (error) {
			if (isMissingFile(error)) return [];
			return [];
		}
	}

	async add(config: ReviewConfig): Promise<void> {
		const validated = reviewConfigSchema.parse(config);
		const entries = await this.list();
		const key = configKey(validated);
		const next: ReviewHistoryEntry[] = [
			{ id: randomUUID(), lastOpenedAt: new Date().toISOString(), config: validated },
			...entries.filter((entry) => configKey(entry.config) !== key)
		].slice(0, MAX_HISTORY_ENTRIES);
		await this.write(next);
	}

	async clear(): Promise<void> {
		await this.write([]);
	}

	private async write(entries: ReviewHistoryEntry[]): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp`;
		await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, this.filePath);
	}
}

function configKey(config: ReviewConfig): string {
	return JSON.stringify([
		config.root,
		config.revision,
		config.mode,
		config.model,
		config.sessionId ?? null,
		config.contextMessage ?? null,
		config.detailLevel,
		config.fullPreparation
	]);
}

function isMissingFile(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
