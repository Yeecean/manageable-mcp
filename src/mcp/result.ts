import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const KNOWN_CONTENT_TYPES = new Set([
  'text',
  'image',
  'audio',
  'resource_link',
  'resource',
]);

const STANDARD_RESULT_KEYS = new Set([
  'content',
  'structuredContent',
  'isError',
  '_meta',
  'toolResult',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyForProxy(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/**
 * 代理侧不能假设下游一定遵守当前 MCP schema。旧宿主可能返回旧版
 * toolResult，插件可能返回未知内容块，也可能带非标准顶层字段。这里把这些
 * 形状显式降级成文本或 _meta 通知，避免客户端解析失败或静默丢数据。
 */
export function normalizeDownstreamToolResult(result: unknown): CallToolResult {
  if (!isRecord(result)) {
    return {
      content: [{ type: 'text', text: stringifyForProxy(result) }],
      _meta: {
        manageableMcpProxyNotice:
          '下游 tools/call 结果不是对象，原始值已作为文本块保留。',
      },
    };
  }

  const notices: string[] = [];
  const content: Array<Record<string, unknown>> = [];

  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (
        isRecord(block) &&
        typeof block.type === 'string' &&
        KNOWN_CONTENT_TYPES.has(block.type)
      ) {
        content.push(block);
        continue;
      }
      const type = isRecord(block) && block.type !== undefined
        ? String(block.type)
        : 'missing';
      notices.push(
        `不支持的下游内容块类型 '${type}'，原始值已作为文本保留。`,
      );
      content.push({
        type: 'text',
        text: `[manageable-mcp] 不支持的下游内容块类型 '${type}'：${stringifyForProxy(block)}`,
      });
    }
  } else if (result.content !== undefined) {
    notices.push('下游 content 不是数组，原始值已作为文本保留。');
    content.push({
      type: 'text',
      text: stringifyForProxy(result.content),
    });
  }

  let structuredContent: Record<string, unknown> | undefined;
  if (result.structuredContent !== undefined) {
    if (isRecord(result.structuredContent)) {
      structuredContent = result.structuredContent;
    } else {
      notices.push(
        '下游 structuredContent 不是对象，不能作为 MCP structuredContent 转发。',
      );
      content.push({
        type: 'text',
        text: `[manageable-mcp] 非对象 structuredContent：${stringifyForProxy(result.structuredContent)}`,
      });
    }
  }

  if (result.toolResult !== undefined && content.length === 0) {
    notices.push(
      '下游使用了旧版 MCP 2024-10-07 toolResult 形状，已映射为文本块。',
    );
    content.push({
      type: 'text',
      text: stringifyForProxy(result.toolResult),
    });
  }

  if (content.length === 0) {
    if (structuredContent !== undefined) {
      content.push({
        type: 'text',
        text: stringifyForProxy(structuredContent),
      });
      notices.push(
        '下游只返回 structuredContent，已合成文本块以保持兼容。',
      );
    } else {
      notices.push('下游 tools/call 结果没有 content。');
      content.push({
        type: 'text',
        text: '[manageable-mcp] 下游 tools/call 结果没有 content。',
      });
    }
  }

  let meta: Record<string, unknown> | undefined;
  if (result._meta !== undefined) {
    if (isRecord(result._meta)) {
      meta = { ...result._meta };
    } else {
      notices.push('下游 _meta 不是对象，已丢弃。');
    }
  }

  const extensionKeys = Object.keys(result).filter(
    (key) => !STANDARD_RESULT_KEYS.has(key),
  );
  if (extensionKeys.length > 0) {
    const extensions = Object.fromEntries(
      extensionKeys.map((key) => [key, result[key]]),
    );
    meta = {
      ...(meta ?? {}),
      manageableMcpDownstreamExtensions: extensions,
    };
    notices.push(
      `未知下游顶层字段 ${extensionKeys.join('、')} 已保存到 _meta.manageableMcpDownstreamExtensions。`,
    );
  }

  if (notices.length > 0) {
    const existingNotice = typeof meta?.manageableMcpProxyNotice === 'string'
      ? meta.manageableMcpProxyNotice
      : undefined;
    meta = {
      ...(meta ?? {}),
      manageableMcpProxyNotice: existingNotice
        ? `${existingNotice} ${notices.join(' ')}`
        : notices.join(' '),
    };
  }

  return {
    content: content as CallToolResult['content'],
    ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}),
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}
