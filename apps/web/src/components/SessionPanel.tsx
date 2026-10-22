// 内嵌 OpenCode 会话面板：iframe 嵌在看板右侧停靠分栏。
// 宽度可拖拽调节（localStorage 记忆）；打开时先探测 opencode 可达性，
// 不可达时在面板内给出可见的容错提示（而不是白屏 iframe）。

import { useEffect, useRef, useState } from 'react';
import { X, ExternalLink, RotateCw, AlertTriangle } from 'lucide-react';

const WIDTH_KEY = 'session-panel-width';
const DEFAULT_WIDTH = '25vw';
const MIN_WIDTH_PX = 280;

function initialWidth(): string {
  try { return localStorage.getItem(WIDTH_KEY) || DEFAULT_WIDTH; }
  catch { return DEFAULT_WIDTH; }
}

export function SessionPanel({ url, title, hidden, onClose }: {
  url: string;
  title: string;
  /** 任务抽屉打开时隐藏面板（iframe 保持运行，抽屉关闭即恢复）。 */
  hidden?: boolean;
  onClose: () => void;
}) {
  const [width, setWidth] = useState<string>(initialWidth);
  const [probe, setProbe] = useState<'probing' | 'ok' | 'down'>('probing');
  const [probeNonce, setProbeNonce] = useState(0);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  // 宽度同步到 CSS 变量：停靠分栏的主列 margin 用同一个变量，保持并排不错位。
  useEffect(() => {
    document.documentElement.style.setProperty('--session-panel-w', width);
  }, [width]);

  // 可达性探测：no-cors fetch 能区分「网络不通」与「正常响应」（opaque 即可达）。
  useEffect(() => {
    let stale = false;
    setProbe('probing');
    const origin = new URL(url, window.location.href).origin;
    fetch(origin + '/global/health', { mode: 'no-cors', signal: AbortSignal.timeout(4000) })
      .then(() => { if (!stale) setProbe('ok'); })
      .catch(() => { if (!stale) setProbe('down'); });
    return () => { stale = true; };
  }, [url, probeNonce]);

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: panelRef.current?.getBoundingClientRect().width ?? 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const px = Math.min(
      Math.max(drag.startW + (drag.startX - e.clientX), MIN_WIDTH_PX),
      Math.floor(window.innerWidth * 0.9)
    );
    setWidth(`${px}px`);
  };
  const onHandleUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    try { localStorage.setItem(WIDTH_KEY, width); } catch { /* 私有模式下忽略 */ }
  };

  const newTab = (): void => { window.open(url, '_blank', 'noopener'); };

  return (
    <aside
      ref={panelRef}
      className={hidden ? 'session-panel is-hidden' : 'session-panel'}
      style={{ width }}
      aria-label="OpenCode 会话"
      aria-hidden={hidden || undefined}
    >
      <div className="session-resize-handle" onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp}
        title="拖拽调节宽度" />
      <div className="session-panel-head">
        <span className="session-panel-title" title={title}>{title}</span>
        <div className="session-panel-actions">
          <button className="icon-btn" title="重新加载会话页" onClick={() => setProbeNonce(n => n + 1)}><RotateCw size={14} /></button>
          <button className="icon-btn" title="在新窗口打开" onClick={newTab}><ExternalLink size={14} /></button>
          <button className="icon-btn" onClick={onClose} title="关闭会话面板"><X size={16} /></button>
        </div>
      </div>
      {probe === 'down' ? (
        <div className="session-panel-error">
          <AlertTriangle size={28} />
          <p><strong>OpenCode 服务不可达</strong></p>
          <p className="session-hint">目标 {new URL(url, window.location.href).origin} 无响应——服务可能已停止，或网络/防火墙不通。</p>
          <div className="session-panel-error-actions">
            <button className="btn tiny" onClick={() => setProbeNonce(n => n + 1)}>重试检测</button>
            <button className="btn tiny" onClick={newTab}>在新窗口打开</button>
          </div>
        </div>
      ) : (
        <>
          {probe === 'probing' && <p className="session-hint" style={{ padding: '8px 14px' }}>正在连接 OpenCode 服务…</p>}
          <iframe className="session-panel-frame" src={url} title={title} />
        </>
      )}
    </aside>
  );
}
