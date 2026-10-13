// Comments API: messages that reference `path:L40-58` become read-only
// comment threads anchored at that range — the same mechanism
// vscode-pull-request-github uses for review comments. Replies go through
// the channel (thread webview), not here, so threads are never repliable.

import * as vscode from "vscode";
import type { Message } from "../../adapter/src/protocol/index.js";
import { parseFileRef, type Hive } from "./hive.js";

export class RefComments implements vscode.Disposable {
  private controller = vscode.comments.createCommentController("hive", "Hive");
  private threads: vscode.CommentThread[] = [];
  private signature = "";

  constructor(private hive: Hive) {}

  update(): void {
    // Group by file range so several messages about one range share a thread.
    const groups = new Map<string, { path: string; start: number; end: number; messages: Message[] }>();
    for (const m of this.hive.allMessages()) {
      for (const ref of m.envelope?.refs ?? []) {
        const r = parseFileRef(ref);
        if (!r) continue;
        const key = `${r.path}:${r.start}-${r.end}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { ...r, messages: [] }));
        if (!g.messages.includes(m)) g.messages.push(m);
      }
    }
    // Rebuilding resets expand/collapse state, so only do it when something changed.
    const sig = [...groups.entries()].map(([k, g]) => `${k}=${g.messages.map((m) => m.id).join(",")}`).sort().join("|");
    if (sig === this.signature) return;
    this.signature = sig;

    this.clear();
    for (const g of groups.values()) {
      const range = new vscode.Range(g.start - 1, 0, g.end - 1, 0);
      const comments: vscode.Comment[] = g.messages.map((m) => {
        const body = new vscode.MarkdownString(
          `${m.body}\n\n---\n*${m.envelope?.type ?? "comment"}* · task/${m.task} · ${new Date(m.createdAt).toLocaleString()} · [GitHub](${m.url})`,
        );
        // Untrusted channel content: no command links, no raw HTML.
        body.isTrusted = false;
        body.supportHtml = false;
        return {
          body,
          mode: vscode.CommentMode.Preview,
          author: { name: m.from },
          label: m.verified ? m.envelope?.type : "unverified",
          timestamp: new Date(m.createdAt),
        };
      });
      const thread = this.controller.createCommentThread(this.hive.uri(g.path), range, comments);
      thread.canReply = false;
      thread.label = [...new Set(g.messages.map((m) => `task/${m.task}`))].join(", ");
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      this.threads.push(thread);
    }
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }

  private clear(): void {
    for (const t of this.threads) t.dispose();
    this.threads = [];
  }
}
