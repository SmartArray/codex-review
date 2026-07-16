import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { z } from 'zod';

const threadStatusSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('notLoaded') }),
	z.object({ type: z.literal('idle') }),
	z.object({ type: z.literal('systemError') }),
	z.object({ type: z.literal('active'), activeFlags: z.array(z.string()) })
]);

const turnSchema = z.object({
	id: z.string(),
	status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
	completedAt: z.number().nullable().optional()
});

const threadSchema = z.object({
	id: z.string(),
	cwd: z.string(),
	status: threadStatusSchema,
	turns: z.array(turnSchema),
	modelProvider: z.string().optional(),
	path: z.string().nullable().optional()
});

export type AppThread = z.infer<typeof threadSchema>;

const readResponseSchema = z.object({ thread: threadSchema });
const forkResponseSchema = z.object({
	thread: threadSchema,
	model: z.string(),
	modelProvider: z.string(),
	cwd: z.string()
});

interface RpcSuccess {
	id: number | string;
	result: unknown;
}

interface RpcFailure {
	id: number | string;
	error: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

export interface ForkOptions {
	threadId: string;
	lastTurnId: string;
	cwd: string;
	developerInstructions?: string;
}

export interface ForkResult {
	threadId: string;
	model: string;
	modelProvider: string;
}

export class CodexAppServer {
	private process?: ChildProcessWithoutNullStreams;
	private lines?: Interface;
	private nextId = 1;
	private pending = new Map<number | string, PendingRequest>();
	private starting?: Promise<void>;
	private closed = false;

	constructor(private readonly binaryPath: string) {}

	async start(): Promise<void> {
		if (this.process) return;
		if (this.starting) return this.starting;
		this.starting = this.startInternal();
		try {
			await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	private async startInternal(): Promise<void> {
		if (this.closed) throw new Error('Codex app-server has been closed.');
		const child = spawn(this.binaryPath, ['app-server', '--stdio'], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, CODEX_EXPLAIN: '1' },
			windowsHide: true,
			shell: false
		});
		this.process = child;
		this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		this.lines.on('line', (line) => this.handleLine(line));
		child.stderr.resume();
		child.on('error', (error) =>
			this.failAll(new Error(`Codex app-server failed to start: ${error.message}`))
		);
		child.on('exit', () => {
			this.process = undefined;
			this.lines?.close();
			this.lines = undefined;
			this.failAll(new Error('Codex app-server stopped unexpectedly.'));
		});

		await this.request('initialize', {
			clientInfo: { name: 'codex-explain', title: 'Codex Explain', version: '0.0.1' },
			capabilities: {
				experimentalApi: true,
				requestAttestation: false,
				optOutNotificationMethods: []
			}
		});
		this.notify('initialized');
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (!message || typeof message !== 'object' || !('id' in message)) return;
		const id = (message as { id: number | string }).id;
		const pending = this.pending.get(id);
		if (!pending) {
			// Reject unexpected server requests without granting any capability.
			if ('method' in message)
				this.write({ id, error: { code: -32601, message: 'Client method unavailable' } });
			return;
		}
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if ('error' in message) {
			const failure = message as RpcFailure;
			pending.reject(new Error(failure.error.message ?? 'Codex app-server request failed.'));
		} else {
			pending.resolve((message as RpcSuccess).result);
		}
	}

	private write(message: unknown): void {
		if (!this.process?.stdin.writable) throw new Error('Codex app-server is unavailable.');
		this.process.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private notify(method: string, params?: unknown): void {
		this.write(params === undefined ? { method } : { method, params });
	}

	private async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
		if (!this.process && method !== 'initialize') await this.start();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex app-server timed out during ${method}.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write(params === undefined ? { method, id } : { method, id, params });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	async readThread(threadId: string): Promise<AppThread> {
		await this.start();
		return readResponseSchema.parse(
			await this.request('thread/read', { threadId, includeTurns: true }, 45_000)
		).thread;
	}

	async forkThread(options: ForkOptions): Promise<ForkResult> {
		await this.start();
		const response = forkResponseSchema.parse(
			await this.request(
				'thread/fork',
				{
					threadId: options.threadId,
					lastTurnId: options.lastTurnId,
					cwd: options.cwd,
					runtimeWorkspaceRoots: [options.cwd],
					approvalPolicy: 'never',
					sandbox: 'read-only',
					developerInstructions: options.developerInstructions,
					ephemeral: false,
					threadSource: 'codex-explain',
					excludeTurns: true
				},
				60_000
			)
		);
		return {
			threadId: response.thread.id,
			model: response.model,
			modelProvider: response.modelProvider
		};
	}

	async archiveThread(threadId: string): Promise<void> {
		await this.start();
		await this.request('thread/archive', { threadId }, 30_000);
	}

	async unarchiveThread(threadId: string): Promise<void> {
		await this.start();
		await this.request('thread/unarchive', { threadId }, 30_000);
	}

	async close(): Promise<void> {
		this.closed = true;
		this.lines?.close();
		this.lines = undefined;
		const child = this.process;
		this.process = undefined;
		if (child && !child.killed) child.kill('SIGTERM');
		this.failAll(new Error('Codex app-server closed.'));
	}
}
