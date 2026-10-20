// 父任务组合框：可手输 id / 标题，也可从当前项目的候选父任务里选。
// 候选过滤逻辑在 logic/parentTasks.ts（单一来源）；这里只负责输入、高亮、
// 键盘导航与 floating-ui 定位，视觉复用 .tb-select-panel/.tb-select-option。
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import type { Issue } from '../api';
import { filterParentCandidates, parentCandidates, parentLabel } from '../logic/parentTasks';

/** value 解析为候选任务：id（大小写不敏感）或显示文案精确匹配。 */
function resolveCandidate(issues: Issue[], value: string): Issue | undefined {
  if (!value) return undefined;
  const needle = value.trim().toLowerCase();
  if (!needle) return undefined;
  return parentCandidates(issues).find(issue =>
    issue.id.toLowerCase() === needle || parentLabel(issue).toLowerCase() === needle
  );
}

/** 输入框里展示的文本：能解析到候选就显示「标题（状态）」，否则原样显示 id。 */
function displayText(issues: Issue[], value: string): string {
  const hit = resolveCandidate(issues, value);
  return hit ? parentLabel(hit) : value;
}

export interface ParentComboboxProps {
  /** 候选来源：当前项目全量任务（过滤交给 filterParentCandidates）。 */
  issues: Issue[];
  /** 真正的父任务 id；'' = 顶层任务。 */
  value: string;
  onChange: (id: string) => void;
  /** 提交当前输入后触发（选择候选 / 失焦 / Enter 提交）。 */
  onCommit?: () => void;
  /** 变化时清空输入文本与高亮（对话框创建成功后递增）。 */
  resetSignal?: number | string;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}

export function ParentCombobox({
  issues,
  value,
  onChange,
  onCommit,
  resetSignal,
  disabled = false,
  placeholder = '输入或选择父任务 id',
  ariaLabel = '父任务'
}: ParentComboboxProps) {
  const [text, setText] = useState(() => displayText(issues, value));
  // query 与 text 分离：聚焦/展开时展示全部候选，只有真正输入才过滤——
  // 否则选中后 text 是「标题（状态）」，再展开会被自己的完整 label 过滤成空列表。
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const lastValue = useRef(value);
  const lastReset = useRef(resetSignal);

  const candidates = filterParentCandidates(issues, query);
  const hiSafe = Math.min(hi, Math.max(candidates.length - 1, 0));
  const activeId = open && candidates.length > 0 ? `${listId}-opt-${hiSafe}` : undefined;

  // 外部 value 变化（包括清空）时同步展示文本；不监听 issues，避免后台刷新
  // 把用户正在输入的草稿覆盖掉。
  useEffect(() => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    setText(displayText(issues, value));
    setQuery('');
  }, [value, issues]);

  // resetSignal 变化：清掉草稿与高亮（创建成功后对话框调用）。
  useEffect(() => {
    if (lastReset.current === resetSignal) return;
    lastReset.current = resetSignal;
    setText('');
    setQuery('');
    setHi(0);
    setOpen(false);
  }, [resetSignal]);

  useLayoutEffect(() => {
    if (!open || !inputRef.current || !panelRef.current) return;
    const reference = inputRef.current;
    const floating = panelRef.current;
    const update = (): void => {
      void computePosition(reference, floating, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [
          offset(4),
          flip(),
          shift({ padding: 8 }),
          size({
            apply({ rects, elements }) {
              elements.floating.style.width = `${rects.reference.width}px`;
            }
          })
        ]
      }).then(({ x, y }) => {
        if (!panelRef.current) return;
        panelRef.current.style.left = `${x}px`;
        panelRef.current.style.top = `${y}px`;
      });
    };
    update();
    return autoUpdate(reference, floating, update);
  }, [open]);

  // 点击外部关闭；输入框失焦时另行 commit 当前文本。
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (inputRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 高亮项滚入可视区。
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector('.hi')?.scrollIntoView({ block: 'nearest' });
  }, [open, hiSafe]);

  const openPanel = (): void => {
    if (disabled) return;
    // 展开时清空过滤词，并按当前 value 定位高亮项（找不到则第一条）。
    const list = filterParentCandidates(issues, '');
    const index = list.findIndex(issue => issue.id === value);
    setQuery('');
    setHi(index >= 0 ? index : 0);
    setOpen(true);
  };

  const commit = (): void => {
    const raw = text.trim();
    const hit = resolveCandidate(issues, raw);
    const next = hit ? hit.id : raw;
    setText(hit ? parentLabel(hit) : raw);
    if (next !== value) onChange(next);
    onCommit?.();
  };

  const choose = (issue: Issue): void => {
    setOpen(false);
    setQuery('');
    setText(parentLabel(issue));
    if (issue.id !== value) onChange(issue.id);
    onCommit?.();
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value;
    setText(next);
    setQuery(next);
    setHi(0);
    setOpen(true);
    if (!next.trim()) onChange('');
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    const count = candidates.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (count > 0) setHi(h => (Math.min(h, count - 1) + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (count > 0) setHi(h => (Math.min(h, count - 1) - 1 + count) % count);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHi(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHi(Math.max(0, count - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const option = candidates[hiSafe];
      if (option) {
        choose(option);
      } else {
        commit();
        setOpen(false);
        setQuery('');
      }
    } else if (e.key === 'Escape') {
      // 只关面板、回填当前 value 的展示文本；阻止冒泡以免顺带关掉对话框。
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery('');
      setText(displayText(issues, value));
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        className="tb-combobox-input"
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        onChange={onInputChange}
        onFocus={() => { if (!open) openPanel(); }}
        onClick={() => { if (!open) openPanel(); }}
        onKeyDown={onInputKeyDown}
        onBlur={() => { commit(); setOpen(false); setQuery(''); }}
      />
      {open && (
        <div
          ref={panelRef}
          id={listId}
          className="tb-select-panel tb-combobox-panel"
          role="listbox"
          aria-label={ariaLabel}
        >
          {candidates.length === 0 && (
            <div className="tb-select-empty">
              {query.trim() ? '没有匹配的父任务，回车直接使用原始 ID' : '当前项目没有可选的父任务'}
            </div>
          )}
          {candidates.map((issue, index) => (
            <div
              key={issue.id}
              id={`${listId}-opt-${index}`}
              role="option"
              aria-selected={issue.id === value}
              className={`tb-select-option tb-combobox-option${index === hiSafe ? ' hi' : ''}${issue.id === value ? ' selected' : ''}`}
              onMouseEnter={() => setHi(index)}
              // 阻止 mousedown 抢走输入框焦点：否则 blur 会先关面板，click 永远到不了选项。
              onMouseDown={e => e.preventDefault()}
              onClick={e => { e.preventDefault(); choose(issue); }}
            >
              <span className="tb-combobox-label">{parentLabel(issue)}</span>
              <span className="tb-combobox-id">{issue.id.slice(0, 8)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
