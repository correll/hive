# Hive — federated multi-agent collaboration over GitHub

> Names: project `hive`, publisher/marketplace namespace `nd-robotics`.
> Change both in one pass if renamed; they appear in the extension ID, the plugin
> marketplace name, and the MCP server name.

## What this is

A collaboration substrate where **several people, each running their own coding
agent on their own account and hardware, work together on one repo**. Humans and
agents share a channel; agents post final summaries only (never thinking or tool
traces); all durable work lands in git.

The distinguishing property, and the reason this isn't just another multi-agent
framework: **participants are federated**. No central provider holds everyone's
keys. Each person brings their own agent, their own model subscription, their own
private data and compute. Preserve this property in every design decision.

Primary testbed is collaborative **scientific paper writing** (LaTeX in git),
with code collaboration second. Paper-first is deliberate: lower stakes on merge
conflicts, and section ownership is already how the work is divided.

## Architecture — three layers

**1. Artifact layer — the git repo is the only shared truth.**
Not just outputs; coordination state lives here too. Anything another participant
needs to know must become a committed artifact, not a chat message. Chat is
ephemeral; the repo is memory.

**2. Conversation layer — GitHub Discussions.**
One Discussion per task = one channel. Comments = messages. Free, hosted, has a
real web UI that non-VS-Code collaborators (Overleaf users, phone) can use with
zero setup, and sits next to the artifacts it references.

**3. Participant layer — a local adapter daemon per person.**
Owns the agent session, the polling loop, and publish logic. **The adapter is a
separate process from any editor extension.** Three reasons, all load-bearing:
non-VS-Code collaborators still participate; agents keep running when the editor
is closed; participants can run headless on a cluster node.

## Decisions already made — do not re-litigate

| Decision | Rationale |
|---|---|
| GitHub Discussions, not Matrix | Free + hosted + human web UI, next to the repo. Matrix reconsidered only if real-time push becomes essential. |
| **Not** git commit messages as the bus | Push contention (non-fast-forward rejection → livelock), history pollution, CI detonation on every message, no total order, humans can't participate. |
| If git-native is ever revisited: orphan branch, one file per message | `chat/YYYY/MM/DD/<ulid>-<author>.json` on `git checkout --orphan chat`. Distinct filenames ⇒ writes never conflict. Not the current plan. |
| Branch-per-agent + PR, never shared-branch editing | Let git reject rather than letting agents negotiate. |
| Mandatory task claiming with a TTL lease | Two agents must never edit one file concurrently. |
| VS Code extension distributed as `.vsix`, **not** Marketplace | No Azure DevOps publisher account, no PAT, no review. Attach to a GitHub release; `code --install-extension hive-x.y.z.vsix`. Revisit only when outsiders want it. |
| The protocol is the product; clients are replaceable | If the extension becomes load-bearing, we've built a VS Code feature instead of a collaboration architecture. |

## Repo layout

```
AGENTS.md | CLAUDE.md   project goals + conventions (agent-readable context)
tasks/                  claimable work units, one file each
decisions/              append-only ADR-style records — the shared memory
sections/ | src/        the actual artifacts (paper or code)
adapter/                local daemon: polling, publish, agent session
plugin/                 Claude Code plugin (hooks, MCP server, skill, subagent)
extension/              VS Code extension (optional client)
```

## Message envelope

Every channel message is structured, not prose. Humans see the body; adapters
parse the envelope. Carried in a fenced JSON block or an HTML comment inside the
Discussion comment.

```json
{
  "from":  "nikolaus/claude",
  "type":  "claim | summary | question | review_request | handoff | decision",
  "refs":  ["task/3", "PR#17", "sections/stability.tex:L40-58"],
  "body":  "...",
  "lease": { "paths": ["sections/stability.tex"], "expires": "<iso8601>" },
  "confidence": 0.7
}
```

`from` is always `<person>/<agent>` or bare `<person>` for humans. Sign commits
per human-agent pair so provenance survives — this matters for papers.

## Claude Code integration

The participant-side bundle is a **Claude Code plugin** (`/plugin install
hive@nd-robotics`), containing:

- **`Stop` hook** → receives `last_assistant_message`; forwards it to the adapter
  as a `summary`. This *is* the "final summaries only, thinking stays local"
  rule. Hooks cannot rewrite the message — format compliance comes from the skill
  and this file, not enforcement.
- **MCP server** (the adapter) → outbound tools: `claim_task`, `post_update`,
  `request_review`, `handoff`, `read_thread`.
- **`PreToolUse` hook on `Edit`/`Write`** → blocks the write if another
  participant holds a lease on that path. Contention surfaces at write time, not
  as a merge conflict an hour later. **This is the most important hook.**
- **Skill** defining the envelope and etiquette: when to claim, when to stay
  quiet, what belongs in a summary.
- **`channel-scribe` subagent** for compressing a long working session into
  something postable.

### Deployment modes, in build order

1. **Poll-and-resume** — `claude -p --resume <id> --output-format json` per
   inbound message. Needs nothing but the CLI. **Build this first.**
2. **Daemon** — Agent SDK streaming-input mode: hold an async generator open,
   yield a user message when a Discussion event arrives. For headless
   participants on cluster nodes.
3. **Interactive** — adapter registered as a Claude Code *channel*, pushing
   inbound messages into a live session. Best experience, most constraints.

### Known constraints — check before designing around them

- **Channels is a research preview.** Custom channel servers need
  `--dangerously-load-development-channels`, require claude.ai or Console API-key
  auth (not Bedrock/Vertex), and Team/Enterprise admins must enable it.
- **No supported way to inject a turn into a running interactive session** other
  than channels. tmux send-keys and the per-session inbox socket exist but the
  external wire format is undocumented — do not build on them.
- **`--bare` skips hooks, plugins and CLAUDE.md** and requires an API key rather
  than subscription auth. Keep subscription participants off `--bare`.
- **Do not parse session transcript `.jsonl` files.** Internal format. Use
  `--output-format json` or hooks.
- Anthropic does not permit third-party products to use claude.ai login, so
  anything distributed to other labs assumes each participant brings their own
  credentials. This is consistent with the federation premise.

Non-Claude participants (Codex, Copilot) need their own adapter. The envelope on
the Discussion is the contract; nothing else is shared.

## VS Code extension

Optional client. It is the **room** — participant roster, task tree, Discussion
threads, and Comments-API threads anchored to file ranges. It is *not* an agent
UI: Claude Code's own extension already provides that and sits beside it.

- Auth: `vscode.authentication.getSession('github', ['repo'])`. Never handle PATs.
- Tree view = tasks/Discussions. Webview = thread. Comments API = inline anchored
  threads (same mechanism `vscode-pull-request-github` uses).
- Gutter decoration for "another agent holds a lease on this file".
- Chat Participant API (`@team`) is a *secondary* entry point if added at all —
  it constrains us to Copilot's chat shell and is only partly compatible with
  Cursor/Windsurf.

```bash
npm install -g @vscode/vsce   # note the scope; bare "vsce" is the old package
vsce package                  # → hive-0.0.1.vsix
code --install-extension hive-0.0.1.vsix
```

Press F5 in `extension/` for the Extension Development Host. Do **not** add
Marketplace publishing steps, publisher IDs, or Azure DevOps PAT handling without
an explicit decision to change the distribution route.

## Open problems — the actual research

These are unsolved. Do not paper over them with a default; flag them.

1. **Loop control.** A summarizes, B responds, A responds — thousands of dollars
   in a weekend. Needs a token/turn budget per task, a rule that agents speak only
   when addressed or when holding a claim, and a human gate before any chain
   exceeds N hops.
2. **Context asymmetry.** My agent doesn't know what yours learned. Mitigation is
   the `decisions/` log, but what *must* be written down is an open question.
3. **Trust and attribution.** Signed commits per human-agent pair; what a
   reviewer or journal needs beyond that is undetermined.
4. **Claim granularity.** File-level leases are the starting point; section- or
   function-level may be needed.

## Conventions for agents working in this repo

- Branch `agent/<person>/<task>`; PR to merge. Never push to `main` directly.
- Claim before editing. Release or let the lease expire.
- Anything another participant needs goes in `decisions/`, not only the channel.
- Summaries posted to the channel are final answers — no thinking, no tool logs.
- Prefer editing files in place over regenerating them from context.
- When a design choice contradicts the decisions table above, stop and ask rather
  than silently diverging.
