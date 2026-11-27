import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AppError, errorMessage } from '../core/errors.js';
import { VERSION } from '../version.js';
import { readCliEndpoint, removeCliEndpoint, type CliEndpoint } from './endpoint.js';
import { sanitizeEndpoint, sanitizeErrorMessage } from './sanitize.js';

export type OneShotCommandKind = 'call' | 'list-commands' | 'describe' | 'auth';

export const ONE_SHOT_COMMANDS = new Set<string>(['call', 'list-commands', 'describe', 'auth']);
export const ONE_SHOT_VALUE_FLAGS = new Set<string>([
  '--url',
  '--auth-token',
  '--timeout',
  '--params-file',
]);
export const ONE_SHOT_BOOLEAN_FLAGS = new Set<string>(['--json', '--wait']);
export const ONE_SHOT_FLAGS = new Set<string>([
  ...ONE_SHOT_VALUE_FLAGS,
  ...ONE_SHOT_BOOLEAN_FLAGS,
]);

export const DEFAULT_ONE_SHOT_TIMEOUT_MS = 60_000;
const AUTH_POLL_INTERVAL_MS = 1_000;
const AUTH_URL_MARKER = 'Open this URL in your browser to authorize:';

export interface OneShotCommand {
  kind: OneShotCommandKind;
  server: string;
  command?: string;
  commands?: string[];
  parameters?: Record<string, unknown>;
  paramsFile?: string;
  url?: string;
  authToken?: string;
  json: boolean;
  wait: boolean;
  timeoutMs: number;
}

export interface ResolvedOneShotEndpoint {
  url: string;
  authToken?: string;
  source: string;
  discovered?: CliEndpoint;
}

export interface OneShotToolResult {
  content?: Array<Record<string, unknown> & { type?: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

function usage(kind: OneShotCommandKind): string {
  switch (kind) {
    case 'call':
      return 'manageable-mcp call <server> <command> [json-object|-] [--params-file PATH] [--json] [--url URL] [--timeout SECONDS]';
    case 'list-commands':
      return 'manageable-mcp list-commands <server> [--json] [--url URL] [--timeout SECONDS]';
    case 'describe':
      return 'manageable-mcp describe <server> <command...> [--json] [--url URL] [--timeout SECONDS]';
    case 'auth':
      return 'manageable-mcp auth <server> [--wait] [--json] [--url URL] [--timeout SECONDS]';
  }
}

function parametersError(message: string): AppError {
  return new AppError('INVALID_PARAMETERS', message);
}

function parseParameters(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw parametersError(`参数必须是有效的 JSON：${errorMessage(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw parametersError('参数必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

export function parseOneShotCommand(args: string[]): OneShotCommand {
  const rawKind = args[0];
  if (rawKind === undefined || !ONE_SHOT_COMMANDS.has(rawKind)) {
    throw parametersError(`未知客户端命令 '${rawKind ?? ''}'`);
  }
  const kind = rawKind as OneShotCommandKind;

  const positional: string[] = [];
  let url: string | undefined;
  let authToken: string | undefined;
  let paramsFile: string | undefined;
  let json = false;
  let wait = false;
  let timeoutMs = DEFAULT_ONE_SHOT_TIMEOUT_MS;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (ONE_SHOT_VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.length === 0) {
        throw parametersError(`${arg} 需要提供值`);
      }
      if (value.startsWith('-') && !(arg === '--params-file' && value === '-')) {
        throw parametersError(`${arg} 需要提供值`);
      }
      if (arg === '--url') {
        url = value;
      } else if (arg === '--auth-token') {
        authToken = value;
      } else if (arg === '--params-file') {
        paramsFile = value;
      } else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw parametersError('--timeout 必须是大于 0 的秒数');
        }
        timeoutMs = seconds * 1_000;
      }
      i += 1;
    } else if (ONE_SHOT_BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--json') json = true;
      if (arg === '--wait') wait = true;
    } else if (arg === '-') {
      positional.push(arg);
    } else if (arg.startsWith('-')) {
      throw parametersError(`命令 ${kind} 不支持选项 ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (wait && kind !== 'auth') {
    throw parametersError('--wait 仅适用于 auth');
  }
  if (paramsFile !== undefined && kind !== 'call') {
    throw parametersError('--params-file 仅适用于 call');
  }

  const flags = {
    json,
    wait,
    timeoutMs,
    ...(url === undefined ? {} : { url }),
    ...(authToken === undefined ? {} : { authToken }),
  };

  if (kind === 'call') {
    if (positional.length < 2 || positional.length > 3) {
      throw parametersError(`用法：${usage(kind)}`);
    }
    const server = positional[0] as string;
    const command = positional[1] as string;
    const positionalParameters = positional[2];
    if (paramsFile !== undefined && positionalParameters !== undefined) {
      throw parametersError('位置参数与 --params-file 只能二选一');
    }
    const source = paramsFile ?? (positionalParameters === '-' ? '-' : undefined);
    return {
      kind,
      server,
      command,
      ...flags,
      ...(source === undefined
        ? { parameters: parseParameters(positionalParameters) }
        : { paramsFile: source }),
    };
  }

  if (kind === 'list-commands') {
    if (positional.length !== 1) {
      throw parametersError(`用法：${usage(kind)}`);
    }
    return { kind, server: positional[0] as string, ...flags };
  }

  if (kind === 'describe') {
    if (positional.length < 2) {
      throw parametersError(`用法：${usage(kind)}`);
    }
    return {
      kind,
      server: positional[0] as string,
      commands: positional.slice(1),
      ...flags,
    };
  }

  if (positional.length !== 1) {
    throw parametersError(`用法：${usage(kind)}`);
  }
  return { kind, server: positional[0] as string, ...flags };
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function daemonUnavailable(tried: string): AppError {
  return new AppError(
    'SERVER_UNAVAILABLE',
    '没有可用的 manageable-mcp HTTP 守护进程。\n' +
      `已尝试：${sanitizeErrorMessage(tried)}\n` +
      '可通过以下命令启动：manageable-mcp --transport http --cli\n' +
      '或使用 --url <URL> 指定守护进程。',
  );
}

export function resolveOneShotEndpoint(
  command: Pick<OneShotCommand, 'url' | 'authToken'>,
): ResolvedOneShotEndpoint {
  const envToken = envValue('MANAGEABLE_MCP_AUTH_TOKEN');
  if (command.url !== undefined) {
    const authToken = command.authToken ?? envToken;
    return {
      url: command.url,
      source: '--url',
      ...(authToken === undefined ? {} : { authToken }),
    };
  }

  const envUrl = envValue('MANAGEABLE_MCP_URL');
  if (envUrl !== undefined) {
    const authToken = command.authToken ?? envToken;
    return {
      url: envUrl,
      source: 'MANAGEABLE_MCP_URL',
      ...(authToken === undefined ? {} : { authToken }),
    };
  }

  let discovered: CliEndpoint;
  try {
    discovered = readCliEndpoint();
  } catch (error) {
    throw daemonUnavailable(errorMessage(error));
  }
  const authToken = command.authToken ?? envToken ?? discovered.authToken;
  return {
    url: discovered.url,
    source: 'CLI 端点文件',
    discovered,
    ...(authToken === undefined ? {} : { authToken }),
  };
}

function loadCallParameters(command: OneShotCommand): Record<string, unknown> {
  if (command.paramsFile === undefined) return command.parameters ?? {};
  try {
    const input =
      command.paramsFile === '-'
        ? fs.readFileSync(0, 'utf8')
        : fs.readFileSync(command.paramsFile, 'utf8');
    return parseParameters(input);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw parametersError(
      `无法从 ${command.paramsFile} 读取参数：${sanitizeErrorMessage(errorMessage(error))}`,
    );
  }
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      /timed? out|timeout/i.test(error.message)
    );
  }
  return /timed? out|timeout/i.test(String(error));
}

interface ErrorWithStatus extends Error {
  code?: string | number;
  status?: string | number;
  statusCode?: string | number;
  cause?: unknown;
}

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current = error as ErrorWithStatus | undefined;
  while (current) {
    parts.push(String(current.code ?? ''), current.message ?? '');
    current = current.cause as ErrorWithStatus | undefined;
  }
  return parts.join(' ');
}

function connectionHttpStatus(error: unknown): string | undefined {
  let current = error as ErrorWithStatus | undefined;
  while (current) {
    for (const value of [current.status, current.statusCode, current.code]) {
      if (String(value) === '401' || String(value) === '403') return String(value);
    }
    const status = current.message?.match(/HTTP (401|403)/)?.[1];
    if (status !== undefined) return status;
    current = current.cause as ErrorWithStatus | undefined;
  }
  return undefined;
}

function isJsonRpcAuthError(error: unknown): boolean {
  let current = error as ErrorWithStatus | undefined;
  while (current) {
    if (Number(current.code) === -32001 || /^Unauthorized\b/i.test(current.message ?? '')) {
      return true;
    }
    const jsonStart = current.message?.indexOf('{') ?? -1;
    if (jsonStart >= 0) {
      try {
        const response = JSON.parse(current.message.slice(jsonStart)) as {
          jsonrpc?: unknown;
          error?: { code?: unknown; message?: unknown };
        };
        if (
          response.jsonrpc === '2.0' &&
          response.error !== undefined &&
          (response.error.code === -32001 ||
            (typeof response.error.message === 'string' &&
              /^Unauthorized\b/i.test(response.error.message)))
        ) {
          return true;
        }
      } catch {
        // Not a JSON-RPC response body.
      }
    }
    current = current.cause as ErrorWithStatus | undefined;
  }
  return false;
}

function isUnreachableError(error: unknown): boolean {
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|fetch failed/i.test(
    errorChain(error),
  );
}

async function connect(
  endpoint: ResolvedOneShotEndpoint,
  timeoutMs: number,
): Promise<Client> {
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    throw new AppError(
      'INVALID_PARAMETERS',
      `来自 ${endpoint.source} 的 manageable-mcp URL 无效`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(
      'INVALID_PARAMETERS',
      `${endpoint.source} 的 URL 必须使用 http:// 或 https://`,
    );
  }
  const displayUrl = sanitizeEndpoint(endpoint.url);
  const headers: Record<string, string> =
    endpoint.authToken === undefined
      ? {}
      : { Authorization: `Bearer ${endpoint.authToken}` };
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: Object.keys(headers).length === 0 ? undefined : { headers },
  });
  const client = new Client(
    { name: 'manageable-mcp-cli', version: VERSION },
    { capabilities: {} },
  );

  try {
    await client.connect(transport, {
      timeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    try {
      await client.close();
    } catch {
      // The connection never opened.
    }
    const message = errorMessage(error);
    if (isTimeoutError(error)) {
      throw new AppError(
        'TIMEOUT',
        `连接 ${displayUrl} 超时（${timeoutMs / 1_000} 秒）`,
      );
    }
    const status = connectionHttpStatus(error);
    if (status !== undefined || isJsonRpcAuthError(error)) {
      throw new AppError(
        'AUTH_REQUIRED',
        `${displayUrl} 上的 manageable-mcp 守护进程拒绝了 bearer token` +
          `（HTTP ${status ?? '401'}）。请检查 --auth-token 或 MANAGEABLE_MCP_AUTH_TOKEN。`,
      );
    }
    if (isUnreachableError(error)) {
      if (endpoint.discovered !== undefined) removeCliEndpoint(endpoint.discovered);
      throw daemonUnavailable(`${displayUrl} (${endpoint.source}): ${sanitizeErrorMessage(message)}`);
    }
    throw new AppError(
      'SERVER_UNAVAILABLE',
      `${displayUrl} 上的 manageable-mcp 守护进程有响应，但 MCP 初始化失败：` +
        sanitizeErrorMessage(message),
    );
  }
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<OneShotToolResult> {
  try {
    return (await client.callTool(
      { name, arguments: args },
      undefined,
      {
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
      },
    )) as OneShotToolResult;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isTimeoutError(error)) {
      throw new AppError('TIMEOUT', `等待 ${name} 超时（${timeoutMs / 1_000} 秒）`);
    }
    throw new AppError(
      'SERVER_UNAVAILABLE',
      `调用 ${name} 失败：${sanitizeErrorMessage(errorMessage(error))}`,
    );
  }
}

function contentText(result: OneShotToolResult): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

function parseNestedResult(result: OneShotToolResult): unknown {
  const text = contentText(result);
  if (text.length === 0) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function renderContent(value: unknown): string {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { content?: unknown }).content)) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
  return ((value as { content: unknown[] }).content)
    .map((block) => {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text;
      }
      return JSON.stringify(block, null, 2);
    })
    .join('\n');
}

function resultIsError(result: OneShotToolResult, nested: unknown): boolean {
  return (
    result.isError === true ||
    (nested !== null &&
      typeof nested === 'object' &&
      (nested as { isError?: unknown }).isError === true)
  );
}

export function extractAuthUrl(result: OneShotToolResult): string | undefined {
  const meta = result._meta?.['manageableMcpProxyError'];
  if (meta !== null && typeof meta === 'object') {
    const details = (meta as Record<string, unknown>).details;
    if (details !== null && typeof details === 'object') {
      const nested = (details as Record<string, unknown>).authUrl;
      if (typeof nested === 'string' && nested.length > 0) return nested;
    }
    const direct = (meta as Record<string, unknown>).authUrl;
    if (typeof direct === 'string' && direct.length > 0) return direct;
  }

  const text = contentText(result);
  const markerIndex = text.indexOf(AUTH_URL_MARKER);
  if (markerIndex >= 0) {
    const match = text
      .slice(markerIndex + AUTH_URL_MARKER.length)
      .match(/https?:\/\/[^\s"'<>]+/);
    if (match !== null) return match[0];
  }
  return undefined;
}

function writeAuthState(
  command: OneShotCommand,
  write: (output: string) => void,
  authenticated: boolean,
  authUrl?: string,
): void {
  if (command.json) {
    write(
      JSON.stringify({
        server: command.server,
        authenticated,
        ...(authUrl === undefined ? {} : { authUrl }),
      }),
    );
  } else if (authenticated) {
    write(`服务器 '${command.server}' 已完成认证。`);
  } else if (authUrl !== undefined) {
    write(authUrl);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeToolResult(
  command: OneShotCommand,
  result: OneShotToolResult,
  write: (output: string) => void,
  writeError: (output: string) => void,
): number {
  const nested = parseNestedResult(result);
  const failed = resultIsError(result, nested);
  if (command.json) {
    write(JSON.stringify(result, null, 2));
  } else {
    const output =
      command.kind === 'call'
        ? renderContent(nested)
        : typeof nested === 'string'
          ? nested
          : JSON.stringify(nested, null, 2);
    if (failed) writeError(output);
    else write(output);
  }
  return failed ? 1 : 0;
}

async function runAuth(
  command: OneShotCommand,
  client: Client,
  write: (output: string) => void,
  writeError: (output: string) => void,
): Promise<number> {
  const args = { server: command.server };
  let result = await callTool(client, 'list_commands', args, command.timeoutMs);
  const authUrl = extractAuthUrl(result);

  if (authUrl === undefined) {
    if (result.isError === true) {
      writeError(contentText(result));
      return 1;
    }
    writeAuthState(command, write, true);
    return 0;
  }

  writeAuthState(command, write, false, authUrl);
  if (!command.wait) return 0;

  for (;;) {
    await sleep(AUTH_POLL_INTERVAL_MS);
    result = await callTool(client, 'list_commands', args, command.timeoutMs);
    if (extractAuthUrl(result) !== undefined) continue;
    if (result.isError === true) {
      writeError(contentText(result));
      return 1;
    }
    writeAuthState(command, write, true);
    return 0;
  }
}

export async function runOneShotCommand(
  command: OneShotCommand,
  write: (output: string) => void = (output) => process.stdout.write(`${output}\n`),
  writeError: (output: string) => void = (output) => process.stderr.write(`${output}\n`),
): Promise<number> {
  const callParameters = command.kind === 'call' ? loadCallParameters(command) : undefined;
  const endpoint = resolveOneShotEndpoint(command);
  const client = await connect(endpoint, command.timeoutMs);

  try {
    switch (command.kind) {
      case 'call': {
        const result = await callTool(
          client,
          'invoke_command',
          {
            server: command.server,
            command_name: command.command,
            parameters: callParameters ?? {},
          },
          command.timeoutMs,
        );
        return writeToolResult(command, result, write, writeError);
      }
      case 'list-commands': {
        const result = await callTool(
          client,
          'list_commands',
          { server: command.server },
          command.timeoutMs,
        );
        return writeToolResult(command, result, write, writeError);
      }
      case 'describe': {
        const result = await callTool(
          client,
          'describe_commands',
          { server: command.server, command_names: command.commands },
          command.timeoutMs,
        );
        return writeToolResult(command, result, write, writeError);
      }
      case 'auth':
        return await runAuth(command, client, write, writeError);
    }
    throw new AppError('INTERNAL_ERROR', `不支持的一次性命令 '${command.kind}'`);
  } finally {
    try {
      await client.close();
    } catch {
      // Best-effort cleanup.
    }
  }
}
