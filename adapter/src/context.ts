// Everything a command needs: where the repo is, who "self" is, the shared
// policy, local state paths, and a lazily authenticated channel.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Channel, GitHub, parseRepoConfig, parseTask, type RepoConfig, type Roster, type Task } from "./protocol/index.js";

export interface Participant {
  person: string;
  agent: string;
  /** Extra args for `claude -p` in poll-and-resume mode, e.g. ["--permission-mode", "acceptEdits"]. Never "--bare". */
  claudeArgs: string[];
  pollSeconds: number;
  /** "spawned": only adapter-spawned turns post their final message (default). "task-branch": also interactive sessions on agent/<person>/<task>. */
  postStopSummaries: "spawned" | "task-branch";
  worktreeRoot?: string;
}

export const participantConfigPath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "hive", "participant.json");

export function loadParticipant(): Participant | null {
  const p = participantConfigPath();
  const raw: Partial<Participant> = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const person = process.env.HIVE_PERSON ?? raw.person;
  const agent = process.env.HIVE_AGENT ?? raw.agent ?? "claude";
  if (!person) return null;
  if (raw.claudeArgs?.includes("--bare"))
    throw new Error(`${p}: claudeArgs must not contain --bare (it skips hooks, plugins and CLAUDE.md)`);
  return {
    person,
    agent,
    claudeArgs: raw.claudeArgs ?? [],
    pollSeconds: raw.pollSeconds ?? 60,
    postStopSummaries: raw.postStopSummaries ?? "spawned",
    worktreeRoot: raw.worktreeRoot,
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function findRepoRoot(cwd: string): string | null {
  try {
    return git(cwd, "rev-parse", "--show-toplevel");
  } catch {
    return null;
  }
}

/** The main checkout, even when `root` is a linked worktree. */
export function mainCheckout(root: string): string {
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common.endsWith("/.git") ? common.slice(0, -5) : root;
}

export function currentBranch(root: string): string | null {
  try {
    return git(root, "symbolic-ref", "--short", "HEAD");
  } catch {
    return null;
  }
}

export const branchFor = (person: string, task: string) => `agent/${person}/${task}`;

export function taskFromBranch(branch: string | null, person: string): string | null {
  const m = branch ? /^agent\/([^/]+)\/(.+)$/.exec(branch) : null;
  return m && m[1] === person ? m[2] : null;
}

export function resolveToken(): string {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return env;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error("No GitHub token: set GITHUB_TOKEN or run `gh auth login`");
  }
}

export class Context {
  private _channel?: Channel;

  constructor(
    readonly root: string,
    readonly config: RepoConfig,
    readonly roster: Roster,
    readonly participant: Participant | null,
  ) {}

  /** Returns null when cwd isn't inside a hive repo (no hive.json at the top level). */
  static load(cwd: string): Context | null {
    const root = findRepoRoot(cwd);
    if (!root || !existsSync(join(root, "hive.json"))) return null;
    const config = parseRepoConfig(readFileSync(join(root, "hive.json"), "utf8"));
    const rosterPath = join(root, "participants.json");
    const roster: Roster = existsSync(rosterPath) ? JSON.parse(readFileSync(rosterPath, "utf8")) : {};
    return new Context(root, config, roster, loadParticipant());
  }

  static require(cwd: string): Context {
    const ctx = Context.load(cwd);
    if (!ctx) throw new Error(`${cwd} is not inside a hive repo (no hive.json at the repository root)`);
    return ctx;
  }

  get me(): Participant {
    if (!this.participant)
      throw new Error(`No participant identity. Run \`hive init --person <you>\` or set HIVE_PERSON (config: ${participantConfigPath()})`);
    return this.participant;
  }

  /** "<person>/<agent>" — this participant's agent. */
  get self(): string {
    return `${this.me.person}/${this.me.agent}`;
  }

  get channel(): Channel {
    const { owner, name } = this.config.repo;
    this._channel ??= new Channel(new GitHub(resolveToken(), owner, name, this.config.discussionCategory), this.config, this.roster);
    return this._channel;
  }

  get stateDir(): string {
    const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    const dir = join(base, "hive", `${this.config.repo.owner}__${this.config.repo.name}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  tasks(): Task[] {
    const dir = join(this.root, "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parseTask(`tasks/${f}`, readFileSync(join(dir, f), "utf8")))
      .filter((t): t is Task => t !== null);
  }

  task(id: string): Task | undefined {
    return this.tasks().find((t) => t.id === id);
  }
}
