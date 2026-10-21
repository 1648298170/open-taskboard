import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync
} from 'node:fs';
import { join } from 'node:path';

const COOKIE_NAME = 'taskboard_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const HASH_BYTES = 64;
// Sliding-expiry bumps happen on every request; flush them to disk at most
// once per minute so a restart loses at most one minute of sliding time.
const SESSION_PERSIST_THROTTLE_MS = 60 * 1000;

interface AdminRecord {
  version: 1;
  username: string;
  salt: string;
  passwordHash: string;
  createdAt: string;
}

interface SessionRecord {
  username: string;
  expiresAt: number;
}

interface SessionFile {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

interface LoginAttemptRecord {
  windowStartedAt: number;
  count: number;
}

export class AuthError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, HASH_BYTES, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Single-admin browser auth. Credentials and sessions persist in /data, so a
 * server restart no longer invalidates browser sessions (expired ones are
 * dropped on load). Session tokens are stored 0600 next to the credentials
 * file; losing that file equals logging every browser out. */
export class BrowserAuth {
  private readonly filePath: string;
  private readonly sessionsFilePath: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly loginAttempts = new Map<string, LoginAttemptRecord>();
  private lastSessionsPersistAt = 0;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filePath = join(dataDir, 'taskboard-auth.json');
    this.sessionsFilePath = join(dataDir, 'taskboard-sessions.json');
    this.loadSessions();
  }

  private loadSessions(): void {
    if (!existsSync(this.sessionsFilePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.sessionsFilePath, 'utf8')) as Partial<SessionFile>;
      if (parsed.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
        throw new Error('invalid shape');
      }
      const now = Date.now();
      for (const [token, record] of Object.entries(parsed.sessions)) {
        if (typeof token !== 'string' || typeof record?.username !== 'string'
          || typeof record?.expiresAt !== 'number') continue;
        if (record.expiresAt <= now) continue;
        this.sessions.set(token, { username: record.username, expiresAt: record.expiresAt });
      }
    } catch {
      // A corrupt sessions file must never brick the board: start clean and
      // the next login rewrites it.
      this.sessions.clear();
    }
  }

  private persistSessions(): void {
    const payload: SessionFile = { version: 1, sessions: Object.fromEntries(this.sessions) };
    const tmp = `${this.sessionsFilePath}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(payload, null, 2), undefined, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.sessionsFilePath);
    this.lastSessionsPersistAt = Date.now();
  }

  private persistSessionsThrottled(): void {
    if (Date.now() - this.lastSessionsPersistAt < SESSION_PERSIST_THROTTLE_MS) return;
    this.persistSessions();
  }

  get initialized(): boolean {
    return existsSync(this.filePath);
  }

  private readAdmin(): AdminRecord | null {
    if (!existsSync(this.filePath)) return null;
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<AdminRecord>;
    if (parsed.version !== 1 || typeof parsed.username !== 'string'
      || typeof parsed.salt !== 'string' || typeof parsed.passwordHash !== 'string') {
      throw new Error('Taskboard auth file is invalid; refusing to bypass authentication');
    }
    return parsed as AdminRecord;
  }

  private startSession(username: string): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
    this.persistSessions();
    return token;
  }

  async initialize(usernameInput: string, password: string): Promise<{ username: string; sessionToken: string }> {
    if (this.initialized) throw new AuthError(409, '管理员账号已初始化，请直接登录');
    const username = usernameInput.trim();
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
      throw new AuthError(400, '用户名需为 3–64 位字母、数字、点、下划线或连字符');
    }
    if (password.length < 12 || password.length > 256) {
      throw new AuthError(400, '密码长度必须为 12–256 个字符');
    }

    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await derivePassword(password, salt)).toString('hex');
    const record: AdminRecord = {
      version: 1,
      username,
      salt,
      passwordHash,
      createdAt: new Date().toISOString()
    };

    // 'wx' makes first-admin creation atomic: concurrent setup requests cannot
    // overwrite the account created by the winner.
    let fd: number;
    try {
      fd = openSync(this.filePath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AuthError(409, '管理员账号已初始化，请直接登录');
      }
      throw error;
    }
    try {
      writeSync(fd, JSON.stringify(record, null, 2), undefined, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    this.loginAttempts.clear();
    return { username, sessionToken: this.startSession(username) };
  }

  private assertLoginAllowed(ip: string): void {
    const now = Date.now();
    const record = this.loginAttempts.get(ip);
    if (record && now - record.windowStartedAt < LOGIN_WINDOW_MS && record.count >= MAX_LOGIN_ATTEMPTS) {
      throw new AuthError(429, '登录尝试次数过多，请 15 分钟后再试');
    }
    if (!record || now - record.windowStartedAt >= LOGIN_WINDOW_MS) {
      this.loginAttempts.set(ip, { windowStartedAt: now, count: 0 });
    }
  }

  async login(usernameInput: string, password: string, ip: string): Promise<{ username: string; sessionToken: string }> {
    this.assertLoginAllowed(ip);
    const admin = this.readAdmin();
    if (!admin) throw new AuthError(409, '管理员尚未初始化，请先完成初始化');
    const username = usernameInput.trim();
    const candidate = await derivePassword(password, admin.salt);
    const expected = Buffer.from(admin.passwordHash, 'hex');
    const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (!matches || username !== admin.username) {
      const prior = this.loginAttempts.get(ip);
      if (prior) prior.count += 1;
      else this.loginAttempts.set(ip, { windowStartedAt: Date.now(), count: 1 });
      // Avoid revealing whether the username exists.
      throw new AuthError(401, '用户名或密码错误');
    }
    this.loginAttempts.delete(ip);
    return { username: admin.username, sessionToken: this.startSession(admin.username) };
  }

  sessionUser(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    const pair = cookieHeader.split(';').map(value => value.trim())
      .find(value => value.startsWith(`${COOKIE_NAME}=`));
    if (!pair) return null;
    const token = pair.slice(COOKIE_NAME.length + 1);
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      this.persistSessions();
      return null;
    }
    // Sliding expiration keeps an active board signed in while still bounding
    // an abandoned session to at most SESSION_TTL_MS. The bump is flushed to
    // disk at most once per minute (persistSessionsThrottled).
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    this.persistSessionsThrottled();
    return session.username;
  }

  logout(cookieHeader: string | undefined): void {
    if (!cookieHeader) return;
    const pair = cookieHeader.split(';').map(value => value.trim())
      .find(value => value.startsWith(`${COOKIE_NAME}=`));
    if (pair && this.sessions.delete(pair.slice(COOKIE_NAME.length + 1))) {
      this.persistSessions();
    }
  }

  cookie(sessionToken: string, secure: boolean): string {
    return `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure: boolean): string {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}
