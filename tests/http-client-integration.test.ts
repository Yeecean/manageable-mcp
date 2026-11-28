import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { ServerManager } from '../src/mcp/manager.js';
import { startHttpServer, type RunningHttpServer } from '../src/transports/http.js';

let directory: string;
let server: RunningHttpServer;
const priorCodexHome = process.env.CODEX_HOME;
const priorStateDir = process.env.MANAGEABLE_MCP_STATE_DIR;
const token = 'integration-test-token';

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-client-http-'));
  process.env.CODEX_HOME = path.join(directory, 'codex');
  process.env.MANAGEABLE_MCP_STATE_DIR = path.join(directory, 'state');
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(directory, 'servers.json'), JSON.stringify({ servers: [] }));
  const manager = new ServerManager([], { configPath: path.join(directory, 'servers.json') });
  server = await startHttpServer(manager, {
    host: '127.0.0.1', port: 0, path: '/mcp', authToken: token,
    allowedHosts: [], allowedOrigins: [], maxBodyBytes: 1024 * 1024, admin: true, cli: false,
  }, silentLogger);
});

afterAll(async () => {
  await server?.close();
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = priorCodexHome;
  if (priorStateDir === undefined) delete process.env.MANAGEABLE_MCP_STATE_DIR;
  else process.env.MANAGEABLE_MCP_STATE_DIR = priorStateDir;
  const resolved = path.resolve(directory).toLowerCase();
  if (!resolved.startsWith(path.resolve(os.tmpdir(), 'manageable-client-http-').toLowerCase())) {
    throw new Error('unexpected test directory');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('管理 API 客户端接入', () => {
  it('通过 HTTP 保护冲突，并在显式替换后恢复原配置', async () => {
    const configPath = path.join(directory, 'codex', 'config.toml');
    const original = '# 保留\n[mcp_servers.manageable-mcp]\ncommand = "other"\nargs = []\n';
    fs.writeFileSync(configPath, original);
    const base = server.url.replace(/\/mcp$/, '');
    const post = (action: string, body: Record<string, unknown>) => fetch(`${base}/api/admin/clients/codex/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await post('install', {})).status).toBe(400);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    expect((await post('install', { replace: true })).status).toBe(200);
    expect((await post('verify', {})).status).toBe(200);
    expect((await post('rollback', {})).status).toBe(200);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  }, 60_000);
});
