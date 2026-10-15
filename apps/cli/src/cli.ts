#!/usr/bin/env node
// taskctl-style CLI for opencode-taskboard. Talks to the HTTP service.
import { startServer } from '@taskboard/server';

const URL_ENV = 'TASKBOARD_URL';
const base = (): string => process.env[URL_ENV] || `http://127.0.0.1:${process.env.TASKBOARD_PORT || 47824}`;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base() + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`error: ${(data as { error?: string }).error ?? res.status}`); process.exit(1); }
  return data;
}

interface Flags { [k: string]: string | boolean }
function parseFlags(args: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = {}; const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else rest.push(arg);
  }
  return { flags, rest };
}

interface IssueLike {
  id: string; projectId: string; parentId: string | null; title: string;
  status: string; priority: string; labels: string; branch: string;
  assignee: string; version: number; description: string;
  children?: IssueLike[]; comments?: { author: string; body: string }[];
}

const show = (i: IssueLike): void => {
  console.log(`#${i.id} [${i.status}] (${i.priority}) ${i.title}`);
  console.log(`  project: ${i.projectId}  parent: ${i.parentId ?? '-'}  branch: ${i.branch || '-'}  assignee: ${i.assignee || '-'}  labels: ${i.labels || '-'}  v${i.version}`);
  if (i.description) console.log(`\n${i.description}`);
};

const HELP = `
opencode-taskboard CLI

  taskboard serve [--host H] [--port P] [--data-dir D]   start the board + API
  taskboard project create --id ID --name NAME [--workspace-path PATH]
  taskboard project list
  taskboard project delete ID [--yes]
  taskboard issue create --project ID --title T [--parent PARENT_ID]
        [--status todo|in_progress|in_review|done] [--priority urgent|high|medium|low]
        [--labels a,b] [--branch BRANCH] [--assignee WHO] [--description TEXT]
  taskboard issue list --project ID [--status S] [--parent ID|null]
  taskboard issue show ID
  taskboard issue update ID [--title T] [--status S] [--priority P] [--branch B]
        [--labels L] [--assignee W] [--description TEXT] [--expected-version N]
  taskboard issue done ID [--expected-version N]
  taskboard issue delete ID
  taskboard comment add ID [--author WHO] [--body TEXT]
  taskboard comment list ID
  taskboard progress --project ID

Env: ${URL_ENV} to point at another host (e.g. LAN teammate's board).
`;

async function main(): Promise<void> {
  let [cmd, sub, ...args] = process.argv.slice(2);
  if (sub && sub.startsWith('--')) { args.unshift(sub); sub = undefined; }
  const { flags, rest } = parseFlags(args);

  if (!cmd || cmd === 'help' || flags.help) { console.log(HELP); return; }

  if (cmd === 'serve') {
    const { url } = await startServer({
      host: String(flags.host ?? '127.0.0.1'),
      port: Number(flags.port ?? 47824),
      dataDir: String(flags['data-dir'] ?? '.data')
    });
    console.log(`opencode-taskboard listening on ${url}`);
    return;
  }

  const need = (cond: boolean, usage: string): void => {
    if (!cond) { console.error(`usage: ${usage}`); process.exit(1); }
  };

  switch (`${cmd} ${sub ?? ''}`.trim()) {
    case 'project create': {
      need(!!flags.name, 'project create --name NAME [--id ID]');
      const p = await api('POST', '/api/projects', { id: flags.id, name: flags.name, workspacePath: flags['workspace-path'] ?? '' });
      console.log(`created project ${p.id} (${p.name})`);
      break;
    }
    case 'project list': {
      for (const p of await api('GET', '/api/projects')) console.log(`${p.id}  ${p.name}  ${p.workspacePath}`);
      break;
    }
    case 'project delete': {
      need(!!rest[0], 'project delete ID [--yes]');
      if (!flags.yes && !process.stdin.isTTY) { console.error('refusing to delete without confirmation: use --yes'); process.exit(1); }
      if (!flags.yes) {
        process.stderr.write(`delete project "${rest[0]}" and all its issues/comments? [y/N] `);
        const answer = await new Promise<string>(r => process.stdin.once('data', d => r(String(d).trim())));
        if (!/^y(es)?$/i.test(answer)) { console.log('aborted'); return; }
      }
      await api('DELETE', `/api/projects/${rest[0]}`);
      console.log(`deleted project ${rest[0]}`);
      break;
    }
    case 'issue create': {
      need(!!flags.project && !!flags.title, 'issue create --project ID --title T [--parent ID]');
      const i = await api('POST', `/api/projects/${flags.project}/issues`, {
        parentId: flags.parent ?? null, title: flags.title,
        description: flags.description ?? '', status: flags.status ?? 'todo',
        priority: flags.priority ?? 'medium', labels: flags.labels ?? '',
        branch: flags.branch ?? '', assignee: flags.assignee ?? ''
      });
      console.log(`created #${i.id} [${i.status}] ${i.title}`);
      break;
    }
    case 'issue list': {
      need(!!flags.project, 'issue list --project ID');
      const qs = new URLSearchParams();
      if (flags.status) qs.set('status', String(flags.status));
      if (flags.parent) qs.set('parentId', String(flags.parent));
      for (const i of await api('GET', `/api/projects/${flags.project}/issues?${qs}`)) {
        console.log(`#${i.id} [${String(i.status).padEnd(11)}] (${String(i.priority).padEnd(6)}) ${i.parentId ? '  └ ' : ''}${i.title}${i.branch ? `  ⟂ ${i.branch}` : ''}`);
      }
      break;
    }
    case 'issue show': {
      need(!!rest[0], 'issue show ID');
      const i: IssueLike = await api('GET', `/api/issues/${rest[0]}`);
      show(i);
      if (i.children?.length) { console.log('\nchildren:'); i.children.forEach(c => console.log(`  #${c.id} [${c.status}] ${c.title}`)); }
      if (i.comments?.length) { console.log('\ncomments:'); i.comments.forEach(c => console.log(`  ${c.author || 'anon'}: ${c.body}`)); }
      break;
    }
    case 'issue update':
    case 'issue done': {
      need(!!rest[0], `${cmd} ${sub} ID [flags]`);
      const body: Record<string, unknown> = sub === 'done'
        ? { status: 'done' }
        : Object.fromEntries(['title', 'status', 'priority', 'branch', 'labels', 'assignee', 'description']
          .filter(k => flags[k] !== undefined).map(k => [k, flags[k]]));
      if (flags['expected-version'] !== undefined) body.version = Number(flags['expected-version']);
      const i = await api('PATCH', `/api/issues/${rest[0]}`, body);
      console.log(`#${i.id} ${sub === 'done' ? '→ done' : 'updated'} (v${i.version})`);
      break;
    }
    case 'issue delete': {
      need(!!rest[0], 'issue delete ID');
      await api('DELETE', `/api/issues/${rest[0]}`);
      console.log(`deleted #${rest[0]}`);
      break;
    }
    case 'comment add': {
      need(!!rest[0] && !!flags.body, 'comment add ID --body TEXT');
      const c = await api('POST', `/api/issues/${rest[0]}/comments`, { author: flags.author ?? 'cli', body: flags.body });
      console.log(`comment ${c.id} added`);
      break;
    }
    case 'comment list': {
      need(!!rest[0], 'comment list ID');
      for (const c of await api('GET', `/api/issues/${rest[0]}/comments`)) console.log(`${c.createdAt} ${c.author}: ${c.body}`);
      break;
    }
    case 'progress': {
      need(!!flags.project, 'progress --project ID');
      const pr = await api('GET', `/api/projects/${flags.project}/progress`);
      console.log(`issues: ${pr.done}/${pr.total} done | top-level: ${pr.topDone}/${pr.topTotal} | weighted(父任务等权): ${pr.weightedDone}/${pr.weightedTotal}`);
      break;
    }
    default:
      console.error(`unknown command: ${cmd} ${sub ?? ''}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
