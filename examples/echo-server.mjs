#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'echo-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the supplied text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'add',
      description: 'Add two numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
    {
      name: 'fail',
      description: 'Return a downstream tool error for smoke testing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === 'echo') {
    return {
      content: [{ type: 'text', text: String(args.text ?? '') }],
    };
  }
  if (name === 'add') {
    const sum = Number(args.a) + Number(args.b);
    return {
      content: [{ type: 'text', text: String(sum) }],
      structuredContent: { sum },
    };
  }
  if (name === 'fail') {
    return {
      content: [{ type: 'text', text: 'simulated downstream failure' }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
