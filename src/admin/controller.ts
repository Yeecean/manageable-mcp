import { timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import { loadConfig } from '../config/load.js';
import type { LoadedConfig } from '../config/types.js';
import { errorMessage } from '../core/errors.js';
import type {
  ServerHealth,
  ServerManager,
  ServerStatus,
  ServerSummary,
} from '../mcp/manager.js';
import {
  AdminConfigStore,
  AdminError,
  type RawConfigSnapshot,
  type RawServerConfig,
} from './store.js';
import { renderAdminHtml } from './ui.js';

export { AdminError } from './store.js';
export type { AdminConfigStore, RawConfigSnapshot, RawServerConfig } from './store.js';

export interface AdminControllerOptions {
  configPath?: string;
  mcpPath?: string;
  authToken?: string;
  host?: string;
  maxBodyBytes?: number;
}

export interface AdminServerView {
  name: string;
  description: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  status: ServerStatus;
  toolCount?: number;
  health?: ServerHealth;
  error?: string;
  raw: RawServerConfig;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const mutationQueues = new Map<string, Promise<unknown>>();

export class AdminController {
  private readonly manager: ServerManager;
  private readonly store: AdminConfigStore;
  private readonly configPath: string;
  private readonly mcpPath: string;
  private readonly authToken?: string;
  private readonly maxBodyBytes: number;

  constructor(manager: ServerManager, options: AdminControllerOptions = {}) {
    const configPath = options.configPath ?? manager.getConfigPath();
    if (!configPath) {
      throw new Error('AdminController 需要配置文件路径');
    }

    this.manager = manager;
    this.configPath = path.resolve(configPath);
    this.store = new AdminConfigStore(this.configPath);
    this.mcpPath = normalizeMcpPath(options.mcpPath ?? '/mcp');
    if (options.authToken !== undefined) this.authToken = options.authToken;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL | string,
  ): Promise<boolean> {
    const parsed = typeof url === 'string' ? new URL(url, 'http://localhost') : url;
    const pathname = parsed.pathname || '/';
    const isPage = pathname === '/admin' || pathname.startsWith('/admin/');
    const isApi =
      pathname === '/api/admin' ||
      pathname === '/api/admin/' ||
      pathname.startsWith('/api/admin/');

    if (!isPage && !isApi) return false;

    try {
      if (isPage) {
        if (this.authToken === undefined && !isLoopbackRequest(req)) {
          sendJson(res, 403, {
            success: false,
            error: { message: '未配置令牌时，管理页面只允许本机回环客户端访问' },
          });
          return true;
        }
        if (pathname !== '/admin' && pathname !== '/admin/') {
          throw new AdminError(404, '未找到');
        }
        requireMethod(req, res, ['GET']);
        sendHtml(res, 200, renderAdminHtml());
        return true;
      }

      if (!this.authorizeApi(req, res)) return true;
      await this.routeApi(req, res, pathname);
      return true;
    } catch (error) {
      sendAdminError(res, error);
      return true;
    }
  }

  private authorizeApi(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (this.authToken !== undefined) {
      if (!hasValidBearer(req, this.authToken)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        sendJson(res, 401, { success: false, error: { message: '未授权' } });
        return false;
      }
      return true;
    }

    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, {
        success: false,
        error: { message: '未配置令牌时，管理 API 只允许本机回环客户端访问' },
      });
      return false;
    }
    return true;
  }

  private async routeApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (pathname === '/api/admin' || pathname === '/api/admin/') {
      requireMethod(req, res, ['GET']);
      await this.getOverview(res);
      return;
    }

    const rest = pathname.slice('/api/admin/'.length);
    const rawSegments = rest.split('/');
    if (rawSegments[rawSegments.length - 1] === '') rawSegments.pop();
    if (rawSegments.length === 0 || rawSegments.some((segment) => segment.length === 0)) {
      throw new AdminError(404, '未找到');
    }
    const segments = rawSegments.map(decodeSegment);
    const first = segments[0];

    if (first === 'servers' && segments.length === 1) {
      requireMethod(req, res, ['POST']);
      await this.addServer(req, res);
      return;
    }

    if (first === 'reload' && segments.length === 1) {
      requireMethod(req, res, ['POST']);
      await this.reloadConfig(req, res);
      return;
    }

    if (first === 'probe' && segments.length === 1) {
      requireMethod(req, res, ['POST']);
      await this.probeServers(req, res);
      return;
    }

    if (first === 'servers' && (segments.length === 2 || segments.length === 3)) {
      const name = segments[1];
      if (!name) throw new AdminError(404, '未找到');

      if (segments.length === 2) {
        if (req.method === 'GET') {
          await this.getServer(res, name);
          return;
        }
        if (req.method === 'PUT') {
          await this.updateServer(req, res, name);
          return;
        }
        if (req.method === 'DELETE') {
          await this.deleteServer(res, name);
          return;
        }
        res.setHeader('Allow', 'GET, PUT, DELETE');
        throw new AdminError(405, '请求方法不受支持');
      }

      if (segments[2] === 'toggle') {
        requireMethod(req, res, ['POST']);
        await this.toggleServer(req, res, name);
        return;
      }
    }

    throw new AdminError(404, '未找到');
  }

  private async getOverview(res: http.ServerResponse): Promise<void> {
    const snapshot = await this.store.snapshot();
    const summaries = this.summaryMap();
    const servers = snapshot.servers.map((raw) =>
      describeServer(raw, summaries.get(typeof raw.name === 'string' ? raw.name : '')),
    );

    sendJson(res, 200, {
      success: true,
      data: {
        servers,
        groups: snapshot.groups,
        configFile: this.configPath,
        mcpPath: this.mcpPath,
      },
    });
  }

  private async getServer(res: http.ServerResponse, name: string): Promise<void> {
    const raw = await this.store.get(name);
    const summary = this.summaryMap().get(name);
    sendJson(res, 200, {
      success: true,
      data: { server: describeServer(raw, summary) },
    });
  }

  private async addServer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const input = requireRecord(
      await readJsonBody(req, this.maxBodyBytes),
      '请求体必须是服务器配置对象',
    );

    const view = await this.withMutation(async () => {
      const raw = await this.store.add(input);
      await this.reloadManager('服务器已保存，但运行中的管理器重新加载失败');
      return describeServer(raw, this.summaryMap().get(nameOf(raw)));
    });

    sendJson(res, 201, { success: true, data: { server: view } });
  }

  private async updateServer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    name: string,
  ): Promise<void> {
    const input = requireRecord(
      await readJsonBody(req, this.maxBodyBytes),
      '请求体必须是服务器配置对象',
    );

    const view = await this.withMutation(async () => {
      const raw = await this.store.update(name, input);
      await this.reloadManager('服务器已保存，但运行中的管理器重新加载失败');
      return describeServer(raw, this.summaryMap().get(name));
    });

    sendJson(res, 200, { success: true, data: { server: view } });
  }

  private async deleteServer(res: http.ServerResponse, name: string): Promise<void> {
    await this.withMutation(async () => {
      await this.store.remove(name);
      await this.reloadManager('服务器已删除，但运行中的管理器重新加载失败');
    });
    sendJson(res, 200, { success: true, data: { removed: name } });
  }

  private async toggleServer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    name: string,
  ): Promise<void> {
    const body = requireRecord(
      await readJsonBody(req, this.maxBodyBytes),
      '请求体必须包含布尔字段 "enabled"',
    );
    if (typeof body.enabled !== 'boolean') {
      throw new AdminError(400, '字段 "enabled" 必须是布尔值');
    }

    const view = await this.withMutation(async () => {
      const raw = await this.store.setEnabled(name, body.enabled as boolean);
      await this.reloadManager('服务器已更新，但运行中的管理器重新加载失败');
      return describeServer(raw, this.summaryMap().get(name));
    });

    sendJson(res, 200, { success: true, data: { server: view } });
  }

  private async reloadConfig(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    await readJsonBody(req, this.maxBodyBytes);
    const loaded = await this.withMutation(() => this.reloadManager());
    sendJson(res, 200, {
      success: true,
      data: {
        configFile: this.configPath,
        serverCount: loaded.config.servers.length,
      },
    });
  }

  private async probeServers(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(req, this.maxBodyBytes);
    let requested: string[] | undefined;
    if (body !== undefined) {
      const record = requireRecord(body, '请求体必须是对象');
      if (record.names !== undefined) {
        if (!Array.isArray(record.names) || record.names.some((name) => typeof name !== 'string')) {
          throw new AdminError(400, '字段 "names" 必须是字符串数组');
        }
        requested = record.names as string[];
      }
    }

    const enabledNames = this.manager
      .listServers()
      .filter((server) => server.enabled)
      .map((server) => server.name);
    const names = requested === undefined
      ? enabledNames
      : enabledNames.filter((name) => requested.includes(name));
    const results = await this.manager.probeAllServers(names);

    sendJson(res, 200, {
      success: true,
      data: {
        results: results.map((health, index) => ({
          name: names[index] ?? '',
          ...health,
        })),
      },
    });
  }

  private summaryMap(): Map<string, ServerSummary> {
    const summaries = new Map<string, ServerSummary>();
    for (const summary of this.manager.listServers()) {
      summaries.set(summary.name, summary);
    }
    return summaries;
  }

  private withMutation<T>(task: () => Promise<T>): Promise<T> {
    return enqueueMutation(this.configPath, task);
  }

  private async reloadManager(messagePrefix = '配置重新加载失败'): Promise<LoadedConfig> {
    try {
      const loaded = loadConfig(this.configPath);
      const health = this.manager.isHealthForcedOn()
        ? { ...loaded.config.health, enabled: true }
        : loaded.config.health;
      await this.manager.reconfigure(loaded.config.servers, {
        groups: loaded.config.groups,
        permissions: loaded.config.permissions,
        health,
        healthOverride: this.manager.isHealthForcedOn(),
        configPath: this.configPath,
      });
      return loaded;
    } catch (error) {
      throw new AdminError(500, `${messagePrefix}: ${errorMessage(error)}`);
    }
  }
}

function normalizeMcpPath(value: string): string {
  if (value.length === 0) return '/mcp';
  const withSlash = value.startsWith('/') ? value : `/${value}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AdminError(400, message);
  return value;
}

function nameOf(server: RawServerConfig): string {
  return typeof server.name === 'string' ? server.name : '';
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function describeServer(
  raw: RawServerConfig,
  summary: ServerSummary | undefined,
): AdminServerView {
  const config = cloneJson(raw);
  const view: AdminServerView = {
    name: typeof config.name === 'string' ? config.name : (summary?.name ?? ''),
    description: typeof config.description === 'string'
      ? config.description
      : (summary?.description ?? ''),
    enabled: summary?.enabled ?? (typeof config.enabled === 'boolean' ? config.enabled : true),
    transport: summary?.transport ?? (typeof config.url === 'string' ? 'http' : 'stdio'),
    status: summary?.status ?? 'idle',
    raw: config,
  };

  if (summary?.toolCount !== undefined) view.toolCount = summary.toolCount;
  if (summary?.health !== undefined) view.health = summary.health;
  if (summary?.error !== undefined) view.error = summary.error;
  return view;
}

function decodeSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0 || decoded.includes('/')) {
      throw new AdminError(404, '未找到');
    }
    return decoded;
  } catch (error) {
    if (error instanceof AdminError) throw error;
    throw new AdminError(400, '服务器名称的 URL 编码无效');
  }
}

function requireMethod(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowed: string[],
): void {
  const method = req.method ?? 'GET';
  if (!allowed.includes(method)) {
    res.setHeader('Allow', allowed.join(', '));
    throw new AdminError(405, '请求方法不受支持');
  }
}

function hasValidBearer(req: http.IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const target = Buffer.from(expected, 'utf8');
  return provided.length === target.length && timingSafeEqual(provided, target);
}

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const address = req.socket?.remoteAddress;
  if (!address) return true;
  const value = address.toLowerCase();
  return (
    value === '::1' ||
    value === '::ffff:7f00:1' ||
    value.startsWith('127.') ||
    value.startsWith('::ffff:127.')
  );
}

async function readJsonBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      throw new AdminError(413, `请求体超过 ${limit} 字节`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new AdminError(400, '请求体必须是有效的 JSON');
  }
}

function sendAdminError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof AdminError) {
    if (error.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    sendJson(res, error.status, {
      success: false,
      error: { message: localizeAdminMessage(error.message) },
    });
    return;
  }
  sendJson(res, 500, {
    success: false,
    error: { message: '服务器内部错误' },
  });
}

function localizeAdminMessage(message: string): string {
  const localized = message
    .replace(/^Server '(.+)' not found$/, '服务器 “$1” 不存在')
    .replace(/^Server '(.+)' already exists$/, '服务器 “$1” 已存在')
    .replace(/^Server entry must be a JSON object$/, '服务器配置必须是 JSON 对象')
    .replace(
      /^Server name in the request body must match the URL$/,
      '请求体中的服务器名称必须与 URL 一致',
    )
    .replace(
      /^Server name is required and must be a non-empty string$/,
      '服务器名称必填，且必须是非空字符串',
    )
    .replace(
      /^Cannot read config file '(.+)': ([\s\S]+)$/,
      '无法读取配置文件 “$1”。请检查文件是否存在且可访问。',
    )
    .replace(
      /^Config file '(.+)' is not valid JSON: ([\s\S]+)$/,
      '配置文件 “$1” 不是有效的 JSON。请检查语法。',
    )
    .replace(
      /^Config file '(.+)' must contain a JSON object$/,
      '配置文件 “$1” 必须包含 JSON 对象',
    )
    .replace(
      /^Config file '(.+)' must contain a "servers" array$/,
      '配置文件 “$1” 必须包含 "servers" 数组',
    )
    .replace(
      /^Config file '(.+)' has an invalid "groups" object$/,
      '配置文件 “$1” 的 "groups" 对象无效',
    )
    .replace(
      /^Config servers\[(\d+)\] must be a JSON object$/,
      '配置 servers[$1] 必须是 JSON 对象',
    )
    .replace(
      /^Cannot write config file '(.+)': ([\s\S]+)$/,
      '无法写入配置文件 “$1”。请检查目录权限。',
    )
    .replace(/^Config could not be serialized$/, '配置无法序列化')
    .replace(/^Invalid config: ([\s\S]+)$/, '配置校验失败：$1')
    .replace(/^Property "([^"]+)" /, '字段 “$1” ');

  return localizeConfigDetail(localized);
}

function localizeConfigDetail(message: string): string {
  return message
    .replace(/^config root /, '配置根节点 ')
    .replace(/must not be empty after expansion/g, '展开后不能为空')
    .replace(/must be a non-empty string/g, '必须是非空字符串')
    .replace(/must be an object of string values/g, '必须是字符串值对象')
    .replace(/must be a string/g, '必须是字符串')
    .replace(/must be a boolean/g, '必须是布尔值')
    .replace(/must be an array of strings/g, '必须是字符串数组')
    .replace(/must be an array/g, '必须是数组')
    .replace(/must be a JSON object/g, '必须是 JSON 对象')
    .replace(/must be an object/g, '必须是对象')
    .replace(/must be a positive integer/g, '必须是正整数')
    .replace(/must be a non-negative integer/g, '必须是非负整数')
    .replace(/must be <=/g, '必须小于等于')
    .replace(/must match/g, '必须匹配')
    .replace(/is not a valid URL/g, '不是有效的 URL')
    .replace(/must use http or https/g, '必须使用 http 或 https')
    .replace(/must set exactly one of command or url/g, '必须且只能设置 command 或 url 之一')
    .replace(/duplicate server name/g, '服务器名称重复')
    .replace(/references unknown server/g, '引用了不存在的服务器')
    .replace(/contains duplicates/g, '包含重复项')
    .replace(/must not be empty/g, '不能为空')
    .replace(/cannot read/g, '无法读取')
    .replace(/references undefined environment variable/g, '引用了未定义的环境变量')
    .replace(/has an empty file reference/g, '文件引用为空')
    .replace(/is reserved for the health endpoint/g, '是健康检查端点的保留路径')
    .replace(
      /must not use the reserved \/admin or \/api\/admin prefix/g,
      '不得使用保留的 /admin 或 /api/admin 前缀',
    )
    .replace(/must be a path without query or fragment/g, '必须是不含查询串或片段的路径')
    .replace(/must be 'allow' or 'deny'/g, "必须是 'allow' 或 'deny'");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; img-src 'self' data:; font-src 'none'; base-uri 'none'; " +
      "form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  });
  res.end(html);
}

function enqueueMutation<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(key, settled);
  void settled.then(() => {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  });
  return run;
}
