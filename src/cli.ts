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
  process.stdout.write(`Usage:
  ${PACKAGE_NAME} [serve] [options]
  ${PACKAGE_NAME} --attach <url> [--auth-token <token>]
  ${PACKAGE_NAME} call <server> <command> [json-object|-] [options]
  ${PACKAGE_NAME} list-commands <server> [options]
  ${PACKAGE_NAME} describe <server> <command...> [options]
  ${PACKAGE_NAME} auth <server> [--wait] [options]

Daemon options:
  --config <path>       servers.json path
  --transport <mode>    stdio (default) or http
  --host <host>         HTTP bind host (default 127.0.0.1)
  --port <port>         HTTP port (default 8080)
  --path <path>         HTTP MCP path (default /mcp)
  --auth-token <token>  Require a bearer token for HTTP requests
  --group <name>        Restrict a stdio session to one configured group
  --ui                  Enable /admin and /api/admin (HTTP only)
  --cli                 Publish a one-shot CLI endpoint (HTTP only)
  --health              Enable activity-driven health probes
  --log-level <level>   debug, info, warn, or error (default info)

One-shot options:
  --url <url>           Select an HTTP daemon explicitly
  --auth-token <token>  Bearer token for the daemon
  --timeout <seconds>   Request timeout (default 60)
  --params-file <path>  Read call parameters from a JSON file, or - for stdin
  --json                Print the full MCP result as JSON
  --wait                Wait for OAuth authorization to complete

Local-only build. No publishing, legacy aliases, or compatibility modes.
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
      throw new AppError('INVALID_PARAMETERS', `Unknown option: ${arg}`);
    }
    const value = args[i + 1];
    if (value === undefined || value.length === 0 || value.startsWith('-')) {
      throw new AppError('INVALID_PARAMETERS', `${arg} requires a value`);
    }
    flags.set(arg, value);
    i += 1;
  }
  return { command, flags };
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = value ?? 'info';
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') return level;
  throw new AppError('INVALID_PARAMETERS', `Invalid --log-level '${level}'`);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError('INVALID_PARAMETERS', `Invalid port '${value}'`);
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
    throw new AppError('INVALID_PARAMETERS', '--path must not contain a query or fragment');
  }
  if (mcpPath === '/health') {
    throw new AppError('INVALID_PARAMETERS', "--path '/health' is reserved for the health endpoint");
  }
  if (mcpPath === '/admin' || mcpPath.startsWith('/admin/')) {
    throw new AppError('INVALID_PARAMETERS', "--path '/admin' is reserved for the admin panel");
  }
  const authToken = flags.get('--auth-token') ?? envValue('MANAGEABLE_MCP_AUTH_TOKEN') ?? config.authToken;
  const admin = flags.has('--ui') || config.admin;
  const cli = flags.has('--cli') || config.cli;
  if (cli && !isLoopbackHost(host)) {
    throw new AppError(
      'INVALID_PARAMETERS',
      '--cli publishes a loopback-only endpoint; bind loopback or use --url explicitly',
    );
  }
  if (admin && !isLoopbackHost(host) && !authToken) {
    throw new AppError(
      'INVALID_PARAMETERS',
      '--ui on a non-loopback host requires --auth-token or MANAGEABLE_MCP_AUTH_TOKEN',
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
      `--attach cannot be combined with ${unsupported.join(', ')}. Select a group through the URL (/mcp/<group>).`,
    );
  }
  const url = flags.get('--attach');
  if (!url) throw new AppError('INVALID_PARAMETERS', '--attach requires a URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('INVALID_PARAMETERS', 'Invalid --attach URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('INVALID_PARAMETERS', '--attach URL must start with http:// or https://');
  }
  const authToken = flags.get('--auth-token') ?? envValue('MANAGEABLE_MCP_AUTH_TOKEN');
  if (!isLoopbackUrl(url) && !authToken) {
    throw new AppError(
      'INVALID_PARAMETERS',
      'Attaching to a non-loopback daemon requires --auth-token or MANAGEABLE_MCP_AUTH_TOKEN',
    );
  }
  if (!isLoopbackUrl(url) && parsed.protocol !== 'https:') {
    throw new AppError(
      'INVALID_PARAMETERS',
      'Attaching to a non-loopback daemon requires https://',
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
      process.stderr.write(`Error: ${errorMessage(error)}\n`);
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
    throw new AppError('INVALID_PARAMETERS', `Unknown command '${command}'. Use --help.`);
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
    throw new AppError('INVALID_PARAMETERS', `Invalid transport '${transport}'`);
  }
  if (flags.has('--group') && transport !== 'stdio') {
    throw new AppError(
      'INVALID_PARAMETERS',
      '--group is only supported with stdio transport; use <path>/<group> over HTTP',
    );
  }
  if ((flags.has('--ui') || flags.has('--cli')) && transport !== 'http') {
    throw new AppError('INVALID_PARAMETERS', '--ui and --cli require --transport http');
  }

  logger.info('config loaded', {
    path: loaded.sourcePath,
    servers: loaded.config.servers.length,
    transport,
  });

  let scope: ProxyScope | undefined;
  if (flags.has('--group')) {
    scope = resolveGroupScope(manager, flags.get('--group') as string);
    logger.info('stdio session scoped to group', {
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
      logger.info('config reloaded', { path: next.sourcePath });
    } catch (error) {
      logger.error('config reload failed', { error: errorMessage(error) });
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
    logger.info('CLI endpoint published', { path: getDefaultCliEndpointPath() });
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
      process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
    } else {
      process.stderr.write(`Error: ${errorMessage(error)}\n`);
    }
    process.exitCode = 1;
  }
}
