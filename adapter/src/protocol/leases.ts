// Lease table: a pure function of the channel history.
//
// Every participant replays the same verified messages in the same order
// (server createdAt, then comment id) and therefore computes the same table.
// No participant is the lock server; GitHub's comment ordering is the
// arbiter. First valid claim wins; later overlapping claims are rejected,
// not queued.
//
// OPEN PROBLEM (AGENTS.md #4, claim granularity): leases are file- or
// directory-level. A path ending in "/" covers everything beneath it.

import type { Message } from "./message.js";

export interface ActiveLease {
  holder: string; // participant id, e.g. "nikolaus/claude"
  path: string;
  task: string;
  expires: string;
  claimedAt: string;
  messageUrl: string;
}

export interface Rejection {
  message: Message;
  path: string;
  heldBy: ActiveLease;
}

export interface LeaseTable {
  leases: ActiveLease[];
  rejections: Rejection[];
}

export interface LeasePolicy {
  maxMinutes: number;
}

export function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** Does lease path `lease` cover repo-relative file `file`? */
export function covers(lease: string, file: string): boolean {
  const l = normalizePath(lease);
  const f = normalizePath(file);
  return l === f || (l.endsWith("/") && f.startsWith(l));
}

export function overlaps(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a);
}

function cmp(a: Message, b: Message): number {
  return a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1;
}

/**
 * Replay messages into a lease table valid at `now`.
 * Only verified messages participate; an unverified claim is ignored, not
 * rejected, because we can't tell who made it.
 */
export function computeLeases(messages: Message[], policy: LeasePolicy, now: Date = new Date()): LeaseTable {
  let held: ActiveLease[] = [];
  const rejections: Rejection[] = [];

  for (const msg of [...messages].sort(cmp)) {
    const env = msg.envelope;
    if (!env || !msg.verified) continue;
    const at = Date.parse(msg.createdAt);
    held = held.filter((l) => Date.parse(l.expires) > at);

    if (env.type === "claim" && env.lease) {
      const expires = capExpiry(env.lease.expires, at, policy);
      const conflicts = env.lease.paths.flatMap((p) =>
        held.filter((l) => l.holder !== env.from && overlaps(l.path, p)).map((l) => ({ path: p, heldBy: l })),
      );
      if (conflicts.length > 0) {
        // All-or-nothing: a partially granted claim would let an agent edit
        // half of what it planned.
        for (const c of conflicts) rejections.push({ message: msg, ...c });
        continue;
      }
      for (const p of env.lease.paths) {
        held = held.filter((l) => !(l.holder === env.from && l.path === normalizePath(p)));
        if (Date.parse(expires) > at)
          held.push({ holder: env.from, path: normalizePath(p), task: msg.task, expires, claimedAt: msg.createdAt, messageUrl: msg.url });
      }
    } else if (env.type === "handoff") {
      const mine = held.filter((l) => l.holder === env.from && l.task === msg.task);
      held = held.filter((l) => !mine.includes(l));
      // Transfer only when there is exactly one addressee and the handoff
      // names the paths; otherwise it's a plain release.
      if (env.to?.length === 1 && env.lease) {
        const expires = capExpiry(env.lease.expires, at, policy);
        for (const p of env.lease.paths) {
          if (!mine.some((l) => covers(l.path, p))) continue; // can't hand off what you don't hold
          held.push({ holder: env.to[0], path: normalizePath(p), task: msg.task, expires, claimedAt: msg.createdAt, messageUrl: msg.url });
        }
      }
    }
  }

  return { leases: held.filter((l) => Date.parse(l.expires) > now.getTime()), rejections };
}

function capExpiry(requested: string, at: number, policy: LeasePolicy): string {
  const cap = at + policy.maxMinutes * 60_000;
  return new Date(Math.min(Date.parse(requested), cap)).toISOString();
}

/** Leases held by someone other than `self` that cover `file`. */
export function blockingLeases(table: LeaseTable, file: string, self: string): ActiveLease[] {
  return table.leases.filter((l) => l.holder !== self && covers(l.path, file));
}
