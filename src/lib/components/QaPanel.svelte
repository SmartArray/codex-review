<script lang="ts">
	import {
		ArrowUp,
		Bot,
		CircleStop,
		GripHorizontal,
		LoaderCircle,
		MessageCircleQuestion,
		X
	} from '@lucide/svelte';
	import { tick } from 'svelte';
	import type { DiffHunk, QaConversation } from '$lib/shared/types';

	export let conversation: QaConversation;
	export let hunk: DiffHunk;
	export let filePath: string;
	export let busy = false;
	export let onAsk: (question: string) => void = () => undefined;
	export let onCancel: () => void = () => undefined;
	export let onClose: () => void = () => undefined;

	let question = '';
	let height = 310;
	let messagesElement: HTMLDivElement;
	let previousMessageCount = 0;

	$: if (conversation.messages.length !== previousMessageCount) scrollToBottom();

	async function scrollToBottom() {
		previousMessageCount = conversation.messages.length;
		await tick();
		messagesElement?.scrollTo({ top: messagesElement.scrollHeight, behavior: 'smooth' });
	}

	function submit() {
		const value = question.trim();
		if (!value || busy) return;
		question = '';
		onAsk(value);
	}

	function resizeStart(event: PointerEvent) {
		const startY = event.clientY;
		const startHeight = height;
		const move = (moveEvent: PointerEvent) => {
			height = Math.max(
				210,
				Math.min(window.innerHeight * 0.68, startHeight + startY - moveEvent.clientY)
			);
		};
		const end = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', end);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', end, { once: true });
	}
</script>

<aside class="qa-panel" style={`height:${height}px`} aria-label="Ask about hunk">
	<button
		type="button"
		class="resize"
		onpointerdown={resizeStart}
		aria-label="Resize question panel"><GripHorizontal size={18} /></button
	>
	<header>
		<div class="title">
			<MessageCircleQuestion size={15} />
			<div><strong>Ask about this hunk</strong><span>{filePath} · hunk {hunk.index + 1}</span></div>
		</div>
		<button type="button" class="close" onclick={onClose} aria-label="Close question panel"
			><X size={15} /></button
		>
	</header>
	<div class="messages" bind:this={messagesElement}>
		{#if conversation.preparingContext}
			<div class="preparing">
				<span class="spin"><LoaderCircle size={14} /></span> Preparing hunk context…
			</div>
		{/if}
		{#each conversation.messages as message (message.id)}
			<div class:assistant={message.role === 'assistant'} class="message">
				<div class="avatar">
					{#if message.role === 'assistant'}<Bot size={13} />{:else}You{/if}
				</div>
				<div class="bubble">
					<p>{message.content || (message.status === 'streaming' ? 'Thinking…' : '')}</p>
					{#if message.status === 'failed'}<small>Response failed</small>{/if}
					{#if message.status === 'cancelled'}<small>Cancelled</small>{/if}
				</div>
			</div>
		{:else}
			<div class="empty">
				<Bot size={20} />
				<p>Ask how this hunk works, why it exists, or how it connects to the rest of the change.</p>
			</div>
		{/each}
	</div>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			submit();
		}}
	>
		<textarea
			bind:value={question}
			placeholder="Ask a focused question…"
			rows="2"
			onkeydown={(event) => {
				if (event.key === 'Enter' && !event.shiftKey) {
					event.preventDefault();
					submit();
				}
			}}></textarea>
		{#if busy}
			<button type="button" class="send cancel" onclick={onCancel} aria-label="Cancel response"
				><CircleStop size={16} /></button
			>
		{:else}
			<button type="submit" class="send" disabled={!question.trim()} aria-label="Ask question"
				><ArrowUp size={16} /></button
			>
		{/if}
	</form>
</aside>

<style>
	.qa-panel {
		position: absolute;
		z-index: 50;
		left: 0;
		right: 0;
		bottom: 0;
		display: grid;
		grid-template-rows: 42px 1fr auto;
		min-height: 210px;
		border-top: 1px solid var(--border-strong);
		background: color-mix(in srgb, var(--surface-1) 97%, transparent);
		box-shadow: 0 -14px 40px color-mix(in srgb, black 15%, transparent);
		backdrop-filter: blur(18px);
	}

	.resize {
		position: absolute;
		top: -8px;
		left: calc(50% - 25px);
		width: 50px;
		height: 16px;
		display: grid;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text-muted);
		cursor: ns-resize;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 13px;
		border-bottom: 1px solid var(--border);
	}

	.title {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--accent-text);
	}

	.title div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.title strong {
		font-size: 11px;
		color: var(--text-primary);
	}
	.title span {
		font: 9px/1 var(--font-mono);
		color: var(--text-muted);
	}

	.close {
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border: 0;
		background: transparent;
		color: var(--text-muted);
	}

	.messages {
		overflow: auto;
		padding: 14px max(18px, calc((100% - 840px) / 2));
	}

	.message {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr);
		gap: 8px;
		margin-bottom: 12px;
	}

	.avatar {
		width: 25px;
		height: 25px;
		display: grid;
		place-items: center;
		border-radius: 7px;
		background: var(--surface-3);
		font-size: 8px;
		font-weight: 700;
		color: var(--text-muted);
	}

	.assistant .avatar {
		background: var(--selection-soft);
		color: var(--accent-text);
	}

	.bubble {
		padding: 7px 10px;
		border: 1px solid var(--border);
		border-radius: 4px 10px 10px 10px;
		background: var(--surface-0);
	}

	.bubble p {
		margin: 0;
		white-space: pre-wrap;
		font-size: 11px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.bubble small {
		color: var(--danger);
		font-size: 9px;
	}

	.empty {
		height: 100%;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 7px;
		text-align: center;
		color: var(--text-muted);
	}

	.empty p {
		max-width: 430px;
		margin: 0;
		font-size: 11px;
		line-height: 1.5;
	}

	.preparing {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 7px 10px;
		margin-bottom: 10px;
		border-radius: 6px;
		background: var(--warning-soft);
		color: var(--warning-text);
		font-size: 10px;
	}

	form {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 9px max(18px, calc((100% - 840px) / 2)) 12px;
		border-top: 1px solid var(--border);
	}

	textarea {
		width: 100%;
		min-height: 48px;
		max-height: 100px;
		resize: none;
		padding: 9px 42px 9px 11px;
		border: 1px solid var(--border);
		border-radius: 9px;
		outline: 0;
		background: var(--surface-0);
		color: var(--text-primary);
		font: 11px/1.45 var(--font-sans);
	}

	textarea:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--selection-soft);
	}

	.send {
		position: absolute;
		right: max(24px, calc((100% - 828px) / 2));
		bottom: 20px;
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 7px;
		background: var(--accent);
		color: white;
		cursor: pointer;
	}

	.send.cancel {
		background: var(--danger);
	}
	.send:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.spin {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
