import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseJson } from 'jsonc-parser';
import { parse as parseToml, toJS } from '@watolua/toml';
import { silentLogger } from '../src/core/logger.js';
import { ServerManager } from '../src/mcp/manager.js';
import { startHttpServer } from '../src/transports/http.js';
import {
  CLIENTS,
  clientEntry,
  editClientEntry,
  readClientEntry,
  type ClientName,
} from '../src/integrations/config.js';
import {
  createLaunchSpec,
  installIntegration,
  integrationStatus,
  rollbackIntegration,
  uninstallIntegration,
  verifyIntegration,
} from '../src/integrations/service.js';

let directory: string;
let serverConfig: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-integration-'));
  serverConfig = path.join(directory, 'servers with space.json');
  fs.writeFileSync(serverConfig, JSON.stringify({ servers: [] }), 'utf8');
});

afterEach(() => {
  const resolved = path.resolve(directory).toLowerCase();
  const expected = path.resolve(os.tmpdir(), 'manageable-integration-').toLowerCase();
  if (!resolved.startsWith(expected)) throw new Error('unexpected test directory');
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('客户端配置编辑', () => {
  it('保留 JSONC 注释和其他服务器，并使用 OpenCode 2.x 结构', () => {
    const original = '{\n  // 保留注释\n  "mcp": { "servers": { "other": { "type": "local", "command": ["other"] } } }\n}\n';
    const entry = clientEntry('opencode', { command: 'node', args: ['C:\\folder space\\index.js'] });
    const changed = editClientEntry('opencode', original, entry);
    expect(changed).toContain('// 保留注释');
    expect(readClientEntry('opencode', changed)).toEqual(entry);
    expect(parseJson(changed).mcp.servers.other.command).toEqual(['other']);
    const removed = editClientEntry('opencode', changed, undefined);
    expect(readClientEntry('opencode', removed)).toBeUndefined();
    expect(parseJson(removed).mcp.servers.other.command).toEqual(['other']);
  });

  it('保留 TOML 注释、其他服务器和原有配置', () => {
    const original = '# 保留注释\nmodel = "example"\n[mcp_servers.other]\ncommand = "other"\n';
    const entry = clientEntry('codex', { command: 'C:\\Program Files\\node.exe', args: ['index.js'] });
    const changed = editClientEntry('codex', original, entry);
    expect(changed).toContain('# 保留注释');
    expect(readClientEntry('codex', changed)).toEqual(entry);
    expect(toJS(parseToml(changed))).toMatchObject({ model: 'example', mcp_servers: { other: { command: 'other' } } });
    const removed = editClientEntry('codex', changed, undefined);
    expect(readClientEntry('codex', removed)).toBeUndefined();
    expect(removed).toContain('command = "other"');
  });

  it('拒绝重复键、无效配置和不兼容的服务器节点', () => {
    const entry = clientEntry('cursor', { command: 'node', args: ['index.js'] });
    expect(() => editClientEntry('cursor', '{"mcpServers":{},"mcpServers":{}}', entry)).toThrow('重复');
    expect(() => editClientEntry('cursor', '{"mcpServers":', entry)).toThrow('格式');
    expect(() => editClientEntry('cursor', '{"mcpServers":[]}', entry)).toThrow('不是对象');
    expect(() => editClientEntry('codex', 'mcp_servers = "text"', entry)).toThrow('不是对象');
  });
});

describe('客户端接入和回滚', () => {
  it.each(CLIENTS)('在隔离目录接入、验证并卸载 %s', async (client: ClientName) => {
    const configPath = path.join(directory, client === 'codex' ? 'config.toml' : `${client}.json`);
    const options = { client, configPath, stateDir: path.join(directory, 'state') };
    const original = client === 'codex' ? '# 原有内容\nmodel = "example"\n' : '{\n  "otherSetting": true\n}\n';
    fs.writeFileSync(configPath, original, 'utf8');
    const spec = createLaunchSpec({ config: serverConfig });

    expect(await installIntegration(options, spec)).toBe(true);
    expect((await integrationStatus(options)).state).toBe('已接入');
    await verifyIntegration(options);
    expect(await installIntegration(options, spec)).toBe(false);
    expect(await uninstallIntegration(options)).toBe(true);
    expect((await integrationStatus(options)).state).toBe('未配置');
    await rollbackIntegration(options);
    expect((await integrationStatus(options)).state).toBe('已接入');
  }, 60_000);

  it('回滚新建文件时只删除本工具创建的文件', async () => {
    const options = { client: 'cursor' as const, configPath: path.join(directory, 'mcp.json'), stateDir: path.join(directory, 'state') };
    await installIntegration(options, createLaunchSpec({ config: serverConfig }));
    await rollbackIntegration(options);
    expect(fs.existsSync(options.configPath)).toBe(false);
  }, 30_000);

  it('更新启动参数后可以逐字节回滚', async () => {
    const options = { client: 'codex' as const, configPath: path.join(directory, 'config.toml'), stateDir: path.join(directory, 'state') };
    fs.writeFileSync(serverConfig, JSON.stringify({
      servers: [{ name: 'example', description: '示例', command: process.execPath }],
      groups: { demo: { servers: ['example'] } },
    }));
    fs.writeFileSync(options.configPath, '# 保留原有内容\nmodel = "example"\n');
    await installIntegration(options, createLaunchSpec({ config: serverConfig }));
    const original = fs.readFileSync(options.configPath);
    await installIntegration(options, createLaunchSpec({ config: serverConfig, group: 'demo' }));
    expect(fs.readFileSync(options.configPath, 'utf8')).toContain('--group');
    await rollbackIntegration(options);
    expect(fs.readFileSync(options.configPath).equals(original)).toBe(true);
  }, 30_000);

  it('共享运行时接入通过真实 attach 握手', async () => {
    const manager = new ServerManager([]);
    const running = await startHttpServer(manager, {
      host: '127.0.0.1', port: 0, path: '/mcp', allowedHosts: [], allowedOrigins: [],
      maxBodyBytes: 1024 * 1024, admin: false, cli: false,
    }, silentLogger);
    const options = { client: 'cursor' as const, configPath: path.join(directory, 'mcp.json'), stateDir: path.join(directory, 'state') };
    try {
      await installIntegration(options, createLaunchSpec({ attach: running.url }));
      await verifyIntegration(options);
      expect(fs.readFileSync(options.configPath, 'utf8')).toContain('--attach');
    } finally {
      await running.close();
    }
  }, 30_000);

  it('备份被篡改时拒绝回滚', async () => {
    const options = { client: 'cursor' as const, configPath: path.join(directory, 'mcp.json'), stateDir: path.join(directory, 'state') };
    fs.writeFileSync(options.configPath, '{}');
    await installIntegration(options, createLaunchSpec({ config: serverConfig }));
    const backupRoot = path.join(options.stateDir, 'client-backups');
    const journalDir = path.join(backupRoot, fs.readdirSync(backupRoot)[0] as string);
    const backup = fs.readdirSync(journalDir).find((entry) => entry.endsWith('.backup')) as string;
    const current = fs.readFileSync(options.configPath);
    fs.writeFileSync(path.join(journalDir, backup), 'broken');
    await expect(rollbackIntegration(options)).rejects.toThrow('备份校验失败');
    expect(fs.readFileSync(options.configPath).equals(current)).toBe(true);
  }, 30_000);

  it('名称冲突时不覆盖他人的服务器', async () => {
    const options = { client: 'cursor' as const, configPath: path.join(directory, 'mcp.json'), stateDir: path.join(directory, 'state') };
    const original = '{"mcpServers":{"manageable-mcp":{"command":"other","args":[]}}}';
    fs.writeFileSync(options.configPath, original);
    await expect(installIntegration(options, createLaunchSpec({ config: serverConfig }))).rejects.toThrow('不属于当前项目');
    expect(fs.readFileSync(options.configPath, 'utf8')).toBe(original);
    await expect(uninstallIntegration(options)).rejects.toThrow('不属于当前项目');
    expect(await installIntegration(options, createLaunchSpec({ config: serverConfig }), true)).toBe(true);
    await rollbackIntegration(options);
    expect(fs.readFileSync(options.configPath, 'utf8')).toBe(original);
  }, 30_000);

  it('操作后文件被其他程序修改时拒绝回滚', async () => {
    const options = { client: 'cursor' as const, configPath: path.join(directory, 'mcp.json'), stateDir: path.join(directory, 'state') };
    fs.writeFileSync(options.configPath, '{}');
    await installIntegration(options, createLaunchSpec({ config: serverConfig }));
    const changed = fs.readFileSync(options.configPath, 'utf8') + '\n';
    fs.writeFileSync(options.configPath, changed);
    await expect(rollbackIntegration(options)).rejects.toThrow('已变化');
    expect(fs.readFileSync(options.configPath, 'utf8')).toBe(changed);
  }, 30_000);

  it('代理启动失败时不写客户端配置', async () => {
    const options = { client: 'cursor' as const, configPath: path.join(directory, 'mcp.json'), stateDir: path.join(directory, 'state') };
    const original = '{"other": true}';
    fs.writeFileSync(options.configPath, original);
    const spec = createLaunchSpec({ config: path.join(directory, 'missing.json') });
    await expect(installIntegration(options, spec)).rejects.toThrow('接入验证失败');
    expect(fs.readFileSync(options.configPath, 'utf8')).toBe(original);
  }, 30_000);

  it('拒绝将服务器配置误用为客户端配置', async () => {
    const options = { client: 'cursor' as const, configPath: serverConfig, stateDir: path.join(directory, 'state') };
    const original = fs.readFileSync(serverConfig, 'utf8');
    await expect(installIntegration(options, createLaunchSpec({ config: serverConfig }))).rejects.toThrow('同一个文件');
    expect(fs.readFileSync(serverConfig, 'utf8')).toBe(original);
  });

  it('拒绝把 URL 凭据写进客户端配置', () => {
    expect(() => createLaunchSpec({ attach: 'http://localhost/mcp?token=secret' })).toThrow('不含凭据');
    expect(() => createLaunchSpec({ attach: 'http://example.com/mcp' })).toThrow('HTTPS');
    expect(() => createLaunchSpec({ attach: 'http://localhost/mcp', group: 'group' })).toThrow('不能与');
  });

  it('命令行接入、验证和回滚只影响指定的隔离文件', () => {
    const clientConfig = path.join(directory, 'client.json');
    const cliPath = path.resolve(__dirname, '..', 'dist', 'index.js');
    const env = { ...process.env, MANAGEABLE_MCP_STATE_DIR: path.join(directory, 'state') };
    const run = (...args: string[]) => spawnSync(process.execPath, [cliPath, 'connect', ...args], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const install = run('install', 'cursor', '--client-config', clientConfig, '--config', serverConfig);
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain('代理启动检查通过');
    const verify = run('verify', 'cursor', '--client-config', clientConfig);
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toContain('客户端实际状态请在客户端内确认');
    const rollback = run('rollback', 'cursor', '--client-config', clientConfig);
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(fs.existsSync(clientConfig)).toBe(false);
  }, 60_000);
});
