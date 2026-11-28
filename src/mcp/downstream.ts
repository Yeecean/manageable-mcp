import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  type CallToolResult,
  type GetPromptResult,
  type Prompt,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  AppError,
  OAuthAuthorizationRequiredError,
  errorMessage,
} from '../core/errors.js';
import { silentLogger, type Logger } from '../core/logger.js';
import { TimeoutError, withTimeout } from '../core/timeout.js';
import type { ServerConfig } from '../config/types.js';
import { createOAuthProvider } from '../oauth/index.js';
import { sanitizeErrorMessage, sanitizeStructuredValue } from '../oauth/sanitize.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { normalizeDownstreamToolResult } from './result.js';

const MAX_TOOL_PAGES = 100;
const MAX_PROMPT_PAGES = 100;
const TASKKILL_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);
const PERMISSIVE_CALL_TOOL_RESULT_SCHEMA = z.object({
  content: z.array(z.unknown()).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
  _meta: z.unknown().optional(),
  toolResult: z.unknown().optional(),
}).loose() as unknown as typeof CallToolResultSchema;

export interface DownstreamConnection {
  readonly promptsSupported: boolean;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  listPrompts(): Promise<Prompt[]>;
  getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<GetPromptResult>;
  ping(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

function processEnv(extra: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  return { ...result, ...extra };
}

function configSecrets(config: ServerConfig): readonly string[] {
  const values = new Set<string>();
  for (const value of Object.values(config.headers)) values.add(value);
  for (const value of Object.values(config.oauth?.extraHeaders ?? {})) values.add(value);
  if (config.oauth?.clientSecret !== undefined) values.add(config.oauth.clientSecret);

  if (config.url !== undefined) {
    try {
      const url = new URL(config.url);
      values.add(url.username);
      values.add(url.password);
      for (const value of url.searchParams.values()) values.add(value);
    } catch {
      // URL validation happens before downstream connection.
    }
  }

  return Array.from(values).filter((value) => value.length >= 3);
}

function downstreamFailureMessage(
  error: unknown,
  context: string,
  secrets: readonly string[],
): string {
  if (error instanceof StreamableHTTPError) {
    const status = typeof error.code === 'number' && error.code > 0
      ? `HTTP ${error.code}`
      : 'HTTP 请求';
    return `${context}失败（${status}）`;
  }
  return `${context}失败：${sanitizeErrorMessage(errorMessage(error), secrets)}`;
}

function throwDownstreamError(
  error: unknown,
  context: string,
  secrets: readonly string[],
): never {
  if (
    error instanceof TimeoutError ||
    error instanceof OAuthAuthorizationRequiredError ||
    error instanceof AppError
  ) {
    throw error;
  }
  throw new Error(downstreamFailureMessage(error, context, secrets));
}

function sanitizeToolErrorResult(
  result: CallToolResult,
  secrets: readonly string[],
): CallToolResult {
  if (result.isError !== true) return result;
  return {
    ...result,
    content: result.content.map(
      (item) => sanitizeStructuredValue(item, secrets) as typeof item,
    ),
    ...(result.structuredContent === undefined
      ? {}
      : {
          structuredContent: sanitizeStructuredValue(
            result.structuredContent,
            secrets,
          ) as Record<string, unknown>,
        }),
    ...(result._meta === undefined
      ? {}
      : {
          _meta: sanitizeStructuredValue(
            result._meta,
            secrets,
          ) as Record<string, unknown>,
        }),
  };
}

async function killWindowsProcessTree(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    await execFileAsync(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function closeClient(
  client: Client,
  transport: StdioClientTransport | StreamableHTTPClientTransport,
  secrets: readonly string[],
  logger: Logger,
): Promise<void> {
  const pid = transport instanceof StdioClientTransport ? transport.pid : null;
  let closeError: unknown;
  let closePromise: Promise<void>;
  // The SDK can reap the wrapper before a later /T walk sees its children.
  const killedBeforeClose = pid === null ? true : await killWindowsProcessTree(pid);
  try {
    closePromise = client.close().catch((error: unknown) => {
      closeError = error;
    });
  } catch (error) {
    closeError = error;
    closePromise = Promise.resolve();
  }

  const killedAfterClose = pid === null ? true : await killWindowsProcessTree(pid);
  await closePromise;
  if (pid !== null && !killedBeforeClose && !killedAfterClose) {
    logger.debug('Windows 下游进程树清理未完成', { pid });
  }
  if (closeError !== undefined) {
    throw new Error(`关闭下游连接失败：${sanitizeErrorMessage(errorMessage(closeError), secrets)}`);
  }
}

export async function connectDownstream(
  config: ServerConfig,
  logger: Logger = silentLogger,
): Promise<DownstreamConnection> {
  const client = new Client(
    { name: `${PACKAGE_NAME}-client`, version: VERSION },
    { capabilities: {} },
  );
  const secrets = configSecrets(config);

  const oauthProvider = config.url === undefined
    ? undefined
    : createOAuthProvider(config.name, config.url, config.oauth ?? {}, logger);
  if (oauthProvider !== undefined && (config.oauth !== undefined || oauthProvider.callbackPort === 0)) {
    await oauthProvider.ready;
  }
  const transport = config.url
    ? new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: config.headers,
        },
        ...(oauthProvider === undefined
          ? {}
          : { authProvider: oauthProvider, fetch: oauthProvider.oauthFetch }),
      })
    : new StdioClientTransport({
        command: config.command as string,
        args: config.args,
        cwd: config.cwd,
        env: processEnv(config.env),
        stderr: 'inherit',
      });

  try {
    await withTimeout(
      client.connect(transport, { timeout: config.timeoutMs }),
      config.timeoutMs,
      `连接 '${config.name}'`,
    );
  } catch (error) {
    await closeClient(client, transport, secrets, logger).catch(() => undefined);
    if (error instanceof OAuthAuthorizationRequiredError) throw error;
    if (isOAuthAuthorizationError(error) && oauthProvider?.lastAuthorizationUrl !== undefined) {
      throw new OAuthAuthorizationRequiredError(oauthProvider.lastAuthorizationUrl);
    }
    if (error instanceof TimeoutError) throw error;
    throwDownstreamError(error, `连接 '${config.name}'`, secrets);
  }

  let closed = false;
  return {
    get promptsSupported(): boolean {
      return client.getServerCapabilities()?.prompts !== undefined;
    },

    async listTools(): Promise<Tool[]> {
      const tools: Tool[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      try {
        for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
          const result = await withTimeout(
            client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: config.timeoutMs }),
            config.timeoutMs,
            `在 '${config.name}' 上执行 tools/list`,
          );
          tools.push(...result.tools);

          if (!result.nextCursor) return tools;
          if (seenCursors.has(result.nextCursor)) {
            throw new Error(`服务器 '${config.name}' 在 tools/list 中重复返回分页游标`);
          }
          seenCursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
      } catch (error) {
        throwDownstreamError(error, `在 '${config.name}' 上执行 tools/list`, secrets);
      }

      throw new AppError(
        'PAGINATION_LIMIT',
        `PAGINATION_LIMIT：服务器 '${config.name}' 的 tools/list 分页超过 ${MAX_TOOL_PAGES} 页上限`,
        { server: config.name, limit: MAX_TOOL_PAGES },
      );
    },

    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
      try {
        const rawResult = await withTimeout(
          client.callTool({ name, arguments: args }, PERMISSIVE_CALL_TOOL_RESULT_SCHEMA, {
            timeout: config.timeoutMs,
            ...(signal === undefined ? {} : { signal }),
          }),
          config.timeoutMs,
          `在 '${config.name}' 上执行 tools/call '${name}'`,
        ) as unknown;
        return sanitizeToolErrorResult(
          normalizeDownstreamToolResult(rawResult),
          secrets,
        );
      } catch (error) {
        throwDownstreamError(
          error,
          `在 '${config.name}' 上执行 tools/call '${name}'`,
          secrets,
        );
      }
    },

    async listPrompts(): Promise<Prompt[]> {
      const prompts: Prompt[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      try {
        for (let page = 0; page < MAX_PROMPT_PAGES; page += 1) {
          const result = await withTimeout(
            client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout: config.timeoutMs }),
            config.timeoutMs,
            `在 '${config.name}' 上执行 prompts/list`,
          );
          prompts.push(...result.prompts);
          if (!result.nextCursor) return prompts;
          if (seenCursors.has(result.nextCursor)) {
            throw new Error(`服务器 '${config.name}' 在 prompts/list 中重复返回分页游标`);
          }
          seenCursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
      } catch (error) {
        throwDownstreamError(error, `在 '${config.name}' 上执行 prompts/list`, secrets);
      }

      throw new AppError(
        'PAGINATION_LIMIT',
        `PAGINATION_LIMIT：服务器 '${config.name}' 的 prompts/list 分页超过 ${MAX_PROMPT_PAGES} 页上限`,
        { server: config.name, limit: MAX_PROMPT_PAGES },
      );
    },

    async getPrompt(
      name: string,
      args?: Record<string, string>,
      signal?: AbortSignal,
    ): Promise<GetPromptResult> {
      try {
        return await withTimeout(
          client.getPrompt({ name, ...(args === undefined ? {} : { arguments: args }) }, {
            timeout: config.timeoutMs,
            ...(signal === undefined ? {} : { signal }),
          }),
          config.timeoutMs,
          `在 '${config.name}' 上执行 prompts/get '${name}'`,
        );
      } catch (error) {
        throwDownstreamError(
          error,
          `在 '${config.name}' 上执行 prompts/get '${name}'`,
          secrets,
        );
      }
    },

    async ping(signal?: AbortSignal): Promise<void> {
      try {
        await withTimeout(
          client.ping({
            timeout: config.timeoutMs,
            ...(signal === undefined ? {} : { signal }),
          }),
          config.timeoutMs,
          `向 '${config.name}' 发送 ping`,
        );
      } catch (error) {
        throwDownstreamError(error, `向 '${config.name}' 发送 ping`, secrets);
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeClient(client, transport, secrets, logger);
    },
  };
}

function isOAuthAuthorizationError(error: unknown): boolean {
  const message = errorMessage(error);
  return /unauthorized|authorization required|oauth/i.test(message);
}
