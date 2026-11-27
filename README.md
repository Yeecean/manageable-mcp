# manageable-mcp v2

A local-only, Windows-first rewrite of `manageable-mcp`.

This project is intentionally a clean break:

- no `lazy-mcp` aliases, no `lazy_mcp` package, no `LAZY_MCP_*` variables;
- no `_meta.lazyMcp*` keys, no old config directory lookup;
- no package publishing, Docker, Homebrew, Rust, or Python packaging;
- no compatibility layer of any kind.

The current `0.1.0` milestone is a runnable core: config loading, lazy
downstream connections, four meta-tools, stdio transport, and a local HTTP
transport.

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
```

`npm run smoke` starts the proxy over stdio, connects a real MCP client, lists
the four meta-tools, and calls the demo `echo` and `add` tools. `smoke:http`
does the same over the local HTTP transport.

## Run the HTTP daemon

```powershell
npm run demo:http
```

- MCP endpoint: `http://127.0.0.1:8080/mcp`
- Health check: `http://127.0.0.1:8080/health`

The demo uses `servers.example.json`. For a real setup, copy it to:

```text
%APPDATA%\manageable-mcp\servers.json
```

Then run:

```powershell
node dist/index.js serve
# or
node dist/index.js serve --transport http
```

The default config path is `%APPDATA%\manageable-mcp\servers.json`. On
non-Windows systems it is `$XDG_CONFIG_HOME/manageable-mcp/servers.json` or
`~/.config/manageable-mcp/servers.json`. `--config` and
`MANAGEABLE_MCP_CONFIG` override it.

## Use from an MCP client

Stdio:

```json
{
  "command": "node",
  "args": [
    "E:\\GitHub Clone\\manageable-mcp-v2\\dist\\index.js",
    "serve",
    "--config",
    "E:\\GitHub Clone\\manageable-mcp-v2\\servers.example.json"
  ]
}
```

HTTP:

```json
{
  "url": "http://127.0.0.1:8080/mcp"
}
```

If an HTTP bearer token is configured, use the `Authorization: Bearer <token>`
header. The token can be set with `--auth-token` or
`MANAGEABLE_MCP_AUTH_TOKEN`.

## Configuration

```json
{
  "servers": [
    {
      "name": "local-demo",
      "description": "Local stdio MCP server.",
      "command": "node",
      "args": ["examples/echo-server.mjs"],
      "cwd": "."
    },
    {
      "name": "remote-demo",
      "description": "Remote Streamable HTTP MCP server.",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${REMOTE_TOKEN}"
      }
    }
  ],
  "transport": {
    "host": "127.0.0.1",
    "port": 8080,
    "path": "/mcp"
  }
}
```

Each server must set exactly one of `command` (stdio) or `url` (HTTP). A
server-level `timeoutMs` defaults to 15000. `${VAR}` references are expanded
from the environment; `{file:relative/or/absolute/path}` reads a secret from
a file. Missing variables and unreadable files fail config loading.

`enabled: false` keeps a server in the list but refuses connections. Groups
are accepted by the parser for the next milestone, but scoped routing is not
implemented yet.

## The four meta-tools

The client sees only:

| Tool | Purpose |
|---|---|
| `list_servers` | List configured servers and cached state; does not connect. |
| `list_commands` | List tool names and short descriptions for one server. |
| `describe_commands` | Return full input schemas for selected tools. |
| `invoke_command` | Call one downstream tool. |

The enabled server catalog is embedded in the `list_servers` description, so
the agent can choose a server before making a tool call. Full schemas stay
lazy until `describe_commands`.

## Breaking changes from the old tree

| Old surface | New behavior |
|---|---|
| `lazy-mcp` command | Removed. Binary is `manageable-mcp`. |
| `lazy_mcp` Python package | Removed. There is no Python package. |
| `LAZY_MCP_*` variables | Removed. Only `MANAGEABLE_MCP_*` is read. |
| `_meta.lazyMcp*` | Removed. Only `_meta.manageableMcp*` is emitted. |
| `~/.config/lazy-mcp/` | Ignored. Default is `%APPDATA%\manageable-mcp\`. |
| `LazyMCPServer` export | Removed. The new entry point is `createProxyServer`; there is no class alias. |
| npm/PyPI/Docker/Homebrew/Rust release paths | Not present. |

## Development

```powershell
npm run dev -- --help
npm run build
npm test
```

Source layout and design rules are in [ARCHITECTURE.md](./ARCHITECTURE.md).
The staged rewrite plan is in [docs/ROADMAP.md](./docs/ROADMAP.md).
Engineering rules and the required workflow are in [RULE.md](./RULE.md).
