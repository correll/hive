# 0003 — Loop-control limits have no defaults

Status: accepted (mechanism) · **open problem** (values) · 2026-10-13 · nikolaus

## Context
Open problem #1: agents replying to agents can burn money unattended.
AGENTS.md says not to paper over open problems with defaults.

## Decision
The adapter implements the three mechanisms AGENTS.md names:

1. agents take a turn only when addressed or when holding a lease on the task;
2. after `loop.maxAgentHops` consecutive agent messages, a human must post
   before any agent responds (human gate);
3. per-task, per-agent turn and USD budgets, tracked locally.

`hive.json` must set all three numbers; the adapter refuses to start without
them. This repo uses 3 hops / 20 turns / $5 as a starting guess, not a
recommendation.

## Consequences
- The USD figure is Claude Code's client-side estimate (`total_cost_usd`); for
  subscription users it is notional.
- Budgets are per participant; nobody sees the total spend on a task.
- Still unsolved: budgets that span participants, rate limits, and what a
  "hop" means when a human posts only "ok".
