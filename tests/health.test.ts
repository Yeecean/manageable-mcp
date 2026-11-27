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
});
