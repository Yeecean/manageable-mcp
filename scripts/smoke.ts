import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client(
  { name: 'manageable-mcp-smoke', version: '1.0.0' },
  { capabilities: {} },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(root, 'dist', 'index.js'),
    'serve',
    '--config',
    path.join(root, 'servers.example.json'),
  ],
  cwd: root,
  stderr: 'inherit',
});

try {
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  if (names.join(',') !== 'list_servers,list_commands,describe_commands,invoke_command') {
    throw new Error(`Unexpected meta-tools: ${names.join(',')}`);
  }

  const echo = await client.callTool({
    name: 'invoke_command',
    arguments: {
      server: 'echo',
      command_name: 'echo',
      parameters: { text: 'hello from smoke' },
    },
  });
  const echoText = echo.content?.find((item) => item.type === 'text');
  if (!echoText || echoText.type !== 'text' || !echoText.text.includes('hello from smoke')) {
    throw new Error(`Unexpected echo result: ${JSON.stringify(echo)}`);
  }

  const add = await client.callTool({
    name: 'invoke_command',
    arguments: {
      server: 'echo',
      command_name: 'add',
      parameters: { a: 2, b: 3 },
    },
  });
  const addText = add.content?.find((item) => item.type === 'text');
  if (!addText || addText.type !== 'text' || addText.text !== '5') {
    throw new Error(`Unexpected add result: ${JSON.stringify(add)}`);
  }

  console.log('smoke ok: 4 meta-tools, echo=hello from smoke, add=5');
} finally {
  await client.close().catch(() => undefined);
}
