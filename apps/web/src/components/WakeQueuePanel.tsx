import { useEffect, useState, useCallback } from 'react';
import { ListOrdered, RefreshCw, X, Zap, RotateCcw } from 'lucide-react';
import { api_ } from '../api';

interface QueueItem {
  commentId: string;
  issueId: string;
  issueTitle: string;
  projectId: string;
  bodyPreview: string;
  status: string;
  queuePriority: number;
  priorityAt: string | null;
  queuedAt: string | null;
  notBefore: string | null;
  attempts: number;
  lastError: string;
  queueState: string;
  sessionProtected: boolean;
}

interface QueueData {
  generatedAt: string;
  queueRevision: number;
  counts: Record<string, number>;
  items: QueueItem[];
}

const COUNT_LABELS: [string, string][] = [
  ['pending', '待调度'],
  ['readyByTime', '到期候选'],
  ['delayed', '延迟/等待'],
  ['processing', '执行中'],
  ['manual', '需人工'],
];

export function WakeQueuePanel({ open, onClose, onOpenIssue }: {
  open: boolean;
  onClose: () => void;
  onOpenIssue: (issueId: string) => void;
}) {
  const [data, setData] = useState<QueueData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'queued' | 'processing' | 'manual'>('queued');
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const d = await api_.wakeQueue();
      setData(d);
    } catch {
      setError('加载失败');
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  const togglePriority = async (item: QueueItem) => {
    setBusyId(item.commentId);
    try {
      const target = item.queuePriority === 1 ? 0 : 1;
      const expected = item.queuePriority;
      await api_.setWakePriority(item.commentId, target, expected);
      await refresh();
    } catch {
      setError('队列状态已变化，请重试');
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  if (!open) return null;

  const items = (data?.items ?? []).filter(i =>
    tab === 'queued' ? i.queueState === 'ready' || i.queueState === 'delayed'
    : tab === 'processing' ? i.queueState === 'processing'
    : i.queueState === 'manual'
  );

  return (
    <aside className="wake-queue-panel" role="complementary" aria-label="唤醒队列">
      <div className="wake-queue-head">
        <span className="wake-queue-title">唤醒队列</span>
        <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
      </div>
      <div className="wake-queue-counts">
        {COUNT_LABELS.map(([key, label]) => (
          <span key={key} className="wake-queue-count">
            {label} <strong>{data ? (data.counts[key] ?? '—') : '—'}</strong>
          </span>
        ))}
      </div>
      <div className="wake-queue-tabs">
        {([['queued', '待调度'], ['processing', '已领取'], ['manual', '需人工']] as const).map(([v, label]) => (
          <button key={v} className={`wake-queue-tab${tab === v ? ' on' : ''}`} onClick={() => setTab(v)}>{label}</button>
        ))}
        <button className="icon-btn wake-queue-refresh" title="刷新" onClick={() => void refresh()}>
          <RefreshCw size={14} />
        </button>
      </div>
      {error && <p className="wake-queue-error">{error}</p>}
      <ul className="wake-queue-list">
        {items.length === 0 && <li className="wake-queue-empty">暂无队列项</li>}
        {items.map(item => (
          <li key={item.commentId} className="wake-queue-item">
            <div className="wake-queue-item-head">
              {item.queuePriority === 1 && <span className="wake-queue-pri">优先</span>}
              <button className="wake-queue-issue-link" onClick={() => onOpenIssue(item.issueId)}>
                {item.issueTitle}
              </button>
            </div>
            <p className="wake-queue-body">{item.bodyPreview}</p>
            <div className="wake-queue-meta">
              <span>attempts {item.attempts}</span>
              {item.notBefore && <span>冷却至 {new Date(item.notBefore).toLocaleTimeString()}</span>}
              {item.lastError && <span className="wake-queue-err" title={item.lastError}>⚠</span>}
            </div>
            {(item.queueState === 'ready' || item.queueState === 'delayed') && !item.sessionProtected && (
              <button className="btn tiny" disabled={busyId === item.commentId}
                onClick={() => void togglePriority(item)}>
                {item.queuePriority === 1 ? '恢复普通顺序' : '优先执行'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
