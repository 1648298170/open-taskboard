// 时间显示纯函数：ISO（UTC）→ 本地时区文案。面板所有时间显示必须经此
// 转换，禁止直接 slice ISO 字符串（那会显示 UTC，与用户时区差 N 小时）。

const pad = (n: number): string => String(n).padStart(2, '0');

/** ISO → 本地「MM-DD HH:mm」（活动/附件时间线用）。非法输入原样返回。 */
export function fmtWhenLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO → 本地「HH:mm」（租约截止时刻用）。非法输入原样返回。 */
export function fmtHMLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
