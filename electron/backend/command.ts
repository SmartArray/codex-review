import { spawn } from 'node:child_process';

export interface CommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string | Uint8Array;
	timeoutMs?: number;
	maxOutputBytes?: number;
	signal?: AbortSignal;
}

export interface CommandResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number;
}

export class CommandError extends Error {
	readonly command: string;
	readonly args: string[];
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(
		command: string,
		args: string[],
		exitCode: number | null,
		stderr: Buffer,
		reason?: string
	) {
		const detail = stderr.toString('utf8').trim();
		super(reason ?? (detail || `${command} exited with code ${String(exitCode)}`));
		this.name = 'CommandError';
		this.command = command;
		this.args = args;
		this.exitCode = exitCode;
		this.stderr = detail;
	}
}

export async function runCommand(
	command: string,
	args: readonly string[],
	options: CommandOptions = {}
): Promise<CommandResult> {
	const maxOutputBytes = options.maxOutputBytes ?? 128 * 1024 * 1024;
	return new Promise((resolve, reject) => {
		let settled = false;
		let outputBytes = 0;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: false,
			windowsHide: true
		});

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener('abort', abort);
			callback();
		};

		const abort = () => {
			child.kill('SIGTERM');
			finish(() =>
				reject(
					new CommandError(command, [...args], null, Buffer.concat(stderr), 'Command cancelled')
				)
			);
		};

		const timer = options.timeoutMs
			? setTimeout(() => {
					child.kill('SIGKILL');
					finish(() =>
						reject(
							new CommandError(
								command,
								[...args],
								null,
								Buffer.concat(stderr),
								`Command timed out after ${options.timeoutMs} ms`
							)
						)
					);
				}, options.timeoutMs)
			: undefined;

		if (options.signal?.aborted) {
			abort();
			return;
		}
		options.signal?.addEventListener('abort', abort, { once: true });

		const collect = (target: Buffer[], chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > maxOutputBytes) {
				child.kill('SIGKILL');
				finish(() =>
					reject(
						new CommandError(
							command,
							[...args],
							null,
							Buffer.concat(stderr),
							`Command output exceeded ${maxOutputBytes} bytes`
						)
					)
				);
				return;
			}
			target.push(Buffer.from(chunk));
		};

		child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
		child.on('error', (error) => {
			finish(() =>
				reject(new CommandError(command, [...args], null, Buffer.concat(stderr), error.message))
			);
		});
		child.on('close', (exitCode) => {
			const out = Buffer.concat(stdout);
			const err = Buffer.concat(stderr);
			if (exitCode === 0) {
				finish(() => resolve({ stdout: out, stderr: err, exitCode: 0 }));
			} else {
				finish(() => reject(new CommandError(command, [...args], exitCode, err)));
			}
		});

		if (options.input === undefined) child.stdin.end();
		else child.stdin.end(options.input);
	});
}

export async function commandText(
	command: string,
	args: readonly string[],
	options?: CommandOptions
): Promise<string> {
	const result = await runCommand(command, args, options);
	return result.stdout.toString('utf8');
}
