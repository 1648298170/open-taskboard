// Markdown rendering for descriptions and comments. marked parses;
// DOMPurify sanitizes — the sanitize call IS the "no raw HTML" boundary
// (raw HTML in the source never reaches the DOM unsanitized).
// T7-38: ```mermaid 代码块只读渲染 —— sanitize 之后才把 language-mermaid
// 代码块换成 div.mermaid（div 由代码块源文本创建，不携带未消毒 HTML），
// mermaid 动态 import（独立 chunk，不进主包），渲染失败回退原源码块。
import { useEffect, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Mermaid } from 'mermaid';

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(marked.parse(src, { async: false }) as string);
}

/** mermaid 单例：动态 import 使其落在独立 chunk；initialize 全 app 只跑一次
 *  （theme 按当下主题选，暗色兜底；重新初始化不做——只读渲染够用）。 */
let mermaidLoader: Promise<Mermaid> | null = null;
const loadMermaid = (): Promise<Mermaid> => {
  mermaidLoader ??= import('mermaid').then(m => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: document.documentElement.dataset.theme === 'light' ? 'default' : 'dark',
    });
    return m.default;
  });
  return mermaidLoader;
};

/** 描述/评论正文渲染器（T7-38）：sanitized markdown + mermaid 图表。
 *  非 mermaid 内容与 renderMarkdown 完全一致；图表块失败时原样保留源码。 */
export function Markdown({ src }: { src: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(src);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-mermaid'));
    if (blocks.length === 0) return;
    let stale = false; // src 快速切换时放弃本次遍历，避免污染新一轮 innerHTML
    void (async () => {
      let mermaid: Mermaid;
      try {
        mermaid = await loadMermaid();
      } catch {
        return; // chunk 加载失败：保持源码块（即回退形态）
      }
      for (const code of blocks) {
        if (stale) return;
        const pre = code.parentElement;
        if (!(pre instanceof HTMLPreElement)) continue;
        const diagram = document.createElement('div');
        diagram.className = 'mermaid';
        diagram.textContent = code.textContent ?? '';
        pre.replaceWith(diagram);
        try {
          await mermaid.run({ nodes: [diagram] }); // suppressErrors 默认 false：语法错误会 throw
        } catch {
          diagram.replaceWith(pre); // T7-38: 渲染失败回退源码块
        }
      }
    })();
    return () => { stale = true; };
  }, [html]);

  return <div ref={ref} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
