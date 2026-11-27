import { getDefaultCliEndpointPath } from './config/paths.js';
import { AppError, errorMessage } from './core/errors.js';
import { createLogger, type LogLevel, type Logger } from './core/logger.js';
import { loadConfig } from './config/load.js';
import type { HealthConfig, HttpTransportConfig } from './config/types.js';
import { ServerManager } from './mcp/manager.js';
import { runStdioAttached } from './client/attach.js';
import {
  ONE_SHOT_COMMANDS,
  parseOneShotCommand,
  runOneShotCommand,
} from './client/one-shot.js';
import {
  isLoopbackUrl,
  removeCliEndpoint,
  writeCliEndpoint,
} from './client/endpoint.js';
import { refreshGroupScope, resolveGroupScope, type ProxyScope } from './mcp/proxy-scope.js';
import { closeAllOAuthCallbackServers } from './oauth/index.js';
import { startHttpServer } from './transports/http.js';
import { startStdioServer } from './transports/stdio.js';
import { PACKAGE_NAME, VERSION } from './version.js';

type TransportKind = 'stdio' | 'http';

const VALUE_FLAGS = new Set([
  '--config',
  '--transport',
  '--host',
  '--port',
  '--path',
  '--auth-token',
  '--log-level',
  '--group',
  '--attach',
]);

const BOOLEAN_FLAGS = new Set(['--help', '--version', '--ui', '--cli', '--health']);

function printHelp(): void {
  process.stdout.write(`用法：
  ${PACKAGE_NAME} [serve] [options]
  ${PACKAGE_NAME} --attach <url> [--auth-token <token>]
  ${PACKAGE_NAME} call <server> <command> [json-object|-] [options]
  ${PACKAGE_NAME} list-commands <server> [options]
  ${PACKAGE_NAME} describe <server> <command...> [options]
  ${PACKAGE_NAME} auth <server> [--wait] [options]

守护进程选项：
  --config <path>       servers.json 路径
  --transport <mode>    stdio（默认）或 http
  --host <host>         HTTP 绑定主机（默认 127.0.0.1）
  --port <port>         HTTP 端口（默认 8080）
  --path <path>         HTTP MCP 路径（默认 /mcp）
  --auth-token <token>  要求 HTTP 请求携带 bearer token
  --group <name>        将 stdio 会话限定到一个已配置分组
  --ui                  启用 /admin 和 /api/admin（仅 HTTP）
  --cli                 发布一次性 CLI 端点（仅 HTTP）
  --health              启用由活动触发的健康探测
  --log-level <level>   debug、info、warn 或 error（默认 info）

一次性命令选项：
  --url <url>           显式选择 HTTP 守护进程
  --auth-token <token>  守护进程的 bearer token
  --timeout <seconds>   请求超时（默认 60 秒）
  --params-file <path>  从 JSON 文件读取 call 参数，或用 - 从 stdin 读取
  --json                以 JSON 输出完整 MCP 结果
  --wait                等待 OAuth 授权完成

本地专用构建。不包含发布、旧别名或兼容模式。
`);
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const args = [...argv];
  let command = 'serve';
  if (args[0] && !args[0].startsWith('-')) command = args.shift() as string;

  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--help' || arg === '-h') {
      flags.set('--help', 'true');
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      flags.set('--version', 'true');
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.set(arg, 'true');
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new AppError('INVALID_PARAMETERS', `未知选项：${arg}`);
    }
    const value = args[i + 1];
    if (value === undefined || value.length === 0 || value.startsWith('-')) {
      throw new AppError('INVALID_PARAMETERS', `${arg} 需要提供值`);
    }
    flags.set(arg, value);
    i += 1;
  }
  return { command, flags };
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = value ?? 'info';
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') return level;
  throw new AppError('INVALID_PARAMETERS', `无效的 --log-level '${level}'`);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError('INVALID_PARAMETERS', `无效的端口 '${value}'`);
  }
  return port;
}

function envValue(name: string): string | undefined {
  return process.env[name] || undefined;
}

function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return value === 'localhost' || value === '::1' || value === '127.0.0.1' || value.startsWith('127.');
}

function httpOptions(
  config: HttpTransportConfig,
  flags: Map<string, string>,
): HttpTransportConfig {
  const port = parsePort(flags.get('--port') ?? envValue('MANAGEABLE_MCP_PORT'), config.port);
  const host = flags.get('--host') ?? envValue('MANAGEABLE_MCP_HOST') ?? config.host;
  const rawPath = flags.get('--path') ?? envValue('MANAGEABLE_MCP_PATH') ?? config.path;
  const mcpPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (mcpPath.includes('?') || mcpPath.includes('#')) {
    throw new AppError('INVALID_PARAMETERS', '--path 不能包含查询字符串或片段');
  }
  if (mcpPath === '/health') {
    throw new AppError('INVALID_PARAMETERS', "--path '/health' 是健康检查端点的保留路径");
  }
  if (mcpPath === '/admin' || mcpPath.startsWith('/admin/')) {
    throw new AppError('INVALID_PARAMETERS', "--path '/admin' 是管理面板的保留路径");
  }
  const authToken = flags.get('--auth-token') ?? envValue('MANAGEABLE_MCP_AUTH_TOKEN') ?? config.authToken;
  const admin = flags.has('--ui') || config.admin;
  const cli = flags.has('--cli') || config.cli;
  if (cli && !isLoopbackHost(host)) {
    throw new AppError(
      'INVALID_PARAMETERS',
      '--cli 只发布回环地址端点；请绑定回环地址，或显式使用 --url',
    );
  }
  if (admin && !isLoopbackHost(host) && !authToken) {
    throw new AppError(
      'INVALID_PARAMETERS',
      '在非回环主机上使用 --ui 需要 --auth-token 或 MANAGEABLE_MCP_AUTH_TOKEN',
    );
  }

  return {
    ...config,
    host,
    port,
    path: mcpPath.length > 1 ? mcpPath.replace(/\/+$/, '') : mcpPath,
    ...(authToken === undefined ? {} : { authToken }),
    admin,
    cli,
  };
}

function managerHealth(configHealth: HealthConfig, flags: Map<string, string>): HealthConfig {
  if (!flags.has('--health')) return configHealth;
  return { ...configHealth, enabled: true };
}

async function runAttach(flags: Map<string, string>, logger: Logger): Promise<void> {
  const unsupported = [...flags.keys()].filter(
    (flag) => flag !== '--attach' && flag !== '--auth-token' && flag !== '--log-level',
  );
  if (unsupported.length > 0) {
    throw new AppError(
      'INVALID_PARAMETERS',
      `--attach 不能与 ${unsupported.join(', ')} 同时使用。请通过 URL（/mcp/<group>）选择分组。`,
    );
  }
  const url = flags.get('--attach');
  if (!url) throw new AppError('INVALID_PARAMETERS', '--attach 需要一个 URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('INVALID_PARAMETERS', '无效的 --attach URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('INVALID_PARAMETERS', '--attach URL 必须以 http:// 或 https:// 开头');
  }
  const authToken = flags.get('--auth-token') ?? envValue('MANAGEABLE_MCP_AUTH_TOKEN');
  if (!isLoopbackUrl(url) && !authToken) {
    throw new AppError(
      'INVALID_PARAMETERS',
      '连接非回环守护进程需要 --auth-token 或 MANAGEABLE_MCP_AUTH_TOKEN',
    );
  }
  if (!isLoopbackUrl(url) && parsed.protocol !== 'https:') {
    throw new AppError(
      'INVALID_PARAMETERS',
      '连接非回环守护进程需要 https://',
    );
  }
  await runStdioAttached({ url, authToken, logger });
}

export async function main(argv: string[]): Promise<void> {
  if (argv[0] && ONE_SHOT_COMMANDS.has(argv[0])) {
    try {
      const command = parseOneShotCommand(argv);
      process.exitCode = await runOneShotCommand(command);
    } catch (error) {
      process.stderr.write(`错误：${errorMessage(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const { command, flags } = parseArgs(argv);
  if (flags.has('--help')) {
    printHelp();
    return;
  }
  if (flags.has('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const logger = createLogger(parseLogLevel(flags.get('--log-level')));
  if (flags.has('--attach')) {
    await runAttach(flags, logger);
    return;
  }
  if (command !== 'serve') {
    throw new AppError('INVALID_PARAMETERS', `未知命令 '${command}'。请使用 --help。`);
  }

  const loaded = loadConfig(flags.get('--config'));
  const currentHealth = managerHealth(loaded.config.health, flags);
  const manager = new ServerManager(loaded.config.servers, {
    groups: loaded.config.groups,
    permissions: loaded.config.permissions,
    health: currentHealth,
    healthOverride: flags.has('--health'),
    configPath: loaded.sourcePath,
    logger,
  });
  const transport = (flags.get('--transport') ?? envValue('MANAGEABLE_MCP_TRANSPORT') ?? 'stdio') as TransportKind;
  if (transport !== 'stdio' && transport !== 'http') {
    throw new AppError('INVALID_PARAMETERS', `无效的传输方式 '${transport}'`);
  }
  if (flags.has('--group') && transport !== 'stdio') {
    throw new AppError(
      'INVALID_PARAMETERS',
      '--group 仅支持 stdio 传输；通过 HTTP 时请使用 <path>/<group>',
    );
  }
  if ((flags.has('--ui') || flags.has('--cli')) && transport !== 'http') {
    throw new AppError('INVALID_PARAMETERS', '--ui 和 --cli 需要 --transport http');
  }

  logger.info('配置已加载', {
    path: loaded.sourcePath,
    servers: loaded.config.servers.length,
    transport,
  });

  let scope: ProxyScope | undefined;
  if (flags.has('--group')) {
    scope = resolveGroupScope(manager, flags.get('--group') as string);
    logger.info('stdio 会话已限定到分组', {
      group: scope.group,
      servers: Array.from(scope.allowedServers),
    });
  }

  let reloading = false;
  const reload = async (): Promise<void> => {
    if (reloading) return;
    reloading = true;
    try {
      const next = loadConfig(flags.get('--config'));
      await manager.reconfigure(next.config.servers, {
        groups: next.config.groups,
        permissions: next.config.permissions,
        health: managerHealth(next.config.health, flags),
        healthOverride: flags.has('--health'),
        configPath: next.sourcePath,
      });
      if (scope) refreshGroupScope(manager, scope);
      logger.info('配置已重新加载', { path: next.sourcePath });
    } catch (error) {
      logger.error('配置重新加载失败', { error: errorMessage(error) });
    } finally {
      reloading = false;
    }
  };
  process.on('SIGHUP', () => void reload());

  if (transport === 'stdio') {
    await startStdioServer(manager, logger, scope);
    return;
  }

  const options = httpOptions(loaded.config.transport, flags);
  const running = await startHttpServer(manager, options, logger);
  let publishedEndpoint: { url: string; pid: number } | undefined;
  if (options.cli) {
    await writeCliEndpoint({
      url: running.url,
      ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: VERSION,
    });
    publishedEndpoint = { url: running.url, pid: process.pid };
    logger.info('CLI 端点已发布', { path: getDefaultCliEndpointPath() });
  }

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void running.close()
        .then(() => closeAllOAuthCallbackServers())
        .finally(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  if (publishedEndpoint) removeCliEndpoint(publishedEndpoint);
}

export async function runCli(argv: string[]): Promise<void> {
  try {
    await main(argv);
  } catch (error) {
    if (error instanceof AppError) {
      process.stderr.write(`错误 [${error.code}]：${error.message}\n`);
    } else {
      process.stderr.write(`错误：${errorMessage(error)}\n`);
    }
    process.exitCode = 1;
  }
}
