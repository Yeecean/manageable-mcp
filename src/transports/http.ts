import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AdminController } from '../admin/controller.js';
import type { Logger } from '../core/logger.js';
import { AppError, errorMessage } from '../core/errors.js';
import type { HttpTransportConfig } from '../config/types.js';
import { createProxyServer } from '../mcp/proxy-server.js';
import type { ServerManager } from '../mcp/manager.js';
import { buildGroupScope, type ProxyScope } from '../mcp/proxy-scope.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RunningHttpServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return (
    value === 'localhost' ||
    value === '::1' ||
    value === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(value)
  );
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isRequestAllowed(req: http.IncomingMessage, options: HttpTransportConfig): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!isLoopbackOrigin(origin) && !options.allowedOrigins.includes(origin)) return false;
  }

  const hostHeader = req.headers.host;
  if (!hostHeader) return false;
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(1, hostHeader.indexOf(']'))
    : hostHeader.split(':')[0];
  if (!hostname) return false;
  if (options.allowedHosts.length > 0) {
    return options.allowedHosts.includes(hostHeader) || options.allowedHosts.includes(hostname);
  }
  return isLoopbackHostname(hostname) || hostname === options.host;
}

function isAuthorized(req: http.IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true;
  const header = req.headers.authorization;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (match === null) return false;
  const provided = Buffer.from(match[1] as string);
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJsonBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new HttpError(413, `请求体超过 ${limit} 字节上限`);
    chunks.push(buffer);
  }

  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体必须是有效 JSON');
  }
}

function pathnameOf(req: http.IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function scopeForPath(
  pathname: string,
  options: HttpTransportConfig,
  manager: ServerManager,
): ProxyScope | undefined {
  const base = options.path === '/' ? '/' : options.path;
  if (pathname === base || pathname === `${base}/`) return undefined;
  const prefix = base === '/' ? '/' : `${base}/`;
  if (!pathname.startsWith(prefix)) throw new HttpError(404, '未找到');

  let group = pathname.slice(prefix.length);
  if (group.endsWith('/')) group = group.slice(0, -1);
  if (group.length === 0 || group.includes('/')) throw new HttpError(404, '未找到');
  try {
    group = decodeURIComponent(group);
  } catch {
    throw new HttpError(404, '未找到');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(group)) throw new HttpError(404, '未找到');
  try {
    return buildGroupScope(manager, group);
  } catch {
    throw new HttpError(404, '未找到');
  }
}

function healthPayload(manager: ServerManager): Record<string, unknown> {
  return {
    status: 'ok',
    name: PACKAGE_NAME,
    version: VERSION,
    servers: manager.listServers().map((server) => ({
      name: server.name,
      enabled: server.enabled,
      status: server.status,
      ...(server.toolCount === undefined ? {} : { toolCount: server.toolCount }),
      ...(server.health === undefined
        ? {}
        : {
            health: {
              healthy: server.health.healthy,
              lastChecked: server.health.lastChecked,
              ...(server.health.latencyMs === undefined ? {} : { latencyMs: server.health.latencyMs }),
              ...(server.health.authRequired ? { authRequired: true } : {}),
            },
          }),
    })),
  };
}

function normalizeHttpOptions(options: HttpTransportConfig): HttpTransportConfig {
  const host = options.host.trim();
  if (host.length === 0) {
    throw new AppError('INVALID_PARAMETERS', 'HTTP 绑定主机不能为空');
  }

  const rawPath = options.path.trim();
  if (rawPath.length === 0) {
    throw new AppError('INVALID_PARAMETERS', 'HTTP MCP 路径不能为空');
  }
  if (rawPath.includes('?') || rawPath.includes('#')) {
    throw new AppError('INVALID_PARAMETERS', 'HTTP MCP 路径不能包含查询字符串或片段');
  }
  let path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');

  for (const reserved of ['/health', '/admin', '/api/admin']) {
    if (path === reserved || path.startsWith(`${reserved}/`)) {
      throw new AppError(
        'INVALID_PARAMETERS',
        `HTTP MCP 路径 '${path}' 与保留路径 '${reserved}' 冲突`,
      );
    }
  }

  const authToken = options.authToken?.trim();
  if ((authToken === undefined || authToken.length === 0) && !isLoopbackHostname(host)) {
    throw new AppError(
      'INVALID_PARAMETERS',
      `非回环主机 '${host}' 必须配置认证令牌，已拒绝启动`,
    );
  }

  return {
    ...options,
    host,
    path,
    authToken: authToken === undefined || authToken.length === 0 ? undefined : authToken,
  };
}

export async function startHttpServer(
  manager: ServerManager,
  options: HttpTransportConfig,
  logger: Logger,
): Promise<RunningHttpServer> {
  options = normalizeHttpOptions(options);
  const adminController = options.admin
    ? new AdminController(manager, {
        configPath: manager.getConfigPath(),
        mcpPath: options.path,
        ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
        maxBodyBytes: options.maxBodyBytes,
      })
    : undefined;
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = pathnameOf(req);

      if (!isRequestAllowed(req, options)) {
        throw new HttpError(403, 'Host 或 Origin 不被允许');
      }
      if (pathname === '/health') {
        sendJson(res, 200, healthPayload(manager));
        return;
      }
      if (adminController !== undefined) {
        const adminUrl = new URL(req.url ?? '/', 'http://localhost');
        if (await adminController.handle(req, res, adminUrl)) return;
      }
      if (!isAuthorized(req, options.authToken)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw new HttpError(401, '未授权');
      }
      if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
        res.setHeader('Allow', 'POST, GET, DELETE');
        throw new HttpError(405, '请求方法不允许');
      }

      const body = req.method === 'POST' ? await readJsonBody(req, options.maxBodyBytes) : undefined;
      const scope = scopeForPath(pathname, options, manager);
      const mcpServer = createProxyServer(manager, logger, scope);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      let cleanedUp = false;
      const cleanup = async (): Promise<void> => {
        if (cleanedUp) return;
        cleanedUp = true;
        await transport.close().catch(() => undefined);
        await mcpServer.close().catch(() => undefined);
      };

      res.once('finish', () => void cleanup());
      res.once('close', () => void cleanup());

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      logger.error('HTTP request failed', { error: errorMessage(error) });
      sendJson(res, 500, { error: '服务器内部错误' });
    }
  });

  server.on('clientError', (error, socket) => {
    logger.warn('HTTP client error', { error: error.message });
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.host);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  const displayHost = options.host.includes(':') ? `[${options.host}]` : options.host;
  const url = `http://${displayHost}:${port}${options.path}`;

  logger.info('HTTP server listening', { url, health: `http://${displayHost}:${port}/health` });

  return {
    url,
    port,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await manager.closeAll();
    },
  };
}
