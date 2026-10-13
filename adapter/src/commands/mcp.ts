// `hive mcp` — the adapter as an MCP server: the agent's outbound tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Context } from "../context.js";
import { blockingLeases, type Envelope, type Message } from "../protocol/index.js";
import { currentLeases, writeLeaseCache } from "../state.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

function guard<A>(fn: (a: A) => Promise<Result>): (a: A) => Promise<Result> {
  return async (a) => {
    try {
      return await fn(a);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}

const participantId = z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/);

export async function mcp(cwd: string): Promise<void> {
  const server = new McpServer({ name: "hive", version: "0.1.0" });
  // Resolved per call: the session may cd, and hive.json may not exist yet.
  const ctx = () => Context.require(cwd);

  const post = async (task: string, env: Omit<Envelope, "from">) => {
    const c = ctx();
    const msg = await c.channel.post(task, { from: c.self, ...env });
    return { c, msg };
  };

  server.registerTool(
    "claim_task",
    {
      description:
        "Claim a task and take a TTL lease on the paths you will edit. Required before editing any file in the repo. " +
        "Fails if another participant holds an overlapping lease. Re-claiming renews your lease.",
      inputSchema: {
        task: z.string().describe("Task id, as in tasks/<id>-*.md"),
        paths: z.array(z.string()).optional().describe("Repo-relative files, or directories ending in '/'. Defaults to the task file's `paths`."),
        minutes: z.number().positive().optional().describe("Lease length; capped by hive.json lease.maxMinutes"),
        note: z.string().optional().describe("What you intend to do — shown to humans in the channel"),
      },
    },
    guard(async ({ task, paths, minutes, note }) => {
      const c = ctx();
      const t = c.task(task);
      const want = paths?.length ? paths : (t?.paths ?? []);
      if (want.length === 0) return fail(`No paths given and tasks/ has no \`paths\` for task ${task}.`);

      const { table } = await currentLeases(c, { maxAgeMs: 0 });
      const conflicts = want.flatMap((p) => blockingLeases(table, p, c.self).map((l) => `${p} ← ${l.holder} (task/${l.task}, until ${l.expires})`));
      // Also catch a requested directory that contains someone's leased file.
      const contained = table.leases.filter((l) => l.holder !== c.self && want.some((p) => p.endsWith("/") && l.path.startsWith(p)));
      if (conflicts.length || contained.length)
        return fail(`Not claimed — already leased:\n${[...conflicts, ...contained.map((l) => `${l.path} ← ${l.holder} (task/${l.task})`)].join("\n")}`);

      const mins = Math.min(minutes ?? c.config.lease.defaultMinutes, c.config.lease.maxMinutes);
      const expires = new Date(Date.now() + mins * 60_000).toISOString();
      if (t) await c.channel.ensureTaskDiscussion(task, t.title, t.body);
      const { msg } = await post(task, {
        type: "claim",
        refs: [],
        body: note ?? `Claiming ${want.join(", ")} for ${mins} min.`,
        lease: { paths: want, expires },
      });

      // Two claims can race. Replaying the thread in server order decides.
      const snap = await c.channel.snapshot();
      writeLeaseCache(c, snap.leases);
      const lost = snap.leases.rejections.filter((r) => r.message.id === msg.id);
      if (lost.length)
        return fail(`Lost a race: ${lost.map((r) => `${r.path} ← ${r.heldBy.holder}`).join(", ")}. Your claim is void; don't edit.`);
      return ok(`Claimed ${want.join(", ")} until ${expires} (${msg.url}).`);
    }),
  );

  server.registerTool(
    "post_update",
    {
      description:
        "Post a message to a task's channel. Use sparingly: only when addressed, when holding a claim, or when a human needs to know. " +
        "Your turn's final message is already posted as a summary by the Stop hook — don't duplicate it.",
      inputSchema: {
        task: z.string(),
        type: z.enum(["summary", "question", "decision"]),
        body: z.string().describe("Final, human-readable text. No thinking, no tool logs."),
        refs: z.array(z.string()).optional().describe('e.g. ["PR#17", "sections/stability.tex:L40-58"]'),
        to: z.array(participantId).optional().describe('Addressees, e.g. ["alice/codex", "bob"]'),
        confidence: z.number().min(0).max(1).optional(),
      },
    },
    guard(async ({ task, type, body, refs, to, confidence }) => {
      const { msg } = await post(task, { type, body, refs: refs ?? [], ...(to ? { to } : {}), ...(confidence !== undefined ? { confidence } : {}) });
      const hint = type === "decision" ? "\nAlso record it in decisions/ — the channel is ephemeral; the repo is memory." : "";
      return ok(`Posted ${msg.url}${hint}`);
    }),
  );

  server.registerTool(
    "request_review",
    {
      description: "Ask for review of a pull request in a task's channel.",
      inputSchema: {
        task: z.string(),
        pr: z.number().int().positive(),
        body: z.string(),
        reviewers: z.array(participantId).optional(),
      },
    },
    guard(async ({ task, pr, body, reviewers }) => {
      const { msg } = await post(task, { type: "review_request", body, refs: [`PR#${pr}`], ...(reviewers ? { to: reviewers } : {}) });
      return ok(`Posted ${msg.url}`);
    }),
  );

  server.registerTool(
    "handoff",
    {
      description:
        "Hand a task off. Releases all your leases on it. With exactly one `to` and transfer_lease, your leased paths pass to them directly.",
      inputSchema: {
        task: z.string(),
        body: z.string().describe("State of the work and what's next"),
        to: participantId.optional(),
        transfer_lease: z.boolean().optional(),
      },
    },
    guard(async ({ task, body, to, transfer_lease }) => {
      const c = ctx();
      const { table } = await currentLeases(c, { maxAgeMs: 0 });
      const mine = table.leases.filter((l) => l.holder === c.self && l.task === task);
      const env: Omit<Envelope, "from"> = { type: "handoff", body, refs: [], ...(to ? { to: [to] } : {}) };
      if (to && transfer_lease && mine.length) {
        const expires = mine.map((l) => l.expires).sort().at(-1)!;
        env.lease = { paths: mine.map((l) => l.path), expires };
      }
      const { msg } = await post(task, env);
      return ok(`Posted ${msg.url}. Released ${mine.length} lease(s)${env.lease ? ` to ${to}` : ""}.`);
    }),
  );

  server.registerTool(
    "read_thread",
    {
      description: "Read a task's channel: the latest messages, oldest first.",
      inputSchema: { task: z.string(), limit: z.number().int().positive().max(200).optional() },
    },
    guard(async ({ task, limit }) => {
      const c = ctx();
      const d = await c.channel.gh.findTaskDiscussion(task);
      if (!d) return ok(`task/${task} has no channel yet.`);
      const thread = (await c.channel.thread(d)).slice(-(limit ?? 30));
      return ok(`${d.url}\n\n${thread.map(formatMessage).join("\n\n")}`);
    }),
  );

  server.registerTool(
    "list_leases",
    { description: "Active leases across all tasks. Check before planning edits.", inputSchema: {} },
    guard(async () => {
      const c = ctx();
      const { table, stale, fetchedAt } = await currentLeases(c);
      if (!table.leases.length) return ok("No active leases.");
      const rows = table.leases.map((l) => `${l.path}\t${l.holder}\ttask/${l.task}\tuntil ${l.expires}`);
      return ok(`${stale ? `(stale cache from ${fetchedAt})\n` : ""}${rows.join("\n")}`);
    }),
  );

  server.registerTool(
    "list_tasks",
    { description: "Tasks in tasks/ with their active lease holders.", inputSchema: {} },
    guard(async () => {
      const c = ctx();
      const { table } = await currentLeases(c);
      const rows = c.tasks().map((t) => {
        const holders = [...new Set(table.leases.filter((l) => l.task === t.id).map((l) => l.holder))];
        return `${t.id}\t[${t.status}]\t${t.title}\t${holders.length ? `held by ${holders.join(", ")}` : "unclaimed"}`;
      });
      return ok(rows.join("\n") || "No tasks.");
    }),
  );

  await server.connect(new StdioServerTransport());
}

export function formatMessage(m: Message): string {
  const env = m.envelope;
  const tags = [env?.type ?? "message", m.verified ? null : "UNVERIFIED", env?.to?.length ? `to ${env.to.join(", ")}` : null]
    .filter(Boolean)
    .join(", ");
  const refs = env?.refs.length ? `\nrefs: ${env.refs.join(", ")}` : "";
  const lease = env?.lease ? `\nlease: ${env.lease.paths.join(", ")} until ${env.lease.expires}` : "";
  return `[${m.createdAt}] ${m.from} (${tags})\n${m.body}${refs}${lease}`;
}

