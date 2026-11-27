import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppError } from '../core/errors.js';
import { resolveConfigPath } from './paths.js';
import type {
  AppConfig,
  GlobalPermissionRule,
  GlobalPermissions,
  GroupConfig,
  HealthConfig,
  HttpTransportConfig,
  LoadedConfig,
  OAuthConfig,
  PermissionAction,
  PermissionRule,
  ServerConfig,
  ServerPermissions,
} from './types.js';

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const FILE_REFERENCE = /^\{file:(.*)\}$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_HEALTH_INTERVAL_MS = 30_000;
const DEFAULT_HEALTH_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new AppError('CONFIG_INVALID', message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${field} 必须是非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${field} 必须是非空字符串`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalid(`${field} 必须是布尔值`);
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    invalid(`${field} 必须是正整数`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalid(`${field} 必须是非负整数`);
  }
  return value;
}

function timerValue(value: unknown, field: string): number | undefined {
  const parsed = optionalPositiveInteger(value, field);
  if (parsed !== undefined && parsed > MAX_TIMER_MS) {
    invalid(`${field} 必须 <= ${MAX_TIMER_MS}`);
  }
  return parsed;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    invalid(`${field} 必须是字符串数组`);
  }
  return value as string[];
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) invalid(`${field} 必须是字符串值对象`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') invalid(`${field}.${key} 必须是字符串`);
    result[key] = item;
  }
  return result;
}

function expandValue(value: string, baseDir: string, field: string): string {
  const fileMatch = FILE_REFERENCE.exec(value);
  if (fileMatch) {
    const rawPath = fileMatch[1];
    if (!rawPath) invalid(`${field} 的文件引用为空`);
    const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (error) {
      invalid(`${field} 无法读取 ${filePath}：${(error as Error).message}`);
    }
  }

  return value.replace(ENV_REFERENCE, (_, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      invalid(`${field} 引用了未定义的环境变量 ${name}`);
    }
    return resolved;
  });
}

function expandRecord(
  record: Record<string, string>,
  baseDir: string,
  field: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = expandValue(value, baseDir, `${field}.${key}`);
  }
  return result;
}

function parsePermissionAction(value: unknown, field: string): PermissionAction {
  if (value === 'allow' || value === 'deny') return value;
  invalid(`${field} 必须是 'allow' 或 'deny'`);
}

function parsePermissionRules(value: unknown, field: string, global: boolean): Array<PermissionRule | GlobalPermissionRule> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`${field} 必须是数组`);
  return value.map((raw, index) => {
    const ruleField = `${field}[${index}]`;
    if (!isRecord(raw)) invalid(`${ruleField} 必须是对象`);
    const pattern = requireString(raw.pattern, `${ruleField}.pattern`);
    const action = parsePermissionAction(raw.action, `${ruleField}.action`);
    const message = optionalString(raw.message, `${ruleField}.message`);
    const rule: PermissionRule | GlobalPermissionRule = {
      pattern,
      action,
      ...(message === undefined ? {} : { message }),
    };
    if (global) {
      const server = optionalString(raw.server, `${ruleField}.server`);
      if (server !== undefined) (rule as GlobalPermissionRule).server = server;
    }
    return rule;
  });
}

function parseServerPermissions(raw: unknown, field: string): ServerPermissions | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) invalid(`${field} 必须是对象`);
  const defaultAction = raw.default === undefined ? undefined : parsePermissionAction(raw.default, `${field}.default`);
  return {
    ...(defaultAction === undefined ? {} : { default: defaultAction }),
    rules: parsePermissionRules(raw.rules, `${field}.rules`, false) as PermissionRule[],
  };
}

function parseGlobalPermissions(raw: unknown): GlobalPermissions {
  if (raw === undefined) return { rules: [] };
  if (!isRecord(raw)) invalid('permissions 必须是对象');
  const defaultAction = raw.default === undefined
    ? undefined
    : parsePermissionAction(raw.default, 'permissions.default');
  return {
    ...(defaultAction === undefined ? {} : { default: defaultAction }),
    rules: parsePermissionRules(raw.rules, 'permissions.rules', true) as GlobalPermissionRule[],
  };
}

function parseOAuth(raw: unknown, field: string, baseDir: string): OAuthConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) invalid(`${field} 必须是对象`);
  const clientId = optionalString(raw.clientId, `${field}.clientId`);
  const clientSecret = raw.clientSecret === undefined
    ? undefined
    : optionalString(raw.clientSecret, `${field}.clientSecret`);
  const callbackPort = optionalNonNegativeInteger(raw.callbackPort, `${field}.callbackPort`);
  if (callbackPort !== undefined && callbackPort > 65_535) {
    invalid(`${field}.callbackPort 必须 <= 65535`);
  }
  const scope = optionalString(raw.scope, `${field}.scope`);
  const extraHeadersSource = stringRecord(raw.extraHeaders, `${field}.extraHeaders`);
  const extraHeaders = expandRecord(extraHeadersSource, baseDir, `${field}.extraHeaders`);
  return {
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(callbackPort === undefined ? {} : { callbackPort }),
    ...(scope === undefined ? {} : { scope }),
    ...(Object.keys(extraHeaders).length === 0 ? {} : { extraHeaders }),
  };
}

function parseHealth(raw: unknown): HealthConfig {
  if (raw === undefined) {
    return {
      enabled: false,
      intervalMs: DEFAULT_HEALTH_INTERVAL_MS,
      idleTimeoutMs: DEFAULT_HEALTH_IDLE_TIMEOUT_MS,
      timeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
    };
  }
  if (!isRecord(raw)) invalid('health 必须是对象');
  const idleTimeoutMs = optionalNonNegativeInteger(raw.idleTimeoutMs, 'health.idleTimeoutMs')
    ?? DEFAULT_HEALTH_IDLE_TIMEOUT_MS;
  if (idleTimeoutMs > MAX_TIMER_MS) {
    invalid(`health.idleTimeoutMs 必须 <= ${MAX_TIMER_MS}`);
  }
  return {
    enabled: optionalBoolean(raw.enabled, 'health.enabled') ?? false,
    intervalMs: timerValue(raw.intervalMs, 'health.intervalMs') ?? DEFAULT_HEALTH_INTERVAL_MS,
    idleTimeoutMs,
    timeoutMs: timerValue(raw.timeoutMs, 'health.timeoutMs') ?? DEFAULT_HEALTH_TIMEOUT_MS,
  };
}

function parseServer(raw: unknown, index: number, baseDir: string): ServerConfig {
  if (!isRecord(raw)) invalid(`servers[${index}] 必须是对象`);

  const name = requireString(raw.name, `servers[${index}].name`);
  if (!SERVER_NAME.test(name)) {
    invalid(`servers[${index}].name '${name}' 必须匹配 ${SERVER_NAME.source}`);
  }

  const description = requireString(raw.description, `servers[${index}].description`);
  const command = optionalString(raw.command, `servers[${index}].command`);
  const url = optionalString(raw.url, `servers[${index}].url`);
  if ((command === undefined) === (url === undefined)) {
    invalid(`servers[${index}] 必须且只能设置 command 或 url 之一`);
  }

  const rawCwd = optionalString(raw.cwd, `servers[${index}].cwd`);
  const cwd = rawCwd === undefined ? undefined : path.resolve(baseDir, expandValue(rawCwd, baseDir, `servers[${index}].cwd`));
  const args = stringArray(raw.args, `servers[${index}].args`).map((arg, argIndex) =>
    expandValue(arg, baseDir, `servers[${index}].args[${argIndex}]`),
  );
  const env = expandRecord(stringRecord(raw.env, `servers[${index}].env`), baseDir, `servers[${index}].env`);
  const headers = expandRecord(
    stringRecord(raw.headers, `servers[${index}].headers`),
    baseDir,
    `servers[${index}].headers`,
  );

  const resolvedCommand = command === undefined ? undefined : expandValue(command, baseDir, `servers[${index}].command`);
  const resolvedUrl = url === undefined ? undefined : expandValue(url, baseDir, `servers[${index}].url`);
  if (resolvedUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(resolvedUrl);
    } catch {
      invalid(`servers[${index}].url 不是有效 URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      invalid(`servers[${index}].url 必须使用 http 或 https`);
    }
  }

  const timeoutMs = optionalPositiveInteger(raw.timeoutMs, `servers[${index}].timeoutMs`) ?? DEFAULT_TIMEOUT_MS;
  if (timeoutMs > MAX_TIMER_MS) {
    invalid(`servers[${index}].timeoutMs 必须 <= ${MAX_TIMER_MS}`);
  }

  const permissions = parseServerPermissions(raw.permissions, `servers[${index}].permissions`);
  const oauth = parseOAuth(raw.oauth, `servers[${index}].oauth`, baseDir);

  return {
    name,
    description,
    enabled: optionalBoolean(raw.enabled, `servers[${index}].enabled`) ?? true,
    ...(resolvedCommand === undefined ? {} : { command: resolvedCommand }),
    args,
    ...(cwd === undefined ? {} : { cwd }),
    env,
    ...(resolvedUrl === undefined ? {} : { url: resolvedUrl }),
    headers,
    timeoutMs,
    forwardPrompts: optionalBoolean(raw.forwardPrompts, `servers[${index}].forwardPrompts`) ?? false,
    ...(permissions === undefined ? {} : { permissions }),
    ...(oauth === undefined ? {} : { oauth }),
  };
}

function parseGroups(raw: unknown): Record<string, GroupConfig> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) invalid('groups 必须是对象');

  const result: Record<string, GroupConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!GROUP_NAME.test(name)) invalid(`分组名称 '${name}' 必须匹配 ${GROUP_NAME.source}`);
    if (!isRecord(value)) invalid(`groups.${name} 必须是对象`);
    const description = optionalString(value.description, `groups.${name}.description`);
    const servers = stringArray(value.servers, `groups.${name}.servers`);
    if (servers.length === 0) invalid(`groups.${name}.servers 不能为空`);
    if (new Set(servers).size !== servers.length) invalid(`groups.${name}.servers 包含重复项`);
    result[name] = {
      ...(description === undefined ? {} : { description }),
      servers,
    };
  }
  return result;
}

function parseTransport(raw: unknown, baseDir: string): HttpTransportConfig {
  if (raw === undefined) {
    return {
      host: '127.0.0.1',
      port: 8080,
      path: '/mcp',
      allowedOrigins: [],
      allowedHosts: [],
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      admin: false,
      cli: false,
    };
  }
  if (!isRecord(raw)) invalid('transport 必须是对象');

  const host = expandValue(optionalString(raw.host, 'transport.host') ?? '127.0.0.1', baseDir, 'transport.host');
  const port = optionalPositiveInteger(raw.port, 'transport.port') ?? 8080;
  if (port > 65_535) invalid('transport.port 必须 <= 65535');
  const rawPath = expandValue(optionalString(raw.path, 'transport.path') ?? '/mcp', baseDir, 'transport.path');
  const mcpPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (mcpPath.includes('?') || mcpPath.includes('#')) invalid('transport.path 必须是路径，不能包含查询串或片段');
  if (mcpPath === '/health') invalid("transport.path '/health' 是健康检查保留路径");
  if (mcpPath === '/admin' || mcpPath.startsWith('/admin/') || mcpPath === '/api/admin' || mcpPath.startsWith('/api/admin/')) {
    invalid('transport.path 不能使用保留前缀 /admin 或 /api/admin');
  }

  let authToken = optionalString(raw.authToken, 'transport.authToken');
  if (authToken !== undefined) {
    authToken = expandValue(authToken, baseDir, 'transport.authToken');
    if (authToken.length === 0) invalid('transport.authToken 展开后不能为空');
  }

  return {
    host,
    port,
    path: mcpPath.length > 1 ? mcpPath.replace(/\/+$/, '') : mcpPath,
    ...(authToken === undefined ? {} : { authToken }),
    allowedOrigins: stringArray(raw.allowedOrigins, 'transport.allowedOrigins')
      .map((origin, index) => expandValue(origin, baseDir, `transport.allowedOrigins[${index}]`)),
    allowedHosts: stringArray(raw.allowedHosts, 'transport.allowedHosts')
      .map((hostName, index) => expandValue(hostName, baseDir, `transport.allowedHosts[${index}]`)),
    maxBodyBytes: optionalPositiveInteger(raw.maxBodyBytes, 'transport.maxBodyBytes') ?? DEFAULT_MAX_BODY_BYTES,
    admin: optionalBoolean(raw.admin, 'transport.admin') ?? false,
    cli: optionalBoolean(raw.cli, 'transport.cli') ?? false,
  };
}

export function parseConfig(raw: unknown, sourcePath: string): AppConfig {
  if (!isRecord(raw)) invalid('配置根节点必须是对象');
  if (!Array.isArray(raw.servers)) invalid('servers 必须是数组');

  const baseDir = path.dirname(path.resolve(sourcePath));
  const servers = raw.servers.map((server, index) => parseServer(server, index, baseDir));
  const seenNames = new Set<string>();
  for (const server of servers) {
    if (seenNames.has(server.name)) invalid(`服务器名称 '${server.name}' 重复`);
    seenNames.add(server.name);
  }

  const groups = parseGroups(raw.groups);
  for (const [name, group] of Object.entries(groups)) {
    for (const member of group.servers) {
      if (!seenNames.has(member)) invalid(`groups.${name} 引用了未知服务器 '${member}'`);
    }
  }

  return {
    servers,
    groups,
    transport: parseTransport(raw.transport, baseDir),
    permissions: parseGlobalPermissions(raw.permissions),
    health: parseHealth(raw.health),
  };
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  const sourcePath = resolveConfigPath(explicitPath);
  let text: string;
  try {
    text = fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw new AppError(
      'CONFIG_INVALID',
      `无法读取配置 ${sourcePath}。请复制 servers.example.json 到该路径，或用 --config 指定配置。(${(error as Error).message})`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AppError('CONFIG_INVALID', `配置文件 ${sourcePath} 不是有效 JSON：${(error as Error).message}`);
  }

  return {
    config: parseConfig(raw, sourcePath),
    sourcePath,
    baseDir: path.dirname(sourcePath),
  };
}
