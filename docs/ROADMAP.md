# Rewrite roadmap

The goal is a clean local-first implementation, not a compatibility-preserving
upgrade. Old names are deliberately absent.

## 0.1 — Runnable core (done)

- [x] strict config parsing and platform config path
- [x] lazy stdio and Streamable HTTP downstream clients
- [x] `list_servers`, `list_commands`, `describe_commands`, `invoke_command`
- [x] stdio and local HTTP transports
- [x] bearer auth, Host/Origin checks, body limit
- [x] examples, smoke scripts, unit and integration tests
- [x] no legacy aliases, no publishing tooling

## 0.2 — Client ergonomics (done)

- [x] server groups and `--group`
- [x] HTTP `/mcp/<group>` routes
- [x] one-shot `list-commands`, `describe`, `call`, `auth` commands
- [x] `--attach` stdio-to-HTTP bridge
- [x] `SIGHUP` reload (POSIX) and explicit admin reload

## 0.3 — Management (done)

- [x] admin HTTP API for server CRUD, probe, and reload
- [x] dependency-free admin UI at `/admin`
- [x] config write-back with atomic replace
- [x] health/status endpoint with cached tool counts

## 0.4 — Remote auth and policy (done)

- [x] OAuth 2.0 + PKCE with dynamic client registration
- [x] token storage and refresh
- [x] per-server/global allow/deny policy rules
- [x] secret redaction in diagnostics

## 0.5 — Fidelity and scale (current)

- [x] prompts forwarding (opt-in per server)
- [x] paginated tool and prompt discovery
- [ ] unknown content block normalization
- [x] activity-driven health monitor
- [ ] concurrency and timeout stress tests

## Non-goals

- publishing to npm, PyPI, crates.io, Docker, Homebrew, or a Git remote
- Python launcher / wheel
- old `lazy-*` compatibility aliases
- old config directory lookup
