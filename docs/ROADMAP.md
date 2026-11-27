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

## 0.2 — Client ergonomics

- [ ] server groups and `--group`
- [ ] HTTP `/mcp/<group>` routes
- [ ] one-shot `list`, `describe`, `call`, `auth` commands
- [ ] `--attach` stdio-to-HTTP bridge
- [ ] config reload on `SIGHUP` (POSIX) and explicit reload command

## 0.3 — Management

- [ ] admin HTTP API for server CRUD and reload
- [ ] dependency-free admin UI at `/admin`
- [ ] config write-back with atomic replace
- [ ] health/status endpoint with cached tool counts

## 0.4 — Remote auth and policy

- [ ] OAuth 2.0 + PKCE with dynamic client registration
- [ ] token storage and refresh
- [ ] per-server/global allow/deny policy rules
- [ ] secret redaction in diagnostics

## 0.5 — Fidelity and scale

- [ ] prompts forwarding (opt-in per server)
- [ ] paginated tool discovery edge cases
- [ ] unknown content block normalization
- [ ] activity-driven health monitor
- [ ] concurrency and timeout stress tests

## Non-goals

- publishing to npm, PyPI, crates.io, Docker, Homebrew, or a Git remote
- Python launcher / wheel
- old `lazy-*` compatibility aliases
- old config directory lookup
