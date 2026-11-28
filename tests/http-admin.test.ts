import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/core/logger.js';
import { loadConfig } from '../src/config/load.js';
import { ServerManager } from '../src/mcp/manager.js';
import { startHttpServer, type RunningHttpServer } from '../src/transports/http.js';

const token = '{{SECRET_admin_test}}';
const root = path.resolve(__dirname, '..');
let tempDir: string;
let manager: ServerManager;
let server: RunningHttpServer;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-mcp-http-admin-'));
  const configPath = path.join(tempDir, 'servers.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        servers: [
          {
            name: 'echo',
            description: 'Demo',
            command: process.execPath,
            args: [path.join(root, 'examples', 'echo-server.mjs')],
            cwd: root,
          },
        ],
        groups: { demo: { servers: ['echo'] } },
        transport: { admin: true },
      },
      null,
      2,
    ),
  );
  const loaded = loadConfig(configPath);
  manager = new ServerManager(loaded.config.servers, {
    groups: loaded.config.groups,
    permissions: loaded.config.permissions,
    health: loaded.config.health,
    configPath: loaded.sourcePath,
  });
  server = await startHttpServer(
    manager,
    {
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      authToken: token,
      allowedOrigins: [],
      allowedHosts: [],
      maxBodyBytes: 64 * 1024,
      admin: true,
      cli: false,
    },
    createLogger('error'),
  );
});

afterAll(async () => {
  await server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('admin HTTP routing', () => {
  it('serves the panel shell and protects the API', async () => {
    const base = server.url.replace(/\/mcp$/, '');
    const page = await fetch(`${base}/admin`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('manageable-mcp');
    expect(html).toContain('管理面板');

    const unauthorized = await fetch(`${base}/api/admin`);
    expect(unauthorized.status).toBe(401);
    const unauthorizedClients = await fetch(`${base}/api/admin/clients`);
    expect(unauthorizedClients.status).toBe(401);

    const overview = await fetch(`${base}/api/admin`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toMatchObject({
      success: true,
      data: {
        servers: [{ name: 'echo', raw: { name: 'echo' } }],
        groups: { demo: { servers: ['echo'] } },
      },
    });
    const clients = await fetch(`${base}/api/admin/clients`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(clients.status).toBe(200);
    const clientBody = await clients.json() as { data: Array<{ client: string }> };
    expect(clientBody.data.map((client) => client.client)).toEqual(['claude', 'codex', 'opencode', 'cursor']);
    const invalidClient = await fetch(`${base}/api/admin/clients/unknown/install`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(invalidClient.status).toBe(404);
    const unsafeClientPost = await fetch(`${base}/api/admin/clients/cursor/install`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(unsafeClientPost.status).toBe(415);
  });

  it('reloads and probes through the admin API', async () => {
    const base = server.url.replace(/\/mcp$/, '');
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const reload = await fetch(`${base}/api/admin/reload`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(reload.status).toBe(200);
    await expect(reload.json()).resolves.toMatchObject({
      success: true,
      data: { serverCount: 1 },
    });

    const probe = await fetch(`${base}/api/admin/probe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ names: ['echo'] }),
    });
    expect(probe.status).toBe(200);
    await expect(probe.json()).resolves.toMatchObject({
      success: true,
      data: { results: [{ name: 'echo', ok: true }] },
    });
  });
});
