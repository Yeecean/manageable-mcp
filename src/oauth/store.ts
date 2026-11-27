import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getOAuthStorePath } from '../config/paths.js';
import { AppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { sanitizeErrorMessage } from './sanitize.js';
import type { OAuthStoreEntry, OAuthStoreFile } from './types.js';

const STORE_VERSION = 1 as const;
const STORE_FILE = 'oauth.json';
const TEMP_PREFIX = '.oauth-';
const TEMP_SUFFIX = '.tmp';

let storeQueue: Promise<void> = Promise.resolve();

function normalizeServerUrl(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    url.hash = '';
    return url.toString();
  } catch {
    throw new AppError('CONFIG_INVALID', 'OAuth 存储键的服务器 URL 无效');
  }
}

/**
 * A display-safe form of the server URL. Credentials, query, and fragment are
 * removed so they are not persisted in the readable metadata portion of the
 * store.
 */
export function sanitizeOAuthServerUrl(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[无效 URL]';
  }
}

/**
 * Stable key for a provider. The raw URL is hashed, so query parameters and
 * credentials embedded in a URL are not exposed as object keys in oauth.json.
 */
export function oauthStoreKey(serverName: string, serverUrl: string): string {
  return createHash('sha256')
    .update(serverName)
    .update('\0')
    .update(normalizeServerUrl(serverUrl))
    .digest('hex');
}

function emptyStore(): OAuthStoreFile {
  return { version: STORE_VERSION, entries: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStore(raw: string): OAuthStoreFile {
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!isRecord(value) || value.version !== STORE_VERSION || !isRecord(value.entries)) {
    throw new Error('不支持的 OAuth 存储结构');
  }

  const entries: Record<string, OAuthStoreEntry> = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.serverName !== 'string' || typeof entry.serverUrl !== 'string') continue;
    entries[key] = entry as unknown as OAuthStoreEntry;
  }
  return { version: STORE_VERSION, entries };
}

async function readStore(logger?: Logger): Promise<OAuthStoreFile> {
  const file = getOAuthStorePath();
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return emptyStore();
    logger?.error('读取 OAuth 存储失败', { path: file, code: code ?? 'UNKNOWN' });
    throw new AppError(
      'INTERNAL_ERROR',
      `读取 OAuth 存储 ${file} 失败（${code ?? '未知错误'}）；为避免覆盖，已停止后续写入。`,
      { path: file },
    );
  }

  try {
    return parseStore(raw);
  } catch {
    logger?.error('OAuth 存储格式损坏', { path: file });
    throw new AppError(
      'INTERNAL_ERROR',
      `OAuth 存储 ${file} 已损坏；为避免覆盖，已停止后续写入。请手动修复或删除该文件。`,
      { path: file },
    );
  }
}

async function writeStore(store: OAuthStoreFile): Promise<void> {
  const file = getOAuthStorePath();
  const directory = path.dirname(file);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });

  const temporary = path.join(directory, `${TEMP_PREFIX}${process.pid}-${randomUUID()}${TEMP_SUFFIX}`);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporary, 'w', 0o600);
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporary, file);
    try {
      await fs.promises.chmod(file, 0o600);
    } catch {
      // Windows does not implement POSIX modes; the file is still user-scoped.
    }
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw new AppError(
      'INTERNAL_ERROR',
      `写入 OAuth 存储 ${STORE_FILE} 失败：${sanitizeErrorMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
}

function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = storeQueue.then(operation, operation);
  storeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function readOAuthStoreEntry(
  serverName: string,
  serverUrl: string,
  logger?: Logger,
): Promise<OAuthStoreEntry | undefined> {
  const key = oauthStoreKey(serverName, serverUrl);
  const store = await readStore(logger);
  return Object.prototype.hasOwnProperty.call(store.entries, key) ? store.entries[key] : undefined;
}

/**
 * Read-modify-write is serialized within this process and committed with
 * write-then-rename so a crash cannot leave a partially written oauth.json.
 */
export async function updateOAuthStoreEntry(
  serverName: string,
  serverUrl: string,
  update: (entry: OAuthStoreEntry) => void,
  logger?: Logger,
): Promise<OAuthStoreEntry> {
  const key = oauthStoreKey(serverName, serverUrl);

  return await withStoreLock(async () => {
    const store = await readStore(logger);
    const existing = Object.prototype.hasOwnProperty.call(store.entries, key)
      ? store.entries[key]
      : undefined;
    const entry: OAuthStoreEntry = existing ?? {
      serverName,
      serverUrl: sanitizeOAuthServerUrl(serverUrl),
      updatedAt: Date.now(),
    };

    update(entry);
    entry.serverName = serverName;
    entry.serverUrl = sanitizeOAuthServerUrl(serverUrl);
    entry.updatedAt = Date.now();
    store.entries[key] = entry;
    await writeStore(store);
    return entry;
  });
}

export type OAuthCredentialScope = 'all' | 'client' | 'tokens' | 'verifier' | 'discovery';

export async function invalidateOAuthStoreEntry(
  serverName: string,
  serverUrl: string,
  scope: OAuthCredentialScope,
  logger?: Logger,
): Promise<OAuthStoreEntry | undefined> {
  const key = oauthStoreKey(serverName, serverUrl);

  return await withStoreLock(async () => {
    const store = await readStore(logger);
    const entry = Object.prototype.hasOwnProperty.call(store.entries, key)
      ? store.entries[key]
      : undefined;
    if (entry === undefined) return undefined;

    if (scope === 'all' || scope === 'client') delete entry.clientInformation;
    if (scope === 'all' || scope === 'tokens') delete entry.tokens;
    if (scope === 'all' || scope === 'verifier') delete entry.codeVerifier;
    if (scope === 'all' || scope === 'discovery') delete entry.discoveryState;
    entry.updatedAt = Date.now();
    store.entries[key] = entry;
    await writeStore(store);
    return entry;
  });
}
