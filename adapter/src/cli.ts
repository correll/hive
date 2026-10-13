#!/usr/bin/env node
// hive — the participant adapter. One binary, several roles:
//   hive poll            deployment mode 1 (poll-and-resume)
//   hive mcp             MCP server (started by the Claude Code plugin)
//   hive hook <event>    Claude Code hooks (started by the plugin)
//   hive init|status|tasks|leases|task open|post   for humans

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { poll } from "./commands/poll.js";
import { mcp, formatMessage } from "./commands/mcp.js";
import { preWriteHook, stopHook } from "./commands/hooks.js";
import { Context, loadParticipant, participantConfigPath } from "./context.js";
import { MESSAGE_TYPES, type MessageType } from "./protocol/index.js";
import { currentLeases } from "./state.js";

const USAGE = `usage:
  hive init --person <name> [--agent claude] [--claude-arg <arg>]...
  hive status
  hive tasks
  hive leases
  hive task open <id>
  hive thread <task> [--limit N]
  hive post <task> --type <type> [--to <id>]... <body>
  hive poll [--once] [--dry-run]
  hive mcp
  hive hook stop|pre-write`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const cwd = process.cwd();

  switch (cmd) {
    case "init": {
      const { values } = parseArgs({
        args: rest,
        options: { person: { type: "string" }, agent: { type: "string" }, "claude-arg": { type: "string", multiple: true } },
      });
      if (!values.person) throw new Error("--person is required (your bare participant id, e.g. nikolaus)");
      const path = participantConfigPath();
      const cfg = { person: values.person, agent: values.agent ?? "claude", claudeArgs: values["claude-arg"] ?? [], pollSeconds: 60, postStopSummaries: "spawned" };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
      console.log(`wrote ${path}\nYou are ${cfg.person}/${cfg.agent}. Add yourself to participants.json in each hive repo (via PR).`);
      return;
    }

    case "status": {
      const ctx = Context.require(cwd);
      const p = loadParticipant();
      console.log(`repo:     ${ctx.config.repo.owner}/${ctx.config.repo.name} (category "${ctx.config.discussionCategory}")`);
      console.log(`root:     ${ctx.root}`);
      console.log(`self:     ${p ? `${p.person}/${p.agent}` : "(not configured — run hive init)"}`);
      console.log(`state:    ${ctx.stateDir}`);
      console.log(`loop:     ${JSON.stringify(ctx.config.loop)}`);
      if (p && !ctx.roster[p.person]) console.log(`warning:  ${p.person} is not in participants.json; your messages will only verify if your GitHub login is "${p.person}"`);
      return;
    }

    case "tasks": {
      const ctx = Context.require(cwd);
      const { table } = await currentLeases(ctx);
      for (const t of ctx.tasks()) {
        const holders = [...new Set(table.leases.filter((l) => l.task === t.id).map((l) => l.holder))];
        console.log(`${t.id.padEnd(6)} ${t.status.padEnd(8)} ${t.title}${holders.length ? `  ← ${holders.join(", ")}` : ""}`);
      }
      return;
    }

    case "leases": {
      const ctx = Context.require(cwd);
      const { table, stale } = await currentLeases(ctx, { maxAgeMs: 0 });
      if (stale) console.log("(stale cache)");
      for (const l of table.leases) console.log(`${l.path}\t${l.holder}\ttask/${l.task}\tuntil ${l.expires}`);
      for (const r of table.rejections) console.log(`rejected: ${r.message.from} on ${r.path} (held by ${r.heldBy.holder}) ${r.message.url}`);
      if (!table.leases.length) console.log("No active leases.");
      return;
    }

    case "task": {
      const [sub, id] = rest;
      if (sub !== "open" || !id) throw new Error("usage: hive task open <id>");
      const ctx = Context.require(cwd);
      const t = ctx.task(id);
      if (!t) throw new Error(`No task with id ${id} in tasks/`);
      const d = await ctx.channel.ensureTaskDiscussion(id, t.title, t.body);
      console.log(d.url);
      return;
    }

    case "thread": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { limit: { type: "string" } } });
      const ctx = Context.require(cwd);
      const d = await ctx.channel.gh.findTaskDiscussion(positionals[0]);
      if (!d) throw new Error(`task/${positionals[0]} has no channel`);
      const thread = (await ctx.channel.thread(d)).slice(-Number(values.limit ?? 30));
      console.log(`${d.url}\n\n${thread.map(formatMessage).join("\n\n")}`);
      return;
    }

    case "post": {
      // Humans post as bare <person>; agents use the MCP tools.
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { type: { type: "string" }, to: { type: "string", multiple: true }, ref: { type: "string", multiple: true } },
      });
      const [task, ...words] = positionals;
      const type = values.type as MessageType;
      if (!task || !words.length || !MESSAGE_TYPES.includes(type) || type === "claim")
        throw new Error(`usage: hive post <task> --type <${MESSAGE_TYPES.filter((t) => t !== "claim").join("|")}> <body>`);
      const ctx = Context.require(cwd);
      const msg = await ctx.channel.post(task, { from: ctx.me.person, type, refs: values.ref ?? [], body: words.join(" "), ...(values.to ? { to: values.to } : {}) });
      console.log(msg.url);
      return;
    }

    case "poll": {
      const { values } = parseArgs({ args: rest, options: { once: { type: "boolean" }, "dry-run": { type: "boolean" } } });
      return poll(Context.require(cwd), { once: values.once, dryRun: values["dry-run"] });
    }

    case "mcp":
      return mcp(cwd);

    case "hook":
      if (rest[0] === "stop") return stopHook();
      if (rest[0] === "pre-write") return preWriteHook();
      throw new Error(`unknown hook ${rest[0]}`);

    default:
      console.error(USAGE);
      process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0;
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`hive: ${e.message}`);
  process.exitCode = 1;
});
