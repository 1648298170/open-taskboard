// Pure wake-routing decisions shared by the external sidecar and (phase 2) the
// embedded server engine. No I/O lives here, so every branch is unit-testable.

import { isWakeComment } from '@taskboard/core';

/** Try the explicit endpoint first, then project/TUI routes, deduplicating equivalent URLs. */
export function sessionBaseCandidates(
  opencodeBase: string | undefined,
  projectChannel: string | null | undefined,
  tuiUrl: string | undefined,
): string[] {
  const normalize = (value: string): string => value.trim().replace(/\/+$/, '');
  return [...new Set(
    [opencodeBase, projectChannel ?? undefined, tuiUrl]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(normalize),
  )];
}

export interface OpenCodeMessageLike {
  info?: {
    id?: string;
    parentID?: string;
    role?: string;
    sessionID?: string;
    time?: { created?: number; completed?: number };
    error?: unknown;
    finish?: unknown;
  };
  parts?: Array<{ type?: string; text?: string }>;
}

/**
 * Find the Assistant response that follows the exact Taskboard-injected user
 * message. OpenCode's history may contain unrelated work in the same Session;
 * never correlate by Session idle/busy alone.
 */
export function findCorrelatedAssistant(
  input: unknown,
  marker: string,
): { matchedPrompt: boolean; assistant?: OpenCodeMessageLike } {
  if (!Array.isArray(input)) return { matchedPrompt: false };
  const messages = (input as OpenCodeMessageLike[]).map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const at = a.message.info?.time?.created;
      const bt = b.message.info?.time?.created;
      return typeof at === 'number' && typeof bt === 'number' ? at - bt || a.index - b.index : a.index - b.index;
    })
    .map(item => item.message);
  const promptIndex = messages.findIndex(message =>
    message.info?.role === 'user'
    && (message.parts ?? []).some(part => part.type === 'text' && typeof part.text === 'string' && part.text.includes(marker))
  );
  if (promptIndex < 0) return { matchedPrompt: false };
  const promptMessage = messages[promptIndex];
  if (!promptMessage) return { matchedPrompt: false };
  const promptId = promptMessage.info?.id;
  // Prefer OpenCode's explicit parent relationship. This remains correct even
  // when several prompts are queued before the first Assistant response arrives.
  const linkedAssistant = promptId
    ? messages.find(message => message.info?.role === 'assistant' && message.info?.parentID === promptId)
    : undefined;
  if (linkedAssistant) return { matchedPrompt: true, assistant: linkedAssistant };

  // Compatibility fallback for API payloads without parentID: a later user
  // message starts another request, so never cross that boundary.
  const nextUserOffset = messages.slice(promptIndex + 1).findIndex(message => message.info?.role === 'user');
  const endIndex = nextUserOffset < 0 ? messages.length : promptIndex + 1 + nextUserOffset;
  const assistants = messages.slice(promptIndex + 1, endIndex).filter(message => message.info?.role === 'assistant');
  const assistant = assistants.at(-1);
  return assistant ? { matchedPrompt: true, assistant } : { matchedPrompt: true };
}

export interface SseEvent { name: string; data: string }

/**
 * Incremental SSE parser: feed decoded chunks, get complete events. Retained
 * for consumers of the legacy board event stream; the engine itself now
 * subscribes to the Store EventBus directly.
 */
export function makeSseParser(onEvent: (name: string, data: string) => void): { push: (chunk: string) => void } {
  let buf = '';
  return {
    push(chunk: string): void {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let name = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length) onEvent(name, dataLines.join('\n'));
      }
    }
  };
}

export interface WakePayload { type?: unknown; payload?: { body?: unknown; status?: unknown } }

/**
 * Only fresh pending comments starting with the prefix wake the agent, on
 * either comment.created (new comment) or comment.updated (saved edit re-queues
 * an edited pending comment).
 */
export function shouldWake(evt: WakePayload, prefix: string): boolean {
  if (evt.type !== 'comment.created' && evt.type !== 'comment.updated') return false;
  const { status, body } = evt.payload ?? {};
  if (status !== undefined && status !== 'pending') return false;
  return typeof body === 'string' && isWakeComment(body, prefix);
}

/**
 * TUI channel for unbound tasks: the project's persisted wake channel wins,
 * then the watch --tui-url fallback. Bound sessions never use this channel;
 * they go to the original Session API instead.
 */
export function channelFor(projectChannel: string | null, fallback: string | undefined): string | undefined {
  const normalize = (value: string): string => value.trim().replace(/\/+$/, '');
  const bound = projectChannel && projectChannel.trim() !== '' ? normalize(projectChannel) : undefined;
  return bound ?? (fallback ? normalize(fallback) : undefined);
}

/**
 * Project routing: optional scope filter (--project). An unresolved project
 * (null) never wakes — better to miss than to inject into another project's
 * pipeline. projectId is resolved by the caller on demand.
 */
export function wantsProject(filter: string | undefined, projectId: string | null): boolean {
  return !filter || projectId === filter;
}

/**
 * Self-wake guard: an agent that writes an `@agent`-prefixed comment must not
 * re-wake itself in a loop. Actor names are compared case-insensitively; the
 * sidecar's own actor is always implicit, extra names come from
 * `--ignore-author a,b`.
 */
export function isIgnoredAuthor(author: string | undefined, ignore: ReadonlySet<string>): boolean {
  return typeof author === 'string' && ignore.has(author.trim().toLowerCase());
}

export function buildWakePrompt(issueId: string, issueTitle: string, instruction: string): string {
  return `#${issueId} ${issueTitle}\n`
    + '[看板唤醒] 主进程忙时先收尾手头任务，再处理本条；勿中断进行中的工作。\n'
    + '收尾：处理完把本次唤醒评论置为 processed（MCP update_comment status=processed），否则面板会一直显示「唤醒中」。\n'
    + `指令：${instruction}`;
}

/**
 * The startup sweep and the live event stream share one dedupe key.
 *
 * Keyed by comment id, not body: two different wake comments can carry the
 * exact same instruction text, and keying on the body silently swallowed the
 * second one (it looked "already processed").
 */
export function wakeKey(issueId: string, commentId: string): string {
  return `${issueId}:${commentId}`;
}

interface CommentLike { id: string; body: string; status?: string; createdAt: string; author?: string }
export interface IssueDetailLike { id: string; title: string; comments: CommentLike[] }

/**
 * Legacy HTTP backfill filter, retained as a pure helper for tests and any
 * future polling path. The engine's startup sweep now queries pending comments
 * directly instead of walking project → issue → detail.
 */
export function missedWakes(
  issues: ReadonlyArray<IssueDetailLike>,
  sinceMs: number,
  prefix: string,
  seen: ReadonlySet<string>,
  ignore: ReadonlySet<string> = new Set(),
): Array<{ issueId: string; commentId: string; issueTitle: string; instruction: string; key: string }> {
  const out: { issueId: string; commentId: string; issueTitle: string; instruction: string; key: string }[] = [];
  for (const it of issues) {
    for (const c of it.comments) {
      if (Date.parse(c.createdAt) <= sinceMs) continue;
      if (c.status !== undefined && c.status !== 'pending') continue;
      if (isIgnoredAuthor(c.author, ignore)) continue;
      if (!isWakeComment(c.body, prefix)) continue;
      const key = wakeKey(it.id, c.id);
      if (seen.has(key)) continue;
      out.push({ issueId: it.id, commentId: c.id, issueTitle: it.title, instruction: c.body.trimStart().slice(prefix.length).trim(), key });
    }
  }
  return out;
}

/**
 * A task bound to an opencode session (and a reachable opencode server)
 * wakes via session prompt injection — same conversation, TUI-visible.
 * Everything else falls back to the headless spawn.
 */
export function decideWake(sessionId: string | null | undefined, opencodeBase: string | undefined | null): 'prompt' | 'spawn' {
  return Boolean(sessionId) && Boolean(opencodeBase) ? 'prompt' : 'spawn';
}
