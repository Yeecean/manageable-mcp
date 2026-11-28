import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-client-apps-'));
const profile = path.join(tempRoot, 'profile');
const roaming = path.join(tempRoot, 'roaming');
const config = path.join(tempRoot, 'servers.json');
const env = {
  ...process.env,
  HOME: profile,
  USERPROFILE: profile,
  APPDATA: roaming,
  LOCALAPPDATA: path.join(tempRoot, 'local'),
  TMP: path.join(tempRoot, 'temp'),
  TEMP: path.join(tempRoot, 'temp'),
  CODEX_HOME: path.join(tempRoot, 'codex'),
  CLAUDE_CONFIG_DIR: path.join(tempRoot, 'claude'),
  XDG_CONFIG_HOME: path.join(tempRoot, 'xdg'),
  XDG_DATA_HOME: path.join(tempRoot, 'data'),
  XDG_CACHE_HOME: path.join(tempRoot, 'cache'),
  XDG_STATE_HOME: path.join(tempRoot, 'state'),
  MANAGEABLE_MCP_STATE_DIR: path.join(tempRoot, 'manageable'),
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  NO_COLOR: '1',
};
const actualRoaming = process.env.APPDATA || '';
const actualProfile = os.homedir();
const clients = [
  {
    name: 'codex',
    executable: process.execPath,
    entry: process.env.CODEX_TEST_ENTRY || path.join(actualRoaming, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    args: ['mcp', 'get', 'manageable-mcp', '--json'],
  },
  {
    name: 'claude',
    executable: process.env.CLAUDE_TEST_EXECUTABLE || path.join(actualProfile, '.local', 'bin', 'claude.exe'),
    args: ['mcp', 'get', 'manageable-mcp'],
  },
  {
    name: 'opencode',
    executable: process.env.OPENCODE_TEST_EXECUTABLE || path.join(actualRoaming, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    args: ['mcp', 'list', '--standalone'],
  },
];

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: tempRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`退出码 ${result.status ?? '无'}：${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout;
}

let failures = 0;
try {
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(env.TEMP, { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ servers: [] }));
  for (const client of clients) {
    if (!fs.existsSync(client.executable) || (client.entry && !fs.existsSync(client.entry))) {
      console.log(`${client.name}: 未找到程序，跳过`);
      continue;
    }
    try {
      run(process.execPath, [path.join(projectRoot, 'dist', 'index.js'), 'connect', 'install', client.name, '--config', config]);
      const output = run(client.executable, [...(client.entry ? [client.entry] : []), ...client.args]);
      if (!output.includes('manageable-mcp')) {
        if (client.name === 'opencode') {
          const sources = run(client.executable, ['debug', 'config', '--standalone']);
          if (!sources.includes('manageable-mcp')) throw new Error('客户端没有读取生成的配置');
          run(client.executable, ['mcp', 'add', 'native-check', '--global', '--', process.execPath, path.join(projectRoot, 'dist', 'index.js'), '--config', config]);
          const nativeList = run(client.executable, ['mcp', 'list', '--standalone']);
          const nativeNote = nativeList.includes('native-check') ? '' : '；其原生添加的条目也不显示';
          throw new Error(`客户端已读取配置，但独立模式的 MCP 列表为空${nativeNote}`);
        }
        throw new Error('客户端输出中没有接入项');
      }
      if (client.name === 'claude' && !/Status:.*Connected/i.test(output)) {
        throw new Error('客户端识别了配置，但未确认连接');
      }
      console.log(client.name === 'claude'
        ? 'claude: 隔离配置已被真实客户端识别并连接'
        : `${client.name}: 隔离配置已被真实客户端识别`);
    } catch (error) {
      failures += 1;
      console.error(`${client.name}: ${error.message}`);
    }
  }
  console.log('cursor: 当前 CLI 没有无界面读取 MCP 状态的命令，未验证 GUI');
} finally {
  const resolved = path.resolve(tempRoot).toLowerCase();
  const prefix = path.resolve(os.tmpdir(), 'manageable-client-apps-').toLowerCase();
  if (!resolved.startsWith(prefix)) throw new Error('拒绝清理非测试目录');
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
