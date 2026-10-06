import * as path from "path";
import * as vscode from "vscode";
import {
  IssueStatus,
  buildIssueLine,
  findCheckboxRange,
  findTitleRange,
  nextStatus,
  parseHeadingLine,
  parseIssueLine,
  parsePlan,
  statusToToken,
} from "./planModel";

type WebviewMessage =
  | { type: "ready" }
  | { type: "toggleStatus"; line: number; status?: IssueStatus }
  | { type: "updateIssue"; line: number; text: string }
  | { type: "deleteIssue"; line: number }
  | { type: "addIssue"; groupLine: number }
  | { type: "addIssueAfter"; line: number }
  | { type: "addGroup" }
  | { type: "renameGroup"; line: number; title: string }
  | { type: "deleteGroup"; line: number };

export class PlanEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "pln.planEditor";

  /** Serializes edits so queued messages never race on stale line numbers. */
  private queue: Promise<unknown> = Promise.resolve();

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new PlanEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      PlanEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "media")),
      ],
    };

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    let updateTimer: ReturnType<typeof setTimeout> | undefined;

    const updateWebview = () => {
      const fallback = path.basename(document.fileName, path.extname(document.fileName));
      const plan = parsePlan(document.getText(), fallback);
      webviewPanel.webview.postMessage({ type: "update", plan });
    };

    const scheduleUpdate = () => {
      if (updateTimer) {
        clearTimeout(updateTimer);
      }
      updateTimer = setTimeout(updateWebview, 80);
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        scheduleUpdate();
      }
    });

    webviewPanel.onDidDispose(() => {
      if (updateTimer) {
        clearTimeout(updateTimer);
      }
      changeSub.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === "ready") {
        updateWebview();
        return;
      }
      this.enqueue(() => this.handle(document, webviewPanel, message));
    });

    updateWebview();
  }

  private enqueue(run: () => Promise<void>): void {
    this.queue = this.queue.then(run, run).catch((err) => {
      console.error("pln: edit failed", err);
    });
  }

  private async handle(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    message: WebviewMessage
  ): Promise<void> {
    switch (message.type) {
      case "toggleStatus":
        await this.setStatus(document, message.line, message.status);
        break;
      case "updateIssue":
        await this.setIssueText(document, message.line, message.text);
        break;
      case "deleteIssue":
        await this.deleteLine(document, message.line);
        break;
      case "addIssue":
        await this.addIssue(document, panel, message.groupLine, "group");
        break;
      case "addIssueAfter":
        await this.addIssue(document, panel, message.line, "issue");
        break;
      case "addGroup":
        await this.addGroup(document, panel);
        break;
      case "renameGroup":
        await this.renameGroup(document, message.line, message.title);
        break;
      case "deleteGroup":
        await this.deleteGroup(document, message.line);
        break;
    }
  }

  private async applyEdit(
    build: (edit: vscode.WorkspaceEdit) => void
  ): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    build(edit);
    return vscode.workspace.applyEdit(edit);
  }

  private async setStatus(
    document: vscode.TextDocument,
    line: number,
    explicit?: IssueStatus
  ): Promise<void> {
    if (line < 0 || line >= document.lineCount) {
      return;
    }
    const range = findCheckboxRange(document.lineAt(line).text);
    if (!range) {
      return;
    }
    const status = explicit ?? nextStatus(range.status);
    await this.applyEdit((edit) =>
      edit.replace(
        document.uri,
        new vscode.Range(line, range.start, line, range.end),
        statusToToken(status)
      )
    );
  }

  private async setIssueText(
    document: vscode.TextDocument,
    line: number,
    text: string
  ): Promise<void> {
    if (line < 0 || line >= document.lineCount) {
      return;
    }
    const lineText = document.lineAt(line).text;
    const range = findTitleRange(lineText);
    if (!range) {
      return;
    }
    const value = (range.needsSpace ? " " : "") + text.trim();
    await this.applyEdit((edit) =>
      edit.replace(
        document.uri,
        new vscode.Range(line, range.start, line, range.end),
        value
      )
    );
  }

  private async deleteLine(
    document: vscode.TextDocument,
    line: number
  ): Promise<void> {
    if (line < 0 || line >= document.lineCount) {
      return;
    }
    await this.applyEdit((edit) =>
      edit.delete(document.uri, this.fullLineRange(document, line, line))
    );
  }

  /** Range covering lines [from, to] plus the line break that joins them on. */
  private fullLineRange(
    document: vscode.TextDocument,
    from: number,
    to: number
  ): vscode.Range {
    if (to < document.lineCount - 1) {
      return new vscode.Range(from, 0, to + 1, 0);
    }
    const start =
      from > 0
        ? document.lineAt(from - 1).range.end
        : new vscode.Position(from, 0);
    return new vscode.Range(start, document.lineAt(to).range.end);
  }

  private async addIssue(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    anchorLine: number,
    anchorKind: "group" | "issue"
  ): Promise<void> {
    const fallback = path.basename(document.fileName, path.extname(document.fileName));
    const plan = parsePlan(document.getText(), fallback);

    let insertAfter: number;
    let template = "- [ ]";

    if (anchorKind === "issue") {
      insertAfter = anchorLine;
      const parts = parseIssueLine(document.lineAt(anchorLine).text);
      if (parts) {
        template = buildIssueLine(parts.indent, parts.marker, "todo", "");
      }
    } else {
      const group = plan.groups.find((g) => g.line === anchorLine);
      if (!group) {
        return;
      }
      insertAfter = group.endLine;
      const last = group.issues[group.issues.length - 1];
      if (last) {
        const parts = parseIssueLine(document.lineAt(last.line).text);
        if (parts) {
          template = buildIssueLine(parts.indent, parts.marker, "todo", "");
        }
      }
    }

    const applied = await this.applyEdit((edit) =>
      edit.insert(
        document.uri,
        document.lineAt(insertAfter).range.end,
        `\n${template}`
      )
    );

    if (applied) {
      panel.webview.postMessage({ type: "focus", kind: "issue", line: insertAfter + 1 });
    }
  }

  private async addGroup(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const lastLine = document.lineCount - 1;
    const endsBlank = document.lineAt(lastLine).text.trim() === "";
    const prefix = endsBlank ? "\n" : "\n\n";
    const headingLine = lastLine + (endsBlank ? 1 : 2);

    const applied = await this.applyEdit((edit) =>
      edit.insert(
        document.uri,
        document.lineAt(lastLine).range.end,
        `${prefix}## New section`
      )
    );

    if (applied) {
      panel.webview.postMessage({ type: "focus", kind: "group", line: headingLine });
    }
  }

  private async renameGroup(
    document: vscode.TextDocument,
    line: number,
    title: string
  ): Promise<void> {
    if (line < 0 || line >= document.lineCount) {
      return;
    }
    const heading = parseHeadingLine(document.lineAt(line).text);
    const clean = title.trim();
    if (!heading || !clean) {
      return;
    }
    await this.applyEdit((edit) =>
      edit.replace(
        document.uri,
        document.lineAt(line).range,
        `${heading.hashes} ${clean}`
      )
    );
  }

  private async deleteGroup(
    document: vscode.TextDocument,
    line: number
  ): Promise<void> {
    const fallback = path.basename(document.fileName, path.extname(document.fileName));
    const plan = parsePlan(document.getText(), fallback);
    const index = plan.groups.findIndex((g) => g.line === line);
    if (index === -1) {
      return;
    }

    const group = plan.groups[index];
    if (group.issues.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `Delete "${group.title}" and its ${group.issues.length} ${
          group.issues.length === 1 ? "issue" : "issues"
        }?`,
        { modal: true },
        "Delete"
      );
      if (choice !== "Delete") {
        return;
      }
    }

    const next = plan.groups[index + 1];
    const lastLine = next ? next.line - 1 : document.lineCount - 1;
    await this.applyEdit((edit) =>
      edit.delete(document.uri, this.fullLineRange(document, line, lastLine))
    );
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "planEditor.js"))
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "planEditor.css"))
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Plan</title>
</head>
<body>
  <header class="topbar">
    <div class="breadcrumb">
      <span class="crumb-icon">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2.8A.8.8 0 0 1 2.8 2h2l1 1.4h3.4a.8.8 0 0 1 .8.8v5a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8z"
                fill="currentColor"/>
        </svg>
      </span>
      <span>Projects</span>
      <span class="crumb-sep">/</span>
      <span class="crumb-current" id="crumb-title">Plan</span>
    </div>
    <div class="topbar-right">
      <svg class="donut" viewBox="0 0 18 18" aria-hidden="true">
        <circle class="donut-track" cx="9" cy="9" r="7"/>
        <circle class="donut-fill" id="donut-fill" cx="9" cy="9" r="7"/>
      </svg>
      <span id="pct">0%</span>
    </div>
  </header>

  <section class="hero">
    <h1 id="title">Plan</h1>
    <div class="hero-meta" id="hero-meta"></div>
  </section>

  <div class="list-toolbar">
    <span id="toolbar-label">Sections</span>
    <button type="button" class="toolbar-btn" id="collapse-all">
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 3.5h8M2 6h8M2 8.5h8" fill="none" stroke="currentColor" stroke-width="1.4"
              stroke-linecap="round"/>
      </svg>
      <span id="collapse-all-label">Collapse all</span>
    </button>
  </div>

  <main class="groups" id="groups"></main>

  <div id="empty" class="empty hidden">
    <svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <path d="M7 9.5h10M7 13h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <h2>No issues yet</h2>
    <p>Add a section below, or type directly in the file using <code>## Group</code> and <code>- [ ] Task</code>.</p>
  </div>

  <div class="footer">
    <button type="button" class="add-section" id="add-section">
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 2.5v7M2.5 6h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      Add section
    </button>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
