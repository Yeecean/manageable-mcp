import { AppError } from '../core/errors.js';
import { CLIENTS, type ClientName } from './config.js';
import {
  createLaunchSpec,
  installIntegration,
  integrationStatus,
  rollbackIntegration,
  uninstallIntegration,
  verifyIntegration,
} from './service.js';

function help(): void {
  process.stdout.write(`客户端接入：
  manageable-mcp connect status [客户端]
  manageable-mcp connect install <客户端> [--config <路径>] [--group <分组>] [--replace]
  manageable-mcp connect install <客户端> --attach <URL>
  manageable-mcp connect verify <客户端>
  manageable-mcp connect uninstall <客户端>
  manageable-mcp connect rollback <客户端>

客户端：claude、codex、opencode、cursor（OpenCode 2.x）
使用 --client-config <路径> 可指定客户端配置文件。
install 会先检查代理能否启动，再写入客户端配置；rollback 仅撤销最近一次操作。
只有指定 --replace 才替换同名的其他服务器，替换前会备份。
`);
}

export async function runIntegrationCli(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    help();
    return;
  }
  const [action, maybeClient, ...remaining] = argv;
  if (!['status', 'install', 'verify', 'uninstall', 'rollback'].includes(action as string)) {
    throw new AppError('INVALID_PARAMETERS', '未知客户端接入操作，请使用 connect --help');
  }
  let client: ClientName | undefined;
  const args = [...remaining];
  if (maybeClient?.startsWith('--')) args.unshift(maybeClient);
  else if (maybeClient !== undefined) {
    if (!CLIENTS.includes(maybeClient as ClientName)) {
      throw new AppError('INVALID_PARAMETERS', `不支持客户端 '${maybeClient}'`);
    }
    client = maybeClient as ClientName;
  }
  if (action !== 'status' && client === undefined) {
    throw new AppError('INVALID_PARAMETERS', '请指定客户端名称');
  }

  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    if (flag === '--replace') {
      if (flags.has(flag)) throw new AppError('INVALID_PARAMETERS', `${flag} 不可重复`);
      flags.set(flag, 'true');
      continue;
    }
    if (!['--client-config', '--config', '--group', '--attach'].includes(flag)) {
      throw new AppError('INVALID_PARAMETERS', `未知选项 '${flag}'`);
    }
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new AppError('INVALID_PARAMETERS', `${flag} 需要一个值`);
    }
    if (flags.has(flag)) throw new AppError('INVALID_PARAMETERS', `${flag} 不可重复`);
    flags.set(flag, value);
    index += 1;
  }
  if (action !== 'install' && [...flags.keys()].some((flag) => flag !== '--client-config')) {
    throw new AppError('INVALID_PARAMETERS', '--config、--group、--attach 和 --replace 只能用于 install');
  }
  if (action === 'status' && client === undefined && flags.has('--client-config')) {
    throw new AppError('INVALID_PARAMETERS', '指定 --client-config 时需要选择一个客户端');
  }
  if (action === 'status') {
    for (const name of client === undefined ? CLIENTS : [client]) {
      const status = await integrationStatus({ client: name, configPath: flags.get('--client-config') });
      process.stdout.write(`${name}：${status.state}；${status.executableFound ? '已找到程序' : '未在 PATH 找到程序'}\n  ${status.configPath}\n`);
    }
    return;
  }

  const options = { client: client as ClientName, configPath: flags.get('--client-config') };
  if (action === 'install') {
    const spec = createLaunchSpec({ config: flags.get('--config'), group: flags.get('--group'), attach: flags.get('--attach') });
    const changed = await installIntegration(options, spec, flags.has('--replace'));
    process.stdout.write(changed ? '配置已写入，代理启动检查通过；原配置已备份。\n' : '配置已存在，代理启动检查通过。\n');
  } else if (action === 'verify') {
    await verifyIntegration(options);
    process.stdout.write('代理启动检查通过，已发现四个代理工具；客户端实际状态请在客户端内确认。\n');
  } else if (action === 'uninstall') {
    const changed = await uninstallIntegration(options);
    process.stdout.write(changed ? '已移除接入项，原配置已备份。\n' : '没有需要移除的接入项。\n');
  } else {
    await rollbackIntegration(options);
    process.stdout.write('已恢复最近一次操作前的客户端配置。\n');
  }
}
