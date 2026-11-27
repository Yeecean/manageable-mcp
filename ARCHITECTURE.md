# Architecture

This rewrite keeps one boundary per concern and contains no old-name
compatibility branches.

## Modules

```text
src/
  index.ts                 CLI entry point
  cli.ts                   commands, flags, reload, process lifecycle
  config/
    types.ts               config model and policy/auth/health types
    paths.ts               platform config/state paths
    load.ts                parse, validate, expand secrets, resolve cwd
  core/
    errors.ts              AppError codes and OAuth authorization signal
    logger.ts              stderr logger
    timeout.ts             timeout helper
  mcp/
    downstream.ts          SDK client plus opt-in OAuth transport
    manager.ts             lazy connections, caches, prompts, health, reload
    tools.ts               four meta-tools, scoping, policy enforcement
    proxy-server.ts        MCP server factory and prompt handlers
    proxy-scope.ts         group scope construction and refresh
    prompt-namespace.ts    injective <server>::<prompt> codec
    permissions.ts         glob matching and last-match-wins resolution
  transports/
    stdio.ts               stdio transport
    http.ts                stateless Streamable HTTP, groups, health, admin
  client/
    endpoint.ts            owner-only CLI endpoint discovery file
    one-shot.ts            call/list-commands/describe/auth client
    attach.ts              stdio-to-HTTP bridge
    sanitize.ts            URL/error redaction
  admin/
    store.ts               raw config CRUD and atomic writes
    controller.ts          /admin and /api/admin routes
    ui.ts                  dependency-free browser panel
  oauth/
    provider.ts            OAuthClientProvider, PKCE, tokens, refresh
    callback-server.ts     shared loopback callback listener
    store.ts               token/client/verifier persistence
    sanitize.ts            OAuth-aware redaction
```

## Request flow

1. `cli.ts` handles one-shot and attach commands before config loading.
2. A daemon loads `servers.json`, creates one `ServerManager`, and chooses
   stdio or HTTP.
3. Startup, `tools/list`, and `list_servers` do not connect downstream.
4. `list_commands`, `describe_commands`, and `invoke_command` connect lazily.
   Tool lists are cached; `refresh: true` bypasses the cache.
5. `invoke_command` checks per-server/global policy before calling the
   downstream client. A denial returns `POLICY_BLOCKED`.
6. HTTP requests build a fresh proxy server and optional group scope. Group
   membership is filtered to enabled servers.
7. Prompts are aggregated only from opted-in servers and namespaced with an
   injective codec. The `prompts` capability is advertised only when the scope
   contains at least one opted-in server.
8. Health probes run only when enabled and after tool activity. They use
   downstream `ping` and cache healthy/unhealthy results.
9. `closeAll()` blocks new connections, waits for in-flight connects, closes
   every client, then clears caches. Config reload uses the same connection
   quiescing path before replacing the manager map.

## HTTP routes

```text
GET  /health                  cached health, no auth
     /admin                    admin UI shell
     /api/admin...             admin API (bearer or loopback)
POST /mcp                     unscoped MCP endpoint
POST /mcp/<group>             group-scoped MCP endpoint
```

The HTTP transport is stateless: each request gets a fresh `Server` and
Streamable HTTP transport, while all requests share one `ServerManager`.

## OAuth flow

Every remote server gets an OAuth provider; the callback listener starts only
when authorization is actually needed or when an explicit `oauth` block is
configured. The SDK transport performs discovery, dynamic client registration
when needed, PKCE authorization, and token refresh on `401`/`403`. A shared
loopback callback server exchanges the authorization code. Tokens,
client information, verifiers, and discovery state are persisted under the
application state directory. Authorization-required failures propagate as
`AUTH_REQUIRED` with the authorization URL in error metadata.

## Result model

- Successful downstream results are returned unchanged: `content`, `isError`,
  `structuredContent`, and `_meta` are preserved.
- Proxy failures return `isError: true` with
  `_meta.manageableMcpProxyError = { code, message, ...details }`.
- There is no legacy metadata alias.

## Security model

- stdio runs with the current OS user's trust.
- HTTP binds to loopback by default.
- HTTP checks `Host` and `Origin` before routing, including `/health`.
- Bearer tokens are compared in constant time.
- Request bodies are limited to 4 MiB by default.
- The admin API uses the same bearer token or loopback-only access; the HTML
  shell contains no server data.
- OAuth tokens and callback codes are redacted from logs and error pages.
- One-shot endpoint files are written with owner-only permissions where the
  platform enforces them.
- Config writes use validation, a temporary file, fsync, and atomic rename.

## Non-goals

- npm/PyPI/crates/Docker/Homebrew/Rust packaging
- any old `lazy-*` compatibility surface
- a multi-tenant remote server; this is a local trust-boundary tool
