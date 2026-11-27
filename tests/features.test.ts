import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ServerConfig } from '../src/config/types.js';
import { silentLogger } from '../src/core/logger.js';
import { ServerManager } from '../src/mcp/manager.js';
import { resolvePermission } from '../src/mcp/permissions.js';
import { decodePromptName, encodePromptName } from '../src/mcp/prompt-namespace.js';
import { createProxyServer } from '../src/mcp/proxy-server.js';
import { resolveGroupScope } from '../src/mcp/proxy-scope.js';

const root = path.resolve(__dirname, '..');
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function serverConfig(
  name: string,
  script: string,
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  return {
    name,
    description: `${name} fixture`,
    enabled: true,
    command: process.execPath,
    args: [path.join(root, 'examples', script)],
    cwd: root,
    env: {},
    headers: {},
    timeoutMs: 10_000,
    forwardPrompts: false,
    ...overrides,
  };
}

async function connectedClient(
  manager: ServerManager,
  scope?: ReturnType<typeof resolveGroupScope>,
): Promise<Client> {
  const proxy: Server = createProxyServer(manager, silentLogger, scope);
  const client = new Client({ name: 'feature-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), proxy.connect(serverTransport)]);
  cleanup.push(async () => {
    await client.close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    await manager.closeAll();
  });
  return client;
}

function textPayload(result: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  return text === undefined ? undefined : JSON.parse(text);
}

describe('group scoping', () => {
  it('filters list_servers and rejects servers outside the group', async () => {
    const manager = new ServerManager(
      [
        serverConfig('echo', 'echo-server.mjs'),
        serverConfig('prompt', 'prompt-server.mjs', { forwardPrompts: true }),
      ],
      { groups: { tools: { servers: ['echo'] } } },
    );
    const scope = resolveGroupScope(manager, 'tools');
    const client = await connectedClient(manager, scope);

    const listed = await client.callTool({ name: 'list_servers', arguments: {} });
    const payload = textPayload(listed) as { servers: Array<{ name: string }> };
    expect(payload.servers.map((server) => server.name)).toEqual(['echo']);

    const denied = await client.callTool({
      name: 'list_commands',
      arguments: { server: 'prompt' },
    });
    expect(denied.isError).toBe(true);
    expect(denied._meta).toMatchObject({
      manageableMcpProxyError: { code: 'SERVER_NOT_FOUND' },
    });

    const deniedBatch = await client.callTool({
      name: 'list_commands',
      arguments: { servers: ['echo', 'prompt'] },
    });
    expect(deniedBatch.isError).toBe(true);
    expect(deniedBatch._meta).toMatchObject({
      manageableMcpProxyError: { code: 'SERVER_NOT_FOUND' },
    });
    expect(manager.hasPromptForwarding(scope)).toBe(false);
  });
});

describe('prompt forwarding', () => {
  it('advertises prompts, namespaces names, and resolves the original prompt', async () => {
    const manager = new ServerManager([
      serverConfig('prompt', 'prompt-server.mjs', { forwardPrompts: true }),
      serverConfig('echo', 'echo-server.mjs'),
    ]);
    const client = await connectedClient(manager);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
      'prompt::summarize',
      'prompt::a\\:\\:b',
    ]);

    const result = await client.getPrompt({
      name: 'prompt::a\\:\\:b',
      arguments: { topic: 'MCP' },
    });
    expect(result.messages[0]).toMatchObject({
      role: 'user',
      content: { type: 'text', text: 'Summarize MCP for a::b.' },
    });

    expect(manager.listServers().find((server) => server.name === 'echo')?.status).toBe('idle');
  });

  it('round-trips components containing delimiters and backslashes', () => {
    const encoded = encodePromptName('srv::x\\y', 'a::b\\c');
    expect(decodePromptName(encoded)).toEqual({
      serverName: 'srv::x\\y',
      promptName: 'a::b\\c',
    });
    expect(decodePromptName('plain')).toBeNull();
  });
});

describe('permission policy', () => {
  it('uses server rules before global rules and denies the call', async () => {
    const manager = new ServerManager([
      serverConfig('echo', 'echo-server.mjs', {
        permissions: {
          rules: [{ pattern: 'echo', action: 'deny', message: 'echo is blocked' }],
        },
      }),
    ], {
      permissions: {
        rules: [{ server: 'echo', pattern: 'add', action: 'deny' }],
      },
    });
    const client = await connectedClient(manager);

    const blocked = await client.callTool({
      name: 'invoke_command',
      arguments: { server: 'echo', command_name: 'echo', parameters: { text: 'nope' } },
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.content?.[0]).toMatchObject({ text: 'POLICY_BLOCKED: echo is blocked' });

    const globallyBlocked = await client.callTool({
      name: 'invoke_command',
      arguments: { server: 'echo', command_name: 'add', parameters: { a: 1, b: 2 } },
    });
    expect(globallyBlocked.isError).toBe(true);
    expect(globallyBlocked._meta).toMatchObject({
      manageableMcpProxyError: { code: 'POLICY_BLOCKED', policySource: 'global-rule' },
    });
  });

  it('implements last-rule-wins resolution', () => {
    const decision = resolvePermission('demo', 'read_file', undefined, {
      rules: [
        { server: '*', pattern: '*', action: 'deny' },
        { server: 'demo', pattern: 'read_*', action: 'allow' },
      ],
    });
    expect(decision).toMatchObject({ action: 'allow', source: 'global-rule' });
  });
});

describe('meta-tool contract', () => {
  it('returns legacy server fields and supports case-insensitive filtering', async () => {
    const manager = new ServerManager([
      serverConfig('echo', 'echo-server.mjs', {
        tags: ['Local', 'Fixture'],
        examples: [{ command: 'echo', description: 'Echo text' }],
      }),
      serverConfig('prompt', 'prompt-server.mjs'),
    ]);
    const client = await connectedClient(manager);

    const result = await client.callTool({
      name: 'list_servers',
      arguments: { filter: 'LOCAL' },
    });
    const payload = textPayload(result) as {
      version: string;
      servers: Array<Record<string, unknown>>;
    };
    expect(payload.version).toBe('0.2.0');
    expect(payload.servers).toHaveLength(1);
    expect(payload.servers[0]).toMatchObject({
      name: 'echo',
      tools_count: null,
      tags: ['Local', 'Fixture'],
      examples: [{ command: 'echo', description: 'Echo text' }],
    });
  });

  it('supports single and batch command discovery with refresh', async () => {
    const manager = new ServerManager([
      serverConfig('first', 'echo-server.mjs'),
      serverConfig('second', 'echo-server.mjs'),
    ]);
    const client = await connectedClient(manager);
    const spy = vi.spyOn(manager, 'listTools');

    const single = await client.callTool({
      name: 'list_commands',
      arguments: { server: 'first', refresh: true },
    });
    const singleCommands = textPayload(single) as Array<{ name: string }>;
    expect(Array.isArray(singleCommands)).toBe(true);
    expect(singleCommands.map((command) => command.name)).toEqual(['echo', 'add', 'fail']);
    expect(spy).toHaveBeenCalledWith('first', true);

    const batch = await client.callTool({
      name: 'list_commands',
      arguments: { servers: ['first', 'second'] },
    });
    const batchCommands = textPayload(batch) as Record<string, Array<{ name: string }>>;
    expect(Object.keys(batchCommands)).toEqual(['first', 'second']);
    expect(batchCommands.second?.map((command) => command.name)).toEqual(['echo', 'add', 'fail']);

    const invalid = await client.callTool({
      name: 'list_commands',
      arguments: { server: 'first', servers: ['second'] },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid._meta).toMatchObject({
      manageableMcpProxyError: { code: 'INVALID_PARAMETERS' },
    });

    const missing = await client.callTool({
      name: 'list_commands',
      arguments: {},
    });
    expect(missing._meta).toMatchObject({
      manageableMcpProxyError: { code: 'INVALID_PARAMETERS' },
    });
  });

  it('describes command names with schemas and refresh', async () => {
    const manager = new ServerManager([serverConfig('echo', 'echo-server.mjs')]);
    const client = await connectedClient(manager);
    const spy = vi.spyOn(manager, 'listTools');

    const result = await client.callTool({
      name: 'describe_commands',
      arguments: { server: 'echo', command_names: ['echo', 'add'], refresh: true },
    });
    const schemas = textPayload(result) as Array<Record<string, unknown>>;
    expect(schemas).toHaveLength(2);
    expect(schemas[0]).toMatchObject({
      name: 'echo',
      description: 'Echo the supplied text.',
      inputSchema: { type: 'object' },
    });
    expect(spy).toHaveBeenCalledWith('echo', true);
  });

  it('preserves title, outputSchema, annotations, and _meta in descriptions', async () => {
    const manager = new ServerManager([serverConfig('echo', 'echo-server.mjs')]);
    const client = await connectedClient(manager);
    vi.spyOn(manager, 'listTools').mockResolvedValue([
      {
        name: 'rich',
        title: 'Rich Tool',
        description: 'Rich schema',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        annotations: { readOnlyHint: true },
        _meta: { source: 'fixture' },
      },
    ]);

    const result = await client.callTool({
      name: 'describe_commands',
      arguments: { server: 'echo', command_names: ['rich'] },
    });
    expect(textPayload(result)).toEqual([
      {
        name: 'rich',
        title: 'Rich Tool',
        description: 'Rich schema',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        annotations: { readOnlyHint: true },
        _meta: { source: 'fixture' },
      },
    ]);
  });

  it('requires command_name and rejects flattened downstream arguments', async () => {
    const manager = new ServerManager([serverConfig('echo', 'echo-server.mjs')]);
    const client = await connectedClient(manager);

    const missing = await client.callTool({
      name: 'invoke_command',
      arguments: { server: 'echo', parameters: { text: 'missing name' } },
    });
    expect(missing.isError).toBe(true);
    expect(missing._meta).toMatchObject({
      manageableMcpProxyError: { code: 'INVALID_PARAMETERS' },
    });

    const flattened = await client.callTool({
      name: 'invoke_command',
      arguments: {
        server: 'echo',
        command_name: 'echo',
        text: 'flattened',
      },
    });
    expect(flattened.isError).toBe(true);
    expect(flattened.content?.[0]).toMatchObject({
      text: expect.stringContaining('放在 parameters 内'),
    });
    expect(flattened._meta).toMatchObject({
      manageableMcpProxyError: {
        code: 'INVALID_PARAMETERS',
        unexpectedKeys: ['text'],
      },
    });
  });
});
