import type {
  GlobalPermissions,
  PermissionAction,
  ServerPermissions,
} from '../config/types.js';

export interface PermissionDecision {
  action: PermissionAction;
  message?: string;
  source: 'server-rule' | 'global-rule' | 'server-default' | 'global-default' | 'implicit-default';
}

export function globToRegExp(pattern: string): RegExp {
  const collapsed = pattern.replace(/\*+/g, '*');
  const escaped = collapsed.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

export function matchesGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

export function resolvePermission(
  serverName: string,
  commandName: string,
  server: ServerPermissions | undefined,
  global: GlobalPermissions,
): PermissionDecision {
  let matchedServerRule: { action: PermissionAction; message?: string } | undefined;
  for (const rule of server?.rules ?? []) {
    if (matchesGlob(rule.pattern, commandName)) matchedServerRule = rule;
  }
  if (matchedServerRule) {
    return {
      action: matchedServerRule.action,
      ...(matchedServerRule.message === undefined ? {} : { message: matchedServerRule.message }),
      source: 'server-rule',
    };
  }

  let matchedGlobalRule: { action: PermissionAction; message?: string } | undefined;
  for (const rule of global.rules) {
    if (
      matchesGlob(rule.server ?? '*', serverName) &&
      matchesGlob(rule.pattern, commandName)
    ) {
      matchedGlobalRule = rule;
    }
  }
  if (matchedGlobalRule) {
    return {
      action: matchedGlobalRule.action,
      ...(matchedGlobalRule.message === undefined ? {} : { message: matchedGlobalRule.message }),
      source: 'global-rule',
    };
  }

  if (server?.default) return { action: server.default, source: 'server-default' };
  if (global.default) return { action: global.default, source: 'global-default' };
  return { action: 'allow', source: 'implicit-default' };
}
