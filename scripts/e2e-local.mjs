#!/usr/bin/env node
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'index.js');
const token = `e2e-${Math.random().toString(36).slice(2)}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child, stderr) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited early (${child.exitCode}): ${stderr.value}`);
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return await response.json();
    } catch {
      // Keep polling while the listener starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`daemon did not become healthy: ${stderr.value}`);
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function rpc(url, tokenValue, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${tokenValue}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  assert(response.ok, `RPC ${method} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-mcp-v2-e2e-'));
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'servers.json');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, MANAGEABLE_MCP_STATE_DIR: stateDir };
let daemon;
let stderr = '';

try {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        servers: [
          {
            name: 'echo',
            description: 'Echo fixture',
            command: process.execPath,
            args: [path.join(root, 'examples', 'echo-server.mjs')],
            cwd: root,
          },
          {
            name: 'prompt',
            description: 'Prompt fixture',
            command: process.execPath,
            args: [path.join(root, 'examples', 'prompt-server.mjs')],
            cwd: root,
            forwardPrompts: true,
          },
        ],
        groups: { demo: { servers: ['echo'] } },
        permissions: {
          rules: [{ server: 'echo', pattern: 'fail', action: 'deny', message: 'blocked by e2e' }],
        },
        health: { enabled: false, intervalMs: 60_000, idleTimeoutMs: 60_000, timeoutMs: 5_000 },
        transport: {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          authToken: token,
          admin: false,
          cli: false,
        },
      },
      null,
      2,
    ),
  );

  daemon = spawn(
    process.execPath,
    [
      cli,
      'serve',
      '--config',
      configPath,
      '--transport',
      'http',
      '--ui',
      '--cli',
      '--health',
      '--log-level',
      'error',
    ],
    {
      cwd: root,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  );
  daemon.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const health = await waitForHealth(base, daemon, { get value() { return stderr; } });
  assert(health.status === 'ok', 'health should be ok');

  const adminPage = await fetch(`${base}/admin`);
  assert(adminPage.status === 200, `admin page should return 200, got ${adminPage.status}`);
  assert((await adminPage.text()).includes('manageable-mcp'), 'admin page should render');

  const unauthorized = await fetch(`${base}/api/admin`);
  assert(unauthorized.status === 401, `admin API should reject missing token, got ${unauthorized.status}`);
  const overview = await fetch(`${base}/api/admin`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(overview.status === 200, 'admin API should accept the bearer token');
  const overviewBody = await overview.json();
  assert(overviewBody.data.servers.length === 2, 'admin overview should show both servers');

  const list = runCli(['list-commands', 'echo', '--json'], env);
  assert(list.status === 0, `list-commands failed: ${list.stderr}`);
  assert(list.stdout.includes('"name": "echo"'), 'list-commands should discover echo');

  const discovered = runCli(['list-commands', 'echo'], env);
  assert(discovered.status === 0, `endpoint discovery failed: ${discovered.stderr}`);
  assert(discovered.stdout.includes('add'), 'endpoint discovery should return tool names');

  const called = runCli(['call', 'echo', 'echo', '{"text":"real-windows-e2e"}'], env);
  assert(called.status === 0, `call failed: ${called.stderr}`);
  assert(called.stdout.trim() === 'real-windows-e2e', 'call should return downstream text');

  const blocked = runCli(['call', 'echo', 'fail'], env);
  assert(blocked.status === 1, 'denied tool call should exit 1');
  assert(blocked.stderr.includes('POLICY_BLOCKED'), 'denied tool call should name POLICY_BLOCKED');

  const group = await rpc(`${base}/mcp/demo`, token, 'tools/call', {
    name: 'list_servers',
    arguments: {},
  });
  const groupServers = JSON.parse(group.result.content[0].text).servers;
  assert(
    groupServers.length === 1 && groupServers[0].name === 'echo',
    `group route should expose only echo: ${JSON.stringify(groupServers)}`,
  );

  const probe = await fetch(`${base}/api/admin/probe`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ names: ['echo'] }),
  });
  const probeBody = await probe.json();
  assert(
    probe.status === 200 && probeBody.data.results[0]?.healthy === true,
    `admin probe failed: ${JSON.stringify(probeBody)}`,
  );

  const attachTransport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, '--attach', `${base}/mcp`, '--auth-token', token],
    cwd: root,
    env,
    stderr: 'pipe',
  });
  const attachClient = new Client(
    { name: 'attach-e2e', version: '1.0.0' },
    { capabilities: {} },
  );
  await attachClient.connect(attachTransport);
  try {
    const attachTools = await attachClient.listTools();
    assert(
      attachTools.tools.map((tool) => tool.name).join(',') ===
        'list_servers,list_commands,describe_commands,invoke_command',
      'attach should forward all four meta-tools',
    );
    const attachCall = await attachClient.callTool({
      name: 'invoke_command',
      arguments: { server: 'echo', command: 'add', parameters: { a: 7, b: 8 } },
    });
    assert(attachCall.content[0].text === '15', 'attach should proxy downstream calls');

    const attachPrompts = await attachClient.listPrompts();
    assert(
      attachPrompts.prompts.some((prompt) => prompt.name === 'prompt::summarize'),
      'attach should forward prompts',
    );
  } finally {
    await attachClient.close().catch(() => undefined);
  }

  const groupAttachTransport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, '--attach', `${base}/mcp/demo`, '--auth-token', token],
    cwd: root,
    env,
    stderr: 'pipe',
  });
  const groupAttachClient = new Client(
    { name: 'attach-group-e2e', version: '1.0.0' },
    { capabilities: {} },
  );
  await groupAttachClient.connect(groupAttachTransport);
  try {
    const scoped = await groupAttachClient.callTool({
      name: 'list_servers',
      arguments: {},
    });
    const scopedServers = JSON.parse(scoped.content[0].text).servers;
    assert(
      scopedServers.length === 1 && scopedServers[0].name === 'echo',
      'attach should honor the group in the URL',
    );
  } finally {
    await groupAttachClient.close().catch(() => undefined);
  }

  const stdioGroupTransport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'serve', '--config', configPath, '--group', 'demo'],
    cwd: root,
    env,
    stderr: 'pipe',
  });
  const stdioGroupClient = new Client(
    { name: 'stdio-group-e2e', version: '1.0.0' },
    { capabilities: {} },
  );
  await stdioGroupClient.connect(stdioGroupTransport);
  try {
    const scoped = await stdioGroupClient.callTool({
      name: 'list_servers',
      arguments: {},
    });
    const scopedServers = JSON.parse(scoped.content[0].text).servers;
    assert(
      scopedServers.length === 1 && scopedServers[0].name === 'echo',
      'stdio --group should expose only the selected group',
    );
  } finally {
    await stdioGroupClient.close().catch(() => undefined);
  }

  process.stdout.write(
    'e2e ok: daemon, one-shot discovery/call/policy, groups, admin, health probe, attach, prompts\n',
  );
} finally {
  if (daemon && daemon.exitCode === null) {
    daemon.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      daemon.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
