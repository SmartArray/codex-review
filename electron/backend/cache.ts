import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import type {
	CacheInfo,
	FileOverview,
	HunkExplanation,
	QaConversation,
	QaMessage,
	StoryPlan
} from '../../src/lib/shared/types.js';
import { hashObject } from './hash.js';

const DATABASE_VERSION = 1;
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const ANALYSIS_VERSION = 'explain-v1';
export const PROMPT_VERSION = '2026-07-10.1';

export type CacheKind = 'overview' | 'hunk' | 'story';

export interface AnalysisCacheContext {
	repositoryIdentity: string;
	baselineSessionId: string;
	baselineTurnId: string;
	oldRevision: string;
	newRevision: string;
	model: string;
	detailLevel: number;
}

interface CacheRow {
	value_json: string;
}

interface CacheStatsRow {
	entry_count: number;
	size_bytes: number;
	oldest_entry: number | null;
}

interface QaRow {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	created_at: number;
	status: QaMessage['status'];
}

export function overviewCacheKey(
	context: AnalysisCacheContext,
	file: { oldPath?: string; newPath?: string; oldHash?: string; newHash?: string }
): string {
	return hashObject({
		kind: 'overview',
		analysisVersion: ANALYSIS_VERSION,
		promptVersion: PROMPT_VERSION,
		...context,
		oldPath: file.oldPath ?? null,
		newPath: file.newPath ?? null,
		oldHash: file.oldHash ?? null,
		newHash: file.newHash ?? null
	});
}

export function hunkCacheKey(
	context: AnalysisCacheContext,
	file: { oldPath?: string; newPath?: string; oldHash?: string; newHash?: string },
	hunkHash: string
): string {
	return hashObject({
		kind: 'hunk',
		analysisVersion: ANALYSIS_VERSION,
		promptVersion: PROMPT_VERSION,
		...context,
		oldPath: file.oldPath ?? null,
		newPath: file.newPath ?? null,
		oldHash: file.oldHash ?? null,
		newHash: file.newHash ?? null,
		hunkHash
	});
}

export function storyCacheKey(
	context: AnalysisCacheContext,
	analysisKeys: readonly string[]
): string {
	return hashObject({
		kind: 'story',
		analysisVersion: ANALYSIS_VERSION,
		promptVersion: PROMPT_VERSION,
		...context,
		analysisKeys
	});
}

export class ReviewCache {
	readonly databasePath: string;
	private database: DatabaseSync;

	constructor(databasePath: string) {
		this.databasePath = databasePath;
		mkdirSync(path.dirname(databasePath), { recursive: true });
		try {
			this.database = this.open(databasePath);
			this.migrate();
		} catch (error) {
			try {
				renameSync(databasePath, `${databasePath}.corrupt-${Date.now()}`);
			} catch {
				// Opening a fresh database is the useful fallback even when the broken file vanished.
			}
			this.database = this.open(databasePath);
			this.migrate();
			if (!(error instanceof Error)) throw error;
		}
		this.prune();
	}

	private open(databasePath: string): DatabaseSync {
		const database = new DatabaseSync(databasePath, { timeout: 5_000, allowExtension: false });
		database.exec(
			'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;'
		);
		return database;
	}

	private migrate(): void {
		const version = (this.database.prepare('PRAGMA user_version').get() as { user_version: number })
			.user_version;
		if (version > DATABASE_VERSION)
			throw new Error('Cache database was created by a newer application version.');
		if (version < 1) {
			this.database.exec(`
				BEGIN;
				CREATE TABLE IF NOT EXISTS cache_entries (
					key TEXT PRIMARY KEY,
					kind TEXT NOT NULL CHECK(kind IN ('overview', 'hunk', 'story')),
					value_json TEXT NOT NULL,
					metadata_json TEXT NOT NULL DEFAULT '{}',
					size_bytes INTEGER NOT NULL,
					created_at INTEGER NOT NULL,
					accessed_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX IF NOT EXISTS cache_entries_accessed_idx ON cache_entries(accessed_at);
				CREATE TABLE IF NOT EXISTS child_threads (
					id TEXT PRIMARY KEY,
					review_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					parent_thread_id TEXT,
					archived INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT;
				CREATE INDEX IF NOT EXISTS child_threads_review_idx ON child_threads(review_id, archived);
				CREATE TABLE IF NOT EXISTS qa_conversations (
					hunk_key TEXT PRIMARY KEY,
					thread_id TEXT,
					preparing_context INTEGER NOT NULL DEFAULT 0,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY(thread_id) REFERENCES child_threads(id) ON DELETE SET NULL
				) STRICT;
				CREATE TABLE IF NOT EXISTS qa_messages (
					id TEXT PRIMARY KEY,
					hunk_key TEXT NOT NULL,
					role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
					content TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('streaming', 'complete', 'cancelled', 'failed')),
					created_at INTEGER NOT NULL,
					FOREIGN KEY(hunk_key) REFERENCES qa_conversations(hunk_key) ON DELETE CASCADE
				) STRICT;
				CREATE INDEX IF NOT EXISTS qa_messages_hunk_idx ON qa_messages(hunk_key, created_at);
				PRAGMA user_version = 1;
				COMMIT;
			`);
		}
	}

	get<T extends FileOverview | HunkExplanation | StoryPlan>(key: string): T | undefined {
		const row = this.database
			.prepare('SELECT value_json FROM cache_entries WHERE key = ?')
			.get(key) as CacheRow | undefined;
		if (!row) return undefined;
		try {
			const value = JSON.parse(row.value_json) as T;
			this.database
				.prepare('UPDATE cache_entries SET accessed_at = ? WHERE key = ?')
				.run(Date.now(), key);
			return value;
		} catch {
			this.database.prepare('DELETE FROM cache_entries WHERE key = ?').run(key);
			return undefined;
		}
	}

	set(
		kind: CacheKind,
		key: string,
		value: FileOverview | HunkExplanation | StoryPlan,
		metadata: unknown = {}
	): void {
		const valueJson = JSON.stringify(value);
		const metadataJson = JSON.stringify(metadata);
		const now = Date.now();
		this.database
			.prepare(
				`INSERT INTO cache_entries(key, kind, value_json, metadata_json, size_bytes, created_at, accessed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET
				 kind = excluded.kind,
				 value_json = excluded.value_json,
				 metadata_json = excluded.metadata_json,
				 size_bytes = excluded.size_bytes,
				 accessed_at = excluded.accessed_at`
			)
			.run(
				key,
				kind,
				valueJson,
				metadataJson,
				Buffer.byteLength(valueJson) + Buffer.byteLength(metadataJson),
				now,
				now
			);
	}

	delete(key: string): void {
		this.database.prepare('DELETE FROM cache_entries WHERE key = ?').run(key);
	}

	recordThread(input: {
		id: string;
		reviewId: string;
		kind: 'baseline' | 'file' | 'hunk' | 'story' | 'qa';
		parentThreadId?: string;
	}): void {
		const now = Date.now();
		this.database
			.prepare(
				`INSERT INTO child_threads(id, review_id, kind, parent_thread_id, archived, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 0, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET review_id = excluded.review_id, updated_at = excluded.updated_at`
			)
			.run(input.id, input.reviewId, input.kind, input.parentThreadId ?? null, now, now);
	}

	markThreadArchived(id: string): void {
		this.database
			.prepare('UPDATE child_threads SET archived = 1, updated_at = ? WHERE id = ?')
			.run(Date.now(), id);
	}

	listUnarchivedThreads(reviewId?: string): string[] {
		const rows = reviewId
			? this.database
					.prepare(
						'SELECT id FROM child_threads WHERE archived = 0 AND review_id = ? ORDER BY created_at'
					)
					.all(reviewId)
			: this.database
					.prepare('SELECT id FROM child_threads WHERE archived = 0 ORDER BY created_at')
					.all();
		return (rows as Array<{ id: string }>).map((row) => row.id);
	}

	ensureQaConversation(hunkKey: string, preparingContext = false): void {
		this.database
			.prepare(
				`INSERT INTO qa_conversations(hunk_key, preparing_context, updated_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(hunk_key) DO UPDATE SET
				 preparing_context = excluded.preparing_context,
				 updated_at = excluded.updated_at`
			)
			.run(hunkKey, preparingContext ? 1 : 0, Date.now());
	}

	setQaThread(hunkKey: string, threadId: string): void {
		this.ensureQaConversation(hunkKey);
		this.database
			.prepare(
				'UPDATE qa_conversations SET thread_id = ?, preparing_context = 0, updated_at = ? WHERE hunk_key = ?'
			)
			.run(threadId, Date.now(), hunkKey);
	}

	upsertQaMessage(hunkKey: string, message: QaMessage): void {
		this.ensureQaConversation(hunkKey);
		this.database
			.prepare(
				`INSERT INTO qa_messages(id, hunk_key, role, content, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET content = excluded.content, status = excluded.status`
			)
			.run(
				message.id,
				hunkKey,
				message.role,
				message.content,
				message.status,
				Date.parse(message.createdAt)
			);
	}

	getQaConversation(hunkKey: string): QaConversation {
		const conversation = this.database
			.prepare('SELECT thread_id, preparing_context FROM qa_conversations WHERE hunk_key = ?')
			.get(hunkKey) as { thread_id: string | null; preparing_context: number } | undefined;
		const messages = this.database
			.prepare(
				'SELECT id, role, content, created_at, status FROM qa_messages WHERE hunk_key = ? ORDER BY created_at, rowid'
			)
			.all(hunkKey) as unknown as QaRow[];
		return {
			hunkId: hunkKey,
			threadId: conversation?.thread_id ?? undefined,
			preparingContext: Boolean(conversation?.preparing_context),
			messages: messages.map((message) => ({
				id: message.id,
				role: message.role,
				content: message.content,
				createdAt: new Date(message.created_at).toISOString(),
				status: message.status
			}))
		};
	}

	prune(now = Date.now()): void {
		this.database.prepare('DELETE FROM cache_entries WHERE accessed_at < ?').run(now - MAX_AGE_MS);
		let total = this.cacheBytes();
		if (total <= MAX_CACHE_BYTES) return;
		const rows = this.database
			.prepare('SELECT key, size_bytes FROM cache_entries ORDER BY accessed_at ASC')
			.all() as Array<{ key: string; size_bytes: number }>;
		const remove = this.database.prepare('DELETE FROM cache_entries WHERE key = ?');
		for (const row of rows) {
			remove.run(row.key);
			total -= row.size_bytes;
			if (total <= MAX_CACHE_BYTES) break;
		}
	}

	private cacheBytes(): number {
		const row = this.database
			.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM cache_entries')
			.get() as {
			total: number;
		};
		return Number(row.total);
	}

	info(): CacheInfo {
		const row = this.database
			.prepare(
				`SELECT COUNT(*) AS entry_count, COALESCE(SUM(size_bytes), 0) AS size_bytes,
				 MIN(created_at) AS oldest_entry FROM cache_entries`
			)
			.get() as unknown as CacheStatsRow;
		return {
			entryCount: Number(row.entry_count),
			sizeBytes: Number(row.size_bytes),
			databasePath: this.databasePath,
			oldestEntry: row.oldest_entry ? new Date(Number(row.oldest_entry)).toISOString() : undefined
		};
	}

	clear(): CacheInfo {
		this.database.exec(`
			BEGIN;
			DELETE FROM qa_messages;
			DELETE FROM qa_conversations;
			DELETE FROM child_threads;
			DELETE FROM cache_entries;
			COMMIT;
			VACUUM;
		`);
		return this.info();
	}

	close(): void {
		if (this.database.isOpen) this.database.close();
	}
}
