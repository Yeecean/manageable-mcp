import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type GetPromptResult,
  type Prompt,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { AppError, OAuthAuthorizationRequiredError, errorMessage } from '../core/errors.js';
import { silentLogger, type Logger } from '../core/logger.js';
import { TimeoutError, withTimeout } from '../core/timeout.js';
import type {
  GlobalPermissions,
  GroupConfig,
  HealthConfig,
  ServerConfig,
} from '../config/types.js';
import { connectDownstream, type DownstreamConnection } from './downstream.js';
import { decodePromptName, encodePromptName } from './prompt-namespace.js';
import type { ProxyScope } from './proxy-scope.js';

export type ServerStatus = 'idle' | 'connecting' | 'ready' | 'auth' | 'error';

export interface ServerHealth {
  healthy: boolean;
  lastChecked: number;
  latencyMs?: number;
  error?: string;
  authRequired?: boolean;
  authUrl?: string;
}

export interface ServerSummary {
  name: string;
  description: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  status: ServerStatus;
  toolCount?: number;
  error?: string;
  health?: ServerHealth;
}

export interface ManagerOptions {
  groups?: Record<string, GroupConfig>;
  permissions?: GlobalPermissions;
  health?: HealthConfig;
  healthOverride?: boolean;
  configPath?: string;
  logger?: Logger;
}

interface ServerEntry {
  config: ServerConfig;
  status: ServerStatus;
  client?: DownstreamConnection;
  connecting?: Promise<DownstreamConnection>;
  tools?: Tool[];
  error?: string;
  health?: ServerHealth;
}

const DEFAULT_HEALTH: HealthConfig = {
  enabled: false,
  intervalMs: 30_000,
  idleTimeoutMs: 300_000,
  timeoutMs: 10_000,
};

export class ServerManager {
  private entries: Map<string, ServerEntry>;
  private groups: Record<string, GroupConfig>;
  private globalPermissions: GlobalPermissions;
  private healthConfig: HealthConfig;
  private healthOverride: boolean;
  private readonly configPath?: string;
  private readonly logger: Logger;
  private closing = false;
  private healthTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private healthMonitorRunning = false;

  constructor(servers: ServerConfig[], options: ManagerOptions = {}) {
    this.entries = buildEntries(servers);
    this.groups = options.groups ?? {};
    this.globalPermissions = options.permissions ?? { rules: [] };
    this.healthConfig = options.health ?? DEFAULT_HEALTH;
    this.healthOverride = options.healthOverride ?? false;
    this.configPath = options.configPath;
    this.logger = options.logger ?? silentLogger;
  }

  listServers(scope?: ProxyScope): ServerSummary[] {
    return Array.from(this.entries.values())
      .filter((entry) => scope === undefined || scope.allowedServers.has(entry.config.name))
      .map((entry) => ({
        name: entry.config.name,
        description: entry.config.description,
        enabled: entry.config.enabled,
        transport: entry.config.url ? 'http' : 'stdio',
        status: entry.status,
        ...(entry.tools === undefined ? {} : { toolCount: entry.tools.length }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
        ...(entry.health === undefined ? {} : { health: entry.health }),
      }));
  }

  getServerConfig(name: string): ServerConfig | undefined {
    return this.entries.get(name)?.config;
  }

  getGroups(): Readonly<Record<string, GroupConfig>> {
    return this.groups;
  }

  getGlobalPermissions(): GlobalPermissions {
    return this.globalPermissions;
  }

  getHealthConfig(): HealthConfig {
    return this.healthConfig;
  }

  isHealthForcedOn(): boolean {
    return this.healthOverride;
  }

  getConfigPath(): string | undefined {
    return this.configPath;
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
      if (!(error instanceof OAuthAuthorizationRequiredError)) await this.fail(entry, error);
      throw this.connectionError(error, `Failed to list tools for '${name}'`, name);
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
      throw this.connectionError(error, `Failed to connect to '${name}'`, name);
    }

    try {
      const result = await client.callTool(toolName, args, signal);
      entry.status = 'ready';
      entry.error = undefined;
      return result;
    } catch (error) {
      const connectionFailure = isConnectionFailure(error);
      if (connectionFailure) await this.fail(entry, error);
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

  hasPromptForwarding(scope?: ProxyScope): boolean {
    return Array.from(this.entries.values()).some(
      (entry) =>
        entry.config.enabled &&
        entry.config.forwardPrompts &&
        (scope === undefined || scope.allowedServers.has(entry.config.name)),
    );
  }

  async listPrompts(scope?: ProxyScope): Promise<Prompt[]> {
    this.assertOpen();
    const candidates = Array.from(this.entries.values()).filter(
      (entry) =>
        entry.config.enabled &&
        entry.config.forwardPrompts &&
        (scope === undefined || scope.allowedServers.has(entry.config.name)),
    );
    const results = await Promise.allSettled(
      candidates.map(async (entry) => {
        const client = await this.ensureConnected(entry);
        if (!client.promptsSupported) return [];
        const prompts = await client.listPrompts();
        return prompts.map((prompt) => ({
          ...prompt,
          name: encodePromptName(entry.config.name, prompt.name),
        }));
      }),
    );

    const prompts: Prompt[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        prompts.push(...result.value);
        return;
      }
      const entry = candidates[index];
      if (!entry) return;
      entry.error = errorMessage(result.reason);
      if (result.reason instanceof OAuthAuthorizationRequiredError) {
        entry.status = 'auth';
        entry.health = {
          healthy: false,
          lastChecked: Date.now(),
          authRequired: true,
          authUrl: result.reason.authUrl,
        };
      }
    });
    return prompts;
  }

  async getPrompt(
    namespacedName: string,
    args?: Record<string, string>,
    scope?: ProxyScope,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    this.assertOpen();
    const decoded = decodePromptName(namespacedName);
    if (!decoded) {
      throw new AppError('PROMPT_NOT_FOUND', `Prompt '${namespacedName}' not found`);
    }
    if (scope !== undefined && !scope.allowedServers.has(decoded.serverName)) {
      throw new AppError('PROMPT_NOT_FOUND', `Prompt '${namespacedName}' not found`);
    }
    const entry = this.requireEntry(decoded.serverName);
    if (!entry.config.forwardPrompts) {
      throw new AppError('PROMPT_NOT_FOUND', `Prompt '${namespacedName}' not found`);
    }

    try {
      const client = await this.ensureConnected(entry);
      if (!client.promptsSupported) {
        throw new AppError(
          'PROMPT_NOT_FOUND',
          `Server '${decoded.serverName}' does not support prompts`,
        );
      }
      return await client.getPrompt(decoded.promptName, args, signal);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw this.connectionError(
        error,
        `Failed to get prompt '${namespacedName}'`,
        decoded.serverName,
      );
    }
  }

  async probeAllServers(names?: string[]): Promise<ServerHealth[]> {
    this.assertOpen();
    const selected = names === undefined ? undefined : new Set(names);
    const entries = Array.from(this.entries.values()).filter(
      (entry) => entry.config.enabled && (selected === undefined || selected.has(entry.config.name)),
    );
    return await Promise.all(entries.map(async (entry) => this.probeEntry(entry)));
  }

  touchActivity(): void {
    if (!this.healthConfig.enabled || this.closing) return;
    if (!this.healthMonitorRunning) {
      this.healthMonitorRunning = true;
      void this.probeAllServers().catch(() => undefined);
      this.healthTimer = setInterval(() => {
        void this.probeAllServers().catch(() => undefined);
      }, this.healthConfig.intervalMs);
      this.healthTimer.unref();
    }

    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.healthConfig.idleTimeoutMs > 0) {
      this.idleTimer = setTimeout(() => this.stopHealthMonitor(), this.healthConfig.idleTimeoutMs);
      this.idleTimer.unref();
    }
  }

  async reconfigure(servers: ServerConfig[], options: ManagerOptions = {}): Promise<void> {
    const wasClosing = this.closing;
    this.closing = true;
    this.stopHealthMonitor();
    await this.closeConnections();
    this.entries = buildEntries(servers);
    this.groups = options.groups ?? {};
    this.globalPermissions = options.permissions ?? { rules: [] };
    this.healthConfig = options.health ?? DEFAULT_HEALTH;
    this.healthOverride = options.healthOverride ?? false;
    this.closing = wasClosing;
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    this.stopHealthMonitor();
    await this.closeConnections();
  }

  private async probeEntry(entry: ServerEntry): Promise<ServerHealth> {
    const startedAt = Date.now();
    try {
      const client = await this.ensureConnected(entry);
      await withTimeout(
        client.ping(),
        this.healthConfig.timeoutMs,
        `health probe '${entry.config.name}'`,
      );
      entry.status = 'ready';
      entry.error = undefined;
      entry.health = {
        healthy: true,
        lastChecked: Date.now(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const authRequired = error instanceof OAuthAuthorizationRequiredError;
      entry.status = authRequired ? 'auth' : 'error';
      entry.error = errorMessage(error);
      entry.health = {
        healthy: false,
        lastChecked: Date.now(),
        latencyMs: Date.now() - startedAt,
        error: errorMessage(error),
        ...(authRequired
          ? { authRequired: true, authUrl: (error as OAuthAuthorizationRequiredError).authUrl }
          : {}),
      };
      if (!authRequired && isConnectionFailure(error)) await this.fail(entry, error);
    }
    return entry.health as ServerHealth;
  }

  private stopHealthMonitor(): void {
    this.healthMonitorRunning = false;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.healthTimer = undefined;
    this.idleTimer = undefined;
  }

  private async closeConnections(): Promise<void> {
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

  private connectionError(error: unknown, prefix: string, server: string): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof OAuthAuthorizationRequiredError) {
      return new AppError('AUTH_REQUIRED', `Server '${server}' requires OAuth authorization.`, {
        server,
        authUrl: error.authUrl,
      });
    }
    return new AppError(
      error instanceof TimeoutError ? 'TIMEOUT' : 'SERVER_UNAVAILABLE',
      `${prefix}: ${errorMessage(error)}`,
      { server },
    );
  }

  private requireEntry(name: string): ServerEntry {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new AppError(
        'SERVER_NOT_FOUND',
        `Unknown server '${name}'. Call list_servers first.`,
        { server: name },
      );
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
        const client = await connectDownstream(entry.config, this.logger);
        entry.client = client;
        entry.status = 'ready';
        return client;
      } catch (error) {
        entry.status = error instanceof OAuthAuthorizationRequiredError ? 'auth' : 'error';
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

function buildEntries(servers: ServerConfig[]): Map<string, ServerEntry> {
  const entries = new Map<string, ServerEntry>();
  for (const config of servers) entries.set(config.name, { config, status: 'idle' });
  return entries;
}

function isConnectionFailure(error: unknown): boolean {
  if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) return true;
  const message = errorMessage(error).toLowerCase();
  return /not connected|connection (closed|lost)|transport closed|epipe|econn|socket hang up|terminated/.test(message);
}
