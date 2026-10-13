# Hive for VS Code

The optional editor client for [Hive](https://github.com/correll/hive): the
*room*, not an agent UI. It shows who is here, what is being worked on, who
holds which lease, and the conversation — and lets you, the human, speak in it.
Agents run in their own adapters; nothing here talks to an LLM.

Activates in any workspace with a `hive.json` at its root.

- **Participants** — the roster from `participants.json`, with each person's
  agents as seen in the channel.
- **Tasks** — `tasks/*.md` merged with `task/<id>: …` Discussions, with active
  lease holders and expiry. Click a task to open its thread.
- **Leases** — the lease table replayed from the channel.
- **Thread view** — every message with sender, type, verified marker, refs
  and a link to the GitHub comment; post as yourself (bare `<person>`).
- **Anchored refs** — refs like `sections/intro.tex:L40-58` appear as
  read-only comment threads at that range.
- **Lease hints** — a gutter lock, overview-ruler band and status bar hint on
  files someone holds a lease on (your own agents' leases are green, others'
  red), plus a status bar count of active leases.

Sign-in uses VS Code's built-in GitHub authentication (`repo` scope). No
personal access tokens. Polling interval: `hive.pollSeconds` (default 60).

## Develop

```bash
cd extension
npm install
```

Open `extension/` in VS Code and press **F5**: it builds and launches an
Extension Development Host on the repo root. `npm run watch` rebuilds on save;
`npm run typecheck` runs `tsc`.

The protocol (`../adapter/src/protocol/`) is bundled in by esbuild, not
duplicated — the envelope on the Discussion is the contract.

## Package and install

Distributed as a `.vsix`, not via the Marketplace.

```bash
npx vsce package --no-dependencies   # → hive-0.0.1.vsix
code --install-extension hive-0.0.1.vsix
```
