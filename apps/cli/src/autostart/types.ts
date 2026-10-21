// Shared contracts for OS autostart backends. Every filesystem/process side
// effect is injected through AutostartDeps so tests can exercise the templates
// and the register/unregister flows without touching a real user profile.
export type AutostartAgent = 'watch' | 'opencode';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (command: string, args: readonly string[]) => Promise<ExecResult>;

export interface AutostartDeps {
  writeFile(path: string, content: string): void;
  mkdir(path: string): void;
  deleteFile(path: string): void;
  exec: ExecFn;
  homedir(): string;
  /** Injected so the backend can be selected without reading the real host OS. */
  platform: NodeJS.Platform;
  /** Absolute Node binary captured at registration time (process.execPath). */
  nodeExecPath: string;
  /** process.versions.node; gated because --env-file-if-exists needs >= 22.9. */
  nodeVersion: string;
  /** Absolute path to the checkout containing apps/cli. */
  repoRoot: string;
  /** Current user id for launchctl gui/<uid>/<label>; unused on Windows. */
  uid: number;
  /** Environment snapshot used for APPDATA/LOCALAPPDATA/TASKBOARD_* defaults. */
  env: NodeJS.ProcessEnv;
  now(): Date;
}

/** Fully resolved values baked into the generated files. */
export interface SetupConfig {
  boardUrl: string;
  opencodeUrl: string;
  opencodePort: number;
  /** Resolved opencode launcher (absolute path when the lookup succeeds). */
  opencodeCommand: string;
  /** Absolute repo root; all generated paths derive from this. */
  repoRoot: string;
  /** Absolute Node binary; captured now so later PATH changes cannot break it. */
  nodeExecPath: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface AutostartStrategy {
  readonly platform: 'win32' | 'darwin';
  /** Pure template rendering — used by --print and by tests. */
  buildFiles(config: SetupConfig, deps: AutostartDeps): GeneratedFile[];
  /** Write files (and run the platform activation command, on macOS). */
  register(config: SetupConfig, deps: AutostartDeps): Promise<GeneratedFile[]>;
  /** Stop both sidecars and remove every generated file. Returns affected paths. */
  unregister(deps: AutostartDeps): Promise<string[]>;
  stopWatch(deps: AutostartDeps): Promise<void>;
  stopOpencode(deps: AutostartDeps): Promise<void>;
}

/** Windows cmd/vbs and launchd plists both need deterministic ASCII content. */
export const assertSupportedNode = (version: string): void => {
  const [majorRaw, minorRaw] = version.split('.');
  const major = Number.parseInt(majorRaw ?? '', 10);
  const minor = Number.parseInt(minorRaw ?? '', 10);
  if (Number.isInteger(major) && (major > 22 || (major === 22 && minor >= 9))) return;
  throw new Error(
    `setup: Node.js >= 22.9 is required for --env-file-if-exists (found ${version}); `
    + 'upgrade Node and re-run setup'
  );
};

/** Escape text for XML plist nodes (paths may contain & or <). */
export const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Best-effort process command: stopping an already-dead process must not throw. */
export const runQuietly = async (
  deps: AutostartDeps,
  command: string,
  args: readonly string[]
): Promise<ExecResult> => {
  try {
    return await deps.exec(command, args);
  } catch {
    return { code: 1, stdout: '', stderr: '' };
  }
};
