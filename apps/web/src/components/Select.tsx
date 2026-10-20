// 自定义下拉（listbox）：原生 <select> 关闭态难定制、展开列表是 OS 原生
// 样式，暗色主题下割裂。floating-ui 定位（bottom-start + flip + shift），
// 键盘 ↑↓/Enter/Esc 导航，点击外部关闭。受控组件。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computePosition, flip, shift } from '@floating-ui/dom';

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({ value, options, onChange, placeholder, title, ariaLabel, emptyText }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** value 不在 options 中时触发按钮的文案（如「＋ 添加依赖…」）。 */
  placeholder?: string;
  title?: string;
  ariaLabel?: string;
  /** 无选项且面板展开时显示的提示（如「当前没有会话」）。 */
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const current = options.find(o => o.value === value);
  const label = current?.label ?? placeholder ?? value;

  const openPanel = (): void => {
    setHi(Math.max(0, options.findIndex(o => o.value === value)));
    setOpen(true);
  };
  const choose = (v: string): void => {
    setOpen(false);
    onChange(v);
  };

  useLayoutEffect(() => {
    if (!open || !btnRef.current || !panelRef.current) return;
    void computePosition(btnRef.current, panelRef.current, {
      placement: 'bottom-start', strategy: 'fixed', middleware: [flip(), shift()]
    }).then(({ x, y }) => {
      if (panelRef.current) {
        panelRef.current.style.left = `${x}px`;
        panelRef.current.style.top = `${y}px`;
      }
    });
  }, [open]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 高亮项滚入可视区
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector('.hi')?.scrollIntoView({ block: 'nearest' });
  }, [open, hi]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(options.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setHi(0); }
    else if (e.key === 'End') { e.preventDefault(); setHi(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[hi];
      if (opt) choose(opt.value);
    }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <>
      <button ref={btnRef} type="button" className="tb-select" title={title} aria-label={ariaLabel}
        aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={onKeyDown}>
        <span className="tb-select-value">{label}</span>
        <span className="tb-select-caret">▾</span>
      </button>
      {open && (
        <div ref={panelRef} className="tb-select-panel" role="listbox">
          {options.length === 0 && emptyText && (
            <div className="tb-select-empty">{emptyText}</div>
          )}
          {options.map((o, i) => (
            <div key={o.value} role="option" aria-selected={o.value === value}
              className={`tb-select-option${i === hi ? ' hi' : ''}${o.value === value ? ' selected' : ''}`}
              onMouseEnter={() => setHi(i)}
              // 阻止 label 的默认激活行为：Select 常被包在 <label> 里，否则点击选项后
              // label 会把点击转发给触发按钮，按钮在 open=false 的新闭包下又把面板打开。
              onClick={e => { e.preventDefault(); choose(o.value); }}>
              {o.label}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
