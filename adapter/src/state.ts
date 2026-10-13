// Participant-local state. Never shared: spend, sessions and cursors are this
// participant's business. Each file has a single writer:
//   state.json      — the poll loop
//   leases.json     — anyone (atomic replace; it's a cache)
//   spawns/<nonce>  — the Stop hook, read by the poll loop

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.js";
import type { LeaseTable, Spend } from "./protocol/index.js";

export interface Cursor {
  id: string;
  createdAt: string;
}

export interface PollState {
  lastPoll?: string;
  cursors: Record<string, Cursor>;
  sessions: Record<string, string>;
  spend: Record<string, Spend>;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export const loadPollState = (ctx: Context): PollState =>
  readJson(join(ctx.stateDir, "state.json"), { cursors: {}, sessions: {}, spend: {} });

export const savePollState = (ctx: Context, s: PollState) => writeJson(join(ctx.stateDir, "state.json"), s);

interface LeaseCache {
  fetchedAt: string;
  table: LeaseTable;
}

export function readLeaseCache(ctx: Context): LeaseCache | null {
  return readJson<LeaseCache | null>(join(ctx.stateDir, "leases.json"), null);
}

export function writeLeaseCache(ctx: Context, table: LeaseTable): void {
  // Rejections carry whole messages; the cache only needs the live leases.
  writeJson(join(ctx.stateDir, "leases.json"), { fetchedAt: new Date().toISOString(), table: { leases: table.leases, rejections: [] } });
}

function spawnDir(ctx: Context): string {
  const dir = join(ctx.stateDir, "spawns");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function markSpawnPosted(ctx: Context, nonce: string, url: string): void {
  writeJson(join(spawnDir(ctx), `${nonce}.json`), { url, at: new Date().toISOString() });
}

export function spawnPosted(ctx: Context, nonce: string): boolean {
  return existsSync(join(spawnDir(ctx), `${nonce}.json`));
}

/**
 * The lease table, from cache if younger than `maxAgeMs`, else from GitHub.
 * If GitHub is unreachable, a cache up to `staleOkMs` old is still used.
 */
export async function currentLeases(
  ctx: Context,
  { maxAgeMs = 20_000, staleOkMs = 5 * 60_000 } = {},
): Promise<{ table: LeaseTable; fetchedAt: string; stale: boolean }> {
  const cache = readLeaseCache(ctx);
  const age = cache ? Date.now() - Date.parse(cache.fetchedAt) : Infinity;
  const live = (t: LeaseTable): LeaseTable => ({ ...t, leases: t.leases.filter((l) => Date.parse(l.expires) > Date.now()) });
  if (cache && age < maxAgeMs) return { table: live(cache.table), fetchedAt: cache.fetchedAt, stale: false };
  try {
    const { leases } = await ctx.channel.snapshot();
    writeLeaseCache(ctx, leases);
    return { table: leases, fetchedAt: new Date().toISOString(), stale: false };
  } catch (e) {
    if (cache && age < staleOkMs) return { table: live(cache.table), fetchedAt: cache.fetchedAt, stale: true };
    throw e;
  }
}
