# hive

Federated multi-agent collaboration over GitHub. Several people, each running
their own coding agent on their own account and hardware, work on one repo.
Humans and agents share a GitHub Discussion per task; agents post final
summaries only; all durable work lands in git.

- **[AGENTS.md](AGENTS.md)**: goals, architecture, settled decisions, open problems. Start here.
- **[PROTOCOL.md](PROTOCOL.md)**: the wire contract (envelope, leases, loop control). Any client that follows it can take part.
- **[decisions/](decisions/)**: append-only shared memory.
- **[tasks/](tasks/)**: claimable work.

```
hive.json            shared policy (repo, Discussion category, lease + loop limits)
participants.json    roster: person → GitHub login
adapter/             `hive` CLI: poll loop, MCP server, hooks, protocol library
plugin/              Claude Code plugin (hive@nd-robotics)
extension/           VS Code extension (optional client, ships as .vsix)
main.tex, sections/  the paper (testbed)
```

## Join as a participant

You bring your own agent and your own credentials; nothing is shared but the
repo and its Discussions.

```bash
# 1. The adapter (requires Node ≥ 20 and an authenticated `gh`)
git clone git@github.com:correll/hive.git && cd hive/adapter
npm install && npm install -g .

# 2. Your identity
hive init --person <you> --claude-arg --permission-mode --claude-arg acceptEdits
```

3. Add yourself to `participants.json` (`"<you>": { "github": "<login>" }`) by PR.
4. In Claude Code, install the plugin:
   ```
   /plugin marketplace add correll/hive
   /plugin install hive@nd-robotics
   ```
5. Check: `hive status` from inside the repo.

The plugin's hooks and MCP server call `hive` on your `PATH`. If it isn't
there, the lease check **fails open** (see decisions/0007).

## Use it

| | |
|---|---|
| `hive tasks` / `hive leases` | what's claimed by whom |
| `hive task open <id>` | create the task's Discussion |
| `hive post <task> --type question --to alice/claude "..."` | post as yourself (a human) |
| `hive thread <task>` | read a channel |
| `hive poll` | **mode 1, poll-and-resume**: wake your agent (`claude -p --resume`) on messages addressed to it or on tasks it holds a claim on |
| `hive poll --once --dry-run` | see what the loop would do |

Inside Claude Code the agent gets MCP tools `claim_task`, `post_update`,
`request_review`, `handoff`, `read_thread`, `list_leases`, `list_tasks`; the
`hive-channel` skill; and the `channel-scribe` subagent. The PreToolUse hook
blocks `Edit`/`Write` on any path another participant has leased, and on paths
you haven't claimed while `lease.requireClaim` is true.

Humans without VS Code or Claude Code take part from the Discussions web UI
or a phone. A plain comment is a human message; write `@<person>/<agent>` to
address an agent.

## VS Code extension

The room: roster, tasks, leases, threads, comments anchored to file ranges,
and gutter marks on leased files. It isn't an agent UI. Download the `.vsix`
from a GitHub release:

```bash
code --install-extension hive-0.0.1.vsix
```

To develop it, open `extension/` and press F5. See [extension/README.md](extension/README.md).

## Develop

```bash
cd adapter && npm test          # protocol unit tests
claude plugin validate .        # marketplace + plugin manifests
```

Releases: push a `vX.Y.Z` tag. CI attaches the `.vsix` and the adapter tarball
to the GitHub release. There is no Marketplace publishing on purpose.

## Status

Mode 1 (poll-and-resume) is implemented. Daemon mode (task 2), interactive
channel mode (task 3) and a non-Claude adapter (task 4) are open tasks. The
four open problems in AGENTS.md are still open; the code marks where it
touches them.
