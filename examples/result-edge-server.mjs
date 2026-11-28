#!/usr/bin/env node

const tools = [
  {
    name: 'unknown',
    description: 'Return a non-standard content block.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'legacy',
    description: 'Return the legacy toolResult shape.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'extension',
    description: 'Return a non-standard top-level field.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function handle(request) {
  const { id, method, params } = request;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'result-edge-server', version: '1.0.0' },
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (name === 'unknown') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'custom/thing', payload: { answer: 42 } }],
        },
      };
    }
    if (name === 'legacy') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          toolResult: { legacy: true, value: 'kept' },
        },
      };
    }
    if (name === 'extension') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: 'ok' }],
          customField: { preserved: true },
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    };
  }
  if (id === undefined || id === null) return null;
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const request = JSON.parse(line);
    const response = handle(request);
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write('result-edge-server: started\n');
