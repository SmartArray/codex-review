import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const execute = promisify(execFile);
let fixtureRoot: string;
let fixtureBase: string;
let userData: string;
let mockCodexBinary: string;

test.beforeAll(async () => {
	fixtureRoot = await mkdtemp(path.join(tmpdir(), 'codex-explain-e2e-repo-'));
	userData = await mkdtemp(path.join(tmpdir(), 'codex-explain-e2e-data-'));
	mockCodexBinary = path.join(userData, 'mock-codex.mjs');
	await writeFile(
		mockCodexBinary,
		`#!/usr/bin/env node
import readline from 'node:readline';
if (!process.argv.includes('app-server')) process.exit(1);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const turns = new Map();
const thread = (id) => ({ id, cwd: process.env.CODEX_REVIEW_TEST_SESSION_CWD, status: { type: 'idle' }, turns: turns.get(id) ?? [{ id: 'source-turn', status: 'completed', completedAt: 1 }], modelProvider: 'openai', path: null });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'mock', codexHome: process.cwd(), platformFamily: 'unix', platformOs: 'test' } });
  if (message.method === 'thread/read') return send({ id: message.id, result: { thread: thread(message.params.threadId) } });
  if (message.method === 'thread/fork') {
    turns.set('review-fork', [{ id: message.params.lastTurnId, status: 'completed', completedAt: 1 }]);
    return send({ id: message.id, result: { thread: thread('review-fork'), model: 'gpt-5.4-mini', modelProvider: 'openai', cwd: process.env.CODEX_REVIEW_TEST_SESSION_CWD } });
  }
  if (message.method === 'thread/compact/start') {
    const turnId = 'compact-turn';
    turns.set(message.params.threadId, [{ id: 'source-turn', status: 'completed', completedAt: 1 }, { id: turnId, status: 'completed', completedAt: 2 }]);
    send({ id: message.id, result: {} });
    send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: message.params.threadId, turnId, tokenUsage: { last: { inputTokens: 120, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 140 }, total: { inputTokens: 120, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 140 }, modelContextWindow: 1000 } } });
    send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId, item: { id: 'compact-item', type: 'contextCompaction' }, completedAtMs: Date.now() } });
    return send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'completed', items: [], error: null } } });
  }
  if (message.method === 'thread/archive' || message.method === 'thread/unarchive') return send({ id: message.id, result: {} });
  send({ id: message.id, error: { code: -1, message: 'unsupported mock method' } });
});
`
	);
	await chmod(mockCodexBinary, 0o755);
	await git('init', '-b', 'main');
	await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
	await writeFile(path.join(fixtureRoot, 'src/app.ts'), 'export const greeting = "old world";\n');
	await writeFile(path.join(fixtureRoot, 'src/stable.ts'), 'export const stable = true;\n');
	await writeFile(path.join(fixtureRoot, 'deleted.txt'), 'old file\n');
	await git('add', '.');
	await git('commit', '-m', 'base');
	fixtureBase = (await git('rev-parse', 'HEAD')).trim();
	await writeFile(
		path.join(fixtureRoot, 'src/app.ts'),
		'export const greeting = "beautiful new world";\nexport const enabled = true;\n'
	);
	await writeFile(
		path.join(fixtureRoot, 'src/feature.ts'),
		'export function feature() { return greeting; }\n'
	);
	await git('rm', 'deleted.txt');
	await git('add', '.');
	await git('commit', '-m', 'feature');
});

test.afterAll(async () => {
	await Promise.all([
		rm(fixtureRoot, { recursive: true, force: true }),
		rm(userData, { recursive: true, force: true })
	]);
});

test('opens the setup screen when required launch arguments are absent', async () => {
	const application = await launch([]);
	try {
		const page = await application.firstWindow();
		await expect(page.getByRole('heading', { name: /Understand the change/ })).toBeVisible();
		await expect(page.getByText('Root directory')).toBeVisible();
		await expect(page.getByText('Codex session ID')).toBeVisible();
		await expect(page.getByRole('combobox', { name: 'Analysis model' })).toHaveValue(
			'gpt-5.4-mini'
		);
	} finally {
		await closeApplication(application);
	}
});

test('loads a frozen commit diff, full file tree, search, and keyboard navigation', async () => {
	const head = (await git('rev-parse', 'HEAD')).trim();
	const application = await launch([
		'--root',
		fixtureRoot,
		'--commit',
		head,
		'--session',
		'missing-e2e-session',
		'--mode',
		'commit'
	]);
	try {
		const page = await application.firstWindow();
		await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByRole('contentinfo', { name: 'Review status' })).toBeVisible();
		await expect(page.getByText(/out · \d+ calls?/)).toBeVisible();
		await expect(page.locator('.setup-shell')).toHaveCount(0);
		await expect(page.getByRole('treeitem', { name: /app.ts/ })).toBeVisible();
		await expect(page.getByRole('treeitem', { name: /stable.ts/ })).toBeVisible();
		await expect(page.getByRole('treeitem', { name: /deleted.txt/ })).toBeVisible();
		await page.getByRole('button', { name: 'Collapse sidebar' }).click();
		const reopenSidebar = page.getByRole('button', { name: 'Open files' });
		await expect(reopenSidebar).toBeVisible();
		await reopenSidebar.click();
		await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
		await page.getByRole('treeitem', { name: /app.ts/ }).click();
		await expect(page.locator('.cm-mergeView')).toBeVisible({ timeout: 20_000 });
		await expect(
			page.locator('.cm-insertedText, .cm-insertedLine, .cm-insertedChunk').first()
		).toBeVisible();
		await expect(page.getByText('beautiful new world')).toBeVisible();

		await page.keyboard.press('Meta+P');
		await expect(page.getByRole('dialog', { name: 'Open file' })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await expect(page.locator('.file-header .path span')).toHaveText('src/feature.ts');
		await page.getByRole('button', { name: /stable\.ts/ }).hover();
		await expect(page.locator('.file-header .path span')).toHaveText('src/feature.ts');
		await page.keyboard.press('Escape');
		await expect(page.locator('.file-header .path span')).toHaveText('src/app.ts');

		await page.keyboard.press('Meta+P');
		await page.getByLabel('File name').fill('stable');
		await expect(page.getByText('Not part of this comparison.')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.locator('.file-header .path span')).toHaveText('src/app.ts');

		await page.keyboard.press('Meta+P');
		await page.getByLabel('File name').fill('stable');
		await page.keyboard.press('Enter');
		await expect(page.getByText('Not part of this comparison.')).toBeVisible();

		await page.keyboard.press('Meta+Shift+F');
		await expect(page.getByLabel('Search project')).toBeVisible();
		await page.getByLabel('Search query').fill('stable');
		await expect(page.getByText(/matches/)).toBeVisible({ timeout: 10_000 });
		await page.getByRole('button', { name: /1:14/ }).click();
		await expect(page.locator('.cm-activeLine')).toBeVisible();

		await page.getByRole('button', { name: 'Review menu' }).click();
		await page.getByRole('button', { name: 'Open another review' }).click();
		await page.getByRole('button', { name: 'Open recent reviews' }).click();
		await expect(page.getByRole('dialog', { name: 'Recent reviews' })).toBeVisible();
		await expect(page.getByText(head, { exact: true })).toBeVisible();
		await page
			.getByRole('button', { name: new RegExp(fixtureRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
			.click();
		await expect(page.getByRole('textbox', { name: 'Root directory' })).toHaveValue(fixtureRoot);
		await expect(page.getByRole('textbox', { name: 'Git revision' })).toHaveValue(head);
		await expect(page.getByRole('button', { name: /Preview comparison/ })).toBeVisible();
	} finally {
		await closeApplication(application);
	}
});

test('compacts an existing session through the mocked native app-server operation', async () => {
	const application = await launch([
		'--root',
		fixtureRoot,
		'--commit',
		fixtureBase,
		'--session-id',
		'e2e-session',
		'--mode',
		'range',
		'--compact'
	]);
	try {
		const page = await application.firstWindow();
		await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 });
		await expect(
			page.getByLabel('Codex tokens used: 120 input, 20 output, across 1 call')
		).toBeVisible({ timeout: 20_000 });
		await page.getByRole('button', { name: /Commits/ }).click();
		await page.getByRole('button', { name: /feature/ }).click();
		await expect(page.getByRole('dialog', { name: 'Commits' })).toHaveCount(0);
		await expect(
			page.getByLabel('Codex tokens used: 120 input, 20 output, across 1 call')
		).toBeVisible({ timeout: 20_000 });
	} finally {
		await closeApplication(application);
	}
});

async function closeApplication(application: ElectronApplication): Promise<void> {
	try {
		await application.evaluate(({ app }) => app.exit(0));
	} catch {
		// The process may exit before Playwright receives the evaluation response.
	}
	await application.close();
}

async function launch(args: string[]): Promise<ElectronApplication> {
	return electron.launch({
		executablePath: electronExecutable(),
		args: [path.resolve('.'), `--user-data-dir=${userData}`, ...args],
		env: {
			...process.env,
			NODE_ENV: 'production',
			CODEX_REVIEW_TEST_MODE: '1',
			CODEX_REVIEW_TEST_CODEX_BINARY: mockCodexBinary,
			CODEX_REVIEW_TEST_SESSION_CWD: fixtureRoot
		},
		timeout: 30_000
	});
}

function electronExecutable(): string {
	if (process.platform === 'darwin') {
		return path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
	}
	if (process.platform === 'win32') return path.resolve('node_modules/electron/dist/electron.exe');
	return path.resolve('node_modules/electron/dist/electron');
}

async function git(...args: string[]): Promise<string> {
	const result = await execute('git', args, {
		cwd: fixtureRoot,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Codex Review E2E',
			GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
			GIT_COMMITTER_NAME: 'Codex Review E2E',
			GIT_COMMITTER_EMAIL: 'e2e@example.invalid'
		}
	});
	return result.stdout;
}
