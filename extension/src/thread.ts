// Webview showing one task's Discussion thread, plus a composer that lets the
// signed-in human post as bare `<person>`. The page shell (and the draft in
// the composer) is rendered once; thread updates arrive by postMessage so a
// background poll never wipes what the human is typing.

import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { MESSAGE_TYPES, type Message, type MessageType } from "../../adapter/src/protocol/index.js";
import { fmtExpiry, parseFileRef, type Hive } from "./hive.js";

// A human can't post a claim here: a claim needs a lease, and humans editing
// files are outside the agents' lease protocol for now.
const HUMAN_TYPES = MESSAGE_TYPES.filter((t) => t !== "claim");

export class ThreadPanels implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(private hive: Hive) {}

  open(taskId: string): void {
    const existing = this.panels.get(taskId);
    if (existing) return existing.reveal();
    const panel = vscode.window.createWebviewPanel("hive.thread", `task/${taskId}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [],
    });
    this.panels.set(taskId, panel);
    panel.onDidDispose(() => this.panels.delete(taskId));
    panel.webview.html = shell(panel.webview, taskId);
    panel.webview.onDidReceiveMessage(async (m: { type: string; [k: string]: unknown }) => {
      if (m.type === "ready") this.render(taskId);
      else if (m.type === "openRef") await this.openRef(String(m.ref));
      else if (m.type === "post") {
        try {
          const refs = String(m.refs ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          await this.hive.post(taskId, m.msgType as MessageType, String(m.body), refs);
          void panel.webview.postMessage({ type: "posted" });
        } catch (e) {
          void panel.webview.postMessage({ type: "error", error: (e as Error).message });
        }
      }
    });
  }

  /** Re-render every open thread from the Hive cache. */
  update(): void {
    for (const id of this.panels.keys()) this.render(id);
  }

  dispose(): void {
    for (const p of this.panels.values()) p.dispose();
  }

  private render(taskId: string): void {
    const panel = this.panels.get(taskId);
    if (!panel) return;
    const view = this.hive.taskViews().find((t) => t.id === taskId);
    const messages = this.hive.thread(taskId);
    panel.title = `task/${taskId}`;
    const head = [
      `<h1>task/${esc(taskId)}: ${esc(view?.title ?? "")}</h1>`,
      `<p class="meta">`,
      view?.task ? `<span>${esc(view.task.status)}</span> · <a href="#" data-ref="${esc(view.task.file)}">${esc(view.task.file)}</a>` : "",
      view?.discussion ? ` · <a href="${esc(view.discussion.url)}">Discussion #${view.discussion.number} ↗</a>` : " · no Discussion yet — posting creates it",
      `</p>`,
      ...(view?.leases ?? []).map(
        (l) => `<p class="lease ${this.hive.isMine(l.holder) ? "mine" : ""}">🔒 ${esc(l.path)} — ${esc(l.holder)} until ${esc(fmtExpiry(l.expires))}</p>`,
      ),
      this.hive.error ? `<p class="warn">${esc(this.hive.error)}</p>` : "",
    ].join("");
    const body = messages?.length ? messages.map(renderMessage).join("") : `<p class="empty">No messages yet.</p>`;
    void panel.webview.postMessage({ type: "render", head, body, me: this.hive.me ?? "" });
  }

  private async openRef(ref: string): Promise<void> {
    const task = /^task\/(.+)$/.exec(ref);
    if (task) return this.open(task[1]);
    const pr = /^PR#(\d+)$/i.exec(ref);
    if (pr && this.hive.config) {
      const { owner, name } = this.hive.config.repo;
      await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${owner}/${name}/pull/${pr[1]}`));
      return;
    }
    const file = parseFileRef(ref);
    const uri = this.hive.uri(file?.path ?? ref);
    const selection = file ? new vscode.Range(file.start - 1, 0, file.end - 1, 0) : undefined;
    try {
      await vscode.window.showTextDocument(uri, { selection, viewColumn: vscode.ViewColumn.One });
    } catch {
      void vscode.window.showWarningMessage(`Hive: can't open ${ref}`);
    }
  }
}

function renderMessage(m: Message): string {
  const type = m.envelope?.type ?? "comment";
  const refs = (m.envelope?.refs ?? [])
    .map((r) => `<a href="#" class="ref" data-ref="${esc(r)}">${esc(r)}</a>`)
    .join(" ");
  const extras = [
    m.envelope?.to?.length ? `to ${m.envelope.to.map(esc).join(", ")}` : "",
    m.envelope?.lease ? `lease ${m.envelope.lease.paths.map(esc).join(", ")} until ${esc(fmtExpiry(m.envelope.lease.expires))}` : "",
    m.envelope?.confidence !== undefined ? `confidence ${m.envelope.confidence}` : "",
  ].filter(Boolean);
  return `<article class="msg${m.verified ? "" : " unverified"}">
    <header>
      <span class="from">${esc(m.from)}</span>
      <span class="badge t-${esc(type)}">${esc(type)}</span>
      ${m.verified ? `<span class="ok" title="Sender matches the GitHub account (${esc(m.author ?? "")})">✓ verified</span>` : `<span class="bad" title="Posted by ${esc(m.author ?? "ghost")}, which doesn't map to ${esc(m.from)}">⚠ unverified</span>`}
      <time title="${esc(m.createdAt)}">${esc(new Date(m.createdAt).toLocaleString())}</time>
      <a class="gh" href="${esc(m.url)}" title="Open comment on GitHub">GitHub ↗</a>
    </header>
    <div class="body">${markdown(m.body)}</div>
    ${extras.length ? `<p class="extras">${extras.join(" · ")}</p>` : ""}
    ${refs ? `<p class="refs">${refs}</p>` : ""}
    ${m.invalid ? `<p class="warn">invalid envelope: ${esc(m.invalid)}</p>` : ""}
  </article>`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Tiny markdown subset: fenced code, inline code, **bold**, *italic*,
 * [text](https://…) links, paragraphs. Everything is HTML-escaped first, so
 * the only tags in the output are the ones this function emits.
 */
export function markdown(src: string): string {
  return src
    .split(/```[^\n]*\n([\s\S]*?)```/g)
    .map((part, i) => (i % 2 ? `<pre><code>${esc(part)}</code></pre>` : paragraphs(part)))
    .join("");
}

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${inline(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/^#{1,6} (.*)$/gm, "<strong>$1</strong>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, '<a href="$2">$1</a>');
    })
    .join("");
}

function shell(webview: vscode.Webview, taskId: string): string {
  const nonce = randomBytes(16).toString("base64");
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:;`;
  const options = HUMAN_TYPES.map((t) => `<option value="${t}"${t === "question" ? " selected" : ""}>${t}</option>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>task/${esc(taskId)}</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 16px 16px; }
  h1 { font-size: 1.3em; margin: 16px 0 4px; }
  a { color: var(--vscode-textLink-foreground); }
  .meta, time, .extras, .empty { color: var(--vscode-descriptionForeground); }
  .lease { margin: 2px 0; color: var(--vscode-editorError-foreground); }
  .lease.mine { color: var(--vscode-testing-iconPassed); }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .msg { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 12px; margin: 10px 0; }
  .msg.unverified { border-style: dashed; opacity: 0.85; }
  .msg header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .from { font-weight: 600; }
  .badge { font-size: 0.85em; padding: 0 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .t-claim { background: var(--vscode-editorError-foreground); color: var(--vscode-editor-background); }
  .t-decision { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
  .t-question, .t-review_request { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
  .ok { color: var(--vscode-testing-iconPassed); font-size: 0.9em; }
  .bad { color: var(--vscode-editorWarning-foreground); font-size: 0.9em; }
  .gh { margin-left: auto; }
  .ref { font-family: var(--vscode-editor-font-family); font-size: 0.9em; margin-right: 6px; }
  pre, code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); }
  pre { padding: 8px; overflow-x: auto; }
  form { position: sticky; bottom: 0; background: var(--vscode-editor-background); padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
  textarea, input, select { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 5em; resize: vertical; }
  .row { display: flex; gap: 8px; margin-top: 6px; align-items: center; }
  .row input { flex: 1; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 12px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<div id="head"></div>
<div id="messages"><p class="empty">Loading…</p></div>
<form id="compose">
  <textarea id="body" placeholder="Message to the channel (Markdown). @mention a participant to address their agent."></textarea>
  <div class="row">
    <select id="type">${options}</select>
    <input id="refs" placeholder="refs, comma-separated (e.g. sections/intro.tex:L10-20, PR#4)">
    <button id="send" type="submit">Post</button>
  </div>
  <p class="meta" id="status"></p>
</form>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = vscode.getState() || {};
  $("body").value = state.body || "";
  $("refs").value = state.refs || "";
  if (state.type) $("type").value = state.type;
  const save = () => vscode.setState({ body: $("body").value, refs: $("refs").value, type: $("type").value });
  for (const id of ["body", "refs", "type"]) $(id).addEventListener("input", save);

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "render") {
      $("head").innerHTML = m.head;
      $("messages").innerHTML = m.body;
      $("status").textContent = m.me ? "Posting as " + m.me : "Not signed in";
    } else if (m.type === "posted") {
      $("body").value = "";
      $("refs").value = "";
      save();
      $("send").disabled = false;
    } else if (m.type === "error") {
      $("status").textContent = "Post failed: " + m.error;
      $("send").disabled = false;
    }
  });
  $("compose").addEventListener("submit", (e) => {
    e.preventDefault();
    const body = $("body").value.trim();
    if (!body) return;
    $("send").disabled = true;
    $("status").textContent = "Posting…";
    vscode.postMessage({ type: "post", msgType: $("type").value, body, refs: $("refs").value });
  });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-ref]");
    if (!a) return;
    e.preventDefault();
    vscode.postMessage({ type: "openRef", ref: a.dataset.ref });
  });
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
