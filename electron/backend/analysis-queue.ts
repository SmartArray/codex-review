export type AnalysisJobKind = 'overview' | 'hunk';
export type AnalysisJobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type PriorityReason =
	'background' | 'current-file' | 'hover' | 'select' | 'story' | 'question';

const PRIORITIES: Record<PriorityReason, number> = {
	background: 0,
	'current-file': 4_000,
	hover: 8_000,
	select: 10_000,
	story: 11_000,
	question: 12_000
};

export interface AnalysisJob {
	id: string;
	fileId: string;
	kind: AnalysisJobKind;
	hunkId?: string;
	state: AnalysisJobState;
	priority: number;
	enqueuedAt: number;
	attempts: number;
}

export interface QueueOptions {
	maxConcurrentFiles?: number;
	canRun(job: AnalysisJob): boolean;
	run(job: AnalysisJob, signal: AbortSignal): Promise<void>;
	onChange?(jobs: AnalysisJob[]): void;
}

export class PrioritizedAnalysisQueue {
	private readonly jobs = new Map<string, AnalysisJob>();
	private readonly activeFiles = new Set<string>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly maxConcurrentFiles: number;
	private scheduled = false;
	private paused = false;
	private stopped = false;

	constructor(private readonly options: QueueOptions) {
		this.maxConcurrentFiles = options.maxConcurrentFiles ?? 3;
	}

	add(input: { id: string; fileId: string; kind: AnalysisJobKind; hunkId?: string }): AnalysisJob {
		const existing = this.jobs.get(input.id);
		if (existing) return existing;
		const job: AnalysisJob = {
			...input,
			state: 'pending',
			priority: input.kind === 'overview' ? 2_000 : 1_000,
			enqueuedAt: Date.now(),
			attempts: 0
		};
		this.jobs.set(job.id, job);
		this.changed();
		this.schedule();
		return job;
	}

	prioritize(jobId: string, reason: PriorityReason): void {
		const job = this.jobs.get(jobId);
		if (!job || job.state !== 'pending') return;
		job.priority = Math.max(job.priority, PRIORITIES[reason] + (job.kind === 'overview' ? 100 : 0));
		job.enqueuedAt = Math.min(job.enqueuedAt, Date.now());
		this.changed();
		this.schedule();
	}

	prioritizeFile(fileId: string, reason: PriorityReason = 'current-file'): void {
		for (const job of this.jobs.values())
			if (job.fileId === fileId) this.prioritize(job.id, reason);
	}

	requeue(jobId: string, reason: PriorityReason = 'select'): void {
		const job = this.jobs.get(jobId);
		if (!job || job.state === 'running') return;
		job.state = 'pending';
		job.priority = Math.max(job.priority, PRIORITIES[reason]);
		job.enqueuedAt = Date.now();
		this.changed();
		this.schedule();
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
		if (!paused) this.schedule();
	}

	isPaused(): boolean {
		return this.paused;
	}

	list(): AnalysisJob[] {
		return [...this.jobs.values()].map((job) => ({ ...job }));
	}

	position(jobId: string): number | undefined {
		const eligible = this.orderedPending();
		const index = eligible.findIndex((job) => job.id === jobId);
		return index < 0 ? undefined : index + 1;
	}

	private schedule(): void {
		if (this.scheduled || this.stopped) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.pump();
		});
	}

	private pump(): void {
		if (this.stopped || this.paused) return;
		while (this.activeFiles.size < this.maxConcurrentFiles) {
			const job = this.orderedPending().find(
				(candidate) => !this.activeFiles.has(candidate.fileId) && this.options.canRun(candidate)
			);
			if (!job) break;
			this.startJob(job);
		}
	}

	private orderedPending(): AnalysisJob[] {
		const now = Date.now();
		return [...this.jobs.values()]
			.filter((job) => job.state === 'pending')
			.sort((left, right) => {
				const leftScore = left.priority + Math.floor((now - left.enqueuedAt) / 1_000) * 5;
				const rightScore = right.priority + Math.floor((now - right.enqueuedAt) / 1_000) * 5;
				return rightScore - leftScore || left.enqueuedAt - right.enqueuedAt;
			});
	}

	private startJob(job: AnalysisJob): void {
		job.state = 'running';
		job.attempts += 1;
		this.activeFiles.add(job.fileId);
		const controller = new AbortController();
		this.controllers.set(job.id, controller);
		this.changed();
		void this.options
			.run({ ...job }, controller.signal)
			.then(() => {
				if (job.state === 'running') job.state = 'completed';
			})
			.catch(() => {
				if (job.state === 'running') job.state = 'failed';
			})
			.finally(() => {
				this.controllers.delete(job.id);
				this.activeFiles.delete(job.fileId);
				this.changed();
				this.schedule();
			});
	}

	private changed(): void {
		this.options.onChange?.(this.list());
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
		for (const job of this.jobs.values()) if (job.state === 'pending') job.state = 'cancelled';
		this.changed();
	}
}
