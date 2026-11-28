import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminController } from '../src/admin/controller.js';
import { AdminConfigStore } from '../src/admin/store.js';
import { loadConfig } from '../src/config/load.js';
import { ServerManager } from '../src/mcp/manager.js';

const root = path.resolve(__dirname, '..');
const echoPath = path.join(root, 'examples', 'echo-server.mjs');
const adminToken = 'admin-secret-token';

let tempDir: string;
let configPath: string;
let manager: ServerManager;
let controller: AdminController;
let adapter: http.Server | undefined;

function echoRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'echo',
    description: 'Echo fixture',
    command: process.execPath,
    args: [echoPath],
    cwd: root,
    ...extra,
  };
}

function initialConfig(): Record<string, unknown> {
  return {
    schemaNote: 'preserve me',
    custom: { nested: true },
    servers: [
      echoRaw({ 'x-extra': 'keep' }),
      {
        name: 'other',
        description: 'Remote example',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer literal-token' },
        'x-note': 'remote',
      },
    ],
    groups: {
      demo: { description: 'Demo group', servers: ['echo', 'other'] },
      solo: { servers: ['other'] },
    },
  };
}

function writeConfig(raw: Record<string, unknown>): void {
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

function authHeaders(json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${adminToken}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function startAdapter(authToken?: string): Promise<string> {
  controller = new AdminController(manager, {
    configPath,
    mcpPath: '/mcp',
    ...(authToken === undefined ? {} : { authToken }),
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const handled = await controller.handle(req, res, url);
      if (!handled) {
        res.writeHead(418, { 'Content-Type': 'text/plain' });
        res.end('not handled');
      }
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      if (!res.writableEnded) res.end('adapter failure');
    }
  });
  adapter = server;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Admin test adapter did not bind to a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

function createMockResponse(): any {
  const chunks: string[] = [];
  const headers: Record<string, unknown> = {};
  const response: any = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    headers,
    setHeader(name: string, value: unknown): void {
      headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, values?: Record<string, unknown>): any {
      response.statusCode = status;
      response.headersSent = true;
      if (values) Object.assign(headers, values);
      return response;
    },
    end(chunk?: unknown): void {
      if (chunk !== undefined) chunks.push(String(chunk));
      response.writableEnded = true;
    },
    json(): unknown {
      return JSON.parse(chunks.join(''));
    },
  };
  return response;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-mcp-v2-admin-'));
  configPath = path.join(tempDir, 'servers.json');
  writeConfig(initialConfig());

  const loaded = loadConfig(configPath);
  manager = new ServerManager(loaded.config.servers, {
    groups: loaded.config.groups,
    permissions: loaded.config.permissions,
    health: loaded.config.health,
    configPath,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (adapter) {
    adapter.closeAllConnections();
    await new Promise<void>((resolve) => {
      adapter?.close(() => resolve());
    });
    adapter = undefined;
  }
  await manager.closeAll();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('AdminConfigStore', () => {
  it('preserves BOM, indentation, CRLF, unknown fields, and temp-file atomic writes', async () => {
    const text = '\uFEFF' + JSON.stringify(initialConfig(), null, 4).replace(/\n/g, '\r\n') + '\r\n';
    fs.writeFileSync(configPath, text, 'utf8');
    const store = new AdminConfigStore(configPath);

    await store.add({
      name: 'alpha',
      description: 'Alpha fixture',
      command: process.execPath,
      args: [echoPath],
      cwd: root,
      'x-new': 'preserved',
    });

    const written = fs.readFileSync(configPath, 'utf8');
    expect(written.charCodeAt(0)).toBe(0xfeff);
    expect(written).toContain('\r\n    "schemaNote"');
    expect(written.endsWith('\r\n')).toBe(true);

    const parsed = JSON.parse(written.replace(/^\uFEFF/, '')) as any;
    expect(parsed.custom).toEqual({ nested: true });
    expect(parsed.servers.find((server: any) => server.name === 'alpha')['x-new']).toBe('preserved');
    expect(parsed.servers.find((server: any) => server.name === 'echo')['x-extra']).toBe('keep');
    expect(fs.readdirSync(tempDir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    await expect(store.get('alpha')).resolves.toMatchObject({ name: 'alpha', 'x-new': 'preserved' });
  });

  it('updates, toggles, and deletes raw servers while preserving top-level fields and groups', async () => {
    const store = new AdminConfigStore(configPath);

    await store.add({
      name: 'worker',
      description: 'Worker fixture',
      command: process.execPath,
      args: [echoPath],
      cwd: root,
      'x-worker': 'one',
    });
    const updated = await store.update('worker', {
      name: 'worker',
      description: 'Worker updated',
      command: process.execPath,
      args: [echoPath],
      cwd: root,
      'x-worker': 'two',
    });
    expect(updated).toMatchObject({ name: 'worker', description: 'Worker updated', 'x-worker': 'two' });

    const disabled = await store.setEnabled('worker', false);
    expect(disabled).toMatchObject({ enabled: false, 'x-worker': 'two' });
    const echoDisabled = await store.setEnabled('echo', false);
    expect(echoDisabled['x-extra']).toBe('keep');

    await store.remove('other');
    const snapshot = await store.snapshot();
    expect(snapshot.servers.map((server) => server.name)).toEqual(['echo', 'worker']);
    expect((snapshot.groups.demo as any).servers).toEqual(['echo']);
    expect(snapshot.groups.solo).toBeUndefined();

    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8')) as any;
    expect(disk.schemaNote).toBe('preserve me');
    expect(disk.custom).toEqual({ nested: true });
    expect(disk.servers.find((server: any) => server.name === 'echo')['x-extra']).toBe('keep');
  });

  it('maps invalid, missing, duplicate, and unreadable config operations to admin statuses', async () => {
    const store = new AdminConfigStore(configPath);

    await expect(store.add(echoRaw())).rejects.toMatchObject({ status: 409 });
    await expect(store.get('missing')).rejects.toMatchObject({ status: 404 });
    await expect(store.update('missing', {})).rejects.toMatchObject({ status: 404 });
    await expect(store.setEnabled('missing', false)).rejects.toMatchObject({ status: 404 });
    await expect(store.remove('missing')).rejects.toMatchObject({ status: 404 });
    await expect(store.setEnabled('echo', 'yes' as any)).rejects.toMatchObject({ status: 400 });

    await expect(
      store.add({ name: 'broken', description: 'No transport' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.add({
        name: 'conflict',
        description: 'Both transports',
        command: 'node',
        url: 'https://example.com/mcp',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.update('echo', { name: 'renamed', description: 'Mismatch', command: 'node' }),
    ).rejects.toMatchObject({ status: 400 });

    fs.writeFileSync(configPath, '{ not json', 'utf8');
    await expect(store.list()).rejects.toMatchObject({ status: 500 });
    fs.rmSync(configPath, { force: true });
    await expect(store.list()).rejects.toMatchObject({ status: 500 });
  });
});

describe('AdminController', () => {
  it('serves the dependency-free page and merges raw config with manager state', async () => {
    const base = await startAdapter(adminToken);

    const page = await fetch(base + '/admin?token=' + adminToken);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('URLSearchParams');
    expect(html).toContain('sessionStorage.setItem(TOKEN_KEY');
    expect(html).toContain('添加服务器');
    expect(html).toContain('重新加载配置');
    expect(html).toContain('检测工具');
    expect(html).toContain('已停用');
    expect(html).toContain('data-filter="disabled"');
    expect(html).toContain('id="copyEndpointBtn"');
    expect(html).toContain('id="oauthDialog"');
    expect(html).toContain('id="toolsDialog"');
    expect(html).toContain('OAuth 授权');
    expect(html).toContain('工具数未知');
    expect(html).toContain('autoProbeUnknown');
    expect(html).toContain('服务器组');
    expect(html).toContain('空闲');
    expect(html).toContain('需要授权');
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:\/\//i);
    expect(html).not.toMatch(/<link\b/i);
    expect((await fetch(base + '/admin')).status).toBe(200);

    const unauthenticated = await fetch(base + '/api/admin');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer');
    await expect(unauthenticated.json()).resolves.toMatchObject({
      success: false,
      error: { message: '未授权' },
    });
    expect(
      (await fetch(base + '/api/admin', { headers: { Authorization: 'Bearer wrong' } })).status,
    ).toBe(401);

    const response = await fetch(base + '/api/admin', { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.configFile).toBe(path.resolve(configPath));
    expect(body.data.mcpPath).toBe('/mcp');
    expect(body.data.servers).toHaveLength(2);
    expect(body.data.stats).toMatchObject({ total: 2, enabled: 2, disabled: 0 });
    expect((body.data.groups.demo as any).servers).toEqual(['echo', 'other']);
    expect(JSON.stringify(body.data)).not.toContain('schemaNote');

    const echo = body.data.servers.find((server: any) => server.name === 'echo');
    expect(echo).toMatchObject({
      name: 'echo',
      description: 'Echo fixture',
      enabled: true,
      transport: 'stdio',
      status: 'idle',
    });
    expect(echo.raw['x-extra']).toBe('keep');
  });

  it('performs authenticated CRUD and reloads the manager after each mutation', async () => {
    const base = await startAdapter(adminToken);
    const alpha = {
      name: 'alpha',
      description: 'Alpha fixture',
      command: process.execPath,
      args: [echoPath],
      cwd: root,
      'x-alpha': 'one',
    };

    const create = await fetch(base + '/api/admin/servers', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(alpha),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as any;
    expect(created.data.server).toMatchObject({ name: 'alpha', status: 'idle' });
    expect(created.data.server.raw['x-alpha']).toBe('one');
    expect(manager.getServerConfig('alpha')?.description).toBe('Alpha fixture');

    const get = await fetch(base + '/api/admin/servers/alpha', { headers: authHeaders() });
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      success: true,
      data: { server: { name: 'alpha', raw: { 'x-alpha': 'one' } } },
    });

    const update = await fetch(base + '/api/admin/servers/alpha', {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify({ ...alpha, description: 'Alpha updated', 'x-alpha': 'two' }),
    });
    expect(update.status).toBe(200);
    expect(manager.getServerConfig('alpha')?.description).toBe('Alpha updated');

    const toggle = await fetch(base + '/api/admin/servers/alpha/toggle', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggle.status).toBe(200);
    expect(manager.getServerConfig('alpha')?.enabled).toBe(false);

    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8')) as any;
    expect(disk.custom).toEqual({ nested: true });
    expect(disk.servers.find((server: any) => server.name === 'alpha')).toMatchObject({
      description: 'Alpha updated',
      enabled: false,
      'x-alpha': 'two',
    });

    const remove = await fetch(base + '/api/admin/servers/alpha', {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(remove.status).toBe(200);
    expect(manager.getServerConfig('alpha')).toBeUndefined();
    expect((await fetch(base + '/api/admin/servers/alpha', { headers: authHeaders() })).status).toBe(404);
  });

  it('rejects non-loopback clients when no token is configured', async () => {
    const base = await startAdapter();
    expect((await fetch(base + '/api/admin')).status).toBe(200);

    const request = {
      method: 'GET',
      url: '/api/admin',
      headers: {},
      socket: { remoteAddress: '10.1.2.3' },
    } as unknown as http.IncomingMessage;
    const response = createMockResponse();

    const handled = await controller.handle(request, response, new URL('http://localhost/api/admin'));
    expect(handled).toBe(true);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('回环') },
    });
  });

  it('reports CRUD errors, unknown routes, and method mismatches', async () => {
    const base = await startAdapter(adminToken);

    const duplicate = await fetch(base + '/api/admin/servers', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(echoRaw()),
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      success: false,
      error: { message: '服务器 “echo” 已存在' },
    });

    const invalid = await fetch(base + '/api/admin/servers', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ name: 'broken', description: 'No transport' }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      success: false,
      error: { message: expect.stringContaining('配置校验失败') },
    });

    const missing = await fetch(base + '/api/admin/servers/nope', { headers: authHeaders() });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      success: false,
      error: { message: '服务器 “nope” 不存在' },
    });

    const mismatch = await fetch(base + '/api/admin/servers/nope', {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify({ description: 'Missing target', command: 'node' }),
    });
    expect(mismatch.status).toBe(404);

    const wrongMethod = await fetch(base + '/api/admin', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');
    await expect(wrongMethod.json()).resolves.toMatchObject({
      success: false,
      error: { message: '请求方法不受支持' },
    });

    expect((await fetch(base + '/api/admin/nope', { headers: authHeaders() })).status).toBe(404);
    expect((await fetch(base + '/not-admin')).status).toBe(418);
  });

  it('reloads external edits and probes a real echo server', async () => {
    const base = await startAdapter(adminToken);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as any;
    raw.servers.push({
      name: 'gamma',
      description: 'Gamma fixture',
      command: process.execPath,
      args: [echoPath],
      cwd: root,
    });
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    expect(manager.getServerConfig('gamma')).toBeUndefined();

    const reload = await fetch(base + '/api/admin/reload', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(reload.status).toBe(200);
    await expect(reload.json()).resolves.toMatchObject({
      success: true,
      data: { serverCount: 3, configFile: path.resolve(configPath) },
    });
    expect(manager.getServerConfig('gamma')).toBeDefined();

    const probe = await fetch(base + '/api/admin/probe', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ names: ['echo'] }),
    });
    expect(probe.status).toBe(200);
    const probeBody = await probe.json() as any;
    expect(probeBody.data.results).toHaveLength(1);
    expect(probeBody.data.results[0]).toMatchObject({ name: 'echo', ok: true });
    expect(probeBody.data.summary).toMatchObject({ total: 1, ok: 1 });

    const overview = await fetch(base + '/api/admin', { headers: authHeaders() });
    const overviewBody = await overview.json() as any;
    const echo = overviewBody.data.servers.find((server: any) => server.name === 'echo');
    expect(echo.health).toMatchObject({ healthy: true });
  });

  it('restores the previous config when a mutation cannot be applied at runtime', async () => {
    const base = await startAdapter(adminToken);
    const before = fs.readFileSync(configPath, 'utf8');
    vi.spyOn(controller as unknown as { reloadManager: () => Promise<unknown> }, 'reloadManager')
      .mockRejectedValueOnce(new Error('forced reload failure'));

    const response = await fetch(base + '/api/admin/servers', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({
        name: 'rollback-me',
        description: 'Should not persist',
        command: process.execPath,
        args: [echoPath],
      }),
    });
    expect(response.status).toBe(500);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(manager.listServers().some((server) => server.name === 'rollback-me')).toBe(false);
  });

  it('forces a live auth check and accepts a case-insensitive bearer scheme', async () => {
    const base = await startAdapter(adminToken);
    const spy = vi.spyOn(manager, 'listTools').mockResolvedValue([
      {
        name: 'remote-tool',
        inputSchema: { type: 'object' },
      },
    ]);

    const response = await fetch(base + '/api/admin/servers/other/auth', {
      method: 'POST',
      headers: { Authorization: `bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { authRequired: false, toolsCount: 1 },
    });
    expect(spy).toHaveBeenCalledWith('other', true);
  });

  it('fails closed when the request socket has no remote address', async () => {
    await startAdapter();
    const request = {
      method: 'GET',
      url: '/api/admin',
      headers: {},
    } as unknown as http.IncomingMessage;
    const response = createMockResponse();

    const handled = await controller.handle(request, response, new URL('http://localhost/api/admin'));
    expect(handled).toBe(true);
    expect(response.statusCode).toBe(403);
  });

  it('logs unknown admin failures to stderr without leaking secrets', async () => {
    const base = await startAdapter(adminToken);
    vi.spyOn(manager, 'listServers').mockImplementation(() => {
      throw new Error('internal failure token=super-secret');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const response = await fetch(base + '/api/admin', { headers: authHeaders() });
    expect(response.status).toBe(500);
    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('管理 API 内部错误');
    expect(output).not.toContain('super-secret');
  });
});

describe('Admin server inspection', () => {
  it('exposes type, auth type, target, tags, and tool counts in the overview', async () => {
    writeConfig({
      servers: [
        echoRaw({ tags: ['local', 'fixture'] }),
        {
          name: 'keyed',
          description: 'Header-authenticated remote',
          url: 'https://example.com/mcp',
          headers: { 'X-Api-Key': 'literal' },
          tags: ['remote'],
        },
        {
          name: 'plain',
          description: 'Unknown auth remote',
          url: 'https://plain.example.com/mcp',
        },
      ],
    });
    const loaded = loadConfig(configPath);
    await manager.reconfigure(loaded.config.servers, {
      groups: loaded.config.groups,
      permissions: loaded.config.permissions,
      health: loaded.config.health,
      configPath,
    });

    const base = await startAdapter(adminToken);
    const overview = await fetch(base + '/api/admin', { headers: authHeaders() });
    const body = await overview.json() as any;
    const byName = new Map(body.data.servers.map((server: any) => [server.name, server]));

    expect(byName.get('echo')).toMatchObject({
      type: 'local',
      authType: 'local',
      toolsCount: null,
      available: true,
      loaded: false,
      tags: ['local', 'fixture'],
    });
    expect((byName.get('echo') as any).target).toContain('echo-server.mjs');
    expect(byName.get('keyed')).toMatchObject({ type: 'remote', authType: 'api-key' });
    expect((byName.get('keyed') as any).authDetail).toContain('X-Api-Key');
    expect(byName.get('plain')).toMatchObject({ type: 'remote', authType: 'unknown' });
    expect(body.data.stats).toMatchObject({ total: 3, enabled: 3, disabled: 0 });
  });

  it('does not treat non-auth headers as API keys and infers OAuth from auth status', async () => {
    writeConfig({
      servers: [
        {
          name: 'plain',
          description: 'Non-auth header',
          url: 'https://plain.example.com/mcp',
          headers: { Accept: 'application/json' },
        },
        {
          name: 'needs-auth',
          description: 'Auth state without static config',
          url: 'https://auth.example.com/mcp',
        },
        {
          name: 'custom-key',
          description: 'Custom subscription key header',
          url: 'https://custom.example.com/mcp',
          headers: { 'X-Subscription-Key': 'literal' },
        },
        {
          name: 'custom-static-header',
          description: 'Custom static credential header',
          url: 'https://custom-static.example.com/mcp',
          headers: { 'X-Custom-Credential': 'literal' },
        },
      ],
    });
    const loaded = loadConfig(configPath);
    await manager.reconfigure(loaded.config.servers, {
      groups: loaded.config.groups,
      permissions: loaded.config.permissions,
      health: loaded.config.health,
      configPath,
    });
    const entry = (manager as unknown as {
      entries: Map<string, { status: string }>;
    }).entries.get('needs-auth');
    expect(entry).toBeDefined();
    entry!.status = 'auth';

    const base = await startAdapter(adminToken);
    const overview = await fetch(base + '/api/admin', { headers: authHeaders() });
    const body = await overview.json() as any;
    const byName = new Map(body.data.servers.map((server: any) => [server.name, server]));
    expect(byName.get('plain')).toMatchObject({ authType: 'unknown' });
    expect(byName.get('custom-key')).toMatchObject({
      authType: 'api-key',
      authDetail: expect.stringContaining('X-Subscription-Key'),
    });
    expect(byName.get('custom-static-header')).toMatchObject({
      authType: 'api-key',
      authDetail: expect.stringContaining('X-Custom-Credential'),
    });
    expect(byName.get('needs-auth')).toMatchObject({
      status: 'auth',
      authType: 'oauth',
      authRequired: true,
    });
  });

  it('redacts targets when falling back to raw config values', async () => {
    writeConfig({
      servers: [
        {
          name: 'remote',
          description: 'Remote with credentials',
          url: 'https://url-user:url-pass-1@example.com/mcp?token=query-secret&region=cn',
        },
        {
          name: 'local',
          description: 'Local with a command secret',
          command: 'node',
          args: ['server.mjs', '--token', 'command-secret'],
        },
      ],
    });
    const fakeManager = {
      getConfigPath: () => configPath,
      listServers: () => [],
      isHealthForcedOn: () => false,
    } as unknown as ServerManager;
    const localController = new AdminController(fakeManager, {
      configPath,
      mcpPath: '/mcp',
      authToken: adminToken,
    });
    const request = {
      method: 'GET',
      url: '/api/admin',
      headers: { authorization: `Bearer ${adminToken}` },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as http.IncomingMessage;
    const response = createMockResponse();

    await localController.handle(request, response, new URL('http://localhost/api/admin'));
    const body = response.json() as any;
    const byName = new Map(body.data.servers.map((server: any) => [server.name, server]));
    expect((byName.get('remote') as any).target).toBe(
      'https://example.com/mcp?token=***&region=cn',
    );
    expect((byName.get('local') as any).target).toBe('node server.mjs --token ***');
  });

  it('probes one server and returns the tool list with a count', async () => {
    const base = await startAdapter(adminToken);

    const probe = await fetch(base + '/api/admin/servers/echo/probe', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(probe.status).toBe(200);
    const probeBody = await probe.json() as any;
    expect(probeBody.data).toMatchObject({ name: 'echo', ok: true, toolsCount: 3 });
    expect(Array.isArray(probeBody.data.tools)).toBe(true);
    expect(probeBody.data.tools.length).toBe(3);

    const tools = await fetch(base + '/api/admin/servers/echo/tools', {
      headers: authHeaders(),
    });
    expect(tools.status).toBe(200);
    const toolsBody = await tools.json() as any;
    expect(toolsBody.data).toMatchObject({ name: 'echo', toolsCount: 3 });
    expect(toolsBody.data.tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(['echo', 'add']),
    );

    const overview = await fetch(base + '/api/admin', { headers: authHeaders() });
    const overviewBody = await overview.json() as any;
    const echo = overviewBody.data.servers.find((server: any) => server.name === 'echo');
    expect(echo).toMatchObject({ toolsCount: 3, loaded: true, healthy: true });
  });

  it('rejects auth checks for local servers and reports disabled servers', async () => {
    const base = await startAdapter(adminToken);

    const auth = await fetch(base + '/api/admin/servers/echo/auth', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(auth.status).toBe(400);
    await expect(auth.json()).resolves.toMatchObject({
      success: false,
      error: { message: expect.stringContaining('本地服务器') },
    });

    const toggle = await fetch(base + '/api/admin/servers/echo/toggle', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggle.status).toBe(200);

    const probe = await fetch(base + '/api/admin/servers/echo/probe', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(probe.status).toBe(409);
    await expect(probe.json()).resolves.toMatchObject({
      success: false,
      error: { message: expect.stringContaining('已停用') },
    });
  });

  it('filters onlyUnknown probes and reports a summary', async () => {
    writeConfig({ servers: [echoRaw()] });
    const loaded = loadConfig(configPath);
    await manager.reconfigure(loaded.config.servers, {
      groups: loaded.config.groups,
      permissions: loaded.config.permissions,
      health: loaded.config.health,
      configPath,
    });
    const base = await startAdapter(adminToken);

    const first = await fetch(base + '/api/admin/probe', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ onlyUnknown: true, concurrency: 2 }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody.data.results.map((result: any) => result.name).sort()).toEqual(['echo']);
    expect(firstBody.data.summary).toMatchObject({ total: 1, ok: 1, failed: 0 });

    const second = await fetch(base + '/api/admin/probe', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ onlyUnknown: true }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as any;
    expect(secondBody.data.results).toEqual([]);
    expect(secondBody.data.summary).toMatchObject({ total: 0, ok: 0, failed: 0 });
  });

  it('validates probe options and reports unknown servers in batches', async () => {
    const base = await startAdapter(adminToken);

    const badNames = await fetch(base + '/api/admin/probe', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ names: [1, 2] }),
    });
    expect(badNames.status).toBe(400);

    const badConcurrency = await fetch(base + '/api/admin/probe', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ concurrency: 'many' }),
    });
    expect(badConcurrency.status).toBe(400);

    const conflictingFilters = await fetch(base + '/api/admin/probe', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ names: ['echo'], onlyUnknown: true }),
    });
    expect(conflictingFilters.status).toBe(400);
    await expect(conflictingFilters.json()).resolves.toMatchObject({
      success: false,
      error: { message: expect.stringContaining('不能与 "names" 同时使用') },
    });

    const unknown = await fetch(base + '/api/admin/servers/missing/probe', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(unknown.status).toBe(404);

    const unknownBatch = await fetch(base + '/api/admin/probe', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ names: ['missing'] }),
    });
    expect(unknownBatch.status).toBe(404);

    const disableEcho = await fetch(base + '/api/admin/servers/echo/toggle', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableEcho.status).toBe(200);

    const disabledBatch = await fetch(base + '/api/admin/probe', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ names: ['echo'] }),
    });
    expect(disabledBatch.status).toBe(409);
  });
});
