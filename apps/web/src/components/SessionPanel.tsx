// 内嵌 OpenCode 会话面板：把会话页以 iframe 嵌在看板右侧。
// 容器是我们自己的文档，所以「已开则聚焦、未开则打开」退化为纯粹的
// 显示/隐藏与 src 切换——完全不依赖浏览器命名窗口（对第三方 SPA 不可靠）。

import { X, ExternalLink } from 'lucide-react';

export function SessionPanel({ url, title, hidden, onClose }: {
  url: string;
  title: string;
  /** 任务抽屉打开时隐藏面板（iframe 保持运行，抽屉关闭即恢复）。 */
  hidden?: boolean;
  onClose: () => void;
}) {
  return (
    <aside className={hidden ? 'session-panel is-hidden' : 'session-panel'} aria-label="OpenCode 会话" aria-hidden={hidden || undefined}>
      <div className="session-panel-head">
        <span className="session-panel-title" title={title}>{title}</span>
        <div className="session-panel-actions">
          <a className="icon-btn" href={url} target="_blank" rel="noreferrer" title="在新标签打开">
            <ExternalLink size={14} />
          </a>
          <button className="icon-btn" onClick={onClose} title="关闭会话面板"><X size={16} /></button>
        </div>
      </div>
      <iframe
        className="session-panel-frame"
        src={url}
        title={title}
        // 会话页是长驻应用；iframe 不加 sandbox（OpenCode UI 需要完整能力）。
      />
    </aside>
  );
}
