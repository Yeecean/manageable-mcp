import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/load.js';

const base = path.join(process.cwd(), 'servers.json');

describe('extended config', () => {
  it('parses groups, permissions, prompts, oauth, health, admin, and cli', () => {
    vi.stubEnv('OAUTH_HEADER', 'secret-header');
    const config = parseConfig(
      {
        servers: [
          {
            name: 'remote',
            description: 'Remote',
            url: 'https://example.com/mcp',
            forwardPrompts: true,
            oauth: {
              clientId: 'client',
              callbackPort: 0,
              scope: 'read',
              extraHeaders: { 'X-Auth': '${OAUTH_HEADER}' },
            },
            permissions: {
              default: 'deny',
              rules: [{ pattern: 'read_*', action: 'allow', message: 'read only' }],
            },
          },
        ],
        groups: { selected: { description: 'Selected', servers: ['remote'] } },
        permissions: {
          default: 'allow',
          rules: [{ server: '*', pattern: 'delete_*', action: 'deny' }],
        },
        health: { enabled: true, intervalMs: 1000, idleTimeoutMs: 0, timeoutMs: 500 },
        transport: { admin: true, cli: true },
      },
      base,
    );

    expect(config.servers[0]).toMatchObject({
      forwardPrompts: true,
      oauth: {
        clientId: 'client',
        callbackPort: 0,
        scope: 'read',
        extraHeaders: { 'X-Auth': 'secret-header' },
      },
      permissions: {
        default: 'deny',
        rules: [{ pattern: 'read_*', action: 'allow', message: 'read only' }],
      },
    });
    expect(config.permissions.rules[0]).toMatchObject({
      server: '*',
      pattern: 'delete_*',
      action: 'deny',
    });
    expect(config.health).toEqual({
      enabled: true,
      intervalMs: 1000,
      idleTimeoutMs: 0,
      timeoutMs: 500,
    });
    expect(config.transport).toMatchObject({ admin: true, cli: true });
    vi.unstubAllEnvs();
  });

  it('defaults health off and prompt forwarding off', () => {
    const config = parseConfig(
      {
        servers: [{ name: 'local', description: 'Local', command: 'node' }],
      },
      base,
    );
    expect(config.servers[0]?.forwardPrompts).toBe(false);
    expect(config.health).toEqual({
      enabled: false,
      intervalMs: 30_000,
      idleTimeoutMs: 300_000,
      timeoutMs: 10_000,
    });
    expect(config.transport).toMatchObject({ admin: false, cli: false });
  });

  it('rejects invalid permission actions and timers', () => {
    expect(() =>
      parseConfig(
        {
          servers: [
            {
              name: 'local',
              description: 'Local',
              command: 'node',
              permissions: { default: 'ask' },
            },
          ],
        },
        base,
      ),
    ).toThrow(/必须是 'allow' 或 'deny'/);

    expect(() =>
      parseConfig(
        {
          servers: [{ name: 'local', description: 'Local', command: 'node' }],
          health: { intervalMs: 0 },
        },
        base,
      ),
    ).toThrow(/必须是正整数/);

    expect(() =>
      parseConfig(
        {
          servers: [{ name: 'local', description: 'Local', command: 'node' }],
          transport: { path: '/api/admin' },
        },
        base,
      ),
    ).toThrow(/保留前缀 \/admin/);
  });
});
