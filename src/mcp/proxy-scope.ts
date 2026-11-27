import { AppError } from '../core/errors.js';
import type { ServerManager } from './manager.js';

export interface ProxyScope {
  group: string;
  allowedServers: Set<string>;
}

const GROUP_NAME = /^[A-Za-z0-9._-]+$/;

export function buildGroupScope(manager: ServerManager, group: string): ProxyScope {
  const config = manager.getGroups()[group];
  if (!config) {
    throw new AppError('INVALID_PARAMETERS', `Unknown group '${group}'`);
  }
  const allowedServers = new Set(
    config.servers.filter((name) => manager.getServerConfig(name)?.enabled === true),
  );
  return { group, allowedServers };
}

export function resolveGroupScope(manager: ServerManager, group: string): ProxyScope {
  if (!GROUP_NAME.test(group)) {
    throw new AppError(
      'INVALID_PARAMETERS',
      `Invalid group name '${group}'. Use letters, digits, dots, underscores, or hyphens.`,
    );
  }
  const groups = manager.getGroups();
  if (!Object.prototype.hasOwnProperty.call(groups, group)) {
    const available = Object.keys(groups);
    throw new AppError(
      'INVALID_PARAMETERS',
      `Unknown group '${group}'. ${available.length > 0 ? `Available: ${available.join(', ')}` : 'No groups are configured.'}`,
    );
  }
  return buildGroupScope(manager, group);
}

export function refreshGroupScope(manager: ServerManager, scope: ProxyScope): void {
  const next = buildGroupScopeSafely(manager, scope.group);
  scope.allowedServers.clear();
  for (const name of next) scope.allowedServers.add(name);
}

function buildGroupScopeSafely(manager: ServerManager, group: string): Set<string> {
  const config = manager.getGroups()[group];
  if (!config) return new Set();
  return new Set(
    config.servers.filter((name) => manager.getServerConfig(name)?.enabled === true),
  );
}
