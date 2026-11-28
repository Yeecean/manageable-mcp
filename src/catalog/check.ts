import * as fs from 'node:fs';
import { resolveConfigPath } from '../config/paths.js';
import { AppError } from '../core/errors.js';

export interface CatalogEntryReport {
  name: string;
  enabled: boolean;
  descriptionChars: number;
  exampleCount: number;
  tagCount: number;
  warnings: string[];
}

export interface CatalogReport {
  total: number;
  enabled: number;
  catalogChars: number;
  warnings: string[];
  servers: CatalogEntryReport[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkCatalog(configPath?: string): CatalogReport {
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(resolveConfigPath(configPath), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new AppError('CONFIG_INVALID', '无法读取服务器配置或配置不是有效 JSON');
  }
  if (!isRecord(config) || !Array.isArray(config.servers)) {
    throw new AppError('CONFIG_INVALID', '服务器配置必须包含 servers 数组');
  }
  const embed = isRecord(config.embedServerSummaries) ? config.embedServerSummaries : {};
  const lines: string[] = [];
  const servers = config.servers.map((raw, index): CatalogEntryReport => {
    if (!isRecord(raw)) throw new AppError('CONFIG_INVALID', `servers[${index}] 必须是对象`);
    const name = typeof raw.name === 'string' ? raw.name.replace(/[\x00-\x1f\x7f]/g, ' ') : `第 ${index + 1} 项`;
    const description = typeof raw.description === 'string' ? raw.description : '';
    const enabled = raw.enabled !== false;
    const warnings: string[] = [];
    if (description.trim().length === 0) warnings.push('缺少描述');
    else if (description.trim().length < 20) warnings.push('描述较短，请人工检查用途和能力边界');
    if (typeof embed.maxDescriptionChars === 'number' && description.length > embed.maxDescriptionChars) {
      warnings.push(`超过配置的 ${embed.maxDescriptionChars} 字符描述预算`);
    }
    if (enabled) lines.push(`- ${name}: ${description.replace(/\s+/g, ' ')}`);
    return {
      name,
      enabled,
      descriptionChars: description.length,
      exampleCount: Array.isArray(raw.examples) ? raw.examples.length : 0,
      tagCount: Array.isArray(raw.tags) ? raw.tags.length : 0,
      warnings,
    };
  });
  const catalogChars = lines.join('\n').length;
  const warnings: string[] = [];
  if (typeof embed.maxCatalogChars === 'number' && catalogChars > embed.maxCatalogChars) {
    warnings.push(`启用服务器目录超过配置的 ${embed.maxCatalogChars} 字符预算`);
  }
  if (embed.enabled === false) warnings.push('已关闭 list_servers 中的内嵌目录');
  return { total: servers.length, enabled: servers.filter((server) => server.enabled).length, catalogChars, warnings, servers };
}

export function runCatalogCli(argv: string[]): void {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法：manageable-mcp catalog check [--config <路径>] [--json]\n只读取简介及数量，不连接下游服务器。\n');
    return;
  }
  if (argv[0] !== 'check') throw new AppError('INVALID_PARAMETERS', '未知目录操作，请使用 catalog --help');
  let configPath: string | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json' && !json) {
      json = true;
    } else if (flag === '--config' && configPath === undefined && argv[index + 1] && !argv[index + 1]?.startsWith('--')) {
      configPath = argv[index + 1];
      index += 1;
    } else {
      throw new AppError('INVALID_PARAMETERS', `无效或重复的目录选项 '${flag}'`);
    }
  }
  const result = checkCatalog(configPath);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`服务器：${result.total}，已启用：${result.enabled}，目录条目：${result.catalogChars} 字符\n`);
  for (const warning of result.warnings) process.stdout.write(`注意：${warning}\n`);
  for (const server of result.servers) {
    process.stdout.write(`${server.name}（${server.enabled ? '启用' : '停用'}）：描述 ${server.descriptionChars} 字符，示例 ${server.exampleCount}，标签 ${server.tagCount}${server.warnings.length ? `；${server.warnings.join('；')}` : ''}\n`);
  }
}
