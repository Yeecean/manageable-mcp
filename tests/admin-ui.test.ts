import { describe, expect, it } from 'vitest';
import { renderAdminHtml } from '../src/admin/ui.js';

describe('admin UI error rendering', () => {
  const html = renderAdminHtml();

  it('collapses long errors behind a native details control', () => {
    expect(html).toContain('.card-error-collapsible');
    expect(html).toContain('.error-summary-text');
    expect(html).toContain('.error-detail');
    expect(html).toContain('function isLongError(text)');
    expect(html).toContain('value.length > 160');
    expect(html).toContain('buildErrorNotice(problem)');
  });

  it('keeps short errors directly visible', () => {
    expect(html).toContain("if (!isLongError(message)) return el('p', 'card-error', message);");
  });
});
