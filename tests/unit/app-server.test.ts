import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServer } from '../../electron/backend/app-server.js';

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function mockServer(
	compaction: 'success' | 'failure' | 'silent' = 'success'
): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'codex-explain-app-server-test-'));
	directories.push(directory);
	const executable = path.join(directory, 'mock-codex.mjs');
	await writeFile(
		executable,
		`#!/usr/bin/env node
import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const compaction = ${JSON.stringify(compaction)};
const thread = (id, turns = []) => ({ id, cwd: process.cwd(), status: { type: 'idle' }, turns, modelProvider: 'openai', path: null });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  let result;
  if (message.method === 'initialize') result = { userAgent: 'mock', codexHome: process.cwd(), platformFamily: 'unix', platformOs: 'test' };
  else if (message.method === 'thread/read') result = { thread: thread(message.params.threadId, [{ id: 'turn-complete', status: 'completed', completedAt: 1 }]) };
  else if (message.method === 'thread/fork') result = { thread: thread('child-thread'), model: 'mock-model', modelProvider: 'openai', cwd: process.cwd() };
  else if (message.method === 'thread/compact/start') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
    if (compaction === 'silent') return;
    const turnId = 'compact-turn';
    process.stdout.write(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: message.params.threadId, turnId, tokenUsage: { last: { inputTokens: 120, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 140 }, total: { inputTokens: 120, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 140 }, modelContextWindow: 1000 } } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: message.params.threadId, turnId, item: { id: 'compact-item', type: 'contextCompaction' }, completedAtMs: Date.now() } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: compaction === 'failure' ? 'failed' : 'completed', items: [], error: null } } }) + '\\n');
    return;
  }
  else if (message.method === 'thread/archive' || message.method === 'thread/unarchive') result = {};
  else return process.stdout.write(JSON.stringify({ id: message.id, error: { code: -1, message: 'unknown' } }) + '\\n');
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`
	);
	await chmod(executable, 0o755);
	return executable;
}

describe('CodexAppServer', () => {
	it('handshakes, reads, forks at a pinned turn, and archives', async () => {
		const binary = await mockServer();
		const server = new CodexAppServer(binary);
		try {
			const baseline = await server.readThread('baseline');
			expect(baseline.id).toBe('baseline');
			expect(baseline.turns[0]).toMatchObject({ id: 'turn-complete', status: 'completed' });
			const child = await server.forkThread({
				threadId: baseline.id,
				lastTurnId: baseline.turns[0].id,
				cwd: process.cwd(),
				developerInstructions: 'read only'
			});
			expect(child).toEqual({
				threadId: 'child-thread',
				model: 'mock-model',
				modelProvider: 'openai'
			});
			await server.archiveThread(child.threadId);
			await server.unarchiveThread(child.threadId);
		} finally {
			await server.close();
		}
	});

	it('runs native compaction and returns the compacted turn usage', async () => {
		const server = new CodexAppServer(await mockServer());
		try {
			await expect(server.compactThread('child-thread')).resolves.toEqual({
				turnId: 'compact-turn',
				usage: {
					inputTokens: 120,
					cachedInputTokens: 80,
					outputTokens: 20,
					reasoningOutputTokens: 5,
					totalTokens: 140
				}
			});
		} finally {
			await server.close();
		}
	});

	it('propagates failed, timed out, and cancelled compaction safely', async () => {
		const failed = new CodexAppServer(await mockServer('failure'));
		await expect(failed.compactThread('failed-thread')).rejects.toThrow('failed');
		await failed.close();

		const timedOut = new CodexAppServer(await mockServer('silent'), 20);
		await expect(timedOut.compactThread('timeout-thread')).rejects.toThrow('timed out');
		await timedOut.close();

		const cancelled = new CodexAppServer(await mockServer('silent'));
		const controller = new AbortController();
		const result = cancelled.compactThread('cancelled-thread', controller.signal);
		controller.abort();
		await expect(result).rejects.toThrow('cancelled');
		await cancelled.close();
	});
});
