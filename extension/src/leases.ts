// Lease awareness in the editor: a gutter lock + overview-ruler band on files
// someone holds a lease on, a status bar hint for the active file, and a
// status bar count of all active leases. The PreToolUse hook is what actually
// blocks agents; this only makes the lease visible to the human.

import * as vscode from "vscode";
import type { ActiveLease } from "../../adapter/src/protocol/index.js";
import { fmtExpiry, type Hive } from "./hive.js";

type Kind = "mine" | "others";

export class LeaseDecorations implements vscode.Disposable {
  private gutter: Record<Kind, vscode.TextEditorDecorationType>;
  private ruler: Record<Kind, vscode.TextEditorDecorationType>;
  private fileItem = vscode.window.createStatusBarItem("hive.fileLease", vscode.StatusBarAlignment.Left, 100);
  private countItem = vscode.window.createStatusBarItem("hive.leaseCount", vscode.StatusBarAlignment.Left, 99);
  private subs: vscode.Disposable[] = [];

  constructor(
    private hive: Hive,
    context: vscode.ExtensionContext,
  ) {
    const make = (kind: Kind) => ({
      gutter: vscode.window.createTextEditorDecorationType({
        gutterIconPath: context.asAbsolutePath(`media/lease-${kind}.svg`),
        gutterIconSize: "contain",
      }),
      ruler: vscode.window.createTextEditorDecorationType({
        overviewRulerColor: new vscode.ThemeColor(kind === "mine" ? "hive.leaseMine" : "hive.leaseOthers"),
        overviewRulerLane: vscode.OverviewRulerLane.Full,
      }),
    });
    const mine = make("mine");
    const others = make("others");
    this.gutter = { mine: mine.gutter, others: others.gutter };
    this.ruler = { mine: mine.ruler, others: others.ruler };

    this.fileItem.name = "Hive: lease on this file";
    this.fileItem.command = "hive.leases.focus";
    this.countItem.name = "Hive: active leases";
    this.countItem.command = "hive.leases.focus";
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
    );
  }

  update(): void {
    for (const editor of vscode.window.visibleTextEditors) this.decorate(editor);
    this.updateFileItem(vscode.window.activeTextEditor);
    this.updateCountItem();
  }

  private decorate(editor: vscode.TextEditor): void {
    const leases = this.hive.leasesFor(editor.document.uri);
    const last = Math.max(0, editor.document.lineCount - 1);
    for (const kind of ["mine", "others"] as const) {
      const ls = leases.filter((l) => this.hive.isMine(l.holder) === (kind === "mine"));
      if (!ls.length) {
        editor.setDecorations(this.gutter[kind], []);
        editor.setDecorations(this.ruler[kind], []);
        continue;
      }
      // Hover lives on line 1 only; a whole-file hover would fire everywhere.
      editor.setDecorations(this.gutter[kind], [{ range: new vscode.Range(0, 0, 0, 0), hoverMessage: hover(ls) }]);
      editor.setDecorations(this.ruler[kind], [new vscode.Range(0, 0, last, 0)]);
    }
  }

  private updateFileItem(editor: vscode.TextEditor | undefined): void {
    const leases = editor ? this.hive.leasesFor(editor.document.uri) : [];
    if (!leases.length) return this.fileItem.hide();
    const others = leases.filter((l) => !this.hive.isMine(l.holder));
    const shown = others[0] ?? leases[0];
    this.fileItem.text = `$(lock) ${shown.holder}${leases.length > 1 ? ` +${leases.length - 1}` : ""}`;
    this.fileItem.tooltip = hover(leases);
    this.fileItem.backgroundColor = others.length ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.fileItem.show();
  }

  private updateCountItem(): void {
    const all = this.hive.leases.leases;
    const mine = all.filter((l) => this.hive.isMine(l.holder)).length;
    if (this.hive.error) {
      this.countItem.text = `$(warning) Hive`;
      this.countItem.tooltip = `Hive: ${this.hive.error}`;
    } else {
      this.countItem.text = `$(lock) ${all.length}`;
      this.countItem.tooltip = `Hive: ${all.length} active lease${all.length === 1 ? "" : "s"} (${mine} yours, ${all.length - mine} others')`;
    }
    this.countItem.show();
  }

  dispose(): void {
    for (const d of [...Object.values(this.gutter), ...Object.values(this.ruler), this.fileItem, this.countItem, ...this.subs]) d.dispose();
  }
}

function hover(leases: ActiveLease[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(
    leases.map((l) => `Leased by **${l.holder}** until ${fmtExpiry(l.expires)} (task/${l.task}) — \`${l.path}\``).join("\n\n"),
  );
  md.isTrusted = false;
  return md;
}
