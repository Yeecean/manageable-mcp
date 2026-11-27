import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { AppError, errorMessage } from '../core/errors.js';
import { TimeoutError } from '../core/timeout.js';
import type { ServerConfig } from '../config/types.js';
import { connectDownstream, type DownstreamConnection } from './downstream.js';

export type ServerStatus = 'idle' | 'connecting' | 'ready' | 'error';

export interface ServerSummary {
  name: string;
  description: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  status: ServerStatus;
  toolCount?: number;
  error?: string;
}

interface ServerEntry {
  config: ServerConfig;
  status: ServerStatus;
  client?: DownstreamConnection;
  connecting?: Promise<DownstreamConnection>;
  tools?: Tool[];
  error?: string;
}

export class ServerManager {
  private readonly entries = new Map<string, ServerEntry>();
  private closing = false;

  constructor(servers: ServerConfig[]) {
    for (const config of servers) {
      this.entries.set(config.name, { config, status: 'idle' });
    }
  }

  listServers(): ServerSummary[] {
    return Array.from(this.entries.values()).map((entry) => ({
      name: entry.config.name,
      description: entry.config.description,
      enabled: entry.config.enabled,
      transport: entry.config.url ? 'http' : 'stdio',
      status: entry.status,
      ...(entry.tools === undefined ? {} : { toolCount: entry.tools.length }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }));
  }

  getServerConfig(name: string): ServerConfig | undefined {
    return this.entries.get(name)?.config;
  }

  async listTools(name: string, refresh = false): Promise<Tool[]> {
    const entry = this.requireEntry(name);
    this.assertOpen();
    if (!refresh && entry.tools) return entry.tools;

    try {
      const client = await this.ensureConnected(entry);
      const tools = await client.listTools();
      entry.tools = tools;
      entry.status = 'ready';
      entry.error = undefined;
      return tools;
    } catch (error) {
      await this.fail(entry, error);
      throw new AppError(
        error instanceof TimeoutError ? 'TIMEOUT' : 'SERVER_UNAVAILABLE',
        `Failed to list tools for '${name}': ${errorMessage(error)}`,
        { server: name },
      );
    }
  }

  async callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const entry = this.requireEntry(name);
    this.assertOpen();
    let client: DownstreamConnection;
    try {
      client = await this.ensureConnected(entry);
    } catch (error) {
      throw new AppError(
        error instanceof TimeoutError ? 'TIMEOUT' : 'SERVER_UNAVAILABLE',
        `Failed to connect to '${name}': ${errorMessage(error)}`,
        { server: name },
      );
    }

    try {
      const result = await client.callTool(toolName, args, signal);
      entry.status = 'ready';
      entry.error = undefined;
      return result;
    } catch (error) {
      const connectionFailure = isConnectionFailure(error);
      if (connectionFailure) {
        await this.fail(entry, error);
      }
      throw new AppError(
        error instanceof TimeoutError
          ? 'TIMEOUT'
          : connectionFailure
            ? 'SERVER_UNAVAILABLE'
            : 'TOOL_EXECUTION_FAILED',
        `Tool '${toolName}' on '${name}' failed: ${errorMessage(error)}`,
        { server: name, tool: toolName },
      );
    }
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    const pending = Array.from(this.entries.values())
      .map((entry) => entry.connecting)
      .filter((promise): promise is Promise<DownstreamConnection> => promise !== undefined);
    await Promise.allSettled(pending);

    const clients = Array.from(this.entries.values())
      .map((entry) => entry.client)
      .filter((client): client is DownstreamConnection => client !== undefined);

    await Promise.allSettled(clients.map((client) => client.close()));
    for (const entry of this.entries.values()) {
      entry.client = undefined;
      entry.connecting = undefined;
      entry.tools = undefined;
      entry.error = undefined;
      entry.status = 'idle';
    }
  }

  private requireEntry(name: string): ServerEntry {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new AppError('SERVER_NOT_FOUND', `Unknown server '${name}'. Call list_servers first.`, { server: name });
    }
    if (!entry.config.enabled) {
      throw new AppError('SERVER_DISABLED', `Server '${name}' is disabled.`, { server: name });
    }
    return entry;
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new AppError('SERVER_UNAVAILABLE', 'Server manager is shutting down');
    }
  }

  private async ensureConnected(entry: ServerEntry): Promise<DownstreamConnection> {
    this.assertOpen();
    if (entry.client) return entry.client;
    if (entry.connecting) return entry.connecting;

    entry.status = 'connecting';
    entry.error = undefined;
    entry.connecting = (async () => {
      try {
        const client = await connectDownstream(entry.config);
        entry.client = client;
        entry.status = 'ready';
        return client;
      } catch (error) {
        entry.status = 'error';
        entry.error = errorMessage(error);
        throw error;
      }
    })();

    try {
      return await entry.connecting;
    } finally {
      entry.connecting = undefined;
    }
  }

  private async fail(entry: ServerEntry, error: unknown): Promise<void> {
    entry.status = 'error';
    entry.error = errorMessage(error);
    entry.tools = undefined;
    if (entry.client) {
      await entry.client.close().catch(() => undefined);
      entry.client = undefined;
    }
  }
}

function isConnectionFailure(error: unknown): boolean {
  if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) return true;
  const message = errorMessage(error).toLowerCase();
  return /not connected|connection (closed|lost)|transport closed|epipe|econn|socket hang up|terminated/.test(message);
}
