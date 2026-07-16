import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
	contextBaselinePrompt,
	sessionWorkspaceMatchesRepository
} from '../../electron/backend/codex-adapter.js';

const exec = promisify(execFile);

describe('Codex session repository matching', () => {
	it('wraps a startup context message with the pinned comparison', () => {
		const prompt = contextBaselinePrompt('Focus on compatibility.', {
			oldRevision: 'old-hash',
			newRevision: 'new-tree',
			revisionExpression: 'HEAD~2',
			mode: 'range',
			dirty: true
		});
		expect(prompt).toContain('Analyze the recent changes');
		expect(prompt).toContain('git diff --find-renames old-hash new-tree');
		expect(prompt).toContain('git diff --cached');
		expect(prompt).toContain('Focus on compatibility.');
	});

	it('accepts a non-Git workspace that contains the selected repository', async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), 'codex-explain-workspace-'));
		const repository = path.join(workspace, 'nested-repository');
		await mkdir(repository);
		await exec('git', ['init', '--quiet'], { cwd: repository });
		const commonDirectory = await realpath(path.join(repository, '.git'));

		await expect(
			sessionWorkspaceMatchesRepository(workspace, repository, commonDirectory)
		).resolves.toBe(true);
	});

	it('rejects an unrelated non-Git workspace', async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), 'codex-explain-workspace-'));
		const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'codex-explain-repository-'));
		await exec('git', ['init', '--quiet'], { cwd: elsewhere });
		const commonDirectory = await realpath(path.join(elsewhere, '.git'));

		await expect(
			sessionWorkspaceMatchesRepository(workspace, elsewhere, commonDirectory)
		).resolves.toBe(false);
	});
});
