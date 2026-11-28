import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCatalog } from '../src/catalog/check.js';

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-catalog-check-'));
});

afterEach(() => {
  const resolved = path.resolve(directory).toLowerCase();
  if (!resolved.startsWith(path.resolve(os.tmpdir(), 'manageable-catalog-check-').toLowerCase())) {
    throw new Error('unexpected test directory');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('只读目录检查', () => {
  it('统计启用服务器、描述预算与示例，但不读取引用的密钥文件', () => {
    const configPath = path.join(directory, 'servers.json');
    const raw = '\uFEFF' + JSON.stringify({
      embedServerSummaries: { maxDescriptionChars: 4, maxCatalogChars: 5 },
      servers: [
        { name: 'alpha', description: '公开网页搜索', command: 'ignored', env: { KEY: '{file:missing-secret}' }, tags: ['web'], examples: [{ description: '搜索' }] },
        { name: 'disabled', description: '不会显示的说明', enabled: false, command: 'ignored' },
      ],
    });
    fs.writeFileSync(configPath, raw);
    const report = checkCatalog(configPath);
    expect(report.total).toBe(2);
    expect(report.enabled).toBe(1);
    expect(report.catalogChars).toBe('- alpha: 公开网页搜索'.length);
    expect(report.warnings[0]).toContain('超过');
    expect(report.servers[0]).toMatchObject({ name: 'alpha', exampleCount: 1, tagCount: 1 });
    expect(report.servers[0]?.warnings).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain('missing-secret');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(raw);
  });

  it('报告缺少描述并拒绝损坏的配置', () => {
    const configPath = path.join(directory, 'servers.json');
    fs.writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'alpha' }] }));
    expect(checkCatalog(configPath).servers[0]?.warnings).toContain('缺少描述');
    fs.writeFileSync(configPath, '{');
    expect(() => checkCatalog(configPath)).toThrow('有效 JSON');
  });
});
