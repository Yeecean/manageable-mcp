import * as os from 'node:os';
import * as path from 'node:path';

export function getDefaultConfigDir(): string {
  if (process.env.MANAGEABLE_MCP_STATE_DIR) {
    return path.resolve(process.env.MANAGEABLE_MCP_STATE_DIR);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'manageable-mcp');
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'manageable-mcp');
}

export function getDefaultConfigPath(): string {
  return path.join(getDefaultConfigDir(), 'servers.json');
}

export function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.MANAGEABLE_MCP_CONFIG) return path.resolve(process.env.MANAGEABLE_MCP_CONFIG);
  return getDefaultConfigPath();
}

export function getDefaultCliEndpointPath(): string {
  return path.join(getDefaultConfigDir(), 'cli-endpoint.json');
}

export function getOAuthStorePath(): string {
  return path.join(getDefaultConfigDir(), 'oauth.json');
}
