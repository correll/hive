// High-level read/write over the channel, shared by the adapter, the MCP
// server, the hooks and the VS Code extension.

import { renderEnvelope, type Envelope } from "./envelope.js";
import type { DiscussionRef, GitHub } from "./github.js";
import { computeLeases, type LeaseTable } from "./leases.js";
import { decodeComment, taskTitle, type Message, type Roster } from "./message.js";
import type { RepoConfig } from "./repo-config.js";

export interface ChannelSnapshot {
  discussions: DiscussionRef[];
  threads: Map<string, Message[]>; // task id -> messages, in order
  leases: LeaseTable;
}

export class Channel {
  constructor(
    readonly gh: GitHub,
    readonly config: RepoConfig,
    readonly roster: Roster,
  ) {}

  async thread(d: DiscussionRef): Promise<Message[]> {
    return (await this.gh.comments(d.number)).map((c) => decodeComment(c, d.task!, this.roster));
  }

  /**
   * Snapshot of every task thread updated since `since`. A lease can only be
   * live if its claim is younger than lease.maxMinutes, and conflicts at claim
   * time can reach back another maxMinutes — so 2×max is enough for leases.
   */
  async snapshot(opts: { since?: Date; now?: Date } = {}): Promise<ChannelSnapshot> {
    const now = opts.now ?? new Date();
    const leaseWindow = new Date(now.getTime() - 2 * this.config.lease.maxMinutes * 60_000);
    const since = opts.since && opts.since < leaseWindow ? opts.since : leaseWindow;
    const discussions = (await this.gh.listTaskDiscussions()).filter((d) => new Date(d.updatedAt) >= since);
    const threads = new Map<string, Message[]>();
    await Promise.all(discussions.map(async (d) => threads.set(d.task!, await this.thread(d))));
    const all = [...threads.values()].flat().filter((m) => new Date(m.createdAt) >= leaseWindow);
    return { discussions, threads, leases: computeLeases(all, this.config.lease, now) };
  }

  async ensureTaskDiscussion(task: string, title?: string, description?: string): Promise<DiscussionRef> {
    const existing = await this.gh.findTaskDiscussion(task);
    if (existing) return existing;
    return this.gh.createTaskDiscussion(
      taskTitle(task, title ?? task),
      `${description ?? ""}\n\nChannel for \`task/${task}\`. Messages carry a hive envelope; see PROTOCOL.md.`.trim(),
    );
  }

  async post(task: string, env: Envelope): Promise<Message> {
    const d = await this.ensureTaskDiscussion(task);
    const refs = env.refs.includes(`task/${task}`) ? env.refs : [`task/${task}`, ...env.refs];
    const raw = await this.gh.addComment(d.id, renderEnvelope({ ...env, refs }));
    return decodeComment(raw, task, this.roster);
  }
}
