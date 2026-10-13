// The extension's view of the room: local repo files (hive.json, roster,
// tasks/) merged with the channel (task Discussions and the lease table).
// Every view reads from here; nothing else talks to GitHub.

import * as path from "path";
import * as vscode from "vscode";
import {
  Channel,
  GitHub,
  covers,
  loginToPerson,
  parseRepoConfig,
  parseTask,
  personOf,
  type ActiveLease,
  type DiscussionRef,
  type Envelope,
  type LeaseTable,
  type Message,
  type RepoConfig,
  type Roster,
  type Task,
} from "../../adapter/src/protocol/index.js";

/** A task as shown in the tree: a tasks/*.md file, a Discussion, or both. */
export interface TaskView {
  id: string;
  title: string;
  task?: Task;
  discussion?: DiscussionRef;
  leases: ActiveLease[];
}

interface CachedThread {
  updatedAt: string;
  messages: Message[];
}

const decoder = new TextDecoder();

export class Hive implements vscode.Disposable {
  config?: RepoConfig;
  roster: Roster = {};
  tasks: Task[] = [];
  discussions: DiscussionRef[] = [];
  leases: LeaseTable = { leases: [], rejections: [] };
  /** Signed-in GitHub login and the roster person it maps to. */
  login?: string;
  me?: string;
  error?: string;
  lastRefresh?: Date;

  private threads = new Map<string, CachedThread>();
  private gh?: GitHub;
  private ghKey?: string;
  private inflight?: Promise<void>;
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(readonly root: vscode.Uri) {}

  dispose(): void {
    this.emitter.dispose();
  }

  /** Re-read hive.json, participants.json and tasks/ without touching the network. */
  async reloadLocal(): Promise<void> {
    try {
      this.config = parseRepoConfig(await this.read("hive.json"));
    } catch (e) {
      this.config = undefined;
      throw e;
    }
    try {
      this.roster = JSON.parse(await this.read("participants.json")) as Roster;
    } catch {
      this.roster = {}; // a roster is optional; unknown logins show as themselves
    }
    const tasks: Task[] = [];
    try {
      const dir = vscode.Uri.joinPath(this.root, "tasks");
      for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
        if (type !== vscode.FileType.File || !name.endsWith(".md")) continue;
        const t = parseTask(`tasks/${name}`, await this.read(`tasks/${name}`));
        if (t) tasks.push(t);
      }
    } catch {
      // no tasks/ directory yet
    }
    this.tasks = tasks;
    if (this.login) this.me = loginToPerson(this.roster, this.login);
  }

  /** Local-only refresh, e.g. when a tasks/*.md file changes. */
  async refreshLocal(): Promise<void> {
    try {
      await this.reloadLocal();
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.emitter.fire();
  }

  /**
   * Full refresh. `interactive` may prompt for GitHub sign-in; background
   * polls never do, so a dismissed prompt doesn't come back every minute.
   */
  refresh(interactive = false): Promise<void> {
    this.inflight ??= this.doRefresh(interactive).finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async doRefresh(interactive: boolean): Promise<void> {
    try {
      await this.reloadLocal();
      const channel = await this.channel(interactive);
      const [snap, all] = await Promise.all([channel.snapshot(), channel.gh.listTaskDiscussions()]);
      this.leases = snap.leases;
      for (const d of snap.discussions) this.threads.set(d.task!, { updatedAt: d.updatedAt, messages: snap.threads.get(d.task!) ?? [] });
      // The snapshot only covers the lease window; fetch older threads once
      // and again only when their Discussion changes.
      const stale = all.filter((d) => this.threads.get(d.task!)?.updatedAt !== d.updatedAt);
      for (let i = 0; i < stale.length; i += 8)
        await Promise.all(
          stale.slice(i, i + 8).map(async (d) => this.threads.set(d.task!, { updatedAt: d.updatedAt, messages: await channel.thread(d) })),
        );
      this.discussions = all;
      this.error = undefined;
      this.lastRefresh = new Date();
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.emitter.fire();
  }

  private async channel(interactive: boolean): Promise<Channel> {
    if (!this.config) throw new Error("hive.json not loaded");
    const session = await vscode.authentication.getSession("github", ["repo"], interactive ? { createIfNone: true } : { silent: true });
    if (!session) throw new Error("Not signed in to GitHub. Run “Hive: Refresh” to sign in.");
    this.login = session.account.label;
    this.me = loginToPerson(this.roster, this.login);
    const { owner, name } = this.config.repo;
    const key = [session.accessToken, owner, name, this.config.discussionCategory].join("\0");
    // Reuse the GitHub client so its repository/category lookup is cached.
    if (key !== this.ghKey) {
      this.gh = new GitHub(session.accessToken, owner, name, this.config.discussionCategory);
      this.ghKey = key;
    }
    return new Channel(this.gh!, this.config, this.roster);
  }

  /** Post as the signed-in human (bare `<person>`), creating the Discussion if needed. */
  async post(taskId: string, type: Envelope["type"], body: string, refs: string[]): Promise<void> {
    const channel = await this.channel(true);
    const view = this.taskViews().find((t) => t.id === taskId);
    await channel.ensureTaskDiscussion(taskId, view?.title, view?.task?.body);
    await channel.post(taskId, { from: this.me!, type, refs, body });
    await this.refresh();
  }

  thread(taskId: string): Message[] | undefined {
    return this.threads.get(taskId)?.messages;
  }

  /** All cached messages, for anchoring file-range refs. */
  allMessages(): Message[] {
    return [...this.threads.values()].flatMap((t) => t.messages);
  }

  taskViews(): TaskView[] {
    const byId = new Map<string, TaskView>();
    const get = (id: string, title: string) => {
      let v = byId.get(id);
      if (!v) byId.set(id, (v = { id, title, leases: this.leases.leases.filter((l) => l.task === id) }));
      return v;
    };
    for (const t of this.tasks) get(t.id, t.title).task = t;
    for (const d of this.discussions) {
      const v = get(d.task!, d.title.replace(/^task\/[^:]+:\s*/, ""));
      v.discussion = d;
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  /** Leases covering a workspace file, or [] if it's outside the repo root. */
  leasesFor(uri: vscode.Uri): ActiveLease[] {
    const rel = this.relative(uri);
    return rel ? this.leases.leases.filter((l) => covers(l.path, rel)) : [];
  }

  /** Held by the signed-in human or one of their agents (`<me>/*`). */
  isMine(holder: string): boolean {
    return this.me !== undefined && personOf(holder) === this.me;
  }

  relative(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== this.root.scheme) return undefined;
    const rel = path.posix.relative(this.root.path, uri.path);
    return rel && !rel.startsWith("..") && !path.posix.isAbsolute(rel) ? rel : undefined;
  }

  uri(rel: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, rel);
  }

  private async read(rel: string): Promise<string> {
    return decoder.decode(await vscode.workspace.fs.readFile(this.uri(rel)));
  }
}

/** "14:32 (in 23m)" — leases are short-lived, so relative time matters most. */
export function fmtExpiry(iso: string): string {
  const t = new Date(iso);
  const mins = Math.round((t.getTime() - Date.now()) / 60_000);
  const rel = mins <= 0 ? "expired" : mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
  return `${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${rel})`;
}

/** `path:L40-58`, `path:L40-L58` or `path:L40` → repo path and 1-based lines. */
export function parseFileRef(ref: string): { path: string; start: number; end: number } | null {
  const m = /^(.+?):L(\d+)(?:-L?(\d+))?$/.exec(ref);
  if (!m) return null;
  const start = Number(m[2]);
  return { path: m[1].replace(/^\.\//, ""), start, end: Math.max(start, Number(m[3] ?? start)) };
}
