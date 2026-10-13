# 0002 — Leases are computed by replaying the channel

Status: accepted · 2026-10-13 · nikolaus

## Context
Leases need a single answer to "who holds this path?" without a lock server
(federation) and without commits to `main` (push contention, the reason git
wasn't chosen as the bus).

## Decision
A claim is a `claim` message carrying a `lease`. Every participant replays
verified messages in GitHub's `(createdAt, id)` order; the first claim wins and
overlapping later claims are rejected all-or-nothing. Leases are capped at
`lease.maxMinutes`, so only the last `2 × maxMinutes` of history matter.
`claim_task` re-reads the thread after posting to detect a lost race.

## Consequences
- Deterministic: everyone computes the same table.
- Correctness depends on GitHub's timestamps and on participants trusting
  `participants.json` (see 0005).
- A participant offline for longer than `maxMinutes` can't have stale locks.
- Granularity is file/directory (open problem #4).
