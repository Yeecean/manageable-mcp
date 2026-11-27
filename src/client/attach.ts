import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { AppError, errorMessage } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { VERSION } from '../version.js';
import { sanitizeEndpoint, sanitizeErrorMessage } from './sanitize.js';

export { sanitizeEndpoint, sanitizeErrorMessage };

export interface AttachOptions {
  url: string;
  authToken?: string;
  logger: Logger;
  timeoutMs?: number;
}

const DEFAULT_ATTACH_TIMEOUT_MS = 15_000;
const DEFAULT_ATTACH_REQUEST_TIMEOUT_MS = 60_000;

function waitForShutdown(register?: (finish: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      process.stdin.off('end', finish);
      process.stdin.off('close', finish);
      process.stdin.off('error', finish);
      resolve();
    };

    register?.(finish);
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      finish();
      return;
    }
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    process.stdin.once('end', finish);
    process.stdin.once('close', finish);
    process.stdin.once('error', finish);
  });
}

export async function runStdioAttached(options: AttachOptions): Promise<void> {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new AppError('INVALID_PARAMETERS', '无效的 --attach URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(
      'INVALID_PARAMETERS',
      `--attach URL 必须使用 http:// 或 https://，实际为 '${url.protocol}'`,
    );
  }

  const endpoint = sanitizeEndpoint(options.url);
  const connectTimeoutMs = options.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
  const requestTimeoutMs = options.timeoutMs ?? DEFAULT_ATTACH_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new AppError('INVALID_PARAMETERS', 'attach 超时必须是大于 0 的毫秒数');
  }

  const headers: Record<string, string> =
    options.authToken === undefined
      ? {}
      : { Authorization: `Bearer ${options.authToken}` };
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: Object.keys(headers).length === 0 ? undefined : { headers },
  });
  const client = new Client(
    { name: 'manageable-mcp-attach', version: VERSION },
    { capabilities: {} },
  );

  try {
    await client.connect(transport, {
      timeout: connectTimeoutMs,
      signal: AbortSignal.timeout(connectTimeoutMs),
    });
  } catch (error) {
    try {
      await client.close();
    } catch {
      // The connection never opened.
    }
    throw new AppError(
      'SERVER_UNAVAILABLE',
      `无法连接到 ${endpoint}：${sanitizeErrorMessage(errorMessage(error))}\n` +
        '请确认守护进程正在运行，URL 指向 /mcp 或 /mcp/<group>，' +
        '且所需的 bearer token 正确。',
    );
  }

  const remoteCapabilities = client.getServerCapabilities() ?? {};
  const server = new Server(
    { name: 'manageable-mcp-attach', version: VERSION },
    {
      capabilities: {
        ...(remoteCapabilities.tools ? { tools: {} } : {}),
        ...(remoteCapabilities.prompts ? { prompts: {} } : {}),
      },
    },
  );

  if (remoteCapabilities.tools) {
    server.setRequestHandler(
      ListToolsRequestSchema,
      async (request, extra): Promise<ListToolsResult> =>
        await client.listTools(request.params, {
          signal: extra.signal,
          timeout: requestTimeoutMs,
        }),
    );
    server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra): Promise<CallToolResult> =>
        (await client.callTool(request.params, undefined, {
          signal: extra.signal,
          timeout: requestTimeoutMs,
        })) as CallToolResult,
    );
  }

  if (remoteCapabilities.prompts) {
    server.setRequestHandler(
      ListPromptsRequestSchema,
      async (request, extra): Promise<ListPromptsResult> =>
        await client.listPrompts(request.params, {
          signal: extra.signal,
          timeout: requestTimeoutMs,
        }),
    );
    server.setRequestHandler(
      GetPromptRequestSchema,
      async (request, extra): Promise<GetPromptResult> =>
        await client.getPrompt(request.params, {
          signal: extra.signal,
          timeout: requestTimeoutMs,
        }),
    );
  }

  const stdioTransport = new StdioServerTransport();
  try {
    await server.connect(stdioTransport);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new AppError(
      'INTERNAL_ERROR',
      `启动 stdio attach 桥接失败：${sanitizeErrorMessage(errorMessage(error))}`,
    );
  }

  options.logger.info('stdio attach 已连接', {
    url: endpoint,
    tools: remoteCapabilities.tools !== undefined,
    prompts: remoteCapabilities.prompts !== undefined,
  });

  let triggerShutdown: () => void = () => undefined;
  await waitForShutdown((finish) => {
    triggerShutdown = finish;
    server.onclose = finish;
    client.onclose = finish;
  });
  triggerShutdown();

  options.logger.info('stdio attach 已断开', { url: endpoint });

  try {
    await server.close();
  } catch {
    // The client may already have closed the stream.
  }
  try {
    await client.close();
  } catch {
    // Best-effort cleanup.
  }
}
