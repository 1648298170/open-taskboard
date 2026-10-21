// 评论 @ 提及自动补全的纯逻辑（框架无关，node:test 可测）。

export interface MentionCandidate {
  value: string;
  label: string;
}

/** 光标处输入 @fragment 时命中的候选（fragment 为空 = 全部候选）。 */
export function mentionCandidatesFor(fragment: string, candidates: MentionCandidate[]): MentionCandidate[] {
  const q = fragment.toLowerCase();
  return candidates.filter(c =>
    c.value.replace(/^@/, '').toLowerCase().startsWith(q) ||
    c.label.replace(/^@/, '').toLowerCase().startsWith(q)
  );
}

/** 高亮索引循环移动（dir: 1=下 -1=上）。len=0 时原样返回。 */
export function nextHi(hi: number, len: number, dir: 1 | -1): number {
  if (len <= 0) return hi;
  return ((hi + dir) % len + len) % len;
}

/** 候选应用到输入框后的新值：触发条件保证了整个输入就是 @mention（允许首尾空白），替换后补空格。 */
export function applyMention(comment: string, candidateValue: string): string {
  return `${comment.trim().replace(/@[\w-]*$/, candidateValue)} `;
}

export interface MentionContext {
  /** @fragment 在原文中的起始下标。 */
  start: number;
  /** @ 后的片段（不含 @）。 */
  fragment: string;
}

/** 光标处检测 @fragment（任意位置）：@ 须位于文本开头、空白或标点之后，避免邮箱 a@b 误触。 */
export function detectMentionAt(text: string, caret: number): MentionContext | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const m = /@([\w-]*)$/.exec(before);
  if (!m) return null;
  const start = caret - m[0].length;
  if (start > 0 && /[\w@]/.test(before[start - 1])) return null;
  return { start, fragment: m[1] };
}

/** 在 start 处把 @fragment 替换为候选值（后补一个空格），返回新文本与新光标位置。 */
export function applyMentionAt(text: string, start: number, candidateValue: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(start).replace(/^@[\w-]*/, '');
  const inserted = `${candidateValue} `;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}
