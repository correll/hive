// Hive for VS Code: the *room* — roster, tasks, Discussion threads, leases and
// file-anchored refs. Not an agent UI; agents run in their own adapters and
// keep running when this editor is closed.

import * as vscode from "vscode";
import { RefComments } from "./comments.js";
import { Hive, type TaskView } from "./hive.js";
import { LeaseDecorations } from "./leases.js";
import { ThreadPanels } from "./thread.js";
import { HiveTree, type Section } from "./tree.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = await findRoot();
  if (!root) return;

  const hive = new Hive(root);
  const sections: Section[] = ["participants", "tasks", "leases"];
  const trees = sections.map((s) => {
    const provider = new HiveTree(s, hive);
    return { provider, view: vscode.window.createTreeView(`hive.${s}`, { treeDataProvider: provider }) };
  });
  const panels = new ThreadPanels(hive);
  const comments = new RefComments(hive);
  const decorations = new LeaseDecorations(hive, context);
  context.subscriptions.push(hive, panels, comments, decorations, ...trees.map((t) => t.view));

  hive.onDidChange(() => {
    for (const t of trees) {
      t.provider.refresh();
      t.view.message = hive.error ? `⚠ ${hive.error}` : undefined;
    }
    comments.update();
    decorations.update();
    panels.update();
  });

  // Tree items pass a task id; inline context-menu actions pass the tree node.
  const taskOf = (arg: string | { view: TaskView }) =>
    typeof arg === "string" ? hive.taskViews().find((t) => t.id === arg) : arg.view;

  context.subscriptions.push(
    vscode.commands.registerCommand("hive.refresh", () => hive.refresh(true)),
    vscode.commands.registerCommand("hive.openThread", (arg: string | { view: TaskView }) => {
      const t = taskOf(arg);
      if (t) panels.open(t.id);
    }),
    vscode.commands.registerCommand("hive.openTaskFile", async (arg: string | { view: TaskView }) => {
      const t = taskOf(arg);
      if (t?.task) await vscode.window.showTextDocument(hive.uri(t.task.file));
    }),
    vscode.commands.registerCommand("hive.openOnGitHub", async (arg: string | { view: TaskView }) => {
      const t = taskOf(arg);
      if (t?.discussion) await vscode.env.openExternal(vscode.Uri.parse(t.discussion.url));
    }),
    vscode.commands.registerCommand("hive.openLeasePath", async (p: string) => {
      const uri = hive.uri(p);
      // A directory lease ("sections/") reveals the folder instead of opening it.
      if (p.endsWith("/")) await vscode.commands.executeCommand("revealInExplorer", uri);
      else await vscode.window.showTextDocument(uri).then(undefined, () => vscode.window.showWarningMessage(`Hive: can't open ${p}`));
    }),
  );

  // Poll on an interval; restart the timer when the setting changes.
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearInterval(timer);
    const secs = Math.max(15, vscode.workspace.getConfiguration("hive").get<number>("pollSeconds", 60));
    timer = setInterval(() => void hive.refresh(), secs * 1000);
  };
  schedule();
  context.subscriptions.push(
    { dispose: () => timer && clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("hive.pollSeconds") && schedule()),
    vscode.authentication.onDidChangeSessions((e) => e.provider.id === "github" && void hive.refresh()),
  );

  // Task files and the roster are local: re-read them immediately, no network.
  // hive.json can change the repo or category, so it triggers a full refresh.
  const local = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "{tasks/*.md,participants.json}"));
  const config = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "hive.json"));
  let debounce: NodeJS.Timeout | undefined;
  const onLocal = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void hive.refreshLocal(), 300);
  };
  for (const ev of [local.onDidCreate, local.onDidChange, local.onDidDelete]) context.subscriptions.push(ev(onLocal));
  for (const ev of [config.onDidCreate, config.onDidChange]) context.subscriptions.push(ev(() => void hive.refresh()));
  context.subscriptions.push(local, config);

  void hive.refresh(true);
}

export function deactivate(): void {}

/** First workspace folder with a hive.json at its root. */
async function findRoot(): Promise<vscode.Uri | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, "hive.json"));
      return folder.uri;
    } catch {
      // not this one
    }
  }
  return undefined;
}
