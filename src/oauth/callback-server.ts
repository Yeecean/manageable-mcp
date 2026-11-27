import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { AppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { sanitizeErrorMessage } from './sanitize.js';

export const DEFAULT_OAUTH_CALLBACK_PORT = 8947;
const CALLBACK_PATH = '/callback';
const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_FLOWS = 1_000;

export interface OAuthFlowProvider extends OAuthClientProvider {
  redactionSecrets?(): Promise<readonly string[]>;
}

export interface PendingOAuthFlow {
  state: string;
  provider: OAuthFlowProvider;
  serverName: string;
  serverUrl: string;
  callbackPort: number;
  authorizationUrl?: string;
  createdAt: number;
  fetchFn?: FetchLike;
}

export interface RegisterOAuthFlowOptions {
  state: string;
  provider: OAuthFlowProvider;
  serverName: string;
  serverUrl: string;
  callbackPort: number;
  authorizationUrl?: string;
  fetchFn?: FetchLike;
}

export interface OAuthCallbackServerHandle {
  readonly port: number;
  readonly callbackUrl: string;
  close(): Promise<void>;
}

const pendingFlows = new Map<string, PendingOAuthFlow>();
const callbackServers = new Map<number, OAuthCallbackServerHandle>();
const callbackServerStarts = new Map<number, Promise<OAuthCallbackServerHandle>>();

function prunePendingFlows(now = Date.now()): void {
  for (const [state, flow] of pendingFlows) {
    if (now - flow.createdAt > FLOW_TTL_MS) pendingFlows.delete(state);
  }

  if (pendingFlows.size <= MAX_PENDING_FLOWS) return;
  const oldest = Array.from(pendingFlows.values())
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, pendingFlows.size - MAX_PENDING_FLOWS);
  for (const flow of oldest) pendingFlows.delete(flow.state);
}

export function registerPendingOAuthFlow(options: RegisterOAuthFlowOptions): void {
  prunePendingFlows();

  for (const [state, flow] of pendingFlows) {
    if (flow.provider === options.provider) pendingFlows.delete(state);
  }

  pendingFlows.set(options.state, {
    state: options.state,
    provider: options.provider,
    serverName: options.serverName,
    serverUrl: options.serverUrl,
    callbackPort: options.callbackPort,
    createdAt: Date.now(),
    ...(options.authorizationUrl === undefined ? {} : { authorizationUrl: options.authorizationUrl }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
}

export function takePendingOAuthFlow(state: string): PendingOAuthFlow | undefined {
  prunePendingFlows();
  const flow = pendingFlows.get(state);
  if (flow === undefined) return undefined;
  pendingFlows.delete(state);
  return flow;
}

export function clearPendingOAuthFlows(): void {
  pendingFlows.clear();
}

export function pendingOAuthFlowCount(): number {
  prunePendingFlows();
  return pendingFlows.size;
}

export function resolveOAuthCallbackPort(callbackPort?: number): number {
  if (callbackPort !== undefined) {
    if (!Number.isInteger(callbackPort) || callbackPort < 0 || callbackPort > 65_535) {
      throw new AppError(
        'CONFIG_INVALID',
        `OAuth callbackPort 必须是 0 到 65535 之间的整数，实际为 ${callbackPort}`,
      );
    }
    return callbackPort;
  }

  const raw = process.env.MANAGEABLE_MCP_OAUTH_CALLBACK_PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_OAUTH_CALLBACK_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new AppError(
      'CONFIG_INVALID',
      'MANAGEABLE_MCP_OAUTH_CALLBACK_PORT 必须是 0 到 65535 之间的整数',
    );
  }
  return parsed;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPage(options: {
  title: string;
  heading: string;
  message: string;
  tone: 'success' | 'error';
}): string {
  const accent = options.tone === 'success' ? '#0f766e' : '#b91c1c';
  const badge = options.tone === 'success' ? '已授权' : '未授权';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #f8fafc;
      color: #0f172a;
    }
    main {
      width: min(560px, 100%);
      padding: 32px;
      border-radius: 18px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      box-shadow: 0 18px 50px rgb(15 23 42 / 8%);
    }
    .badge {
      display: inline-block;
      margin-bottom: 18px;
      padding: 4px 10px;
      border-radius: 999px;
      background: color-mix(in srgb, ${accent} 12%, white);
      color: ${accent};
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    h1 { margin: 0 0 12px; font-size: 26px; line-height: 1.2; }
    p { margin: 0; color: #475569; }
    .hint { margin-top: 22px; font-size: 14px; color: #64748b; }
    @media (prefers-color-scheme: dark) {
      body { background: #020617; color: #e2e8f0; }
      main { background: #0f172a; border-color: #1e293b; box-shadow: none; }
      p { color: #cbd5e1; }
      .hint { color: #94a3b8; }
    }
  </style>
</head>
<body>
  <main>
    <div class="badge">${escapeHtml(badge)}</div>
    <h1>${escapeHtml(options.heading)}</h1>
    <p>${escapeHtml(options.message)}</p>
    <p class="hint">你可以关闭此窗口并返回 manageable-mcp。</p>
  </main>
</body>
</html>`;
}

function sendHtml(
  response: ServerResponse,
  statusCode: number,
  html: string,
  extraHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(html, 'utf8');
  response.statusCode = statusCode;
  response.shouldKeepAlive = false;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Content-Length', String(body.byteLength));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  );
  for (const [key, value] of Object.entries(extraHeaders)) response.setHeader(key, value);
  response.end(body);
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  text: string,
  extraHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(`${text}\n`, 'utf8');
  response.statusCode = statusCode;
  response.shouldKeepAlive = false;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Length', String(body.byteLength));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [key, value] of Object.entries(extraHeaders)) response.setHeader(key, value);
  response.end(body);
}

async function collectSecrets(flow: PendingOAuthFlow): Promise<string[]> {
  const values: string[] = [];
  if (flow.provider.redactionSecrets !== undefined) {
    try {
      values.push(...(await flow.provider.redactionSecrets()));
    } catch {
      // Redaction is best-effort; a store read failure must not mask the auth error.
    }
  }
  return values;
}

async function handleCallback(
  request: IncomingMessage,
  response: ServerResponse,
  logger: Logger,
): Promise<void> {
  const localPort = request.socket.localPort ?? 0;
  const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${localPort}`);

  if (requestUrl.pathname !== CALLBACK_PATH) {
    sendText(response, 404, '未找到');
    return;
  }
  if (request.method !== 'GET') {
    sendText(response, 405, '请求方法不允许', { Allow: 'GET' });
    return;
  }

  const state = requestUrl.searchParams.get('state') ?? '';
  const flow = takePendingOAuthFlow(state);
  if (flow === undefined) {
    logger.warn('Rejected OAuth callback with an invalid or expired state');
    sendHtml(
      response,
      400,
      renderPage({
        title: '授权失败',
        heading: '授权请求无效或已过期',
        message:
          '此回调与任何待处理的 OAuth 请求都不匹配。请重新发起连接以获取新的授权 URL。',
        tone: 'error',
      }),
    );
    return;
  }

  if (flow.callbackPort !== localPort) {
    logger.warn('Rejected OAuth callback on the wrong local callback port', {
      server: flow.serverName,
    });
    sendHtml(
      response,
      400,
      renderPage({
        title: '授权失败',
        heading: '回调地址不正确',
        message: '此授权响应被发送到了预期之外的本地回调端口。',
        tone: 'error',
      }),
    );
    return;
  }

  const oauthError = requestUrl.searchParams.get('error');
  if (oauthError !== null) {
    const description = requestUrl.searchParams.get('error_description') ?? oauthError;
    const secrets = [...(await collectSecrets(flow)), state];
    const safeDescription = sanitizeErrorMessage(description, secrets);
    logger.warn('OAuth authorization was denied', {
      server: flow.serverName,
      error: safeDescription,
    });
    sendHtml(
      response,
      400,
      renderPage({
        title: '授权失败',
        heading: '授权未完成',
        message: safeDescription || '授权服务器返回了错误。',
        tone: 'error',
      }),
    );
    return;
  }

  const code = requestUrl.searchParams.get('code');
  if (code === null || code.length === 0) {
    logger.warn('OAuth callback did not include an authorization code', { server: flow.serverName });
    sendHtml(
      response,
      400,
      renderPage({
        title: '授权失败',
        heading: '缺少授权码',
        message: '授权服务器没有返回授权码。请重新发起连接。',
        tone: 'error',
      }),
    );
    return;
  }

  const secrets = [...(await collectSecrets(flow)), state, code];
  try {
    const result = await auth(flow.provider, {
      serverUrl: flow.serverUrl,
      authorizationCode: code,
      ...(flow.fetchFn === undefined ? {} : { fetchFn: flow.fetchFn }),
    });
    if (result !== 'AUTHORIZED') {
      throw new Error('OAuth 授权码交换未完成授权');
    }
    logger.info('OAuth callback completed', { server: flow.serverName });
    sendHtml(
      response,
      200,
      renderPage({
        title: '授权完成',
        heading: '授权完成',
        message: `manageable-mcp 已获得 '${flow.serverName}' 的授权。下次连接将使用已保存的令牌。`,
        tone: 'success',
      }),
    );
  } catch (error) {
    const safeError = sanitizeErrorMessage(
      error instanceof Error ? error.message : String(error),
      secrets,
    );
    logger.error('OAuth callback failed', {
      server: flow.serverName,
      error: safeError,
    });
    sendHtml(
      response,
      500,
      renderPage({
        title: '授权失败',
        heading: '无法完成授权',
        message: safeError || '授权码交换失败。请重新发起连接。',
        tone: 'error',
      }),
    );
  }
}

function startCallbackServer(
  requestedPort: number,
  logger: Logger,
): Promise<OAuthCallbackServerHandle> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer((request, response) => {
      void handleCallback(request, response, logger).catch((error: unknown) => {
        logger.error('OAuth callback handler failed', {
          error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        });
        if (!response.headersSent) sendText(response, 500, 'OAuth 回调内部错误');
        else response.destroy();
      });
    });

    const rejectStart = (error: Error): void => {
      httpServer.close(() => undefined);
      reject(
        new AppError(
          'INTERNAL_ERROR',
          `无法在 127.0.0.1:${requestedPort} 启动 OAuth 回调服务器：${sanitizeErrorMessage(
            error.message,
          )}`,
        ),
      );
    };

    httpServer.once('error', rejectStart);
    httpServer.listen(requestedPort, '127.0.0.1', () => {
      httpServer.removeListener('error', rejectStart);
      httpServer.on('error', (error) => {
        logger.error('OAuth callback server error', {
          error: sanitizeErrorMessage(error.message),
        });
      });

      const address = httpServer.address();
      if (address === null || typeof address === 'string') {
        httpServer.close(() => undefined);
        reject(new AppError('INTERNAL_ERROR', 'OAuth 回调服务器未暴露 TCP 地址'));
        return;
      }

      httpServer.unref();
      let closing: Promise<void> | undefined;
      const handle: OAuthCallbackServerHandle = {
        port: address.port,
        callbackUrl: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
        close: async (): Promise<void> => {
          if (closing !== undefined) return await closing;
          closing = new Promise<void>((resolveClose) => {
            if (!httpServer.listening) {
              resolveClose();
              return;
            }
            httpServer.close(() => resolveClose());
            httpServer.closeAllConnections?.();
          });
          await closing;
        },
      };

      resolve(handle);
    });
  });
}

export async function getOrStartOAuthCallbackServer(
  requestedPort: number,
  logger: Logger,
): Promise<OAuthCallbackServerHandle> {
  const existing = callbackServers.get(requestedPort);
  if (existing !== undefined) return existing;

  const pending = callbackServerStarts.get(requestedPort);
  if (pending !== undefined) return await pending;

  const start = startCallbackServer(requestedPort, logger)
    .then((handle) => {
      callbackServers.set(requestedPort, handle);
      return handle;
    })
    .finally(() => {
      callbackServerStarts.delete(requestedPort);
    });
  callbackServerStarts.set(requestedPort, start);
  return await start;
}

export async function closeAllOAuthCallbackServers(): Promise<void> {
  const handles = Array.from(callbackServers.values());
  callbackServers.clear();
  const starts = Array.from(callbackServerStarts.values());
  callbackServerStarts.clear();
  const startedHandles = await Promise.allSettled(starts);
  for (const result of startedHandles) {
    if (result.status === 'fulfilled') handles.push(result.value);
  }
  await Promise.all(handles.map(async (handle) => await handle.close()));
  callbackServers.clear();
}
