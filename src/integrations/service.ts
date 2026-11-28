import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDefaultConfigDir, resolveConfigPath } from '../config/paths.js';
import { AppError } from '../core/errors.js';
import { isLoopbackUrl } from '../client/endpoint.js';
import {
  clientEntry,
  defaultClientConfigPath,
  editClientEntry,
  readClientEntry,
  readLaunchSpec,
  type ClientName,
  type LaunchSpec,
} from './config.js';

interface Snapshot {
  exists: boolean;
  bytes: Buffer;
}

interface Journal {
  client: ClientName;
  configPath: string;
  existed: boolean;
  beforeHash: string;
  afterHash: string;
  backupFile: string;
}

export interface IntegrationOptions {
  client: ClientName;
  configPath?: string;
  stateDir?: string;
}

export interface LaunchOptions {
  config?: string;
  group?: string;
  attach?: string;
}

export interface IntegrationStatus {
  client: ClientName;
  configPath: string;
  executableFound: boolean;
  state: '未配置' | '已接入' | '名称冲突' | '配置无效';
}

const REQUIRED_TOOLS = ['list_servers', 'list_commands', 'describe_commands', 'invoke_command'];

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function identityPath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function entryPointPath(): string {
  return fileURLToPath(new URL('../../dist/index.js', import.meta.url));
}

export function createLaunchSpec(options: LaunchOptions = {}): LaunchSpec {
  const entryPoint = entryPointPath();
  if (!fs.existsSync(entryPoint)) {
    throw new AppError('SERVER_UNAVAILABLE', '请先运行 npm run build');
  }
  const args = [entryPoint];
  if (options.attach !== undefined) {
    if (options.config !== undefined || options.group !== undefined) {
      throw new AppError('INVALID_PARAMETERS', '--attach 不能与 --config 或 --group 一起使用');
    }
    let url: URL;
    try {
      url = new URL(options.attach);
    } catch {
      throw new AppError('INVALID_PARAMETERS', '--attach 不是有效 URL');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
      throw new AppError('INVALID_PARAMETERS', '--attach 必须是不含凭据、查询字符串或片段的 HTTP(S) URL');
    }
    if (!isLoopbackUrl(url.href) && url.protocol !== 'https:') {
      throw new AppError('INVALID_PARAMETERS', '非回环 --attach 必须使用 HTTPS');
    }
    args.push('--attach', url.href);
  } else {
    args.push('--config', resolveConfigPath(options.config));
    if (options.group !== undefined) {
      if (!/^[A-Za-z0-9._-]+$/.test(options.group)) {
        throw new AppError('INVALID_PARAMETERS', '分组名称无效');
      }
      args.push('--group', options.group);
    }
  }
  return { command: process.execPath, args };
}

function isOwned(spec: LaunchSpec | undefined): boolean {
  return spec !== undefined && spec.args.length > 0 &&
    identityPath(spec.command) === identityPath(process.execPath) &&
    identityPath(spec.args[0] as string) === identityPath(entryPointPath());
}

async function snapshot(configPath: string): Promise<Snapshot> {
  try {
    const info = await fs.promises.lstat(configPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AppError('CONFIG_INVALID', '客户端配置不是普通文件，未作修改');
    }
    return { exists: true, bytes: await fs.promises.readFile(configPath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, bytes: Buffer.alloc(0) };
    if (error instanceof AppError) throw error;
    throw new AppError('CONFIG_INVALID', `无法读取客户端配置 ${configPath}`);
  }
}

function textFor(client: ClientName, current: Snapshot): string {
  if (!current.exists) return client === 'codex' ? '' : '{}\n';
  return current.bytes.toString('utf8');
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return left.exists === right.exists && left.bytes.equals(right.bytes);
}

async function atomicWrite(filePath: string, bytes: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, filePath);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function locations(options: IntegrationOptions): { configPath: string; journalDir: string } {
  const configPath = path.resolve(options.configPath ?? defaultClientConfigPath(options.client));
  const digest = hash(Buffer.from(identityPath(configPath))).slice(0, 20);
  const stateDir = path.resolve(options.stateDir ?? getDefaultConfigDir());
  return { configPath, journalDir: path.join(stateDir, 'client-backups', `${options.client}-${digest}`) };
}

async function saveJournal(
  options: IntegrationOptions,
  configPath: string,
  journalDir: string,
  before: Snapshot,
  after: Buffer,
): Promise<void> {
  await fs.promises.mkdir(journalDir, { recursive: true, mode: 0o700 });
  const backupFile = `${randomUUID()}.backup`;
  if (before.exists) await atomicWrite(path.join(journalDir, backupFile), before.bytes);
  const journal: Journal = {
    client: options.client,
    configPath,
    existed: before.exists,
    beforeHash: hash(before.bytes),
    afterHash: hash(after),
    backupFile,
  };
  await atomicWrite(path.join(journalDir, 'last.json'), Buffer.from(JSON.stringify(journal), 'utf8'));
}

async function withLock<T>(journalDir: string, operation: () => Promise<T>): Promise<T> {
  await fs.promises.mkdir(journalDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(journalDir, 'operation.lock');
  let lock: fs.promises.FileHandle;
  try {
    lock = await fs.promises.open(lockPath, 'wx', 0o600);
  } catch {
    throw new AppError('CONFIG_INVALID', '客户端接入正在操作或锁文件未清理，请稍后重试');
  }
  try {
    return await operation();
  } finally {
    await lock.close();
    await fs.promises.rm(lockPath, { force: true });
  }
}

async function changeEntry(options: IntegrationOptions, next: LaunchSpec | undefined, replaceExisting = false): Promise<boolean> {
  const { configPath, journalDir } = locations(options);
  return withLock(journalDir, async () => {
    const before = await snapshot(configPath);
    const text = textFor(options.client, before);
    const oldEntry = readClientEntry(options.client, text);
    if (oldEntry !== undefined && !isOwned(readLaunchSpec(options.client, oldEntry)) && !replaceExisting) {
      throw new AppError('CONFIG_INVALID', '同名服务器不属于当前项目，未覆盖或删除');
    }
    if (oldEntry === undefined && next === undefined) return false;
    const newEntry = next === undefined ? undefined : clientEntry(options.client, next);
    if (isDeepStrictEqual(oldEntry, newEntry)) return false;
    const after = Buffer.from(editClientEntry(options.client, text, newEntry), 'utf8');
    const journalPath = path.join(journalDir, 'last.json');
    const previousJournal = await snapshot(journalPath);
    try {
      await saveJournal(options, configPath, journalDir, before, after);
      if (!sameSnapshot(before, await snapshot(configPath))) {
        throw new AppError('CONFIG_INVALID', '客户端配置在操作期间发生变化，未覆盖');
      }
      await atomicWrite(configPath, after);
    } catch (error) {
      if (previousJournal.exists) await atomicWrite(journalPath, previousJournal.bytes);
      else await fs.promises.rm(journalPath, { force: true });
      if (error instanceof AppError) throw error;
      throw new AppError('CONFIG_INVALID', `无法写入客户端配置 ${configPath}`);
    }
    return true;
  });
}

export async function verifyLaunchSpec(spec: LaunchSpec): Promise<void> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => undefined);
  const client = new Client({ name: 'manageable-mcp-integration-check', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 15_000 });
    const result = await client.listTools(undefined, { timeout: 15_000 });
    if (!REQUIRED_TOOLS.every((name) => result.tools.some((tool) => tool.name === name))) {
      throw new Error('missing tools');
    }
  } catch {
    throw new AppError('SERVER_UNAVAILABLE', '接入验证失败：请检查本地配置、构建结果或共享守护进程');
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

export async function installIntegration(
  options: IntegrationOptions,
  spec: LaunchSpec,
  replaceExisting = false,
): Promise<boolean> {
  if (!isOwned(spec)) throw new AppError('INVALID_PARAMETERS', '接入命令不是当前项目的启动文件');
  const configIndex = spec.args.indexOf('--config');
  if (configIndex >= 0 && spec.args[configIndex + 1] !== undefined &&
      identityPath(spec.args[configIndex + 1] as string) === identityPath(locations(options).configPath)) {
    throw new AppError('INVALID_PARAMETERS', '客户端配置不能与服务器配置是同一个文件');
  }
  await verifyLaunchSpec(spec);
  return changeEntry(options, spec, replaceExisting);
}

export async function uninstallIntegration(options: IntegrationOptions): Promise<boolean> {
  return changeEntry(options, undefined);
}

export async function verifyIntegration(options: IntegrationOptions): Promise<void> {
  const { configPath } = locations(options);
  const current = await snapshot(configPath);
  const entry = readClientEntry(options.client, textFor(options.client, current));
  const spec = readLaunchSpec(options.client, entry);
  if (!isOwned(spec)) throw new AppError('CONFIG_INVALID', '客户端尚未接入当前项目');
  await verifyLaunchSpec(spec as LaunchSpec);
}

export async function rollbackIntegration(options: IntegrationOptions): Promise<void> {
  const { configPath, journalDir } = locations(options);
  await withLock(journalDir, async () => {
    let journal: Journal;
    try {
      journal = JSON.parse(await fs.promises.readFile(path.join(journalDir, 'last.json'), 'utf8')) as Journal;
    } catch {
      throw new AppError('CONFIG_INVALID', '没有可用的客户端接入回滚记录');
    }
    if (!journal || journal.client !== options.client || typeof journal.configPath !== 'string' ||
        identityPath(journal.configPath) !== identityPath(configPath) ||
        typeof journal.existed !== 'boolean' || typeof journal.backupFile !== 'string' ||
        !/^[0-9a-f-]{36}\.backup$/.test(journal.backupFile) ||
        !/^[0-9a-f]{64}$/.test(journal.beforeHash) || !/^[0-9a-f]{64}$/.test(journal.afterHash)) {
      throw new AppError('CONFIG_INVALID', '回滚记录无效，未作修改');
    }
    const current = await snapshot(configPath);
    if (!current.exists || hash(current.bytes) !== journal.afterHash) {
      throw new AppError('CONFIG_INVALID', '客户端配置在上次操作后已变化，无法安全回滚');
    }
    if (journal.existed) {
      let before: Buffer;
      try {
        before = await fs.promises.readFile(path.join(journalDir, journal.backupFile));
      } catch {
        throw new AppError('CONFIG_INVALID', '回滚备份不可读取');
      }
      if (hash(before) !== journal.beforeHash) throw new AppError('CONFIG_INVALID', '回滚备份校验失败');
      if (!sameSnapshot(current, await snapshot(configPath))) {
        throw new AppError('CONFIG_INVALID', '客户端配置在回滚期间发生变化，未覆盖');
      }
      await atomicWrite(configPath, before);
    } else {
      if (!sameSnapshot(current, await snapshot(configPath))) {
        throw new AppError('CONFIG_INVALID', '客户端配置在回滚期间发生变化，未删除');
      }
      await fs.promises.unlink(configPath);
    }
    await fs.promises.rm(path.join(journalDir, 'last.json'), { force: true });
  });
}

function executableExists(client: ClientName): boolean {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  return (process.env.PATH ?? '').split(path.delimiter).some((directory) =>
    extensions.some((extension) => fs.existsSync(path.join(directory, `${client}${extension}`))),
  );
}

export async function integrationStatus(options: IntegrationOptions): Promise<IntegrationStatus> {
  const { configPath } = locations(options);
  let state: IntegrationStatus['state'] = '未配置';
  try {
    const current = await snapshot(configPath);
    const entry = readClientEntry(options.client, textFor(options.client, current));
    if (entry !== undefined) state = isOwned(readLaunchSpec(options.client, entry)) ? '已接入' : '名称冲突';
  } catch {
    state = '配置无效';
  }
  return { client: options.client, configPath, executableFound: executableExists(options.client), state };
}
