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
import { redactCommandForDisplay, redactUrlForDisplay } from '../core/redaction.js';
import { TimeoutError, withTimeout } from '../core/timeout.js';
import { sanitizeErrorMessage } from '../oauth/sanitize.js';
import type {
  EmbedServerSummariesConfig,
  GlobalPermissions,
  GroupConfig,
  HealthConfig,
  ServerConfig,
  ServerExample,
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
  type: 'local' | 'remote';
  transport: 'stdio' | 'http';
  target: string;
  status: ServerStatus;
  toolCount?: number;
  tools_count: number | null;
  examples?: ServerExample[];
  tags: string[];
  healthy: boolean;
  available: boolean;
  loaded: boolean;
  authRequired?: boolean;
  authUrl?: string;
  auth_required?: string;
  error?: string;
  health?: ServerHealth;
}

export interface ToolSummary {
  name: string;
  description: string;
}

export interface ServerProbeResult {
  name: string;
  ok: boolean;
  toolsCount: number | null;
  tools?: ToolSummary[];
  error?: string;
  authRequired?: string;
  latencyMs?: number;
  checkedAt: number;
}

export interface ProbeOptions {
  timeoutMs?: number;
  includeTools?: boolean;
  method?: 'tools/list' | 'ping';
}

export interface ProbeBatchOptions {
  concurrency?: number;
  timeoutMs?: number;
  method?: 'tools/list' | 'ping';
}

export interface ManagerOptions {
  groups?: Record<string, GroupConfig>;
  permissions?: GlobalPermissions;
  health?: HealthConfig;
  healthOverride?: boolean;
  embedServerSummaries?: EmbedServerSummariesConfig;
  configPath?: string;
  logger?: Logger;
}

interface ServerEntry {
  config: ServerConfig;
  status: ServerStatus;
  client?: DownstreamConnection;
  connecting?: Promise<DownstreamConnection>;
  probing?: Promise<ServerProbeResult>;
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
  private embedSummaries: EmbedServerSummariesConfig;
  private readonly configPath?: string;
  private readonly logger: Logger;
  private closing = false;
  private activeOperations = 0;
  private operationWaiters: Array<() => void> = [];
  private closePromise?: Promise<void>;
  private healthTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private healthMonitorRunning = false;

  constructor(servers: ServerConfig[], options: ManagerOptions = {}) {
    this.entries = buildEntries(servers);
    this.groups = options.groups ?? {};
    this.globalPermissions = options.permissions ?? { rules: [] };
    this.healthConfig = options.health ?? DEFAULT_HEALTH;
    this.healthOverride = options.healthOverride ?? false;
    this.embedSummaries = options.embedServerSummaries ?? { enabled: true };
    this.configPath = options.configPath;
    this.logger = options.logger ?? silentLogger;
  }

  listServers(scope?: ProxyScope, filter?: string): ServerSummary[] {
    const needle = filter?.toLowerCase();
    return Array.from(this.entries.values())
      .filter((entry) => scope === undefined || scope.allowedServers.has(entry.config.name))
      .filter((entry) => {
        if (needle === undefined || needle.length === 0) return true;
        return (
          entry.config.name.toLowerCase().includes(needle) ||
          entry.config.description.toLowerCase().includes(needle) ||
          (entry.config.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
        );
      })
      .map((entry) => {
        const type: 'local' | 'remote' = entry.config.url === undefined ? 'local' : 'remote';
        const authRequired = entry.health?.authRequired === true || entry.status === 'auth';
        const authUrl = entry.health?.authUrl;
        const toolsCount = entry.tools?.length ?? null;
        return {
          name: entry.config.name,
          description: entry.config.description,
          enabled: entry.config.enabled,
          type,
          transport: type === 'remote' ? 'http' : 'stdio',
          target: targetOf(entry.config),
          status: entry.status,
          ...(entry.tools === undefined ? {} : { toolCount: entry.tools.length }),
          tools_count: toolsCount,
          ...(entry.config.examples === undefined ? {} : { examples: entry.config.examples }),
          tags: entry.config.tags ?? [],
          healthy: entry.health?.healthy ?? true,
          available: true,
          loaded: entry.tools !== undefined,
          ...(authRequired ? { authRequired: true } : {}),
          ...(authUrl === undefined ? {} : { authUrl }),
          ...(authRequired && authUrl !== undefined ? { auth_required: authUrl } : {}),
          ...(entry.error === undefined ? {} : { error: entry.error }),
          ...(entry.health === undefined ? {} : { health: entry.health }),
        };
      });
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

  getEmbedServerSummaries(): EmbedServerSummariesConfig {
    return this.embedSummaries;
  }

  isHealthForcedOn(): boolean {
    return this.healthOverride;
  }

  getConfigPath(): string | undefined {
    return this.configPath;
  }

  async listTools(name: string, refresh = false): Promise<Tool[]> {
    return await this.runOperation(async () => {
      const entry = this.requireEntry(name);
      if (!refresh && entry.tools) return entry.tools;

      const startedAt = Date.now();
      try {
        const client = await this.ensureConnected(entry);
        const tools = await client.listTools();
        entry.tools = tools;
        this.markReady(entry, Date.now() - startedAt);
        return tools;
      } catch (error) {
        await this.fail(entry, error);
        throw this.connectionError(error, `列出服务器 '${name}' 的工具失败`, name);
      }
    });
  }

  async callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    return await this.runOperation(async () => {
      const entry = this.requireEntry(name);
      let client: DownstreamConnection;
      try {
        client = await this.ensureConnected(entry);
      } catch (error) {
        await this.fail(entry, error);
        throw this.connectionError(error, `连接服务器 '${name}' 失败`, name);
      }

      const startedAt = Date.now();
      try {
        const result = await client.callTool(toolName, args, signal);
        this.markReady(entry, Date.now() - startedAt);
        return result;
      } catch (error) {
        if (error instanceof OAuthAuthorizationRequiredError) {
          await this.fail(entry, error);
          throw this.connectionError(error, `连接服务器 '${name}' 失败`, name);
        }
        if (error instanceof AppError && error.code === 'AUTH_REQUIRED') {
          await this.fail(entry, error);
          throw error;
        }
        const connectionFailure = isConnectionFailure(error);
        if (connectionFailure) await this.fail(entry, error);
        throw new AppError(
          error instanceof TimeoutError
            ? 'TIMEOUT'
            : connectionFailure
              ? 'SERVER_UNAVAILABLE'
              : 'TOOL_EXECUTION_FAILED',
          `服务器 '${name}' 上的工具 '${toolName}' 调用失败：${sanitizeErrorMessage(errorMessage(error))}`,
          { server: name, tool: toolName },
        );
      }
    });
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
    return await this.runOperation(async () => {
      const candidates = Array.from(this.entries.values()).filter(
        (entry) =>
          entry.config.enabled &&
          entry.config.forwardPrompts &&
          (scope === undefined || scope.allowedServers.has(entry.config.name)),
      );
      const results = await Promise.allSettled(
        candidates.map(async (entry) => {
          const startedAt = Date.now();
          const client = await this.ensureConnected(entry);
          if (!client.promptsSupported) {
            this.markReady(entry, Date.now() - startedAt);
            return [];
          }
          const prompts = await client.listPrompts();
          this.markReady(entry, Date.now() - startedAt);
          return prompts.map((prompt) => ({
            ...prompt,
            name: encodePromptName(entry.config.name, prompt.name),
          }));
        }),
      );

      const prompts: Prompt[] = [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const entry = candidates[index];
        if (!result || !entry) continue;
        if (result.status === 'fulfilled') {
          prompts.push(...result.value);
        } else {
          await this.fail(entry, result.reason);
        }
      }
      return prompts;
    });
  }

  async getPrompt(
    namespacedName: string,
    args?: Record<string, string>,
    scope?: ProxyScope,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    return await this.runOperation(async () => {
      const decoded = decodePromptName(namespacedName);
      if (!decoded) {
        throw new AppError('PROMPT_NOT_FOUND', `未找到提示词 '${namespacedName}'`);
      }
      if (scope !== undefined && !scope.allowedServers.has(decoded.serverName)) {
        throw new AppError('PROMPT_NOT_FOUND', `未找到提示词 '${namespacedName}'`);
      }
      const entry = this.requireEntry(decoded.serverName);
      if (!entry.config.forwardPrompts) {
        throw new AppError('PROMPT_NOT_FOUND', `未找到提示词 '${namespacedName}'`);
      }

      const startedAt = Date.now();
      try {
        const client = await this.ensureConnected(entry);
        if (!client.promptsSupported) {
          throw new AppError(
            'PROMPT_NOT_FOUND',
            `服务器 '${decoded.serverName}' 不支持提示词`,
          );
        }
        const result = await client.getPrompt(decoded.promptName, args, signal);
        this.markReady(entry, Date.now() - startedAt);
        return result;
      } catch (error) {
        if (error instanceof AppError) throw error;
        await this.fail(entry, error);
        throw this.connectionError(
          error,
          `获取提示词 '${namespacedName}' 失败`,
          decoded.serverName,
        );
      }
    });
  }

  async probeAllServers(names?: string[]): Promise<ServerProbeResult[]> {
    this.assertOpen();
    const selected = names === undefined ? undefined : new Set(names);
    const entries = Array.from(this.entries.values()).filter(
      (entry) => entry.config.enabled && (selected === undefined || selected.has(entry.config.name)),
    );
    return await mapWithConcurrency(entries, 3, async (entry) => {
      try {
        return await this.probeHealth(entry);
      } catch (error) {
        return failedProbe(entry.config.name, error);
      }
    });
  }

  async probeServer(name: string, options: ProbeOptions = {}): Promise<ServerProbeResult> {
    return await this.runOperation(async () => {
      const entry = this.entries.get(name);
      if (!entry) {
        throw new AppError(
          'SERVER_NOT_FOUND',
          `未知服务器 '${name}'。请先调用 list_servers。`,
          { server: name },
        );
      }
      if (!entry.config.enabled) {
        throw new AppError('SERVER_DISABLED', `服务器 '${name}' 已禁用。`, { server: name });
      }

      if (entry.probing) return entry.probing;
      const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0
        ? options.timeoutMs
        : this.healthConfig.timeoutMs;
      const method = options.method ?? 'tools/list';
      const probe = this.probeEntry(
        entry,
        timeoutMs,
        options.includeTools === true,
        method,
      );
      entry.probing = probe;
      try {
        return await probe;
      } finally {
        if (entry.probing === probe) entry.probing = undefined;
      }
    });
  }

  async probeServers(
    names: string[],
    options: ProbeBatchOptions = {},
  ): Promise<ServerProbeResult[]> {
    const unique = Array.from(new Set(names));
    if (unique.length === 0) return [];

    const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 8));
    return await mapWithConcurrency(unique, concurrency, async (name) => {
      try {
        return await this.probeServer(name, {
          timeoutMs: options.timeoutMs,
          ...(options.method === undefined ? {} : { method: options.method }),
        });
      } catch (error) {
        return failedProbe(name, error);
      }
    });
  }

  touchActivity(): void {
    if (!this.isHealthMonitoringEnabled() || this.closing) return;
    if (!this.healthMonitorRunning) {
      this.healthMonitorRunning = true;
      void this.probeBackgroundServers().catch(() => undefined);
      this.healthTimer = setInterval(() => {
        void this.probeBackgroundServers().catch(() => undefined);
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
    await this.waitForOperations();

    const nextEntries = buildEntries(servers);
    const entriesToClose: ServerEntry[] = [];
    for (const [name, next] of nextEntries) {
      const previous = this.entries.get(name);
      if (previous === undefined) continue;
      if (stableSerialize(previous.config) === stableSerialize(next.config)) {
        nextEntries.set(name, previous);
      } else {
        entriesToClose.push(previous);
      }
    }
    for (const [name, previous] of this.entries) {
      if (!nextEntries.has(name)) entriesToClose.push(previous);
    }

    await this.closeEntries(entriesToClose);
    this.entries = nextEntries;
    this.groups = options.groups ?? {};
    this.globalPermissions = options.permissions ?? { rules: [] };
    this.healthConfig = options.health ?? DEFAULT_HEALTH;
    this.healthOverride = options.healthOverride ?? false;
    this.embedSummaries = options.embedServerSummaries ?? { enabled: true };
    this.closing = wasClosing;
  }

  async closeAll(): Promise<void> {
    if (this.closePromise !== undefined) return await this.closePromise;
    this.closing = true;
    this.stopHealthMonitor();
    this.closePromise = this.closeConnections();
    await this.closePromise;
  }

  private async probeEntry(
    entry: ServerEntry,
    timeoutMs: number,
    includeTools: boolean,
    method: 'tools/list' | 'ping',
  ): Promise<ServerProbeResult> {
    const name = entry.config.name;
    const startedAt = Date.now();
    try {
      const client = await this.ensureConnected(entry);
      if (method === 'ping' && !includeTools) {
        await withTimeout(
          client.ping(),
          timeoutMs,
          `health ping '${name}'`,
        );
        const checkedAt = Date.now();
        this.markReady(entry, checkedAt - startedAt, checkedAt);
        return {
          name,
          ok: true,
          toolsCount: entry.tools?.length ?? null,
          latencyMs: checkedAt - startedAt,
          checkedAt,
        };
      }
      const tools = await withTimeout(
        client.listTools(),
        timeoutMs,
        `tool probe '${name}'`,
      );
      entry.tools = tools;
      const checkedAt = Date.now();
      this.markReady(entry, checkedAt - startedAt, checkedAt);
      return {
        name,
        ok: true,
        toolsCount: tools.length,
        ...(includeTools
          ? {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description ?? '',
              })),
            }
          : {}),
        latencyMs: checkedAt - startedAt,
        checkedAt,
      };
    } catch (error) {
      const authRequired = error instanceof OAuthAuthorizationRequiredError;
      entry.status = authRequired ? 'auth' : 'error';
      entry.error = sanitizeErrorMessage(errorMessage(error));
      entry.health = {
        healthy: false,
        lastChecked: Date.now(),
        latencyMs: Date.now() - startedAt,
        error: sanitizeErrorMessage(errorMessage(error)),
        ...(authRequired
          ? { authRequired: true, authUrl: (error as OAuthAuthorizationRequiredError).authUrl }
          : {}),
      };
      await this.fail(entry, error);
      return {
        name,
        ok: false,
        toolsCount: null,
        error: authRequired ? '需要授权' : sanitizeErrorMessage(errorMessage(error)),
        ...(authRequired
          ? { authRequired: (error as OAuthAuthorizationRequiredError).authUrl }
          : {}),
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
      };
    }
  }

  private async probeHealth(entry: ServerEntry): Promise<ServerProbeResult> {
    const healthCheck = entry.config.healthCheck;
    if (healthCheck !== undefined && !healthCheck.enabled) {
      return {
        name: entry.config.name,
        ok: true,
        toolsCount: entry.tools?.length ?? null,
        checkedAt: Date.now(),
      };
    }

    if (
      healthCheck !== undefined &&
      healthCheck.cacheDurationMs > 0 &&
      entry.health !== undefined &&
      Date.now() - entry.health.lastChecked < healthCheck.cacheDurationMs
    ) {
      return healthSnapshot(entry);
    }

    return await this.probeServer(entry.config.name, {
      timeoutMs: healthCheck?.timeoutMs ?? this.healthConfig.timeoutMs,
      method: healthCheck?.method ?? 'tools/list',
    });
  }

  private isHealthMonitoringEnabled(): boolean {
    if (this.healthConfig.enabled) return true;
    return Array.from(this.entries.values()).some(
      (entry) => entry.config.enabled && entry.config.healthCheck?.enabled === true,
    );
  }

  private async probeBackgroundServers(): Promise<void> {
    const entries = Array.from(this.entries.values()).filter(
      (entry) => entry.config.enabled && this.shouldProbeInBackground(entry),
    );
    await mapWithConcurrency(entries, 3, async (entry) => {
      try {
        await this.probeHealth(entry);
      } catch {
        // 单个服务器的后台探测失败不能阻断其他服务器。
      }
    });
  }

  private shouldProbeInBackground(entry: ServerEntry): boolean {
    if (this.healthConfig.enabled) {
      return entry.config.healthCheck?.enabled !== false;
    }
    return entry.config.healthCheck?.enabled === true;
  }

  private stopHealthMonitor(): void {
    this.healthMonitorRunning = false;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.healthTimer = undefined;
    this.idleTimer = undefined;
  }

  private async closeConnections(): Promise<void> {
    await this.waitForOperations();
    await this.closeEntries(Array.from(this.entries.values()));
  }

  private async closeEntries(entries: readonly ServerEntry[]): Promise<void> {
    const pending = entries
      .flatMap((entry) => [entry.connecting, entry.probing])
      .filter(
        (promise): promise is Promise<DownstreamConnection> | Promise<ServerProbeResult> =>
          promise !== undefined,
      );
    await Promise.allSettled(pending);

    const clients = entries
      .map((entry) => entry.client)
      .filter((client): client is DownstreamConnection => client !== undefined);
    await Promise.allSettled(clients.map((client) => client.close()));

    for (const entry of entries) {
      entry.client = undefined;
      entry.connecting = undefined;
      entry.probing = undefined;
      entry.tools = undefined;
      entry.error = undefined;
      entry.health = undefined;
      entry.status = 'idle';
    }
  }

  private connectionError(error: unknown, prefix: string, server: string): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof OAuthAuthorizationRequiredError) {
      return new AppError('AUTH_REQUIRED', `服务器 '${server}' 需要 OAuth 授权。`, {
        server,
        authUrl: error.authUrl,
      });
    }
    return new AppError(
      error instanceof TimeoutError ? 'TIMEOUT' : 'SERVER_UNAVAILABLE',
      `${prefix}: ${sanitizeErrorMessage(errorMessage(error))}`,
      { server },
    );
  }

  private requireEntry(name: string): ServerEntry {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new AppError(
        'SERVER_NOT_FOUND',
        `未知服务器 '${name}'。请先调用 list_servers。`,
        { server: name },
      );
    }
    if (!entry.config.enabled) {
      throw new AppError('SERVER_DISABLED', `服务器 '${name}' 已禁用。`, { server: name });
    }
    return entry;
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new AppError('SERVER_UNAVAILABLE', '服务器管理器正在关闭');
    }
  }

  private async ensureConnected(entry: ServerEntry): Promise<DownstreamConnection> {
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
        entry.error = sanitizeErrorMessage(errorMessage(error));
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
    const message = sanitizeErrorMessage(errorMessage(error));
    entry.error = message;
    const authUrl =
      error instanceof OAuthAuthorizationRequiredError
        ? error.authUrl
        : error instanceof AppError &&
            error.code === 'AUTH_REQUIRED' &&
            typeof error.details?.authUrl === 'string'
          ? error.details.authUrl
          : undefined;
    if (authUrl !== undefined) {
      entry.status = 'auth';
      entry.tools = undefined;
      entry.health = {
        healthy: false,
        lastChecked: Date.now(),
        authRequired: true,
        authUrl,
      };
      return;
    }

    entry.status = 'error';
    entry.tools = undefined;
    entry.health = {
      healthy: false,
      lastChecked: Date.now(),
      error: message,
    };
    if (entry.client) {
      await entry.client.close().catch(() => undefined);
      entry.client = undefined;
    }
  }

  private markReady(entry: ServerEntry, latencyMs?: number, checkedAt = Date.now()): void {
    entry.status = 'ready';
    entry.error = undefined;
    entry.health = {
      healthy: true,
      lastChecked: checkedAt,
      ...(latencyMs === undefined ? {} : { latencyMs }),
    };
  }

  private async runOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        const waiters = this.operationWaiters;
        this.operationWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  private async waitForOperations(): Promise<void> {
    if (this.activeOperations === 0) return;
    await new Promise<void>((resolve) => {
      this.operationWaiters.push(resolve);
    });
  }
}

function buildEntries(servers: ServerConfig[]): Map<string, ServerEntry> {
  const entries = new Map<string, ServerEntry>();
  for (const config of servers) entries.set(config.name, { config, status: 'idle' });
  return entries;
}

function failedProbe(name: string, error: unknown): ServerProbeResult {
  return {
    name,
    ok: false,
    toolsCount: null,
    error: sanitizeErrorMessage(errorMessage(error)),
    checkedAt: Date.now(),
  };
}

function healthSnapshot(entry: ServerEntry): ServerProbeResult {
  const health = entry.health;
  return {
    name: entry.config.name,
    ok: health?.healthy === true,
    toolsCount: entry.tools?.length ?? null,
    ...(health?.error === undefined ? {} : { error: health.error }),
    ...(health?.authRequired === true && health.authUrl !== undefined
      ? { authRequired: health.authUrl }
      : {}),
    ...(health?.latencyMs === undefined ? {} : { latencyMs: health.latencyMs }),
    checkedAt: health?.lastChecked ?? Date.now(),
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function targetOf(config: ServerConfig): string {
  if (config.url !== undefined) return redactUrlForDisplay(config.url);
  return redactCommandForDisplay(
    [config.command, ...config.args].filter((part): part is string => typeof part === 'string'),
  );
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function isConnectionFailure(error: unknown): boolean {
  if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) return true;
  const message = errorMessage(error).toLowerCase();
  return /not connected|connection (closed|lost)|transport closed|epipe|econn|socket hang up|terminated/.test(message);
}
