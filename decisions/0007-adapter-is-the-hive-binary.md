# 0007 — The plugin calls the `hive` binary on PATH

Status: accepted · 2026-10-13 · nikolaus

## Context
The adapter must be a separate process from any editor (AGENTS.md), and the
plugin's hooks and MCP server need the same code.

## Decision
`adapter/` builds one CLI, `hive`. The plugin is thin config: hooks run
`hive hook stop|pre-write`, the MCP server is `hive mcp`. The poll loop is
`hive poll`. Install with `npm install -g ./adapter` (or `npm link`).

## Consequences
- If `hive` isn't on PATH, hooks fail as non-blocking errors — the lease check
  then **fails open**. `hive status` and the README make installation step 1.
- The VS Code extension bundles `adapter/src/protocol/` directly and never
  calls the binary.
