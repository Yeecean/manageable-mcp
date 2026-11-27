#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'prompt-fixture', version: '1.0.0' },
  { capabilities: { prompts: {}, tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'status',
      description: 'Return fixture status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'summarize',
      description: 'Summarize the supplied topic.',
      arguments: [{ name: 'topic', required: true }],
    },
    {
      name: 'a::b',
      description: 'Prompt name containing the namespace delimiter.',
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const topic = request.params.arguments?.topic ?? 'untitled';
  return {
    description: `Prompt for ${request.params.name}`,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: `Summarize ${topic} for ${request.params.name}.` },
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
