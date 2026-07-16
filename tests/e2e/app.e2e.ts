import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const execute = promisify(execFile);
let fixtureRoot: string;
let userData: string;

test.beforeAll(async () => {
	fixtureRoot = await mkdtemp(path.join(tmpdir(), 'codex-explain-e2e-repo-'));
	userData = await mkdtemp(path.join(tmpdir(), 'codex-explain-e2e-data-'));
	await git('init', '-b', 'main');
	await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
	await writeFile(path.join(fixtureRoot, 'src/app.ts'), 'export const greeting = "old world";\n');
	await writeFile(path.join(fixtureRoot, 'src/stable.ts'), 'export const stable = true;\n');
	await writeFile(path.join(fixtureRoot, 'deleted.txt'), 'old file\n');
	await git('add', '.');
	await git('commit', '-m', 'base');
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
		await application.close();
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
		await expect(page.getByText(/tokens · \d+ calls?/)).toBeVisible();
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
		await application.close();
	}
});

async function launch(args: string[]): Promise<ElectronApplication> {
	return electron.launch({
		executablePath: electronExecutable(),
		args: [path.resolve('.'), `--user-data-dir=${userData}`, ...args],
		env: { ...process.env, NODE_ENV: 'production' },
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
