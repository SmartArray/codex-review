import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
	ChangeStatus,
	DiffFile,
	FileContent,
	FileTreeNode,
	RangeReviewItem,
	ResolvedComparison,
	ReviewConfig,
	ReviewManifest,
	SearchOptions,
	SearchResponse,
	SearchResult,
	ValidationIssue,
	ValidationResult
} from '../../src/lib/shared/types.js';
import { reviewConfigSchema } from '../../src/lib/shared/schemas.js';
import { commandText, runCommand } from './command.js';
import { parseUnifiedPatch } from './diff-parser.js';
import {
	analysisSkipReason,
	generatedReasonForPath,
	isProbablyBinary,
	languageForPath
} from './file-policy.js';
import { sha256 } from './hash.js';

const GIT_ENV: NodeJS.ProcessEnv = {
	...process.env,
	GIT_TERMINAL_PROMPT: '0',
	GIT_OPTIONAL_LOCKS: '0',
	GIT_PAGER: 'cat',
	GIT_EXTERNAL_DIFF: '',
	LC_ALL: 'C'
};

interface TreeEntry {
	mode: string;
	type: string;
	oid: string;
	size: number;
	path: string;
}

interface ChangedPath {
	status: ChangeStatus;
	oldPath?: string;
	newPath?: string;
}

export interface PreparedComparison {
	config: ReviewConfig;
	canonicalRoot: string;
	commonDirectory: string;
	repositoryIdentity: string;
	oldRevision: string;
	newRevision: string;
	headRevision: string;
	dirtyPatch?: Buffer;
	dirtyFingerprint?: string;
}

export interface PreparedRangeReview {
	base: PreparedComparison;
	items: RangeReviewItem[];
}

function gitArgs(args: readonly string[]): string[] {
	return ['--no-pager', ...args];
}

async function gitText(
	root: string,
	args: readonly string[],
	input?: string | Uint8Array
): Promise<string> {
	return commandText('git', gitArgs(args), { cwd: root, env: GIT_ENV, input, timeoutMs: 60_000 });
}

async function gitBuffer(
	root: string,
	args: readonly string[],
	input?: string | Uint8Array
): Promise<Buffer> {
	return (
		await runCommand('git', gitArgs(args), {
			cwd: root,
			env: GIT_ENV,
			input,
			timeoutMs: 120_000,
			maxOutputBytes: 256 * 1024 * 1024
		})
	).stdout;
}

function friendlyGitError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/^fatal:\s*/i, '').trim() || 'Git could not complete the request';
}

export async function prepareComparison(configInput: ReviewConfig): Promise<PreparedComparison> {
	const config = reviewConfigSchema.parse(configInput) as ReviewConfig;
	const suppliedRoot = await realpath(config.root);
	const canonicalRoot = (await gitText(suppliedRoot, ['rev-parse', '--show-toplevel'])).trim();
	const commonOutput = (await gitText(canonicalRoot, ['rev-parse', '--git-common-dir'])).trim();
	const commonDirectory = await realpath(path.resolve(canonicalRoot, commonOutput));
	const repositoryIdentity = sha256(
		`${commonDirectory}\0${await gitText(canonicalRoot, ['rev-parse', '--show-object-format'])}`
	);
	const selected = (
		await gitText(canonicalRoot, ['rev-parse', '--verify', `${config.revision}^{commit}`])
	).trim();
	const headRevision = (
		await gitText(canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
	).trim();

	if (config.mode === 'commit') {
		const parents = (await gitText(canonicalRoot, ['rev-list', '--parents', '-n', '1', selected]))
			.trim()
			.split(/\s+/);
		const oldRevision =
			parents[1] ??
			(await gitText(canonicalRoot, ['hash-object', '-t', 'tree', '--stdin'], '')).trim();
		return {
			config,
			canonicalRoot,
			commonDirectory,
			repositoryIdentity,
			oldRevision,
			newRevision: selected,
			headRevision
		};
	}

	const conflicts = await gitBuffer(canonicalRoot, [
		'diff',
		'--name-only',
		'-z',
		'--diff-filter=U',
		'--'
	]);
	if (conflicts.length > 0)
		throw new Error('Range mode is unavailable while the repository has unresolved conflicts.');
	const dirtyPatch = await gitBuffer(canonicalRoot, [
		'diff',
		'--binary',
		'--full-index',
		'--no-color',
		'--no-ext-diff',
		'--no-textconv',
		'HEAD',
		'--'
	]);
	return {
		config,
		canonicalRoot,
		commonDirectory,
		repositoryIdentity,
		oldRevision: selected,
		newRevision: headRevision,
		headRevision,
		dirtyPatch,
		dirtyFingerprint: sha256(dirtyPatch)
	};
}

export async function prepareRangeReview(configInput: ReviewConfig): Promise<PreparedRangeReview> {
	const base = await prepareComparison(configInput);
	if (base.config.mode !== 'range')
		throw new Error('Commit navigation is only available in range mode.');
	const output = await gitText(base.canonicalRoot, [
		'log',
		'--reverse',
		'--topo-order',
		'--format=%H%x00%s%x00%b%x00',
		`${base.oldRevision}..${base.headRevision}`,
		'--'
	]);
	const fields = output.split('\0');
	const items: RangeReviewItem[] = [];
	for (let index = 0; index + 2 < fields.length; index += 3) {
		const commitHash = fields[index].trim();
		if (!commitHash) continue;
		items.push({
			id: commitHash,
			kind: 'commit',
			commitHash,
			title: fields[index + 1].trim() || commitHash.slice(0, 10),
			description: fields[index + 2].trim() || 'No description provided.',
			reviewed: false
		});
	}
	if (base.dirtyPatch?.length && base.dirtyFingerprint) {
		items.push({
			id: `working-tree:${base.dirtyFingerprint}`,
			kind: 'working-tree',
			title: 'Working changes',
			description: `Tracked changes after ${base.headRevision.slice(0, 10)}.`,
			reviewed: false
		});
	}
	return { base, items };
}

export async function prepareRangeReviewItem(
	range: PreparedRangeReview,
	itemId: string
): Promise<PreparedComparison> {
	if (itemId === 'aggregate') return range.base;
	const item = range.items.find((candidate) => candidate.id === itemId);
	if (!item) throw new Error('This commit is not part of the active range.');
	if (item.kind === 'working-tree') {
		return {
			...range.base,
			config: { ...range.base.config, revision: range.base.headRevision, mode: 'range' },
			oldRevision: range.base.headRevision,
			newRevision: range.base.headRevision
		};
	}
	const commitHash = item.commitHash!;
	const parents = (
		await gitText(range.base.canonicalRoot, ['rev-list', '--parents', '-n', '1', commitHash])
	)
		.trim()
		.split(/\s+/);
	const oldRevision =
		parents[1] ??
		(await gitText(range.base.canonicalRoot, ['hash-object', '-t', 'tree', '--stdin'], '')).trim();
	return {
		...range.base,
		config: { ...range.base.config, revision: commitHash, mode: 'commit' },
		oldRevision,
		newRevision: commitHash,
		headRevision: commitHash,
		dirtyPatch: undefined,
		dirtyFingerprint: undefined
	};
}

export async function validateReviewConfig(config: ReviewConfig): Promise<ValidationResult> {
	const parsed = reviewConfigSchema.safeParse(config);
	if (!parsed.success) {
		const issues: ValidationIssue[] = parsed.error.issues.map((issue) => ({
			field: (issue.path[0] as ValidationIssue['field']) ?? 'general',
			message: issue.message
		}));
		return { valid: false, issues };
	}
	try {
		const prepared = await prepareComparison(parsed.data as ReviewConfig);
		return { valid: true, issues: [], resolved: publicComparison(prepared) };
	} catch (error) {
		return { valid: false, issues: [{ field: 'general', message: friendlyGitError(error) }] };
	}
}

function publicComparison(
	prepared: PreparedComparison,
	syntheticRevision?: string
): ResolvedComparison {
	const repositoryName = path.basename(prepared.canonicalRoot);
	const oldRevision = prepared.oldRevision;
	const newRevision = syntheticRevision ?? prepared.newRevision;
	return {
		mode: prepared.config.mode,
		repositoryName,
		repositoryIdentity: prepared.repositoryIdentity,
		root: prepared.canonicalRoot,
		revisionExpression: prepared.config.revision,
		oldRevision,
		newRevision,
		oldLabel: `${prepared.config.revision} (${oldRevision.slice(0, 10)})`,
		newLabel:
			prepared.config.mode === 'commit'
				? `commit ${newRevision.slice(0, 10)}`
				: prepared.dirtyPatch?.length
					? `HEAD + tracked edits (${newRevision.slice(0, 10)})`
					: `HEAD (${newRevision.slice(0, 10)})`,
		dirty: Boolean(prepared.dirtyPatch?.length),
		dirtyFingerprint: prepared.dirtyFingerprint
	};
}

export class FrozenGitSnapshot {
	readonly reviewId: string;
	readonly snapshotDirectory: string;
	readonly sourceRoot: string;
	readonly commonDirectory: string;
	readonly oldRevision: string;
	readonly newRevision: string;
	readonly comparison: ResolvedComparison;
	readonly config: ReviewConfig;

	private filesById = new Map<string, DiffFile>();
	private newEntries = new Map<string, TreeEntry>();
	private oldEntries = new Map<string, TreeEntry>();
	private textCache = new Map<string, string>();
	private textCacheBytes = 0;
	private disposed = false;

	private constructor(input: {
		reviewId: string;
		snapshotDirectory: string;
		prepared: PreparedComparison;
		newRevision: string;
	}) {
		this.reviewId = input.reviewId;
		this.snapshotDirectory = input.snapshotDirectory;
		this.sourceRoot = input.prepared.canonicalRoot;
		this.commonDirectory = input.prepared.commonDirectory;
		this.oldRevision = input.prepared.oldRevision;
		this.newRevision = input.newRevision;
		this.comparison = publicComparison(input.prepared, input.newRevision);
		this.config = input.prepared.config;
	}

	static async create(
		config: ReviewConfig,
		onIndex?: (message: string) => void
	): Promise<{ snapshot: FrozenGitSnapshot; manifest: ReviewManifest }> {
		onIndex?.('Validating repository');
		const prepared = await prepareComparison(config);
		return this.createPrepared(prepared, onIndex);
	}

	static async createPrepared(
		prepared: PreparedComparison,
		onIndex?: (message: string) => void
	): Promise<{ snapshot: FrozenGitSnapshot; manifest: ReviewManifest }> {
		const parent = await mkdtemp(path.join(tmpdir(), 'codex-explain-'));
		const snapshotDirectory = path.join(parent, 'snapshot');
		try {
			onIndex?.('Creating frozen snapshot');
			await runCommand(
				'git',
				[
					'clone',
					'--shared',
					'--no-checkout',
					'--quiet',
					'--',
					prepared.canonicalRoot,
					snapshotDirectory
				],
				{ env: GIT_ENV, timeoutMs: 120_000, maxOutputBytes: 16 * 1024 * 1024 }
			);
			await gitText(snapshotDirectory, ['config', 'core.autocrlf', 'false']);
			await gitText(snapshotDirectory, [
				'checkout',
				'--quiet',
				'--detach',
				prepared.newRevision,
				'--'
			]);

			let newRevision = prepared.newRevision;
			if (prepared.config.mode === 'range' && prepared.dirtyPatch?.length) {
				onIndex?.('Freezing tracked working changes');
				await gitBuffer(
					snapshotDirectory,
					['apply', '--index', '--binary', '--whitespace=nowarn', '--recount', '-'],
					prepared.dirtyPatch
				);
				newRevision = (await gitText(snapshotDirectory, ['write-tree'])).trim();
			}

			const reviewId = `review-${sha256(
				`${prepared.repositoryIdentity}\0${prepared.oldRevision}\0${newRevision}\0${
					prepared.config.sessionId
						? `session:${prepared.config.sessionId}`
						: `context:${sha256(prepared.config.contextMessage ?? '')}`
				}`
			).slice(0, 24)}`;
			const snapshot = new FrozenGitSnapshot({
				reviewId,
				snapshotDirectory,
				prepared,
				newRevision
			});
			onIndex?.('Parsing file tree and diff');
			const manifest = await snapshot.buildManifest();
			return { snapshot, manifest };
		} catch (error) {
			await rm(parent, { recursive: true, force: true });
			throw error;
		}
	}

	private async gitText(args: readonly string[], input?: string | Uint8Array): Promise<string> {
		this.assertOpen();
		return gitText(this.snapshotDirectory, args, input);
	}

	private async gitBuffer(args: readonly string[], input?: string | Uint8Array): Promise<Buffer> {
		this.assertOpen();
		return gitBuffer(this.snapshotDirectory, args, input);
	}

	private assertOpen(): void {
		if (this.disposed) throw new Error('The frozen review snapshot has been closed.');
	}

	private async buildManifest(): Promise<ReviewManifest> {
		const [oldTreeOutput, newTreeOutput, statusOutput] = await Promise.all([
			this.gitBuffer(['ls-tree', '-rlz', '--full-tree', this.oldRevision]),
			this.gitBuffer(['ls-tree', '-rlz', '--full-tree', this.newRevision]),
			this.gitBuffer([
				'diff',
				'--name-status',
				'-z',
				'--find-renames=50%',
				'--no-ext-diff',
				this.oldRevision,
				this.newRevision,
				'--'
			])
		]);
		this.oldEntries = parseTreeEntries(oldTreeOutput);
		this.newEntries = parseTreeEntries(newTreeOutput);
		await Promise.all([
			this.populateEntrySizes(this.oldEntries),
			this.populateEntrySizes(this.newEntries)
		]);
		const changed = parseNameStatus(statusOutput);
		const generatedAttributes = await this.readGeneratedAttributes(
			changed
				.map((item) => item.newPath ?? item.oldPath)
				.filter((item): item is string => Boolean(item))
		);

		const changedFiles = await Promise.all(
			changed.map((item) =>
				this.createChangedFile(item, generatedAttributes.get(item.newPath ?? item.oldPath ?? ''))
			)
		);
		const changedByNewPath = new Map(
			changedFiles.filter((file) => file.newPath).map((file) => [file.newPath as string, file])
		);
		const files: DiffFile[] = [];
		for (const entry of this.newEntries.values()) {
			const changedFile = changedByNewPath.get(entry.path);
			if (changedFile) files.push(changedFile);
			else files.push(this.createUnchangedFile(entry));
		}
		for (const file of changedFiles) {
			if (file.status === 'deleted') files.push(file);
		}
		files.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
		this.filesById = new Map(files.map((file) => [file.id, file]));

		return {
			reviewId: this.reviewId,
			comparison: this.comparison,
			files,
			tree: buildFileTree(files),
			touchedFileCount: changedFiles.length,
			textualHunkCount: changedFiles.reduce((total, file) => total + file.hunks.length, 0),
			createdAt: new Date().toISOString(),
			stale: false
		};
	}

	private async populateEntrySizes(entries: Map<string, TreeEntry>): Promise<void> {
		const objectIds = [
			...new Set(
				[...entries.values()].filter((entry) => entry.type === 'blob').map((entry) => entry.oid)
			)
		];
		if (!objectIds.length) return;
		const output = await this.gitText(
			['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
			`${objectIds.join('\n')}\n`
		);
		const sizes = new Map<string, number>();
		for (const line of output.split(/\r?\n/)) {
			const [oid, type, size] = line.trim().split(/\s+/);
			if (oid && type === 'blob' && size) sizes.set(oid, Number(size));
		}
		for (const entry of entries.values())
			if (sizes.has(entry.oid)) entry.size = sizes.get(entry.oid) as number;
	}

	private createUnchangedFile(entry: TreeEntry): DiffFile {
		const id = fileIdFor('unchanged', entry.path, entry.path);
		return {
			id,
			path: entry.path,
			oldPath: entry.path,
			newPath: entry.path,
			status: 'unchanged',
			oldHash: entry.oid,
			newHash: entry.oid,
			oldMode: entry.mode,
			newMode: entry.mode,
			language: languageForPath(entry.path),
			binary: false,
			submodule: entry.mode === '160000',
			generated: Boolean(generatedReasonForPath(entry.path)),
			generatedReason: generatedReasonForPath(entry.path),
			oldSize: entry.size,
			newSize: entry.size,
			patchLineCount: 0,
			hunks: [],
			overviewAnalysis: { state: 'skipped', reason: 'Not part of this comparison' }
		};
	}

	private async createChangedFile(item: ChangedPath, attributeReason?: string): Promise<DiffFile> {
		const oldEntry = item.oldPath ? this.oldEntries.get(item.oldPath) : undefined;
		const newEntry = item.newPath ? this.newEntries.get(item.newPath) : undefined;
		const displayPath = item.newPath ?? item.oldPath ?? 'unknown';
		const id = fileIdFor(item.status, item.oldPath, item.newPath);
		const pathspecs = [
			...new Set([item.oldPath, item.newPath].filter((value): value is string => Boolean(value)))
		];
		const patch = await this.gitText([
			'diff',
			'--no-color',
			'--no-ext-diff',
			'--no-textconv',
			'--full-index',
			'--find-renames=50%',
			'--unified=3',
			this.oldRevision,
			this.newRevision,
			'--',
			...pathspecs
		]);
		const parsed = parseUnifiedPatch(patch, {
			fileId: id,
			oldPath: item.oldPath,
			newPath: item.newPath,
			oldHash: oldEntry?.oid,
			newHash: newEntry?.oid
		});
		const submodule = oldEntry?.mode === '160000' || newEntry?.mode === '160000';
		const pathReason = generatedReasonForPath(displayPath);
		const generatedReason = attributeReason ?? pathReason;
		const binary = parsed.binary;
		const skipReason = analysisSkipReason({
			binary,
			submodule,
			generatedReason,
			oldSize: oldEntry?.size ?? 0,
			newSize: newEntry?.size ?? 0,
			patchLineCount: parsed.patchLineCount,
			hunkCount: parsed.hunks.length
		});
		const analysisState = skipReason
			? { state: 'skipped' as const, reason: skipReason }
			: { state: 'idle' as const };
		for (const hunk of parsed.hunks) hunk.analysis = { ...analysisState };
		return {
			id,
			path: displayPath,
			oldPath: item.oldPath,
			newPath: item.newPath,
			status: item.status,
			oldHash: oldEntry?.oid,
			newHash: newEntry?.oid,
			oldMode: oldEntry?.mode ?? parsed.oldMode,
			newMode: newEntry?.mode ?? parsed.newMode,
			language: languageForPath(displayPath),
			binary,
			submodule,
			generated: Boolean(generatedReason),
			generatedReason,
			oldSize: oldEntry?.size ?? 0,
			newSize: newEntry?.size ?? 0,
			patchLineCount: parsed.patchLineCount,
			hunks: parsed.hunks,
			overviewAnalysis: { ...analysisState },
			skipReason
		};
	}

	private async readGeneratedAttributes(paths: string[]): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		if (paths.length === 0) return result;
		const output = await this.gitBuffer([
			'check-attr',
			'--cached',
			'-z',
			'linguist-generated',
			'linguist-vendored',
			'generated',
			'vendored',
			'--',
			...paths
		]);
		const fields = splitNull(output);
		for (let index = 0; index + 2 < fields.length; index += 3) {
			const [filePath, attribute, value] = fields.slice(index, index + 3);
			if (value === 'set' || value === 'true' || value === '1') {
				result.set(filePath, `Marked ${attribute} by Git attributes`);
			}
		}
		return result;
	}

	getFile(fileId: string): DiffFile {
		const file = this.filesById.get(fileId);
		if (!file) throw new Error('Unknown file ID.');
		return file;
	}

	getFiles(): DiffFile[] {
		return [...this.filesById.values()];
	}

	async loadFile(fileId: string): Promise<FileContent> {
		const file = this.getFile(fileId);
		if (file.binary || file.submodule) {
			return {
				fileId,
				oldText: '',
				newText: '',
				oldAvailable: Boolean(file.oldHash),
				newAvailable: Boolean(file.newHash),
				truncated: false,
				encoding: 'utf-8'
			};
		}
		let oldText: string;
		let newText: string;
		try {
			[oldText, newText] = await Promise.all([
				file.oldHash ? this.readTextBlob(file.oldHash) : Promise.resolve(''),
				file.newHash ? this.readTextBlob(file.newHash) : Promise.resolve('')
			]);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes('Binary content')) throw error;
			file.binary = true;
			return {
				fileId,
				oldText: '',
				newText: '',
				oldAvailable: Boolean(file.oldHash),
				newAvailable: Boolean(file.newHash),
				truncated: false,
				encoding: 'utf-8'
			};
		}
		return {
			fileId,
			oldText,
			newText,
			oldAvailable: Boolean(file.oldHash),
			newAvailable: Boolean(file.newHash),
			truncated: false,
			encoding: 'utf-8'
		};
	}

	private async readTextBlob(oid: string): Promise<string> {
		const cached = this.textCache.get(oid);
		if (cached !== undefined) return cached;
		const content = await this.gitBuffer(['cat-file', 'blob', oid]);
		if (isProbablyBinary(content)) throw new Error('Binary content cannot be displayed as text.');
		const text = content.toString('utf8');
		if (content.byteLength <= 2 * 1024 * 1024) {
			while (this.textCacheBytes + content.byteLength > 64 * 1024 * 1024 && this.textCache.size) {
				const first = this.textCache.entries().next().value as [string, string] | undefined;
				if (!first) break;
				this.textCache.delete(first[0]);
				this.textCacheBytes -= Buffer.byteLength(first[1]);
			}
			this.textCache.set(oid, text);
			this.textCacheBytes += content.byteLength;
		}
		return text;
	}

	async search(options: SearchOptions, signal?: AbortSignal): Promise<SearchResponse> {
		const requestId = `search-${crypto.randomUUID()}`;
		const page = options.page ?? 0;
		const pageSize = options.pageSize ?? 100;
		if (!options.query) return { requestId, results: [], total: 0, page, pageSize, hasMore: false };
		let expression: RegExp;
		try {
			let source = options.regex ? options.query : escapeRegex(options.query);
			if (options.wholeWord) source = `\\b(?:${source})\\b`;
			expression = new RegExp(source, `${options.caseSensitive ? '' : 'i'}g`);
		} catch (error) {
			return {
				requestId,
				results: [],
				total: 0,
				page,
				pageSize,
				hasMore: false,
				error: error instanceof Error ? error.message : 'Invalid regular expression'
			};
		}

		const all: SearchResult[] = [];
		const candidates = this.getFiles().filter(
			(file) => file.newHash && !file.submodule && file.newSize <= 2 * 1024 * 1024
		);
		for (let start = 0; start < candidates.length; start += 12) {
			if (signal?.aborted) throw new Error('Search cancelled');
			const batch = candidates.slice(start, start + 12);
			const contents = await Promise.all(
				batch.map(async (file) => {
					try {
						return [file, await this.readTextBlob(file.newHash as string)] as const;
					} catch {
						return [file, null] as const;
					}
				})
			);
			for (const [file, text] of contents) {
				if (text === null) continue;
				const changedLines = options.diffOnly ? newSideChangedLines(file) : undefined;
				for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
					const lineNumber = lineIndex + 1;
					if (changedLines && !changedLines.has(lineNumber)) continue;
					expression.lastIndex = 0;
					let match: RegExpExecArray | null;
					while ((match = expression.exec(line))) {
						all.push({
							fileId: file.id,
							path: file.path,
							line: lineNumber,
							column: match.index + 1,
							length: Math.max(1, match[0].length),
							snippet: line.trim().slice(0, 500)
						});
						if (match[0].length === 0) expression.lastIndex += 1;
						if (all.length >= 50_000) break;
					}
					if (all.length >= 50_000) break;
				}
				if (all.length >= 50_000) break;
			}
			if (all.length >= 50_000) break;
		}
		const offset = page * pageSize;
		return {
			requestId,
			results: all.slice(offset, offset + pageSize),
			total: all.length,
			page,
			pageSize,
			hasMore: offset + pageSize < all.length
		};
	}

	async currentSourceFingerprint(): Promise<string> {
		const [head, status] = await Promise.all([
			gitBuffer(this.sourceRoot, ['rev-parse', 'HEAD']),
			gitBuffer(this.sourceRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=no'])
		]);
		return sha256(Buffer.concat([head, Buffer.from([0]), status]));
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await rm(path.dirname(this.snapshotDirectory), { recursive: true, force: true });
	}
}

function parseTreeEntries(output: Buffer): Map<string, TreeEntry> {
	const entries = new Map<string, TreeEntry>();
	for (const record of splitNull(output)) {
		if (!record) continue;
		const tab = record.indexOf('\t');
		if (tab < 0) continue;
		const metadata = record.slice(0, tab).trim().split(/\s+/);
		const entryPath = record.slice(tab + 1);
		entries.set(entryPath, {
			mode: metadata[0],
			type: metadata[1],
			oid: metadata[2],
			size: metadata[3] === '-' ? 0 : Number(metadata[3] ?? 0),
			path: entryPath
		});
	}
	return entries;
}

function parseNameStatus(output: Buffer): ChangedPath[] {
	const fields = splitNull(output);
	const result: ChangedPath[] = [];
	for (let index = 0; index < fields.length;) {
		const code = fields[index++];
		if (!code) continue;
		const letter = code[0];
		if (letter === 'R' || letter === 'C') {
			const oldPath = fields[index++];
			const newPath = fields[index++];
			result.push({ status: letter === 'R' ? 'renamed' : 'copied', oldPath, newPath });
			continue;
		}
		const filePath = fields[index++];
		if (!filePath) continue;
		const status: ChangeStatus =
			letter === 'A'
				? 'added'
				: letter === 'D'
					? 'deleted'
					: letter === 'T'
						? 'type-changed'
						: letter === 'U'
							? 'unmerged'
							: 'modified';
		result.push({
			status,
			oldPath: status === 'added' ? undefined : filePath,
			newPath: status === 'deleted' ? undefined : filePath
		});
	}
	return result;
}

function splitNull(value: Buffer): string[] {
	const output: string[] = [];
	let start = 0;
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== 0) continue;
		output.push(value.subarray(start, index).toString('utf8'));
		start = index + 1;
	}
	if (start < value.length) output.push(value.subarray(start).toString('utf8'));
	return output;
}

function fileIdFor(status: ChangeStatus, oldPath?: string, newPath?: string): string {
	return `file-${sha256(`${status}\0${oldPath ?? ''}\0${newPath ?? ''}`).slice(0, 24)}`;
}

function buildFileTree(files: DiffFile[]): FileTreeNode[] {
	interface MutableNode extends FileTreeNode {
		children?: MutableNode[];
	}
	const root: MutableNode[] = [];
	for (const file of files) {
		const parts = file.path.split('/').filter(Boolean);
		let level = root;
		let accumulated = '';
		for (let index = 0; index < parts.length; index += 1) {
			const name = parts[index];
			accumulated = accumulated ? `${accumulated}/${name}` : name;
			const isFile = index === parts.length - 1;
			let node = level.find(
				(candidate) => candidate.name === name && candidate.type === (isFile ? 'file' : 'directory')
			);
			if (!node) {
				node = isFile
					? {
							id: `tree-${file.id}`,
							name,
							path: accumulated,
							type: 'file',
							fileId: file.id,
							status: file.status,
							analysis: file.overviewAnalysis.state,
							deleted: file.status === 'deleted'
						}
					: {
							id: `dir-${sha256(accumulated).slice(0, 20)}`,
							name,
							path: accumulated,
							type: 'directory',
							children: []
						};
				level.push(node);
			}
			if (!isFile) level = node.children ?? (node.children = []);
		}
	}
	const sort = (nodes: MutableNode[]) => {
		nodes.sort((left, right) => {
			if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
			return left.name.localeCompare(right.name, undefined, { numeric: true });
		});
		for (const node of nodes) if (node.children) sort(node.children);
	};
	sort(root);
	return root;
}

function newSideChangedLines(file: DiffFile): Set<number> {
	const lines = new Set<number>();
	for (const hunk of file.hunks) {
		for (const line of hunk.lines)
			if (line.type === 'addition' && line.newLine !== null) lines.add(line.newLine);
	}
	return lines;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
