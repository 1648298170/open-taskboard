// 应用内对话框（原生 <dialog> 封装，零依赖）：替代 confirm/prompt 原生弹窗
// ——自带焦点陷阱、ESC 关闭、可定制暗色样式。textContent 构建，用户数据
// 永不进 innerHTML。命令式 API：await confirmDialog({...}) → boolean。

export interface ConfirmOpts {
  title: string;
  /** 逐行正文（如整组移动的子任务清单）。textContent 渲染，防注入。 */
  lines?: string[];
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface PromptOpts {
  title: string;
  placeholder?: string;
  /** 预填值。 */
  value?: string;
}

let singleton: HTMLDialogElement | null = null;

function ensureDialog(): HTMLDialogElement {
  if (singleton?.isConnected) return singleton;
  const d = document.createElement('dialog');
  d.className = 'tb-dialog';
  document.body.appendChild(d);
  singleton = d;
  return d;
}

function field(parent: HTMLElement, tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}

export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  const d = ensureDialog();
  d.textContent = '';
  const form = document.createElement('form');
  form.method = 'dialog';
  field(form, 'h3', 'tb-dialog-title', o.title);
  if (o.lines?.length) {
    const box = field(form, 'div', 'tb-dialog-lines');
    for (const line of o.lines) field(box, 'div', 'tb-dialog-line', line);
  }
  const menu = field(form, 'menu', 'tb-dialog-menu') as HTMLElement;
  const cancel = field(menu, 'button', 'btn', o.cancelText ?? '取消') as HTMLButtonElement;
  cancel.type = 'submit';
  cancel.value = 'cancel';
  const ok = field(menu, 'button', `btn primary${o.danger ? ' danger' : ''}`, o.confirmText ?? '确定') as HTMLButtonElement;
  ok.type = 'submit';
  ok.value = 'ok';
  return new Promise(resolve => {
    d.onclose = () => resolve(d.returnValue === 'ok');
    d.showModal();
  });
}

export function promptDialog(o: PromptOpts): Promise<string | null> {
  const d = ensureDialog();
  d.textContent = '';
  const form = document.createElement('form');
  form.method = 'dialog';
  d.append(form);
  field(form, 'h3', 'tb-dialog-title', o.title);
  const input = field(form, 'input', 'tb-dialog-input') as HTMLInputElement;
  input.placeholder = o.placeholder ?? '';
  input.value = o.value ?? '';
  const menu = field(form, 'menu', 'tb-dialog-menu') as HTMLElement;
  const cancel = field(menu, 'button', 'btn', '取消') as HTMLButtonElement;
  cancel.type = 'submit';
  cancel.value = 'cancel';
  const ok = field(menu, 'button', 'btn primary', '确定') as HTMLButtonElement;
  ok.type = 'submit';
  ok.value = 'ok';
  return new Promise(resolve => {
    d.onclose = () => resolve(d.returnValue === 'ok' ? input.value.trim() || null : null);
    d.showModal();
    input.focus();
  });
}
