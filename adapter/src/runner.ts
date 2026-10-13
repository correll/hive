// Deployment mode 1: poll-and-resume. One `claude -p` invocation per inbound
// batch, resuming the task's session. Needs nothing but the CLI.
//
// The agent's final message reaches the channel through the plugin's Stop
// hook (HIVE_TASK tells the hook which task). If the hook didn't fire —
// plugin not installed — we post the `result` ourselves so the turn isn't
// silently lost.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { branchFor, git, mainCheckout, type Context } from "./context.js";
import { spawnPosted } from "./state.js";

export interface RunResult {
  sessionId: string | null;
  usd: number;
  result: string;
  isError: boolean;
  hookPosted: boolean;
}

/** A worktree on agent/<person>/<task>, so agents never share a branch. */
export function ensureWorktree(ctx: Context, task: string): string {
  const main = mainCheckout(ctx.root);
  const root = ctx.me.worktreeRoot ?? join(dirname(main), `${basename(main)}-worktrees`);
  const path = join(root, task);
  if (existsSync(path)) return path;

  const branch = branchFor(ctx.me.person, task);
  let base = "HEAD";
  try {
    git(main, "fetch", "--quiet", "origin", "main");
    base = "origin/main";
  } catch {
    // Offline or no remote yet: branch from the local checkout.
  }
  const exists = (() => {
    try {
      git(main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      return true;
    } catch {
      return false;
    }
  })();
  if (exists) git(main, "worktree", "add", path, branch);
  else git(main, "worktree", "add", "-b", branch, path, base);
  return path;
}

export function runClaude(ctx: Context, task: string, cwd: string, prompt: string, sessionId?: string): Promise<RunResult> {
  const nonce = randomUUID();
  const args = ["-p", prompt, "--output-format", "json", ...(sessionId ? ["--resume", sessionId] : []), ...ctx.me.claudeArgs];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      env: { ...process.env, HIVE_TASK: task, HIVE_SPAWN_NONCE: nonce },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(out);
      } catch {
        return reject(new Error(`claude exited ${code} without JSON output: ${err.trim() || out.trim()}`));
      }
      resolve({
        sessionId: typeof json.session_id === "string" ? json.session_id : null,
        usd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : 0,
        result: typeof json.result === "string" ? json.result : "",
        isError: code !== 0 || json.is_error === true,
        hookPosted: spawnPosted(ctx, nonce),
      });
    });
  });
}
