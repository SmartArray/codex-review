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

async function mockServer(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'codex-explain-app-server-test-'));
	directories.push(directory);
	const executable = path.join(directory, 'mock-codex.mjs');
	await writeFile(
		executable,
		`#!/usr/bin/env node
import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const thread = (id, turns = []) => ({ id, cwd: process.cwd(), status: { type: 'idle' }, turns, modelProvider: 'openai', path: null });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  let result;
  if (message.method === 'initialize') result = { userAgent: 'mock', codexHome: process.cwd(), platformFamily: 'unix', platformOs: 'test' };
  else if (message.method === 'thread/read') result = { thread: thread(message.params.threadId, [{ id: 'turn-complete', status: 'completed', completedAt: 1 }]) };
  else if (message.method === 'thread/fork') result = { thread: thread('child-thread'), model: 'mock-model', modelProvider: 'openai', cwd: process.cwd() };
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
});
