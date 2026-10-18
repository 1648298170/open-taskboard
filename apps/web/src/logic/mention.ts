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
