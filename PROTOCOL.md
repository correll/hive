# Hive protocol v0

The protocol is the product; clients are replaceable. Anything that can read
and write GitHub Discussions and follow this document is a hive participant —
a Codex adapter, a shell script, a human in a browser. The reference
implementation is `adapter/src/protocol/` (pure TypeScript, no Node-only
imports).

## Repo files

| File | Purpose |
|---|---|
| `hive.json` | Shared policy: repo, Discussion category, lease and loop limits. |
| `participants.json` | Roster: `{ "<person>": { "github": "<login>" } }`. Changed by PR. |
| `tasks/<id>-<slug>.md` | One claimable work unit. Frontmatter `id`, `title`, `paths`, `status`. |
| `decisions/NNNN-<slug>.md` | Append-only decision records — the shared memory. |

`hive.json` **must** set `loop.maxAgentHops`, `loop.maxTurnsPerTaskPerAgent`
and `loop.maxUsdPerTaskPerAgent`; there are no defaults (see
[decisions/0003](decisions/0003-loop-control-limits.md)).

## Channels

One Discussion per task, in `hive.json`'s `discussionCategory`, titled
`task/<id>: <title>`. The title is the mapping, so opening a channel never
needs a commit. Comments and their replies are messages, ordered by
`(createdAt, id)`.

## Message envelope

A message is a Discussion comment whose visible text is the body, followed by
the envelope in an HTML comment:

```
Draft of §3 is up; stability proof still hand-wavy at L40-58.

<!-- hive:envelope
{"from":"nikolaus/claude","type":"summary","refs":["task/3","PR#17","sections/stability.tex:L40-58"],"confidence":0.7}
-->
```

A fenced block (` ```hive ` … ` ``` `) is accepted as an alternative carrier.
The body is **not** repeated inside the JSON. Inside the HTML comment, `--`
must be written as `--`.

| Field | Required | Meaning |
|---|---|---|
| `from` | yes | `<person>/<agent>`, or bare `<person>` for a human |
| `type` | yes | `claim` · `summary` · `question` · `review_request` · `handoff` · `decision` |
| `refs` | no | `task/3`, `PR#17`, `path`, `path:L40`, `path:L40-58` |
| `lease` | for `claim` | `{ "paths": [repo-relative], "expires": ISO 8601 }` |
| `confidence` | no | 0–1 |
| `to` | no | addressees, participant ids. **Extension to the AGENTS.md envelope**, used for addressing and lease transfer. |

A comment with no envelope is a human message from the roster person whose
`github` matches the comment author (or the bare login).

### Verification

A message is **verified** if the envelope's `<person>` maps, through
`participants.json`, to the GitHub account that posted the comment (or equals
it when the person isn't in the roster). Unverified messages are shown but
never affect leases or trigger agents. This is the minimum; signing is open
problem #3.

## Leases

The lease table is a pure function of the verified messages: every participant
replays them in `(createdAt, id)` order and gets the same answer. There is no
lock server.

- `claim` with `lease`: if any path overlaps a live lease held by a
  **different** `from`, the whole claim is rejected (all-or-nothing). Otherwise
  each path is granted to `from`, replacing that holder's earlier lease on the
  same path (renewal). `expires` is capped at `claim time + lease.maxMinutes`.
- `handoff`: releases all of `from`'s leases on that task. With exactly one
  `to` and a `lease`, the named paths that `from` held pass to `to[0]`.
- A lease is live while `now < expires`.
- Paths are repo-relative. `dir/` (trailing slash) covers everything beneath it;
  anything else is an exact file. Two paths overlap if either covers the other.

Because a lease can't outlive `maxMinutes`, a participant only needs threads
updated in the last `2 × maxMinutes` to compute the current table.

Writing without a lease is a protocol violation when `lease.requireClaim` is
true (the default). Clients should block it at write time (the Claude plugin's
PreToolUse hook does).

## Loop control

An agent takes a turn on a new message only if:

1. the message is verified and not its own;
2. it is addressed (`to` contains it, or `@<person>/<agent>` appears in the
   text), **or** it holds a live lease on that task;
3. fewer than `maxAgentHops` consecutive agent messages precede it (counting
   back to the last human message) — otherwise a human must speak first;
4. its own per-task turn and cost budgets aren't exhausted.

Budgets are tracked locally by each participant; nobody can see anyone else's
spend. This is a mitigation, not a solution — see AGENTS.md open problem #1.

## Branches and commits

`agent/<person>/<task>`, merged by PR. Commits carry a
`Hive-From: <person>/<agent>` trailer; signing with the human's key is
recommended.
