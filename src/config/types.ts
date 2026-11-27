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
}

export interface GroupConfig {
  description?: string;
  servers: string[];
}

export interface HttpTransportConfig {
  host: string;
  port: number;
  path: string;
  authToken?: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  maxBodyBytes: number;
}

export interface AppConfig {
  servers: ServerConfig[];
  groups: Record<string, GroupConfig>;
  transport: HttpTransportConfig;
}

export interface LoadedConfig {
  config: AppConfig;
  sourcePath: string;
  baseDir: string;
}
