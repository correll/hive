// Claude Code hook handlers, invoked by the plugin as `hive hook <event>`.
// Each reads the hook's JSON on stdin.

import { isAbsolute, relative, resolve } from "node:path";
import { Context, currentBranch, taskFromBranch } from "../context.js";
import { blockingLeases, covers } from "../protocol/index.js";
import { currentLeases, markSpawnPosted } from "../state.js";

/** A spawned turn that has nothing to say ends with this; it is not posted. */
export const NO_UPDATE = "(no update)";

async function readStdin(): Promise<Record<string, any>> {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.trim() ? JSON.parse(s) : {};
}

/**
 * Stop: forward the turn's final message to the channel as a `summary`.
 * This is the "final summaries only, thinking stays local" rule — the hook
 * sees only last_assistant_message. It can't rewrite it; format comes from
 * the skill.
 */
export async function stopHook(): Promise<void> {
  const input = await readStdin();
  if (input.stop_hook_active) return;
  const ctx = Context.load(input.cwd ?? process.cwd());
  if (!ctx || !ctx.participant) return;

  const task =
    process.env.HIVE_TASK ??
    (ctx.me.postStopSummaries === "task-branch" ? taskFromBranch(currentBranch(ctx.root), ctx.me.person) : null);
  const body = typeof input.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
  if (!task || !body || body === NO_UPDATE) return;

  const msg = await ctx.channel.post(task, { from: ctx.self, type: "summary", refs: [], body });
  if (process.env.HIVE_SPAWN_NONCE) markSpawnPosted(ctx, process.env.HIVE_SPAWN_NONCE, msg.url);
}

/**
 * PreToolUse on Edit/Write: the most important hook. Contention surfaces at
 * write time, not as a merge conflict an hour later.
 */
export async function preWriteHook(): Promise<void> {
  const input = await readStdin();
  const cwd: string = input.cwd ?? process.cwd();
  const target: unknown = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof target !== "string") return;

  const ctx = Context.load(cwd);
  if (!ctx) return; // not a hive repo: stay out of the way
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const rel = relative(ctx.root, abs).split("\\").join("/");
  if (rel.startsWith("..") || isAbsolute(rel)) return; // outside the repo

  if (!ctx.participant) return deny(`No hive identity configured, so leases can't be checked. Run \`hive init --person <you>\`.`);

  let leases;
  try {
    leases = await currentLeases(ctx);
  } catch (e) {
    return deny(`Couldn't verify leases for ${rel} (${(e as Error).message}). Writes are blocked until the channel is reachable.`);
  }

  const self = ctx.self;
  const blocking = blockingLeases(leases.table, rel, self);
  if (blocking.length > 0) {
    const l = blocking[0];
    return deny(
      `${rel} is leased by ${l.holder} for task/${l.task} until ${l.expires} (${l.messageUrl}). ` +
        `Don't edit it. Ask them in the task channel (post_update with a question) or pick other work.`,
    );
  }
  if (ctx.config.lease.requireClaim && !leases.table.leases.some((l) => l.holder === self && covers(l.path, rel)))
    return deny(`Claim before editing: you hold no lease covering ${rel}. Call claim_task with this path first.`);
}

function deny(reason: string): void {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `[hive] ${reason}` } }),
  );
}
