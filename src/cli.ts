import { AppError, errorMessage } from './core/errors.js';
import { createLogger, type LogLevel } from './core/logger.js';
import { loadConfig } from './config/load.js';
import type { HttpTransportConfig } from './config/types.js';
import { ServerManager } from './mcp/manager.js';
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
]);

function printHelp(): void {
  process.stdout.write(`Usage:
  ${PACKAGE_NAME} [serve] [options]

Options:
  --config <path>       servers.json path
  --transport <mode>    stdio (default) or http
  --host <host>         HTTP bind host (default 127.0.0.1)
  --port <port>         HTTP port (default 8080)
  --path <path>         HTTP MCP path (default /mcp)
  --auth-token <token>  Require a bearer token for HTTP requests
  --log-level <level>   debug, info, warn, or error (default info)
  --version             Print version
  --help                Print this help

Local-only build. No publishing, legacy aliases, or compatibility modes.
`);
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const args = [...argv];
  let command = 'serve';
  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift() as string;
  }

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
  const authToken = flags.get('--auth-token') ?? envValue('MANAGEABLE_MCP_AUTH_TOKEN') ?? config.authToken;

  return {
    ...config,
    host,
    port,
    path: mcpPath.length > 1 ? mcpPath.replace(/\/+$/, '') : mcpPath,
    ...(authToken === undefined ? {} : { authToken }),
  };
}

export async function main(argv: string[]): Promise<void> {
  const { command, flags } = parseArgs(argv);
  if (flags.has('--help')) {
    printHelp();
    return;
  }
  if (flags.has('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command !== 'serve') {
    throw new AppError('INVALID_PARAMETERS', `Unknown command '${command}'. Use --help.`);
  }

  const logger = createLogger(parseLogLevel(flags.get('--log-level')));
  const loaded = loadConfig(flags.get('--config'));
  const manager = new ServerManager(loaded.config.servers);
  const transport = (flags.get('--transport') ?? envValue('MANAGEABLE_MCP_TRANSPORT') ?? 'stdio') as TransportKind;

  if (transport !== 'stdio' && transport !== 'http') {
    throw new AppError('INVALID_PARAMETERS', `Invalid transport '${transport}'`);
  }

  logger.info('config loaded', {
    path: loaded.sourcePath,
    servers: loaded.config.servers.length,
    transport,
  });

  if (transport === 'stdio') {
    await startStdioServer(manager, logger);
    return;
  }

  const options = httpOptions(loaded.config.transport, flags);
  const running = await startHttpServer(manager, options, logger);
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void running.close().finally(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
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
