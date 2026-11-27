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
    throw new AppError('INVALID_PARAMETERS', `未知分组 '${group}'`);
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
      `分组名称 '${group}' 无效。只能使用字母、数字、点、下划线或连字符。`,
    );
  }
  const groups = manager.getGroups();
  if (!Object.prototype.hasOwnProperty.call(groups, group)) {
    const available = Object.keys(groups);
    throw new AppError(
      'INVALID_PARAMETERS',
      `未知分组 '${group}'。${available.length > 0 ? `可用分组：${available.join(', ')}` : '当前没有配置分组。'}`,
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
