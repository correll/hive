// Three tree views in the Hive activity-bar container: Participants, Tasks,
// Leases. One provider class, parameterized by section, since all three
// render the same Hive state.

import * as vscode from "vscode";
import { isAgent, personOf, type ActiveLease } from "../../adapter/src/protocol/index.js";
import { fmtExpiry, type Hive, type TaskView } from "./hive.js";

export type Section = "participants" | "tasks" | "leases";

type Node =
  | { kind: "person"; person: string; github: string }
  | { kind: "agent"; id: string }
  | { kind: "task"; view: TaskView }
  | { kind: "lease"; lease: ActiveLease };

export class HiveTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private section: Section,
    private hive: Hive,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(node?: Node): Node[] {
    const h = this.hive;
    if (!node) {
      switch (this.section) {
        case "participants":
          return Object.entries(h.roster).map(([person, p]) => ({ kind: "person", person, github: p.github }));
        case "tasks":
          return h.taskViews().map((view) => ({ kind: "task", view }));
        case "leases":
          return [...h.leases.leases].sort((a, b) => a.expires.localeCompare(b.expires)).map((lease) => ({ kind: "lease", lease }));
      }
    }
    if (node.kind === "person") {
      // Agents are whoever has spoken for this person in the channel.
      const agents = new Set(h.allMessages().map((m) => m.from).filter((f) => isAgent(f) && personOf(f) === node.person));
      for (const l of h.leases.leases) if (isAgent(l.holder) && personOf(l.holder) === node.person) agents.add(l.holder);
      return [...agents].sort().map((id) => ({ kind: "agent", id }));
    }
    if (node.kind === "task") return node.view.leases.map((lease) => ({ kind: "lease", lease }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const h = this.hive;
    switch (node.kind) {
      case "person": {
        const held = h.leases.leases.filter((l) => personOf(l.holder) === node.person).length;
        const hasAgents = this.getChildren(node).length > 0;
        const item = new vscode.TreeItem(node.person, hasAgents ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.description = [`@${node.github}`, node.person === h.me ? "you" : "", held ? `${held} lease${held > 1 ? "s" : ""}` : ""]
          .filter(Boolean)
          .join(" · ");
        item.iconPath = new vscode.ThemeIcon(node.person === h.me ? "account" : "person");
        return item;
      }
      case "agent": {
        const held = h.leases.leases.filter((l) => l.holder === node.id);
        const item = new vscode.TreeItem(node.id);
        item.description = held.length ? held.map((l) => l.path).join(", ") : undefined;
        item.iconPath = new vscode.ThemeIcon("hubot");
        return item;
      }
      case "task": {
        const v = node.view;
        const item = new vscode.TreeItem(`task/${v.id}: ${v.title}`, v.leases.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        const holders = [...new Set(v.leases.map((l) => l.holder))];
        const until = v.leases.length ? fmtExpiry(v.leases.reduce((a, b) => (a.expires > b.expires ? a : b)).expires) : "";
        item.description = [v.task?.status, holders.length ? `held by ${holders.join(", ")} until ${until}` : "", v.discussion ? "" : "no thread"]
          .filter(Boolean)
          .join(" · ");
        item.tooltip = new vscode.MarkdownString(
          [`**task/${v.id}**: ${v.title}`, v.task ? `\`${v.task.file}\` — paths: ${v.task.paths.join(", ") || "none"}` : "", v.task?.body ?? ""]
            .filter(Boolean)
            .join("\n\n"),
        );
        item.iconPath = new vscode.ThemeIcon(
          v.leases.length ? "lock" : v.task?.status === "done" ? "pass" : v.discussion ? "comment-discussion" : "circle-outline",
        );
        item.contextValue = ["task", v.task ? "file" : "", v.discussion ? "discussion" : ""].filter(Boolean).join(" ");
        item.command = { command: "hive.openThread", title: "Open Thread", arguments: [v.id] };
        return item;
      }
      case "lease": {
        const l = node.lease;
        const mine = h.isMine(l.holder);
        const item = new vscode.TreeItem(this.section === "tasks" ? l.holder : l.path);
        item.description = this.section === "tasks" ? `${l.path} · until ${fmtExpiry(l.expires)}` : `${l.holder} · until ${fmtExpiry(l.expires)} · task/${l.task}`;
        item.tooltip = `Leased by ${l.holder} until ${new Date(l.expires).toLocaleString()} (task/${l.task})${mine ? " — yours" : ""}`;
        item.iconPath = new vscode.ThemeIcon("lock", new vscode.ThemeColor(mine ? "hive.leaseMine" : "hive.leaseOthers"));
        item.contextValue = "lease";
        item.command = { command: "hive.openLeasePath", title: "Open Leased Path", arguments: [l.path] };
        return item;
      }
    }
  }
}
