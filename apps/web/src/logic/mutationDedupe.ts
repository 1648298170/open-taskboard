// 本地变更触发的主动刷新（onChanged/load）与服务端 SSE 广播触发的刷新
// 针对同一目标会在毫秒级内各跑一次。这个短窗口去重让「本地主动刷新」保留，
// 紧随其后的 SSE 重复被吞掉；窗口外的刷新一律正常执行。

/** 去重窗口（毫秒）。一次本地变更的 SSE 回声通常 < 100ms。 */
export const REFRESH_DEDUPE_MS = 300;

/** lastAt<=0 表示从未刷新过；同目标且距上次刷新不足窗口时返回 true（跳过）。 */
export function shouldSkipRefresh(lastAt: number, now: number, windowMs = REFRESH_DEDUPE_MS): boolean {
  return lastAt > 0 && now - lastAt >= 0 && now - lastAt < windowMs;
}
