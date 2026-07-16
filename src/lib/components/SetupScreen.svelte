<script lang="ts">
	import {
		ArrowRight,
		ChevronDown,
		FolderOpen,
		GitCompareArrows,
		LoaderCircle,
		History,
		ShieldCheck,
		Sparkles
	} from '@lucide/svelte';
	import ReviewHistoryDialog from '$lib/components/ReviewHistoryDialog.svelte';
	import {
		DEFAULT_MODEL,
		DEFAULT_MODEL_REASONING_EFFORT,
		PREDEFINED_MODELS
	} from '$lib/shared/models';
	import type { ReviewConfig, ReviewHistoryEntry, ValidationResult } from '$lib/shared/types';

	export let initial: Partial<ReviewConfig> = {};
	export let validation: ValidationResult | null = null;
	export let validating = false;
	export let starting = false;
	export let onChooseRoot: () => Promise<string | null> = async () => null;
	export let onValidate: (config: ReviewConfig) => void = () => undefined;
	export let onStart: (config: ReviewConfig) => void = () => undefined;

	let root = initial.root ?? '';
	let revision = initial.revision ?? '';
	let sessionId = initial.sessionId ?? '';
	let contextMessage = initial.contextMessage ?? '';
	let contextSource: 'session' | 'message' = initial.contextMessage ? 'message' : 'session';
	let mode: 'commit' | 'range' = initial.mode ?? 'commit';
	let model = initial.model ?? DEFAULT_MODEL;
	let detailLevel = initial.detailLevel ?? 2;
	let fullPreparation = initial.fullPreparation ?? false;
	let modelMenuOpen = false;
	let historyOpen = false;
	let historyLoading = false;
	let historyEntries: ReviewHistoryEntry[] = [];
	let config: ReviewConfig;

	$: config = {
		root: root.trim(),
		revision: revision.trim(),
		...(contextSource === 'session'
			? { sessionId: sessionId.trim() }
			: { contextMessage: contextMessage.trim() }),
		mode,
		model: model.trim(),
		detailLevel,
		fullPreparation
	};
	$: complete = Boolean(
		config.root &&
		config.revision &&
		config.model &&
		(contextSource === 'session' ? config.sessionId : config.contextMessage)
	);

	function selectContextSource(source: 'session' | 'message') {
		contextSource = source;
		validation = null;
	}

	async function chooseRoot() {
		const selected = await onChooseRoot();
		if (selected) {
			root = selected;
			validation = null;
		}
	}

	function selectModel(value: string) {
		model = value;
		modelMenuOpen = false;
		validation = null;
	}

	function closeModelMenu(event: FocusEvent) {
		const container = event.currentTarget as HTMLElement;
		if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget)) {
			modelMenuOpen = false;
		}
	}

	async function openHistory() {
		historyOpen = true;
		historyLoading = true;
		try {
			historyEntries = await window.reviewApi.getReviewHistory();
		} finally {
			historyLoading = false;
		}
	}

	function applyHistory(selected: ReviewConfig) {
		root = selected.root;
		revision = selected.revision;
		mode = selected.mode;
		model = selected.model;
		detailLevel = selected.detailLevel;
		fullPreparation = selected.fullPreparation;
		sessionId = selected.sessionId ?? '';
		contextMessage = selected.contextMessage ?? '';
		contextSource = selected.contextMessage ? 'message' : 'session';
		validation = null;
		modelMenuOpen = false;
	}

	async function clearHistory() {
		await window.reviewApi.clearReviewHistory();
		historyEntries = [];
	}
</script>

<main class="setup-shell">
	<button
		type="button"
		class="history-button"
		onclick={openHistory}
		aria-label="Open recent reviews"
	>
		<History size={16} /> History
	</button>
	<div class="ambient one"></div>
	<div class="ambient two"></div>
	<section class="setup-card">
		<header>
			<div class="mark"><GitCompareArrows size={22} /></div>
			<div>
				<div class="product"><Sparkles size={12} /> Codex Review</div>
				<h1>Understand the change,<br />not just the lines.</h1>
				<p>
					A read-only, diff-focused workspace that turns source context into a guided explanation.
				</p>
			</div>
		</header>

		<form
			onsubmit={(event) => {
				event.preventDefault();
				onValidate(config);
			}}
		>
			<label>
				<span>Root directory</span>
				<div class="input-row">
					<input
						bind:value={root}
						oninput={() => (validation = null)}
						placeholder="/path/to/repository"
						spellcheck="false"
					/>
					<button type="button" class="browse" onclick={chooseRoot} aria-label="Choose repository"
						><FolderOpen size={16} /></button
					>
				</div>
			</label>

			<div class="grid">
				<label>
					<span>Git revision</span>
					<input
						bind:value={revision}
						oninput={() => (validation = null)}
						placeholder="abc123, tag, branch, HEAD~"
						spellcheck="false"
					/>
				</label>
				<label>
					<span>Comparison mode</span>
					<select bind:value={mode} onchange={() => (validation = null)}>
						<option value="commit">Selected commit only</option>
						<option value="range">Revision → working HEAD</option>
					</select>
				</label>
			</div>

			<label>
				<span>Analysis model</span>
				<div class="model-picker" onfocusout={closeModelMenu}>
					<input
						bind:value={model}
						role="combobox"
						aria-autocomplete="list"
						aria-controls="model-options"
						aria-expanded={modelMenuOpen}
						onfocus={() => (modelMenuOpen = true)}
						oninput={() => {
							validation = null;
							modelMenuOpen = true;
						}}
						placeholder={DEFAULT_MODEL}
						spellcheck="false"
						autocomplete="off"
					/>
					<button
						type="button"
						class="model-toggle"
						aria-label="Choose a predefined model"
						onclick={() => (modelMenuOpen = !modelMenuOpen)}><ChevronDown size={15} /></button
					>
					{#if modelMenuOpen}
						<div id="model-options" class="model-options" role="listbox">
							{#each PREDEFINED_MODELS as option (option)}
								<button
									type="button"
									role="option"
									aria-selected={model === option}
									onclick={() => selectModel(option)}
									>{option}{option === DEFAULT_MODEL ? ' · default' : ''}</button
								>
							{/each}
						</div>
					{/if}
				</div>
				<small>All analysis uses {DEFAULT_MODEL_REASONING_EFFORT} reasoning effort.</small>
			</label>

			<fieldset class="context-source">
				<legend>Analysis context</legend>
				<div class="context-options" aria-label="Analysis context source">
					<label class:active={contextSource === 'session'}>
						<input
							type="radio"
							name="context-source"
							value="session"
							checked={contextSource === 'session'}
							onchange={() => selectContextSource('session')}
						/>
						<span>Existing session</span>
					</label>
					<label class:active={contextSource === 'message'}>
						<input
							type="radio"
							name="context-source"
							value="message"
							checked={contextSource === 'message'}
							onchange={() => selectContextSource('message')}
						/>
						<span>New context message</span>
					</label>
				</div>
				{#if contextSource === 'session'}
					<label>
						<span>Codex session ID</span>
						<input
							bind:value={sessionId}
							oninput={() => (validation = null)}
							placeholder="019…"
							spellcheck="false"
						/>
						<small>The completed session turn becomes the baseline for every explanation.</small>
					</label>
				{:else}
					<label>
						<span>Context message</span>
						<textarea
							bind:value={contextMessage}
							oninput={() => (validation = null)}
							placeholder="Explain the goal, constraints, or intent behind these changes—or simply paste the ticket here…"
							maxlength="16000"
							rows="4"></textarea>
						<small
							>Codex analyzes the frozen comparison with this message, then branches every
							explanation from that base chat.</small
						>
					</label>
				{/if}
			</fieldset>

			<label>
				<span
					>Explanation size <output
						>{detailLevel} · {detailLevel === 1
							? 'very small'
							: detailLevel === 2
								? 'compact'
								: detailLevel === 3
									? 'medium'
									: detailLevel === 4
										? 'detailed'
										: 'very detailed'}</output
					></span
				>
				<input
					aria-label="Explanation size"
					type="range"
					min="1"
					max="5"
					step="1"
					bind:value={detailLevel}
					oninput={() => (validation = null)}
				/>
				<small>Controls the length of generated file and hunk explanations.</small>
			</label>

			{#if validation && !validation.valid}
				<div class="issues" role="alert">
					{#each validation.issues as issue, index (issue.field + ':' + index)}<p>
							{issue.message}
						</p>{/each}
				</div>
			{/if}

			{#if validation?.valid && validation.resolved}
				<div class="resolved">
					<div class="resolved-title">
						<ShieldCheck size={15} /> Ready to freeze this comparison
					</div>
					<div class="endpoint"><span>Old</span><code>{validation.resolved.oldLabel}</code></div>
					<div class="line"></div>
					<div class="endpoint"><span>New</span><code>{validation.resolved.newLabel}</code></div>
					<button type="button" class="start" disabled={starting} onclick={() => onStart(config)}>
						{#if starting}<span class="spin"><LoaderCircle size={15} /></span> Preparing review...{:else}Open
							review <ArrowRight size={15} />{/if}
					</button>
				</div>
			{:else}
				<button type="submit" class="validate" disabled={!complete || validating}>
					{#if validating}<span class="spin"><LoaderCircle size={15} /></span> Validating…{:else}Preview
						comparison <ArrowRight size={15} />{/if}
				</button>
			{/if}
		</form>
	</section>

	<footer>
		<ShieldCheck size={12} /> Source repository remains untouched · network disabled for analysis
	</footer>

	{#if historyOpen}
		<ReviewHistoryDialog
			entries={historyEntries}
			loading={historyLoading}
			onSelect={applyHistory}
			onClear={clearHistory}
			onClose={() => (historyOpen = false)}
		/>
	{/if}
</main>

<style>
	.setup-shell {
		position: relative;
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 70px 24px 48px;
		overflow: auto;
		background:
			linear-gradient(var(--grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--grid-line) 1px, transparent 1px), var(--surface-0);
		background-size: 42px 42px;
	}

	.setup-card {
		position: relative;
		z-index: 1;
		width: min(680px, calc(100vw - 40px));
		padding: 34px;
		border: 1px solid var(--border-strong);
		border-radius: 20px;
		background: color-mix(in srgb, var(--surface-1) 92%, transparent);
		box-shadow: var(--shadow-xl);
		backdrop-filter: blur(24px);
	}

	.history-button {
		position: fixed;
		z-index: 3;
		top: 20px;
		right: 22px;
		height: 34px;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 0 12px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-1) 88%, transparent);
		color: var(--text-secondary);
		font: 650 10px/1 var(--font-sans);
		backdrop-filter: blur(14px);
		box-shadow: var(--shadow-sm);
		cursor: pointer;
	}

	.history-button:hover {
		border-color: var(--selection-border);
		color: var(--accent-text);
	}

	header {
		display: flex;
		gap: 18px;
		margin-bottom: 30px;
	}

	.mark {
		width: 46px;
		height: 46px;
		display: grid;
		place-items: center;
		flex: none;
		border-radius: 13px;
		color: white;
		background: linear-gradient(145deg, var(--accent), var(--accent-2));
		box-shadow: 0 10px 28px var(--accent-glow);
	}

	.product {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-bottom: 8px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--accent-text);
	}

	h1 {
		margin: 0;
		font-size: clamp(27px, 4vw, 38px);
		line-height: 1.05;
		letter-spacing: -0.04em;
	}

	header p {
		max-width: 500px;
		margin: 12px 0 0;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	form {
		display: grid;
		gap: 18px;
	}

	label {
		display: grid;
		gap: 7px;
	}

	label > span {
		font-size: 11px;
		font-weight: 650;
		color: var(--text-secondary);
	}

	label small {
		font-size: 10px;
		color: var(--text-muted);
	}

	.grid {
		display: grid;
		grid-template-columns: 1.2fr 1fr;
		gap: 14px;
	}

	.input-row {
		display: flex;
	}

	.model-picker {
		position: relative;
		display: flex;
	}

	input,
	select,
	textarea {
		width: 100%;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		outline: none;
		background: var(--surface-0);
		color: var(--text-primary);
		font: 12px/1.2 var(--font-mono);
	}
	input,
	select {
		height: 40px;
	}
	textarea {
		min-height: 88px;
		padding-top: 10px;
		padding-bottom: 10px;
		line-height: 1.45;
		resize: vertical;
	}

	select {
		font-family: var(--font-sans);
	}

	input:focus,
	select:focus,
	textarea:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--selection-soft);
	}

	.context-source {
		display: grid;
		gap: 11px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.context-source legend {
		margin-bottom: 7px;
		font-size: 11px;
		font-weight: 650;
		color: var(--text-secondary);
	}
	.context-options {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 5px;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: 9px;
		background: var(--surface-0);
	}
	.context-options label {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		min-height: 31px;
		border-radius: 6px;
		color: var(--text-muted);
		cursor: pointer;
	}
	.context-options label.active {
		background: var(--selection-soft);
		color: var(--accent-text);
		box-shadow: inset 0 0 0 1px var(--selection-border);
	}
	.context-options input {
		width: 12px;
		height: 12px;
		margin: 0;
		padding: 0;
		accent-color: var(--accent);
	}
	.context-options span {
		font-size: 10px;
		font-weight: 650;
		color: inherit;
	}

	.input-row input {
		border-radius: 8px 0 0 8px;
	}

	.model-picker input {
		padding-right: 42px;
	}
	.model-toggle,
	.browse {
		display: grid;
		place-items: center;
		padding: 0;
	}

	.model-toggle {
		position: absolute;
		top: 1px;
		right: 1px;
		bottom: 1px;
		width: 39px;
		border: 0;
		border-left: 1px solid var(--border);
		border-radius: 0 7px 7px 0;
		background: var(--surface-2);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.model-options {
		position: absolute;
		z-index: 5;
		top: calc(100% + 5px);
		left: 0;
		right: 0;
		display: grid;
		padding: 5px;
		border: 1px solid var(--border-strong);
		border-radius: 9px;
		background: var(--surface-1);
		box-shadow: var(--shadow-xl);
	}

	.model-options button {
		padding: 8px 9px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary);
		font: 11px/1.2 var(--font-mono);
		text-align: left;
		cursor: pointer;
	}

	.model-options button:hover,
	.model-options button[aria-selected='true'] {
		background: var(--selection-soft);
		color: var(--accent-text);
	}

	.browse {
		width: 43px;
		border: 1px solid var(--border);
		border-left: 0;
		border-radius: 0 8px 8px 0;
		background: var(--surface-2);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.validate,
	.start {
		height: 41px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border: 0;
		border-radius: 8px;
		background: linear-gradient(135deg, var(--accent), var(--accent-2));
		color: white;
		font: 650 12px/1 inherit;
		cursor: pointer;
	}

	.validate:disabled,
	.start:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.issues {
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
		border-radius: 8px;
		background: var(--danger-soft);
		color: var(--danger);
	}

	.issues p {
		margin: 2px 0;
		font-size: 11px;
	}

	.resolved {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 7px 12px;
		padding: 14px;
		border: 1px solid var(--selection-border);
		border-radius: 10px;
		background: var(--selection-soft);
	}

	.resolved-title {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
		font-size: 11px;
		font-weight: 650;
		color: var(--accent-text);
	}

	.endpoint {
		display: contents;
	}

	.endpoint span {
		font-size: 9px;
		font-weight: 700;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.endpoint code {
		font: 10px/1.4 var(--font-mono);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.line {
		display: none;
	}

	.resolved .start {
		grid-column: 1 / -1;
		margin-top: 7px;
	}

	.ambient {
		position: absolute;
		width: 430px;
		height: 430px;
		border-radius: 50%;
		filter: blur(100px);
		opacity: 0.13;
		pointer-events: none;
	}

	.ambient.one {
		top: -160px;
		right: 4%;
		background: var(--accent);
	}

	.ambient.two {
		bottom: -200px;
		left: 3%;
		background: var(--accent-2);
	}

	footer {
		position: absolute;
		bottom: 22px;
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 10px;
		color: var(--text-muted);
	}

	.spin {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 600px) {
		.setup-card {
			padding: 24px;
		}
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
