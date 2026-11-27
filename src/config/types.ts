export interface ServerConfig {
  name: string;
  description: string;
  enabled: boolean;
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  forwardPrompts: boolean;
  permissions?: ServerPermissions;
  oauth?: OAuthConfig;
  tags: string[];
  examples?: ServerExample[];
  healthCheck?: HealthCheckConfig;
  configError?: string;
}

export interface ServerExample {
  command?: string;
  description?: string;
}

export interface HealthCheckConfig {
  enabled: boolean;
  timeoutMs: number;
  method: 'tools/list' | 'ping';
  cacheDurationMs: number;
}

export interface EmbedServerSummariesConfig {
  enabled: boolean;
  maxDescriptionChars?: number;
  maxCatalogChars?: number;
}

export interface GroupConfig {
  description?: string;
  servers: string[];
}

export type PermissionAction = 'allow' | 'deny';

export interface PermissionRule {
  pattern: string;
  action: PermissionAction;
  message?: string;
}

export interface ServerPermissions {
  default?: PermissionAction;
  rules: PermissionRule[];
}

export interface GlobalPermissionRule extends PermissionRule {
  server?: string;
}

export interface GlobalPermissions {
  default?: PermissionAction;
  rules: GlobalPermissionRule[];
}

export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  scope?: string;
  extraHeaders?: Record<string, string>;
}

export interface HealthConfig {
  enabled: boolean;
  intervalMs: number;
  idleTimeoutMs: number;
  timeoutMs: number;
}

export interface HttpTransportConfig {
  host: string;
  port: number;
  path: string;
  authToken?: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  maxBodyBytes: number;
  admin: boolean;
  cli: boolean;
}

export interface AppConfig {
  servers: ServerConfig[];
  groups: Record<string, GroupConfig>;
  transport: HttpTransportConfig;
  permissions: GlobalPermissions;
  health: HealthConfig;
  embedServerSummaries: EmbedServerSummariesConfig;
}

export interface LoadedConfig {
  config: AppConfig;
  sourcePath: string;
  baseDir: string;
}
