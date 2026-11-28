import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts', 'evaluate-catalog.mjs');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'catalog-evaluation.json'), 'utf8')) as {
  cases: Array<{ id: string; expected: string | null }>;
};
let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-catalog-'));
});

afterEach(() => {
  const resolved = path.resolve(directory).toLowerCase();
  if (!resolved.startsWith(path.resolve(os.tmpdir(), 'manageable-catalog-').toLowerCase())) {
    throw new Error('unexpected test directory');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('目录质量评测', () => {
  it('生成不包含答案的任务提示', () => {
    const result = run('prompt');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('请仅根据');
    expect(result.stdout).toContain('"tasks"');
    expect(result.stdout).not.toContain('"expected"');
  });

  it('区分正确、错误和缺失的回答', () => {
    const answers = Object.fromEntries(fixture.cases.map((item) => [item.id, item.expected]));
    answers['01'] = 'browser';
    const answerPath = path.join(directory, 'answers.json');
    fs.writeFileSync(answerPath, JSON.stringify(answers));
    const scored = run('score', answerPath);
    expect(scored.status).toBe(0);
    expect(JSON.parse(scored.stdout)).toMatchObject({ total: 18, correct: 17, wrong: [{ id: '01', expected: 'library_docs', actual: 'browser' }] });

    delete answers['02'];
    fs.writeFileSync(answerPath, JSON.stringify(answers));
    const incomplete = run('score', answerPath);
    expect(incomplete.status).toBe(1);
    expect(incomplete.stderr).toContain('全部任务编号');
  });
});
