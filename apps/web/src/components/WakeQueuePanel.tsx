import { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { api_, ApiError } from '../api';

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
  viewState: string;
  sessionProtected: boolean;
  waitReason: string | null;
}

interface QueueData {
  revision: number;
  counts: Record<string, number>;
  items: QueueItem[];
  nextCursor: string | null;
  stale: boolean;
}

const COUNT_LABELS: [string, string][] = [
  ['pending', '待调度'],
  ['readyByTime', '到期候选'],
  ['delayed', '延迟/等待'],
  ['processing', '执行中'],
  ['manual', '需人工'],
];

// §7.2: 状态文案全部来自后端持久化证据（viewState），无证据不伪装成功
const VIEW_STATE_LABELS: Record<string, string> = {
  queued: '排队中',
  preparing: '准备派发',
  'sent-waiting': '已派发·等待结果',
  running: '执行中',
  'tui-waiting': '等待人工提交',
  verifying: '等待核验',
  manual: '需人工处理',
  done: '已完成',
};

const WAIT_REASON_LABELS: Record<string, string> = {
  'waiting-not-before': '冷却中',
  'session-protected': '会话被其他投递占用',
  'waiting-human-submit': '等待人工提交',
  verifying: '等待核验',
  'needs-human': '需人工处理',
};

type Tab = 'queued' | 'inflight' | 'manual';
const TAB_VIEW_STATES: Record<Tab, string[]> = {
  queued: ['queued'],
  inflight: ['preparing', 'sent-waiting', 'running', 'tui-waiting', 'verifying'],
  manual: ['manual'],
};

export function WakeQueuePanel({ open, onClose, onOpenIssue }: {
  open: boolean;
  onClose: () => void;
  onOpenIssue: (issueId: string) => void;
}) {
  const [data, setData] = useState<QueueData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('queued');
  const [busyId, setBusyId] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);

  const tabToView = (t: Tab): 'queued' | 'processing' | 'manual' =>
    t === 'queued' ? 'queued' : t === 'inflight' ? 'processing' : 'manual';

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const d = await api_.wakeQueue({ limit: 50, view: tabToView(tab) });
      cursorRef.current = d.nextCursor;
      setData(d);
    } catch {
      setError('加载失败');
    }
  }, [tab]);

  // §10: 打开期间 20s 轮询兜底——SSE 事件丢失时仍能刷新，且轮询只拉快照、
  // 不触发任何调度行为。
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 20_000);
    return () => clearInterval(timer);
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

  // §11: cursor 过期（409 STALE_QUEUE_CURSOR）→ 清 cursor 重载第一页，仅一次
  const loadMore = async () => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    try {
      setError(null);
      const d = await api_.wakeQueue({ limit: 50, view: tabToView(tab), cursor });
      cursorRef.current = d.nextCursor;
      setData(prev => {
        if (!prev) return d;
        const seen = new Set(prev.items.map(i => i.commentId));
        return { ...d, items: [...prev.items, ...d.items.filter(i => !seen.has(i.commentId))] };
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        cursorRef.current = null;
        await refresh();
        return;
      }
      setError('加载更多失败');
    }
  };

  if (!open) return null;

  const items = data?.items ?? [];

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
        {([['queued', '待调度'], ['inflight', '已领取/执行中'], ['manual', '需人工']] as const).map(([v, label]) => (
          <button key={v} className={`wake-queue-tab${tab === v ? ' on' : ''}`} onClick={() => { cursorRef.current = null; setTab(v); void refresh(); }}>{label}</button>
        ))}
        <button className="icon-btn wake-queue-refresh" title="刷新" onClick={() => void refresh()}>
          <RefreshCw size={14} />
        </button>
      </div>
      {error && <p className="wake-queue-error">{error}</p>}
      <ul className="wake-queue-list">
        {items.length === 0 && <li className="wake-queue-empty">暂无队列项</li>}
        {items.map(item => {
          const stateLabel = VIEW_STATE_LABELS[item.viewState] ?? '状态未知';
          const waitLabel = item.waitReason ? WAIT_REASON_LABELS[item.waitReason] ?? null : null;
          return (
            <li key={item.commentId} className="wake-queue-item">
              <div className="wake-queue-item-head">
                {item.queuePriority === 1 && <span className="wake-queue-pri">优先</span>}
                <span className="wake-queue-state" data-state={item.viewState}>{stateLabel}</span>
                <button className="wake-queue-issue-link" onClick={() => onOpenIssue(item.issueId)}>
                  {item.issueTitle}
                </button>
              </div>
              <p className="wake-queue-body">{item.bodyPreview}</p>
              <div className="wake-queue-meta">
                <span>attempts {item.attempts}</span>
                {item.notBefore && <span>冷却至 {new Date(item.notBefore).toLocaleTimeString()}</span>}
                {item.sessionProtected && <span className="wake-queue-protected" title="该评论轮次持有会话保护租约">🛡 已保护</span>}
                {waitLabel && <span className="wake-queue-wait" title={waitLabel}>{waitLabel}</span>}
                {item.lastError && <span className="wake-queue-err" title={item.lastError}>⚠</span>}
              </div>
              {item.viewState === 'queued' && !item.sessionProtected && (
                <button className="btn tiny" disabled={busyId === item.commentId}
                  onClick={() => void togglePriority(item)}>
                  {item.queuePriority === 1 ? '恢复普通顺序' : '优先执行'}
                </button>
              )}
            </li>
          );
        })}
        {data?.nextCursor && items.length > 0 && (
          <li className="wake-queue-more">
            <button className="btn tiny" onClick={() => void loadMore()}>加载更多</button>
          </li>
        )}
      </ul>
    </aside>
  );
}
