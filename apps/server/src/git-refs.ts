// T2-8: scan a project workspace for git branches and worktrees.
// Injection-safe by construction: `git` is invoked via execFile with an
// argument vector — never a shell string. Every failure mode (dir missing,
// not a git repo, git not installed, timeout, odd output) collapses to empty
// arrays; this helper never throws.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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

export class GitWorktreeError extends Error {
  constructor(message: string, readonly statusCode: 400 | 409 | 502 = 502) {
    super(message);
    this.name = 'GitWorktreeError';
  }
}

export interface CreatedTaskWorktree {
  branch: string;
  name: string;
  path: string;
}

/**
 * Create a dedicated branch/worktree for one task. The destination is a sibling
 * directory, never nested inside the project checkout. This function does not
 * delete pre-existing branches or directories on failure.
 */
export async function createTaskWorktree(
  workspacePath: string,
  projectId: string,
  issueId: string,
  title: string
): Promise<CreatedTaskWorktree> {
  if (!workspacePath.trim()) {
    throw new GitWorktreeError('项目尚未配置工作目录，无法创建 Worktree', 400);
  }
  let root: string;
  try {
    if (!statSync(workspacePath).isDirectory()) {
      throw new Error('not a directory');
    }
    root = resolve((await execGit(workspacePath, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    throw new GitWorktreeError('项目工作目录不可用或不是 Git 仓库；请检查 workspacePath 和 Git 安装', 400);
  }

  const safePart = (value: string): string =>
    value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'task';
  const slug = safePart(title).toLowerCase();
  const branch = `task/${safePart(issueId)}-${slug}`;
  const name = `${safePart(issueId)}-${slug}`;
  const parent = join(dirname(root), '.taskboard-worktrees', safePart(projectId));
  const path = resolve(join(parent, name));

  // Refuse collisions instead of reusing or overwriting a developer's work.
  const refs = await scanGitRefs(root);
  if (refs.branches.includes(branch)) {
    throw new GitWorktreeError(`分支已存在：${branch}。请在任务详情中手动绑定，或先确认该分支是否可复用`, 409);
  }
  if (refs.worktrees.some(item => resolve(item.path) === path) || existsSync(path)) {
    throw new GitWorktreeError(`Worktree 目标路径已存在：${path}。为保护已有文件，未执行覆盖`, 409);
  }

  try {
    mkdirSync(parent, { recursive: true });
  } catch (error) {
    throw new GitWorktreeError(`无法创建 Worktree 父目录：${(error as Error).message}`, 502);
  }
  try {
    await execGit(root, ['worktree', 'add', '-b', branch, path]);
  } catch (error) {
    const reason = (error as Error).message || String(error);
    throw new GitWorktreeError(
      `Git Worktree 创建失败：${reason}${existsSync(path) ? `；Git 可能留下部分目录，请检查 ${path}` : ''}`,
      502
    );
  }
  return { branch, name, path };
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
