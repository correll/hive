// hive.json — committed, shared policy for everyone working in the repo.

import type { LoopPolicy } from "./loop.js";
import type { LeasePolicy } from "./leases.js";

export interface RepoConfig {
  repo: { owner: string; name: string };
  discussionCategory: string;
  lease: LeasePolicy & { defaultMinutes: number; requireClaim: boolean };
  loop: LoopPolicy;
}

export function parseRepoConfig(text: string): RepoConfig {
  const raw = JSON.parse(text) as Record<string, any>;
  const errs: string[] = [];
  const num = (v: unknown, key: string) => {
    if (typeof v !== "number" || !(v > 0)) errs.push(`${key} must be a positive number`);
    return v as number;
  };

  const [owner, name] = typeof raw.repo === "string" ? raw.repo.split("/") : [];
  if (!owner || !name) errs.push(`repo must be "owner/name"`);
  if (typeof raw.discussionCategory !== "string") errs.push("discussionCategory must be a string");

  const lease = {
    defaultMinutes: num(raw.lease?.defaultMinutes, "lease.defaultMinutes"),
    maxMinutes: num(raw.lease?.maxMinutes, "lease.maxMinutes"),
    // Claiming is mandatory (AGENTS.md decisions); a repo must opt out explicitly.
    requireClaim: raw.lease?.requireClaim !== false,
  };

  // No defaults for loop limits on purpose: loop control is an open problem
  // (AGENTS.md #1) and each repo must choose its limits consciously.
  if (raw.loop === undefined)
    errs.push("loop is required (maxAgentHops, maxTurnsPerTaskPerAgent, maxUsdPerTaskPerAgent) — see decisions/0003-loop-control-limits.md");
  const loop = {
    maxAgentHops: num(raw.loop?.maxAgentHops, "loop.maxAgentHops"),
    maxTurnsPerTaskPerAgent: num(raw.loop?.maxTurnsPerTaskPerAgent, "loop.maxTurnsPerTaskPerAgent"),
    maxUsdPerTaskPerAgent: num(raw.loop?.maxUsdPerTaskPerAgent, "loop.maxUsdPerTaskPerAgent"),
  };

  if (errs.length) throw new Error(`invalid hive.json:\n  ${errs.join("\n  ")}`);
  return { repo: { owner, name }, discussionCategory: raw.discussionCategory, lease, loop };
}
