import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { renderAdminHtml } from '../src/admin/ui.js';

const ADMIN_HTML = renderAdminHtml();
const SCRIPTS = [...ADMIN_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const MAIN_SCRIPT = SCRIPTS[SCRIPTS.length - 1]?.[1] ?? '';
const PAGE_WITHOUT_SCRIPTS = ADMIN_HTML.replace(/<script>[\s\S]*?<\/script>/g, '');

if (!MAIN_SCRIPT) throw new Error('admin UI main script was not found');

const openWindows: Window[] = [];

afterEach(() => {
  for (const window of openWindows) {
    try {
      window.happyDOM.close();
    } catch {}
  }
  openWindows.length = 0;
  vi.restoreAllMocks();
});

function adminEnvelope(servers: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    success: true,
    data: {
      configFile: 'C:/config/servers.json',
      mcpPath: '/mcp',
      servers,
      groups: {},
    },
  };
}

function server(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const name = typeof overrides.name === 'string' ? overrides.name : 'alpha';
  return {
    name,
    description: '测试服务器',
    type: 'remote',
    enabled: true,
    transport: 'http',
    status: 'idle',
    authType: 'unknown',
    authDetail: '',
    target: 'https://mcp.example.test/' + name,
    tags: [],
    toolsCount: 0,
    healthy: true,
    available: true,
    loaded: false,
    raw: {
      name,
      description: '测试服务器',
      url: 'https://raw.example.test/' + name,
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Record<string, unknown> {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function ok(body: unknown): Promise<Record<string, unknown>> {
  return Promise.resolve(jsonResponse(body));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function bootAdmin(options: {
  fetch: (...args: any[]) => any;
  url?: string;
  beforeEval?: (window: Window) => void;
}): Window {
  const window = new Window({
    url: options.url ?? 'http://127.0.0.1:3000/admin',
  });
  openWindows.push(window);
  window.document.write(PAGE_WITHOUT_SCRIPTS);
  window.document.close();
  (window as any).fetch = options.fetch;
  (window as any).confirm = () => true;
  options.beforeEval?.(window);
  window.eval(MAIN_SCRIPT);
  if (window.document.readyState === 'loading') {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }
  return window;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for DOM state');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function cardFor(window: Window, name: string): any {
  return [...window.document.querySelectorAll('.server-card')].find(
    (card: any) => card.querySelector('h3')?.textContent === name,
  );
}

function buttonByText(root: any, text: string): any {
  return [...root.querySelectorAll('button')].find(
    (button: any) => button.textContent === text,
  );
}

function checkboxFor(window: Window, name: string): any {
  return cardFor(window, name)?.querySelector('.switch input');
}

describe('admin UI probe merging', () => {
  it('writes successful health, keeps OAuth, and clears stale errors', async () => {
    const checkedAt = Date.UTC(2026, 0, 2, 3, 4, 5);
    const singleProbe = deferred<any>();
    let batchCalls = 0;
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url) === '/api/admin') {
        return ok(adminEnvelope([
          server({
            name: 'alpha',
            authType: 'oauth',
            status: 'error',
            error: '旧的连接错误',
            health: {
              healthy: false,
              lastChecked: 1,
              latencyMs: 999,
              error: '旧的健康错误',
            },
          }),
        ]));
      }
      if (String(url) === '/api/admin/servers/alpha/probe') return singleProbe.promise;
      if (String(url) === '/api/admin/probe') {
        batchCalls += 1;
        return ok({ success: true, data: { results: [], summary: {} } });
      }
      return ok({ success: true, data: {} });
    });

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => Boolean(cardFor(window, 'alpha')));
    buttonByText(cardFor(window, 'alpha'), '检测').click();

    window.document.getElementById('probeBtn')!.click();
    expect(batchCalls).toBe(0);

    singleProbe.resolve(jsonResponse({
      success: true,
      data: {
        name: 'alpha',
        ok: true,
        toolsCount: 3,
        tools: [
          { name: 'read', description: 'Read' },
          { name: 'write', description: 'Write' },
          { name: 'list', description: 'List' },
        ],
        latencyMs: 37,
        checkedAt,
      },
    }));

    await waitFor(() => Boolean(cardFor(window, 'alpha')?.textContent?.includes('工具 3 个')));
    const card = cardFor(window, 'alpha');
    const dot = card.querySelector('.health-dot');
    expect(dot.classList.contains('ok')).toBe(true);
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toBe('健康 · 37 毫秒');
    expect(card.textContent).toContain('最近检查：');
    expect(card.textContent).toContain('37 毫秒');
    expect(card.textContent).not.toContain('旧的连接错误');
    expect(card.textContent).not.toContain('旧的健康错误');
    expect(card.querySelector('.badge.auth-oauth')?.textContent).toBe('OAuth');
    expect(card.textContent).toContain('就绪');
  });

  it('switches auth type to OAuth when a probe requires authorization', async () => {
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url) === '/api/admin') {
        return ok(adminEnvelope([
          server({
            name: 'alpha',
            authType: 'api-key',
            authDetail: '静态请求头：X-Trace',
            status: 'idle',
            error: '之前的错误',
          }),
        ]));
      }
      if (String(url) === '/api/admin/servers/alpha/probe') {
        return ok({
          success: true,
          data: {
            name: 'alpha',
            ok: false,
            toolsCount: null,
            error: '需要授权',
            authRequired: true,
            authUrl: 'https://auth.example.test/start',
            latencyMs: 21,
            checkedAt: Date.UTC(2026, 0, 3, 4, 5, 6),
          },
        });
      }
      return ok({ success: true, data: {} });
    });

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => Boolean(cardFor(window, 'alpha')));
    expect(buttonByText(cardFor(window, 'alpha'), '检测授权')).toBeUndefined();

    buttonByText(cardFor(window, 'alpha'), '检测').click();

    await waitFor(() => Boolean(buttonByText(cardFor(window, 'alpha'), '重新授权')));
    const card = cardFor(window, 'alpha');
    expect(card.querySelector('.badge.auth-oauth')?.textContent).toBe('OAuth');
    expect(card.querySelector('.health-dot')?.getAttribute('aria-label')).toBe(
      '异常：需要授权',
    );
    expect(card.textContent).toContain('需要授权');
    expect(card.textContent).not.toContain('之前的错误');
  });
});

describe('admin UI asynchronous state', () => {
  it('queues a trailing refresh when concurrent loads overlap', async () => {
    const pendingAdmins: Array<ReturnType<typeof deferred<any>>> = [];
    let adminCalls = 0;
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url) === '/api/admin') {
        adminCalls += 1;
        if (adminCalls === 1) {
          return ok(adminEnvelope([
            server({ name: 'alpha', enabled: false }),
            server({ name: 'beta', enabled: false }),
          ]));
        }
        const pending = deferred<any>();
        pendingAdmins.push(pending);
        return pending.promise;
      }
      if (String(url).endsWith('/toggle')) return ok({ success: true, data: {} });
      return ok({ success: true, data: {} });
    });

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => Boolean(cardFor(window, 'beta')));

    checkboxFor(window, 'alpha').click();
    checkboxFor(window, 'beta').click();

    await waitFor(() => adminCalls === 2);
    expect(pendingAdmins).toHaveLength(1);

    pendingAdmins[0]!.resolve(jsonResponse(adminEnvelope([
      server({ name: 'alpha', enabled: true }),
      server({ name: 'beta', enabled: false }),
    ])));

    await waitFor(() => adminCalls === 3);
    expect(pendingAdmins).toHaveLength(2);
    expect(checkboxFor(window, 'beta').checked).toBe(false);

    pendingAdmins[1]!.resolve(jsonResponse(adminEnvelope([
      server({ name: 'alpha', enabled: true }),
      server({ name: 'beta', enabled: true }),
    ])));

    await waitFor(() => checkboxFor(window, 'alpha').checked && checkboxFor(window, 'beta').checked);
    expect(adminCalls).toBe(3);
  });

  it('ignores a late tools response after another server is opened', async () => {
    const alphaTools = deferred<any>();
    const betaTools = deferred<any>();
    const fetchMock = vi.fn((url: unknown, init: any) => {
      if (String(url) === '/api/admin') {
        return ok(adminEnvelope([
          server({ name: 'alpha', toolsCount: 1 }),
          server({ name: 'beta', toolsCount: 1 }),
        ]));
      }
      if (String(url) === '/api/admin/servers/alpha/tools') return alphaTools.promise;
      if (String(url) === '/api/admin/servers/beta/tools') return betaTools.promise;
      return ok({ success: true, data: {} });
    });

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => Boolean(cardFor(window, 'beta')));
    cardFor(window, 'alpha').querySelector('.meta-action').click();
    await waitFor(() => fetchMock.mock.calls.some(
      ([url]) => String(url) === '/api/admin/servers/alpha/tools',
    ));

    cardFor(window, 'beta').querySelector('.meta-action').click();
    await waitFor(() => fetchMock.mock.calls.some(
      ([url]) => String(url) === '/api/admin/servers/beta/tools',
    ));

    betaTools.resolve(jsonResponse({
      success: true,
      data: {
        name: 'beta',
        toolsCount: 1,
        tools: [{ name: 'beta-tool', description: 'Beta' }],
      },
    }));
    await waitFor(() => window.document.getElementById('toolsBody')!.textContent!.includes('beta-tool'));

    alphaTools.resolve(jsonResponse({
      success: true,
      data: {
        name: 'alpha',
        toolsCount: 1,
        tools: [{ name: 'alpha-tool', description: 'Alpha' }],
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const toolsBody = window.document.getElementById('toolsBody')!;
    expect(toolsBody.textContent).toContain('beta-tool');
    expect(toolsBody.textContent).not.toContain('alpha-tool');
    expect(window.document.getElementById('toolsTitle')!.textContent).toContain('beta');
  });

  it('does not issue duplicate editor saves while one is pending', async () => {
    const save = deferred<any>();
    let saveCalls = 0;
    const fetchMock = vi.fn((url: unknown, init: any) => {
      if (String(url) === '/api/admin') return ok(adminEnvelope([]));
      if (String(url) === '/api/admin/servers' && init?.method === 'POST') {
        saveCalls += 1;
        return save.promise;
      }
      return ok({ success: true, data: {} });
    });

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => window.document.getElementById('serverList')!.textContent!.includes('尚未配置'));
    window.document.getElementById('addBtn')!.click();
    const saveButton = window.document.getElementById('editorSave')!;
    saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(saveCalls).toBe(1);

    save.resolve(jsonResponse({ success: true, data: {} }));
    await waitFor(() => !window.document.getElementById('editorDialog')!.hasAttribute('open'));
  });

  it('does not issue duplicate DELETE requests while one is pending', async () => {
    const remove = deferred<any>();
    let adminCalls = 0;
    let deleteCalls = 0;
    const fetchMock = vi.fn((url: unknown, init: any) => {
      if (String(url) === '/api/admin') {
        adminCalls += 1;
        return ok(adminEnvelope(adminCalls === 1 ? [server({ name: 'alpha' })] : []));
      }
      if (String(url) === '/api/admin/servers/alpha' && init?.method === 'DELETE') {
        deleteCalls += 1;
        return remove.promise;
      }
      return ok({ success: true, data: {} });
    });

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => Boolean(cardFor(window, 'alpha')));
    const removeButton = buttonByText(cardFor(window, 'alpha'), '删除');
    removeButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    removeButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(deleteCalls).toBe(1);

    remove.resolve(jsonResponse({ success: true, data: {} }));
    await waitFor(() => window.document.getElementById('serverList')!.textContent!.includes('尚未配置'));
  });
});

describe('admin UI long text rendering', () => {
  it('preserves details open state across renders and renders text safely', async () => {
    const problem = '<img src=x onerror="window.__xss=1"> ' + 'E'.repeat(180);
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url) === '/api/admin') {
        return ok(adminEnvelope([server({ name: 'alpha', error: problem })]));
      }
      return ok({ success: true, data: {} });
    });

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => Boolean(cardFor(window, 'alpha')));
    let details = cardFor(window, 'alpha').querySelector('details.card-error-collapsible');
    expect(details).toBeTruthy();
    expect(details.querySelector('.error-detail').textContent).toBe(problem);
    expect(details.querySelector('img')).toBeNull();

    details.querySelector('summary').click();
    if (!details.open) details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
    expect(details.open).toBe(true);

    const search = window.document.getElementById('search') as any;
    search.value = 'alpha';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));

    details = cardFor(window, 'alpha').querySelector('details.card-error-collapsible');
    expect(details.open).toBe(true);
    expect(details.querySelector('.error-detail').textContent).toBe(problem);
  });

  it('uses the same collapsible text path for long notices', async () => {
    const problem = '<svg onload="window.__xss=1"></svg> ' + 'N'.repeat(180);
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({
      error: { message: problem },
    }, 500)));

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => {
      const notice = window.document.getElementById('notice');
      return notice !== null && !notice.hasAttribute('hidden');
    });

    const notice = window.document.getElementById('notice')!;
    const details = notice.querySelector('details.card-error-collapsible');
    expect(details).toBeTruthy();
    expect(details!.querySelector('.error-detail')!.textContent).toBe(problem);
    expect(notice.querySelector('svg')).toBeNull();
  });

  it('collapses long editor errors without injecting markup', async () => {
    const problem = '<b onmouseover="window.__xss=1">editor</b> ' + 'E'.repeat(180);
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url) === '/api/admin') return ok(adminEnvelope([]));
      if (String(url) === '/api/admin/servers') {
        return Promise.resolve(jsonResponse({ error: { message: problem } }, 500));
      }
      return ok({ success: true, data: {} });
    });

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => window.document.getElementById('serverList')!.textContent!.includes('尚未配置'));
    window.document.getElementById('addBtn')!.click();
    window.document.getElementById('editorSave')!.click();

    await waitFor(() => {
      const error = window.document.getElementById('editorError');
      return error !== null && !error.hasAttribute('hidden') &&
        error.querySelector('details.card-error-collapsible') !== null;
    });
    const editorError = window.document.getElementById('editorError')!;
    expect(editorError.querySelector('.error-detail')!.textContent).toBe(problem);
    expect(editorError.querySelector('b')).toBeNull();
  });

  it('collapses long OAuth diagnostics without injecting markup', async () => {
    const problem = '<img src=x onerror="window.__xss=1"> ' + 'O'.repeat(180);
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url) === '/api/admin') {
        return ok(adminEnvelope([server({ name: 'alpha', authType: 'unknown' })]));
      }
      if (String(url) === '/api/admin/servers/alpha/auth') {
        return ok({
          success: true,
          data: { authRequired: true, diagnostic: problem },
        });
      }
      return ok({ success: true, data: {} });
    });

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => Boolean(cardFor(window, 'alpha')));
    buttonByText(cardFor(window, 'alpha'), '检测授权').click();

    await waitFor(() => {
      const diagnostic = window.document.getElementById('oauthDiagnostic');
      return diagnostic !== null && !diagnostic.hasAttribute('hidden') &&
        diagnostic.querySelector('details.card-error-collapsible') !== null;
    });
    const diagnostic = window.document.getElementById('oauthDiagnostic')!;
    expect(diagnostic.querySelector('.error-detail')!.textContent).toBe(problem);
    expect(diagnostic.querySelector('img')).toBeNull();
  });
});

describe('admin UI boot token', () => {
  it('keeps an in-memory bootstrap token and removes it from the URL', async () => {
    const calls: Array<{ url: unknown; init: any }> = [];
    const fetchMock = vi.fn((url: unknown, init: any) => {
      calls.push({ url, init });
      return ok(adminEnvelope([]));
    });

    const window = bootAdmin({
      fetch: fetchMock,
      url: 'http://127.0.0.1:3000/admin?keep=1&token=test-boot-token#section',
      beforeEval: (win) => {
        const storage = Object.getPrototypeOf(win.sessionStorage);
        vi.spyOn(storage, 'setItem').mockImplementation(() => {
          throw new Error('storage blocked');
        });
      },
    });

    await waitFor(() => calls.length > 0);
    expect(window.location.search).toBe('?keep=1');
    expect(window.location.hash).toBe('#section');
    expect(calls[0]!.url).toBe('/api/admin');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer test-boot-token');
  });
});

describe('admin UI accessibility and sanitized targets', () => {
  it('labels health dots and dialogs and keeps target text sanitized', async () => {
    const safeTarget = 'https://user:***@example.test/mcp?token=***';
    const hiddenRaw = 'https://raw-secret.example.test/mcp?token=never-render';
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url) === '/api/admin') {
        return ok(adminEnvelope([
          server({
            name: 'alpha',
            target: safeTarget,
            health: { healthy: true, lastChecked: 10, latencyMs: 12 },
          }),
          server({
            name: 'beta',
            target: undefined,
            raw: { name: 'beta', description: '测试服务器', url: hiddenRaw },
          }),
        ]));
      }
      return ok({ success: true, data: {} });
    });

    const window = bootAdmin({ fetch: fetchMock });
    await waitFor(() => Boolean(cardFor(window, 'beta')));

    const alpha = cardFor(window, 'alpha');
    const target = alpha.querySelector('.card-target');
    expect(target.textContent).toBe(safeTarget);
    expect(target.title).toBe(safeTarget);
    expect(alpha.querySelector('.health-dot').getAttribute('aria-label')).toBe('健康 · 12 毫秒');
    expect(cardFor(window, 'beta').querySelector('.card-target')).toBeNull();
    expect(window.document.body.textContent).not.toContain(hiddenRaw);

    for (const [dialogId, titleId] of [
      ['editorDialog', 'editorTitle'],
      ['authDialog', 'authTitle'],
      ['oauthDialog', 'oauthTitle'],
      ['toolsDialog', 'toolsTitle'],
    ]) {
      expect(window.document.getElementById(dialogId)?.getAttribute('aria-labelledby')).toBe(titleId);
      expect(window.document.getElementById(titleId)).toBeTruthy();
    }

    const filterButtons = [...window.document.querySelectorAll('#statusFilter button')] as any[];
    expect(filterButtons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    filterButtons.find((button) => button.getAttribute('data-filter') === 'enabled')!.click();
    expect(filterButtons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
  });
});
