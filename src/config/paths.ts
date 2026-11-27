import * as os from 'node:os';
import * as path from 'node:path';

export function getDefaultConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'manageable-mcp', 'servers.json');
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'manageable-mcp', 'servers.json');
}

export function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.MANAGEABLE_MCP_CONFIG) return path.resolve(process.env.MANAGEABLE_MCP_CONFIG);
  return getDefaultConfigPath();
}
