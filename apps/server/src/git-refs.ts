// T2-8: scan a project workspace for git branches and worktrees.
// Injection-safe by construction: `git` is invoked via execFile with an
// argument vector — never a shell string. Every failure mode (dir missing,
// not a git repo, git not installed, timeout, odd output) collapses to empty
// arrays; this helper never throws.
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

export interface GitRefs {
  branches: string[];
  worktrees: { name: string; path: string }[];
}

/** T6-36: one-line commit summary (`git log --pretty=%h%x09%s%x09%ar`). */
export interface GitCommit {
  hash: string;
  subject: string;
  when: string;
}

const GIT_TIMEOUT_MS = 5000;

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function listBranches(cwd: string): Promise<string[]> {
  try {
    const out = await execGit(cwd, ['branch', '--format=%(refname:short)']);
    return out.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  } catch {
    return []; // not a repo / git missing / timeout — caller sees "no refs"
  }
}

// Porcelain format: one record per worktree, first line `worktree <path>`,
// then indented attributes (branch, bare, detached…). We only need the paths.
// The main checkout is itself a worktree entry — it stays included.
async function listWorktrees(cwd: string): Promise<GitRefs['worktrees']> {
  try {
    const out = await execGit(cwd, ['worktree', 'list', '--porcelain']);
    const worktrees: GitRefs['worktrees'] = [];
    for (const line of out.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const path = line.slice('worktree '.length).trim();
      if (!path) continue;
      // basename tolerating both / and \ (Windows paths from git are mixed)
      const segs = path.split(/[\\/]/).filter(s => s.length > 0);
      worktrees.push({ name: segs.length > 0 ? segs[segs.length - 1]! : path, path });
    }
    return worktrees;
  } catch {
    return [];
  }
}

export async function scanGitRefs(workspacePath: string): Promise<GitRefs> {
  if (!workspacePath) return { branches: [], worktrees: [] };
  try {
    if (!statSync(workspacePath).isDirectory()) return { branches: [], worktrees: [] };
  } catch {
    return { branches: [], worktrees: [] }; // doesn't exist / unreadable
  }
  const [branches, worktrees] = await Promise.all([listBranches(workspacePath), listWorktrees(workspacePath)]);
  return { branches, worktrees };
}

// T6-36: recent commits of a ref (or HEAD when ref empty), newest first.
// Same injection-safety contract as scanGitRefs: execFile argument vector,
// every failure collapses to []. A leading '-' is rejected so git can never
// mistake a caller-supplied ref for an option; trailing '--' keeps refs from
// being resolved as paths.
export async function listCommits(workspacePath: string, ref = '', limit = 5): Promise<GitCommit[]> {
  if (!workspacePath) return [];
  const trimmed = ref.trim();
  if (trimmed.startsWith('-')) return [];
  try {
    if (!statSync(workspacePath).isDirectory()) return [];
  } catch {
    return [];
  }
  const args = ['log', `-${limit}`, '--pretty=%h%x09%s%x09%ar', '--date-order'];
  if (trimmed) args.push(trimmed, '--');
  let out: string;
  try {
    out = await execGit(workspacePath, args);
  } catch {
    return []; // bad ref / git missing / timeout — caller sees "no commits"
  }
  const commits: GitCommit[] = [];
  for (const line of out.split('\n')) {
    // %h\t%s\t%ar — subject may itself contain tabs, so split ends only.
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const hash = parts[0]!.trim();
    const when = parts[parts.length - 1]!.trim();
    const subject = parts.slice(1, -1).join('\t').trim();
    if (hash && subject) commits.push({ hash, subject, when });
  }
  return commits;
}
