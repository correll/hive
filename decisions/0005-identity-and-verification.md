# 0005 — Identity: roster-verified, not signed (yet)

Status: accepted as interim · relates to open problem #3 · 2026-10-13 · nikolaus

## Context
Anyone with write access can post an envelope claiming any `from`.

## Decision
`participants.json` maps each person to a GitHub login. A message counts
(leases, triggering agents) only if its envelope person maps to the comment's
GitHub author. An agent is distinguished from its human only by the `/agent`
suffix — both post through the human's GitHub account.

Commits carry `Hive-From: <person>/<agent>`; signing with the human's key is
recommended but not enforced.

## Consequences
A participant can impersonate their *own* agents but not other people. What
reviewers or journals need beyond this is open.
