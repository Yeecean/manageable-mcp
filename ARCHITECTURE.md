# Architecture

This rewrite keeps one boundary per concern and avoids the old tree's
compatibility branches.

## Modules

```text
src/
  index.ts                 CLI entry point
  cli.ts                   argument parsing and process lifecycle
  config/
    types.ts               config model
    paths.ts               platform config path
    load.ts                parse, validate, expand secrets, resolve cwd
  core/
    errors.ts              AppError and error codes
    logger.ts              stderr logger
    timeout.ts             request timeout helper
  mcp/
    downstream.ts          SDK client per configured server
    manager.ts             lazy connection and tool cache
    tools.ts               four meta-tools and result shaping
    proxy-server.ts        MCP Server with the four handlers
  transports/
    stdio.ts               stdio transport
    http.ts                stateless Streamable HTTP transport
```

## Request flow

1. `cli.ts` loads and validates `servers.json`.
2. `ServerManager` holds only config and lazy state; startup does not connect
   to any downstream server.
3. `tools/list` returns four static meta-tool definitions. The enabled server
   catalog is embedded in the `list_servers` description.
4. `list_commands` or `invoke_command` calls `ServerManager.ensureConnected`.
   The first connection creates an SDK `Client` with either a stdio or
   Streamable HTTP transport.
5. Tool lists are cached per server. `refresh: true` bypasses the cache.
6. `closeAll()` stops new connections, waits for in-flight connection attempts,
   then closes every live client and clears the tool cache.

## Result model

- Successful downstream results are returned unchanged: `content`, `isError`,
  `structuredContent`, and `_meta` are preserved.
- Proxy failures return `isError: true` with
  `_meta.manageableMcpProxyError = { code, message, ...details }`.
- There is no legacy metadata alias.

## Security model

- stdio runs with the current OS user's trust.
- HTTP binds to loopback by default.
- HTTP checks `Host` and `Origin` before routing, including `/health`; loopback
  origins are allowed, non-loopback origins require `transport.allowedOrigins`.
- `--auth-token` enables constant-time bearer-token comparison.
- Request bodies are limited to 4 MiB by default.
- Logs go to stderr. Config values that contain secrets are not logged.
- The HTTP transport is stateless: each request gets its own server and
  transport. A client disconnect aborts that request's downstream call, but a
  separate cancellation request cannot target another request's in-flight work.

## Explicit non-goals for 0.1

- OAuth 2.0 / PKCE and token refresh
- admin API and browser UI
- server groups and scoped routing
- stdio attach bridge and one-shot client commands
- prompts forwarding, permissions, health probes, and result-block rewriting
- npm/PyPI/crates/Docker/Homebrew/Rust packaging
- any old-name compatibility layer

These are staged in [docs/ROADMAP.md](./docs/ROADMAP.md).
