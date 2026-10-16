// T6-30: `taskboard search QUERY` — full-text search over the HTTP service
// (FTS trigram via /api/search). One title line per result, same first-line
// format as the show helper in issue.ts.
import { need, type Command } from './registry.js';
import type { IssueLike } from './issue.js';

export const searchCommand: Command = {
  summary: 'Full-text search issues (title/description/comments)',
  usage: 'search QUERY',
  // QUERY is a positional arg (not a --flag): cli.ts would read it as a sub
  // word, so dispatch on the bare command word and keep it in rest[].
  bare: true,
  async run(ctx) {
    const { api, rest } = ctx;
    // join so multi-word phrases work without quoting: `search login page`
    const query = rest.join(' ').trim();
    need(!!query, 'search QUERY');
    const results: IssueLike[] = await api('GET', `/api/search?q=${encodeURIComponent(query)}`);
    if (!results.length) { console.log('无匹配任务'); return; }
    for (const i of results) {
      console.log(`#${i.id} [${String(i.status).padEnd(11)}] (${String(i.priority).padEnd(6)}) ${i.title}`);
    }
  }
};
