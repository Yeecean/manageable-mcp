import { describe, expect, it } from 'vitest';
import { normalizeDownstreamToolResult } from '../src/mcp/result.js';

describe('downstream result normalization', () => {
  it('keeps standard content, structuredContent, _meta, and isError', () => {
    const result = normalizeDownstreamToolResult({
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'abc', mimeType: 'image/png' },
        {
          type: 'resource_link',
          uri: 'file:///tmp/a.txt',
          name: 'a.txt',
        },
      ],
      structuredContent: { answer: 42 },
      _meta: { downstream: true },
      isError: true,
    });

    expect(result.content).toHaveLength(3);
    expect(result.structuredContent).toEqual({ answer: 42 });
    expect(result._meta).toEqual({ downstream: true });
    expect(result.isError).toBe(true);
  });

  it('degrades unknown content blocks without losing the payload', () => {
    const result = normalizeDownstreamToolResult({
      content: [{ type: 'custom/thing', payload: { a: 1 } }],
    });

    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0]?.text).toContain('custom/thing');
    expect(result.content[0]?.text).toContain('"payload":{"a":1}');
    expect(result._meta?.manageableMcpProxyNotice).toContain('custom/thing');
  });

  it('maps legacy toolResult and preserves unknown top-level fields', () => {
    const result = normalizeDownstreamToolResult({
      toolResult: { legacy: true, value: 'kept' },
      customField: { preserved: true },
    });

    expect(result.content[0]?.text).toContain('"legacy":true');
    expect(result._meta?.manageableMcpProxyNotice).toContain('toolResult');
    expect(result._meta?.manageableMcpDownstreamExtensions).toEqual({
      customField: { preserved: true },
    });
  });

  it('synthesizes a text block for structured-only and empty results', () => {
    const structured = normalizeDownstreamToolResult({
      structuredContent: { answer: 42 },
    });
    expect(structured.content[0]?.text).toContain('"answer":42');
    expect(structured._meta?.manageableMcpProxyNotice).toContain('structuredContent');

    const empty = normalizeDownstreamToolResult({});
    expect(empty.content[0]?.type).toBe('text');
    expect(empty._meta?.manageableMcpProxyNotice).toContain('content');
  });

  it('wraps non-object results and drops non-object _meta with notices', () => {
    const array = normalizeDownstreamToolResult([1, 2, 3]);
    expect(array.content[0]?.text).toBe('[1,2,3]');
    expect(array._meta?.manageableMcpProxyNotice).toContain('不是对象');

    const badMeta = normalizeDownstreamToolResult({
      content: [{ type: 'text', text: 'ok' }],
      _meta: 'not-an-object',
    });
    expect(badMeta._meta?.manageableMcpProxyNotice).toContain('_meta');
  });
});
