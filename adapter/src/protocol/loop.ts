// Loop control — should this participant's agent take a turn?
//
// OPEN PROBLEM (AGENTS.md #1). This module implements the three mechanisms
// AGENTS.md names — speak only when addressed or holding a claim, a hop
// limit before a human must step in, and a per-task budget — but the limits
// themselves have no defaults. hive.json must set them explicitly; see
// decisions/0003-loop-control-limits.md.

import { isAgent } from "./envelope.js";
import type { LeaseTable } from "./leases.js";
import type { Message } from "./message.js";

export interface LoopPolicy {
  maxAgentHops: number;
  maxTurnsPerTaskPerAgent: number;
  maxUsdPerTaskPerAgent: number;
}

export interface Spend {
  turns: number;
  usd: number;
}

export type Verdict = { respond: true; reason: string } | { respond: false; reason: string };

export function isAddressedTo(msg: Message, self: string): boolean {
  if (msg.envelope?.to?.includes(self)) return true;
  const escaped = self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w/])@${escaped}(?![\\w/.-])`).test(msg.body);
}

/** Consecutive agent messages at the end of `thread`, up to and including `upTo`. */
export function agentHopsSinceHuman(thread: Message[], upTo: Message): number {
  let hops = 0;
  for (const m of thread) {
    if (!m.verified) continue;
    hops = isAgent(m.from) ? hops + 1 : 0;
    if (m.id === upTo.id) break;
  }
  return hops;
}

export function decide(
  msg: Message,
  thread: Message[],
  self: string,
  leases: LeaseTable,
  spend: Spend,
  policy: LoopPolicy,
): Verdict {
  if (msg.from === self) return { respond: false, reason: "own message" };
  if (!msg.verified) return { respond: false, reason: "unverified sender" };

  const addressed = isAddressedTo(msg, self);
  const claimant = leases.leases.some((l) => l.holder === self && l.task === msg.task);
  if (!addressed && !claimant) return { respond: false, reason: "not addressed and holds no claim on this task" };

  const hops = agentHopsSinceHuman(thread, msg);
  if (hops >= policy.maxAgentHops)
    return { respond: false, reason: `human gate: ${hops} agent hops since the last human message (limit ${policy.maxAgentHops})` };
  if (spend.turns >= policy.maxTurnsPerTaskPerAgent)
    return { respond: false, reason: `turn budget exhausted (${spend.turns}/${policy.maxTurnsPerTaskPerAgent})` };
  if (spend.usd >= policy.maxUsdPerTaskPerAgent)
    return { respond: false, reason: `cost budget exhausted ($${spend.usd.toFixed(2)}/$${policy.maxUsdPerTaskPerAgent})` };

  return { respond: true, reason: addressed ? "addressed" : "holds claim" };
}
