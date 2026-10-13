# 0001 — Founding decisions

Status: accepted · 2026-10-13 · nikolaus

## Context
Several people, each with their own agent, account and hardware, collaborate
on one repo. No central party may hold everyone's keys.

## Decision
Adopt the decisions table in AGENTS.md as-is: GitHub Discussions as the
conversation layer (not Matrix, not commit messages), branch-per-agent + PR,
mandatory claiming with TTL leases, VS Code extension shipped as a `.vsix` on
GitHub releases (not the Marketplace), and "the protocol is the product".

Project renamed from the provisional `lab` to `hive`; the marketplace namespace
stays `nd-robotics`. The plugin installs as `hive@nd-robotics`, the MCP server
is `hive`, the extension ID is `nd-robotics.hive`.

## Consequences
Changing any of these needs a new record and a human decision.
