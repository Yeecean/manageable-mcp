import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config/types.js';
import { ServerManager } from '../src/mcp/manager.js';

const root = path.resolve(__dirname, '..');

function echo(): ServerConfig {
  return {
    name: 'echo',
    description: 'Demo',
    enabled: true,
    command: process.execPath,
    args: [path.join(root, 'examples', 'echo-server.mjs')],
    cwd: root,
    env: {},
    headers: {},
    timeoutMs: 10_000,
    forwardPrompts: false,
  };
}

let manager: ServerManager | undefined;

afterEach(async () => {
  await manager?.closeAll();
  manager = undefined;
});

describe('health probes', () => {
  it('records a successful proactive probe', async () => {
    manager = new ServerManager([echo()], {
      health: { enabled: true, intervalMs: 60_000, idleTimeoutMs: 60_000, timeoutMs: 5_000 },
    });

    const [health] = await manager.probeAllServers();
    expect(health).toMatchObject({ ok: true });
    expect(manager.listServers()[0]?.health).toMatchObject({ healthy: true });
    expect(manager.listServers()[0]?.status).toBe('ready');
  });

  it('wakes the monitor on activity and records cached health', async () => {
    manager = new ServerManager([echo()], {
      health: { enabled: true, intervalMs: 60_000, idleTimeoutMs: 60_000, timeoutMs: 5_000 },
    });

    manager.touchActivity();
    const deadline = Date.now() + 5_000;
    while (manager.listServers()[0]?.health === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(manager.listServers()[0]?.health).toMatchObject({ healthy: true });
  });

  it('does not probe when health is disabled', async () => {
    manager = new ServerManager([echo()]);
    manager.touchActivity();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.listServers()[0]?.health).toBeUndefined();
  });

  it('uses the per-server ping method without loading tools', async () => {
    manager = new ServerManager([
      {
        ...echo(),
        healthCheck: {
          enabled: true,
          method: 'ping',
          timeoutMs: 5_000,
          cacheDurationMs: 60_000,
        },
      },
    ]);

    const [health] = await manager.probeAllServers();
    expect(health).toMatchObject({ ok: true, toolsCount: null });
    expect(manager.listServers()[0]?.status).toBe('ready');
    expect(manager.listServers()[0]?.toolCount).toBeUndefined();
  });

  it('reuses the per-server health cache until it expires', async () => {
    manager = new ServerManager([
      {
        ...echo(),
        healthCheck: {
          enabled: true,
          method: 'ping',
          timeoutMs: 5_000,
          cacheDurationMs: 60_000,
        },
      },
    ]);

    const [first] = await manager.probeAllServers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [second] = await manager.probeAllServers();
    expect(second?.checkedAt).toBe(first?.checkedAt);
  });

  it('skips a server whose per-server health check is disabled', async () => {
    manager = new ServerManager([
      {
        ...echo(),
        command: 'definitely-not-a-real-command',
        args: [],
        healthCheck: {
          enabled: false,
          method: 'tools/list',
          timeoutMs: 100,
          cacheDurationMs: 0,
        },
      },
    ]);

    const [health] = await manager.probeAllServers();
    expect(health).toMatchObject({ ok: true, toolsCount: null });
    expect(manager.listServers()[0]?.status).toBe('idle');
  });

  it('starts the monitor when a per-server health check is enabled', async () => {
    manager = new ServerManager([
      {
        ...echo(),
        healthCheck: {
          enabled: true,
          method: 'ping',
          timeoutMs: 5_000,
          cacheDurationMs: 0,
        },
      },
    ]);

    manager.touchActivity();
    const deadline = Date.now() + 5_000;
    while (manager.listServers()[0]?.health === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(manager.listServers()[0]?.health).toMatchObject({ healthy: true });
  });

  it('does not probe servers without an opt-in when global health is disabled', async () => {
    manager = new ServerManager([
      {
        ...echo(),
        name: 'opted-in',
        healthCheck: {
          enabled: true,
          method: 'ping',
          timeoutMs: 5_000,
          cacheDurationMs: 0,
        },
      },
      {
        ...echo(),
        name: 'not-opted-in',
      },
    ]);

    manager.touchActivity();
    const optedIn = () => manager?.listServers().find((server) => server.name === 'opted-in');
    const notOptedIn = () => manager?.listServers().find((server) => server.name === 'not-opted-in');
    const deadline = Date.now() + 5_000;
    while (optedIn()?.health === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(optedIn()?.health).toMatchObject({ healthy: true });
    expect(notOptedIn()?.health).toBeUndefined();
  });
});
