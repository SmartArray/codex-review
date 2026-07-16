import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
	FrozenGitSnapshot,
	prepareRangeReview,
	prepareRangeReviewItem,
	validateReviewConfig
} from '../../electron/backend/git-snapshot.js';

const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function git(root: string, ...args: string[]): Promise<string> {
	const result = await execute('git', args, {
		cwd: root,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Codex Review Test',
			GIT_AUTHOR_EMAIL: 'test@example.invalid',
			GIT_COMMITTER_NAME: 'Codex Review Test',
			GIT_COMMITTER_EMAIL: 'test@example.invalid'
		}
	});
	return result.stdout;
}

async function fixture(): Promise<{ root: string; base: string; head: string }> {
	const root = await mkdtemp(path.join(tmpdir(), 'codex-explain-git-test-'));
	directories.push(root);
	await git(root, 'init', '-b', 'main');
	await mkdir(path.join(root, 'src'), { recursive: true });
	await writeFile(path.join(root, 'src/app.ts'), 'export const value = "base";\n');
	await writeFile(path.join(root, 'src/stable.ts'), 'export const stable = true;\n');
	await writeFile(path.join(root, 'remove-me.txt'), 'remove me\n');
	await git(root, 'add', '.');
	await git(root, 'commit', '-m', 'base');
	const base = (await git(root, 'rev-parse', 'HEAD')).trim();

	await writeFile(
		path.join(root, 'src/app.ts'),
		'export const value = "head";\nexport const added = true;\n'
	);
	await writeFile(path.join(root, 'src/new.ts'), 'export function next() { return 2; }\n');
	await git(root, 'rm', 'remove-me.txt');
	await git(root, 'add', '.');
	await git(root, 'commit', '-m', 'head');
	const head = (await git(root, 'rev-parse', 'HEAD')).trim();
	return { root, base, head };
}

describe('FrozenGitSnapshot', () => {
	it('lists range commits oldest first and creates an isolated working-tree comparison', async () => {
		const { root, base, head } = await fixture();
		await writeFile(path.join(root, 'src/follow-up.ts'), 'export const followUp = true;\n');
		await git(root, 'add', '.');
		await git(root, 'commit', '-m', 'follow up', '-m', 'Explain the second step.');
		const followUp = (await git(root, 'rev-parse', 'HEAD')).trim();
		await writeFile(path.join(root, 'src/app.ts'), 'export const value = "working";\n');

		const range = await prepareRangeReview({
			root,
			revision: base,
			sessionId: 'session',
			mode: 'range',
			model: 'gpt-5.4-mini',
			detailLevel: 2,
			fullPreparation: false,
			compactSession: false
		});

		expect(range.items.map((item) => item.title)).toEqual(['head', 'follow up', 'Working changes']);
		expect(range.items[0].description).toBe('No description provided.');
		expect(range.items[1].description).toBe('Explain the second step.');

		const first = await prepareRangeReviewItem(range, head);
		expect(first.oldRevision).toBe(base);
		expect(first.newRevision).toBe(head);
		expect(first.config.mode).toBe('commit');

		const workingItem = range.items.at(-1)!;
		const working = await prepareRangeReviewItem(range, workingItem.id);
		expect(working.oldRevision).toBe(followUp);
		expect(working.newRevision).toBe(followUp);
		const { snapshot, manifest } = await FrozenGitSnapshot.createPrepared(working);
		try {
			expect(manifest.files.find((file) => file.path === 'src/app.ts')?.status).toBe('modified');
			expect(manifest.files.find((file) => file.path === 'src/follow-up.ts')?.status).toBe(
				'unchanged'
			);
		} finally {
			await snapshot.dispose();
		}
	});

	it('builds a full-tree commit comparison including deleted old-only paths', async () => {
		const { root, base, head } = await fixture();
		const validation = await validateReviewConfig({
			root,
			revision: head,
			sessionId: 'session',
			mode: 'commit',
			model: 'gpt-5.4-mini',
			detailLevel: 2,
			fullPreparation: false,
			compactSession: false
		});
		expect(validation.valid).toBe(true);
		expect(validation.resolved?.oldRevision).toBe(base);

		const { snapshot, manifest } = await FrozenGitSnapshot.create({
			root,
			revision: head,
			sessionId: 'session',
			mode: 'commit',
			model: 'gpt-5.4-mini',
			detailLevel: 2,
			fullPreparation: false,
			compactSession: false
		});
		try {
			expect(manifest.files.find((file) => file.path === 'src/stable.ts')?.status).toBe(
				'unchanged'
			);
			expect(manifest.files.find((file) => file.path === 'remove-me.txt')?.status).toBe('deleted');
			const app = manifest.files.find((file) => file.path === 'src/app.ts');
			expect(app?.status).toBe('modified');
			expect(app?.hunks.length).toBeGreaterThan(0);
			const content = await snapshot.loadFile(app!.id);
			expect(content.oldText).toContain('base');
			expect(content.newText).toContain('head');
		} finally {
			await snapshot.dispose();
		}
	});

	it('freezes HEAD plus staged and unstaged tracked edits while excluding untracked files', async () => {
		const { root, base } = await fixture();
		await writeFile(path.join(root, 'src/app.ts'), 'export const value = "dirty";\n');
		await writeFile(path.join(root, 'src/new.ts'), 'export function next() { return 3; }\n');
		await git(root, 'add', 'src/new.ts');
		await writeFile(path.join(root, 'untracked.txt'), 'must stay out\n');
		const statusBefore = await git(root, 'status', '--porcelain=v2', '--untracked-files=all');

		const { snapshot, manifest } = await FrozenGitSnapshot.create({
			root,
			revision: base,
			contextMessage: 'Explain the tracked working changes.',
			mode: 'range',
			model: 'gpt-5.4-mini',
			detailLevel: 2,
			fullPreparation: false,
			compactSession: false
		});
		try {
			expect(manifest.comparison.dirty).toBe(true);
			expect(manifest.files.some((file) => file.path === 'untracked.txt')).toBe(false);
			const app = manifest.files.find((file) => file.path === 'src/app.ts');
			const staged = manifest.files.find((file) => file.path === 'src/new.ts');
			expect((await snapshot.loadFile(app!.id)).newText).toContain('dirty');
			expect((await snapshot.loadFile(staged!.id)).newText).toContain('return 3');
			const search = await snapshot.search({
				query: 'dirty',
				caseSensitive: false,
				wholeWord: false,
				regex: false,
				diffOnly: true
			});
			expect(search.results[0]?.path).toBe('src/app.ts');
		} finally {
			await snapshot.dispose();
		}

		const statusAfter = await git(root, 'status', '--porcelain=v2', '--untracked-files=all');
		expect(statusAfter).toBe(statusBefore);
		expect(await readFile(path.join(root, 'untracked.txt'), 'utf8')).toBe('must stay out\n');
	});

	it('compares a root commit against the repository object-format empty tree', async () => {
		const { root, base } = await fixture();
		const { snapshot, manifest } = await FrozenGitSnapshot.create({
			root,
			revision: base,
			sessionId: 'session',
			mode: 'commit',
			model: 'gpt-5.4-mini',
			detailLevel: 2,
			fullPreparation: false,
			compactSession: false
		});
		try {
			expect(manifest.files.filter((file) => file.status === 'added')).toHaveLength(3);
			expect(manifest.textualHunkCount).toBeGreaterThan(0);
		} finally {
			await snapshot.dispose();
		}
	});

	it('rejects option-like revisions before invoking Git', async () => {
		const { root } = await fixture();
		const result = await validateReviewConfig({
			root,
			revision: '--help',
			sessionId: 'session',
			mode: 'commit',
			model: 'gpt-5.4-mini',
			detailLevel: 2,
			fullPreparation: false,
			compactSession: false
		});
		expect(result.valid).toBe(false);
		expect(result.issues[0].message).toContain('option marker');
	});
});
