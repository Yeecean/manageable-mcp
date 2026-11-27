# manageable-mcp v2

A local-only, Windows-first MCP proxy with lazy tool discovery, scoped groups,
prompt forwarding, policy rules, health probes, OAuth, a management panel, and
a one-shot client.

This project is intentionally a clean break from the old tree:

- no `lazy-mcp` aliases, no `lazy_mcp` package, no `LAZY_MCP_*` variables;
- no `_meta.lazyMcp*` keys, no old config directory lookup;
- no package publishing, Docker, Homebrew, Rust, or Python packaging;
- no compatibility layer of any kind.

Current version: `0.2.0`.

## Requirements

- Windows 10/11
- Node.js 20 or newer
- npm

## Local quick start

```powershell
cd "E:\GitHub Clone\manageable-mcp-v2"
npm install
npm run build
npm test
npm run smoke
npm run smoke:http
npm run test:e2e
```

`test:e2e` starts a real HTTP daemon, exercises one-shot discovery, a policy
denial, group routing, the admin API, a health probe, the stdio attach bridge,
and prompt forwarding, then shuts everything down.

## Configuration

The only configuration source is `servers.json`. The default path is:

- Windows: `%APPDATA%\manageable-mcp\servers.json`
- other platforms: `$XDG_CONFIG_HOME/manageable-mcp/servers.json` or
  `~/.config/manageable-mcp/servers.json`

`--config` and `MANAGEABLE_MCP_CONFIG` override it.

```json
{
  "servers": [
    {
      "name": "local-demo",
      "description": "Local stdio MCP server.",
      "command": "node",
      "args": ["examples/echo-server.mjs"],
      "cwd": ".",
      "forwardPrompts": true,
      "permissions": {
        "default": "allow",
        "rules": [
          { "pattern": "delete_*", "action": "deny", "message": "Read-only session" }
        ]
      }
    },
    {
      "name": "remote-demo",
      "description": "Remote Streamable HTTP MCP server.",
      "url": "https://example.com/mcp",
      "oauth": {
        "callbackPort": 8947,
        "scope": "mcp.read"
      }
    }
  ],
  "groups": {
    "read-only": {
      "description": "Safe tools only",
      "servers": ["local-demo"]
    }
  },
  "permissions": {
    "rules": [
      { "server": "*", "pattern": "delete_*", "action": "deny" },
      { "server": "remote-demo", "pattern": "search_*", "action": "allow" }
    ]
  },
  "health": {
    "enabled": false,
    "intervalMs": 30000,
    "idleTimeoutMs": 300000,
    "timeoutMs": 10000
  },
  "transport": {
    "host": "127.0.0.1",
    "port": 8080,
    "path": "/mcp",
    "admin": false,
    "cli": false
  }
}
```

Each server must set exactly one of `command` (stdio) or `url` (HTTP).
`${VAR}` is expanded from the environment; `{file:relative/or/absolute/path}`
reads a secret from a file. Missing variables and unreadable files fail config
loading. Tokens and secret values are never written to logs.

### Groups

Only enabled members of a group are visible. Disabled members behave exactly
like unknown servers inside that scope.

```powershell
node dist/index.js serve --config servers.json --group read-only
```

Over HTTP, a group is a path alias:

```text
http://127.0.0.1:8080/mcp/read-only
```

An unknown group returns `404`. With stdio, an unknown `--group` fails startup.

### Permissions

Rules are evaluated in this order:

1. per-server rules, last match wins;
2. global rules, last match wins (`server` is a glob, default `*`);
3. per-server default;
4. global default;
5. implicit `allow`.

Glob syntax supports `*` (any characters) and `?` (one character). Denied calls
return `isError: true` with `_meta.manageableMcpProxyError.code =
"POLICY_BLOCKED"`.

### Prompts

Prompt forwarding is opt-in per server with `forwardPrompts: true`. Prompts are
namespaced as `<server>::<prompt>`; the codec escapes `:` and `\` so names
round-trip without collisions. The `prompts` capability is only advertised when
at least one server in the selected scope opts in.

### OAuth

Remote servers automatically attempt OAuth 2.0 + PKCE when they return
`401`/`403`. Add an `oauth` block only to override OAuth defaults such as
static client credentials, callback port, scope, or extra headers. The proxy
performs RFC 9728/8414 discovery, optional dynamic client registration
(RFC 7591), a local callback exchange, token persistence, and refresh.

- Default callback: `http://127.0.0.1:8947/callback`
- `MANAGEABLE_MCP_OAUTH_CALLBACK_PORT` overrides the callback port.
- `callbackPort: 0` asks the OS for an ephemeral port (tests only by default).
- Credentials are stored in `%APPDATA%\manageable-mcp\oauth.json`.
- `clientSecret` requires `clientId`.

When authorization is needed, the tool call returns
`AUTH_REQUIRED` and `_meta.manageableMcpProxyError.authUrl`. Open that URL in a
browser; the callback server saves the token. Retry the call, or use
`manageable-mcp auth <server> --wait`.

### Health

Health probing is disabled by default so startup and `list_servers` never
connect to downstream servers. Enable it in config or with `--health`.
After tool activity begins, the monitor probes enabled servers, records cached
health, and sleeps after `idleTimeoutMs`. `/health` reports the cached state
without starting a probe.

## Run the HTTP daemon

```powershell
npm run demo:http
# or
node dist/index.js serve --transport http --port 8080
```

- MCP endpoint: `http://127.0.0.1:8080/mcp`
- Group endpoint: `http://127.0.0.1:8080/mcp/<group>`
- Health: `http://127.0.0.1:8080/health`
- Admin panel: `http://127.0.0.1:8080/admin`

Use `--ui` to enable the admin panel, `--cli` to publish a one-shot endpoint,
and `--auth-token` to require a bearer token. The one-shot endpoint is
loopback-only. `--ui` on a non-loopback bind requires a token.

## The four meta-tools

| Tool | Purpose |
|---|---|
| `list_servers` | List visible servers and cached state; does not connect. |
| `list_commands` | List tool names and short descriptions for one server. |
| `describe_commands` | Return full input schemas for selected tools. |
| `invoke_command` | Call one downstream tool. |

The enabled catalog is embedded in the `list_servers` description. Full
schemas stay lazy until `describe_commands`.

## One-shot CLI

The daemon publishes `%APPDATA%\manageable-mcp\cli-endpoint.json` when started
with `--cli` (or `transport.cli: true`). The file contains a loopback URL and,
when configured, the bearer token; keep the config directory private.

```powershell
node dist/index.js list-commands echo
node dist/index.js describe echo echo add
node dist/index.js call echo echo '{"text":"hello"}'
node dist/index.js call echo echo - --params-file params.json
node dist/index.js auth remote --wait
```

Use `--url <url>` to select a daemon explicitly, `--auth-token` for its token,
`--json` for the full result, and `--timeout <seconds>` for a client timeout.

## Attach stdio to a running daemon

```powershell
node dist/index.js --attach http://127.0.0.1:8080/mcp
```

Attach mode never reads `servers.json` and never starts downstream servers. It
forwards tools and prompts to the daemon and uses a group via the URL
(`/mcp/<group>`). Loopback is trusted; non-loopback targets require an
`https://` URL and a bearer token. URLs and error text are sanitized before
logging.

## Admin panel and API

Enable with `--ui` or `"transport": { "admin": true }`.

- `GET /admin` — dependency-free browser panel (no CDN).
- `GET /api/admin` — overview.
- `POST /api/admin/servers` — add.
- `GET/PUT/DELETE /api/admin/servers/:name` — read/update/delete.
- `POST /api/admin/servers/:name/toggle` — enable/disable.
- `POST /api/admin/reload` — reload from disk.
- `POST /api/admin/probe` — run health probes.

The API requires the configured bearer token. Without a token it only accepts
loopback clients. Mutating config is validated with the normal parser and
written atomically; unknown raw fields are preserved.

## Security model

- stdout is the MCP protocol channel; every log goes to stderr.
- HTTP binds to `127.0.0.1` by default and validates `Host`/`Origin`.
- Request bodies are limited to 4 MiB by default.
- Bearer comparison is constant-time.
- Admin/config/token files are local files; the CLI endpoint uses owner-only
  permissions where the platform enforces them.
- OAuth tokens and callback codes are redacted from diagnostics.

## Development

```powershell
npm run dev -- --help
npm run build
npm test
npm run smoke
npm run smoke:http
npm run test:e2e
```

Source layout and design rules are in [ARCHITECTURE.md](./ARCHITECTURE.md).
The staged rewrite plan is in [docs/ROADMAP.md](./docs/ROADMAP.md).
Engineering rules and the required workflow are in [RULE.md](./RULE.md).

## Breaking changes from the old tree

| Old surface | New behavior |
|---|---|
| `lazy-mcp` command | Removed. Binary is `manageable-mcp`. |
| `lazy_mcp` Python package | Removed. There is no Python package. |
| `LAZY_MCP_*` variables | Removed. Only `MANAGEABLE_MCP_*` is read. |
| `_meta.lazyMcp*` | Removed. Only `_meta.manageableMcp*` is emitted. |
| `~/.config/lazy-mcp/` | Ignored. Default is `%APPDATA%\manageable-mcp\`. |
| `LazyMCPServer` export | Removed. Use `createProxyServer`. |
| npm/PyPI/Docker/Homebrew/Rust release paths | Not present. |
