// Markdown rendering for descriptions and comments. marked parses;
// DOMPurify sanitizes — the sanitize call IS the "no raw HTML" boundary
// (raw HTML in the source never reaches the DOM unsanitized).
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(marked.parse(src, { async: false }) as string);
}
