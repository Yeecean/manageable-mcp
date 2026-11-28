import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(fs.readFileSync(path.join(projectRoot, 'tests', 'fixtures', 'catalog-evaluation.json'), 'utf8'));
const [action, answerPath] = process.argv.slice(2);

if (action === 'prompt' && answerPath === undefined) {
  const questions = dataset.cases.map(({ id, task }) => ({ id, task }));
  process.stdout.write('请仅根据以下服务器目录，为每个任务选择一个最合适的服务器；没有合适服务器时选择 null。不要调用工具。只输出 JSON 对象，键为任务编号，值为服务器名称或 null。\n\n');
  process.stdout.write(JSON.stringify({ servers: dataset.servers, tasks: questions }, null, 2) + '\n');
} else if (action === 'score' && answerPath !== undefined) {
  try {
    const answers = JSON.parse(fs.readFileSync(path.resolve(answerPath), 'utf8').replace(/^\uFEFF/, ''));
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('答案必须是 JSON 对象');
    const validIds = new Set(dataset.cases.map((item) => item.id));
    const actualIds = Object.keys(answers);
    if (actualIds.length !== validIds.size || actualIds.some((id) => !validIds.has(id))) {
      throw new Error('答案必须包含全部任务编号且不能包含额外编号');
    }
    const allowed = new Set(dataset.servers.map((server) => server.name));
    const invalid = actualIds.filter((id) => answers[id] !== null && !allowed.has(answers[id]));
    if (invalid.length) throw new Error('答案只能包含目录中的服务器名称或 null');
    const wrong = dataset.cases.filter((item) => answers[item.id] !== item.expected);
    process.stdout.write(JSON.stringify({ total: validIds.size, correct: validIds.size - wrong.length, wrong: wrong.map((item) => ({ id: item.id, expected: item.expected, actual: answers[item.id] })) }, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`评测失败：${error.message}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write('用法：node scripts/evaluate-catalog.mjs prompt | score <答案 JSON 文件>\n');
  process.exitCode = 1;
}
