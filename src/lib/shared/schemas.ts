import { z } from 'zod';

export const kokoroVoiceSchema = z.enum(['am_michael', 'am_echo', 'af_sarah', 'af_heart']);
export const speechSettingsSchema = z
	.object({
		engine: z.enum(['kokoro', 'voicebox', 'siri']),
		voice: kokoroVoiceSchema,
		voiceboxProfileId: z
			.string()
			.trim()
			.min(1)
			.max(256)
			.regex(/^[A-Za-z0-9._:-]+$/, 'Voicebox profile ID contains invalid characters')
			.optional(),
		speed: z
			.number()
			.min(0.5)
			.max(2)
			.refine((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-8)
	})
	.strict()
	.superRefine((value, context) => {
		if (value.engine === 'voicebox' && !value.voiceboxProfileId) {
			context.addIssue({
				code: 'custom',
				path: ['voiceboxProfileId'],
				message: 'Choose a Voicebox profile.'
			});
		}
	});
export const speechTextSchema = z.string().trim().min(1).max(2000);
import { DEFAULT_MODEL } from './models.js';

export const reviewModeSchema = z.enum(['commit', 'range']);

export const reviewConfigSchema = z
	.object({
		root: z.string().trim().min(1).max(4096),
		revision: z
			.string()
			.trim()
			.min(1)
			.max(1024)
			.refine((value) => !value.startsWith('-'), 'Revision must not start with an option marker')
			.refine((value) => !value.includes('\0'), 'Revision contains an invalid character'),
		sessionId: z
			.string()
			.trim()
			.min(1)
			.max(256)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Session ID contains invalid characters')
			.optional(),
		contextMessage: z.string().trim().min(1).max(16_000).optional(),
		mode: reviewModeSchema.default('commit'),
		model: z
			.string()
			.trim()
			.min(1, 'Model is required')
			.max(256)
			.refine((value) => !value.startsWith('-'), 'Model must not start with an option marker')
			.refine((value) => !value.includes('\0'), 'Model contains an invalid character')
			.default(DEFAULT_MODEL),
		detailLevel: z.number().int().min(1).max(5).default(2),
		fullPreparation: z.boolean().default(false),
		compactSession: z.boolean().default(false)
	})
	.superRefine((value, context) => {
		if (Boolean(value.sessionId) === Boolean(value.contextMessage)) {
			context.addIssue({
				code: 'custom',
				path: ['general'],
				message: 'Provide either a Codex session ID or a context message, but not both.'
			});
		}
		if (value.compactSession && !value.sessionId) {
			context.addIssue({
				code: 'custom',
				path: ['compactSession'],
				message: 'Session compaction requires an existing Codex session ID.'
			});
		}
	});

export const targetSchema = z.object({
	fileId: z.string().min(1).max(128),
	hunkId: z.string().min(1).max(128).optional()
});

export const fileIdSchema = z.string().min(1).max(128);
export const hunkIdSchema = z.string().min(1).max(128);

export const prioritizeSchema = z.object({
	hunkId: hunkIdSchema,
	reason: z.enum(['hover', 'select', 'story', 'question'])
});

export const searchOptionsSchema = z.object({
	query: z.string().max(1000),
	caseSensitive: z.boolean(),
	wholeWord: z.boolean(),
	regex: z.boolean(),
	diffOnly: z.boolean(),
	page: z.number().int().min(0).max(100_000).optional(),
	pageSize: z.number().int().min(1).max(500).optional()
});

export const questionSchema = z.object({
	hunkId: hunkIdSchema,
	question: z.string().trim().min(1).max(16_000)
});

export const storyDirectionSchema = z.enum(['previous', 'next']);

export const rangeReviewItemIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(192)
	.refine((value) => !value.includes('\0'), 'Range review item ID contains an invalid character');

export const rangeReviewStatusSchema = z
	.object({
		itemId: rangeReviewItemIdSchema,
		reviewed: z.boolean()
	})
	.strict();

export const workerRequestSchema = z.object({
	id: z.string().min(1),
	method: z.string().min(1),
	params: z.unknown().optional()
});

export const fileOverviewSchema = z.object({
	role: z.string().min(1).max(2000),
	whyChanged: z.string().min(1).max(4000),
	howChanged: z.string().min(1).max(4000)
});

export const hunkExplanationSchema = z.object({
	title: z.string().min(1).max(200),
	summary: z.string().min(1).max(3000),
	expandedExplanation: z.string().min(1).max(12_000)
});

export const storyPlanOutputSchema = z.object({
	title: z.string().min(1).max(200),
	summary: z.string().min(1).max(4000),
	fileIds: z.array(z.string().min(1)).max(10_000),
	transitions: z
		.array(
			z.object({
				fromFileId: z.string().min(1).optional(),
				toFileId: z.string().min(1),
				text: z.string().min(1).max(2000)
			})
		)
		.max(10_000)
});

export type ReviewConfigInput = z.infer<typeof reviewConfigSchema>;
