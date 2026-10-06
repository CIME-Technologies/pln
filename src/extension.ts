import { randomUUID } from "crypto";
import * as path from "path";
import * as vscode from "vscode";

export type Status = "todo" | "in_progress" | "done";

export interface Issue {
  line: number;
  text: string;
  status: Status;
}

export interface Section {
  title: string;
  line: number;
  issues: Issue[];
}

export interface Plan {
  title: string;
  sections: Section[];
}

const ISSUE = /^[ \t]*[-*+][ \t]+\[([ xX-])\](?:[ \t]+(.*))?$/;
const SECTION = /^##[ \t]+(.+)$/;

const TOKEN: Record<Status, string> = { todo: " ", in_progress: "-", done: "x" };
const statusOf = (token: string): Status =>
  token === "-" ? "in_progress" : token === " " ? "todo" : "done";

export function parsePlan(text: string, fallbackTitle: string): Plan {
  const heading = /^#[ \t]+(.+)$/m.exec(text);
  const sections: Section[] = [];

  text.split(/\r?\n/).forEach((line, i) => {
    const section = SECTION.exec(line);
    if (section) {
      sections.push({ title: section[1].trim(), line: i, issues: [] });
      return;
    }
    const issue = ISSUE.exec(line);
    if (issue) {
      if (sections.length === 0) {
        sections.push({ title: "Issues", line: i, issues: [] });
      }
      sections[sections.length - 1].issues.push({
        line: i,
        text: issue[2] ?? "",
        status: statusOf(issue[1]),
      });
    }
  });

  return { title: heading ? heading[1].trim() : fallbackTitle, sections };
}

/** Range covering lines [from, to] including the newline that attaches them. */
function lineSpan(doc: vscode.TextDocument, from: number, to: number): vscode.Range {
  if (to < doc.lineCount - 1) {
    return new vscode.Range(from, 0, to + 1, 0);
  }
  const start = from > 0 ? doc.lineAt(from - 1).range.end : new vscode.Position(0, 0);
  return new vscode.Range(start, doc.lineAt(to).range.end);
}

class PlanEditor implements vscode.CustomTextEditorProvider {
  constructor(private readonly root: vscode.Uri) {}

  resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const media = vscode.Uri.joinPath(this.root, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = page(panel.webview, media);

    const send = () =>
      panel.webview.postMessage(
        parsePlan(doc.getText(), path.basename(doc.fileName, ".pln"))
      );

    let timer: ReturnType<typeof setTimeout>;
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === doc) {
        clearTimeout(timer);
        timer = setTimeout(send, 80);
      }
    });

    panel.onDidDispose(() => {
      clearTimeout(timer);
      sub.dispose();
    });
    // A rejected edit produces no change event, so resync the webview itself.
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.t === "ready" || !(await this.edit(doc, m))) {
        send();
      }
    });
  }

  private async edit(doc: vscode.TextDocument, m: any): Promise<boolean> {
    if (m.t === "deleteSection") {
      return this.deleteSection(doc, m.line);
    }

    const edit = new vscode.WorkspaceEdit();
    const at = (n: number) => doc.lineAt(Math.max(0, Math.min(n, doc.lineCount - 1)));

    switch (m.t) {
      case "status": {
        const line = at(m.line);
        if (!ISSUE.test(line.text) || !(m.status in TOKEN)) {
          return false;
        }
        const box = line.text.indexOf("[") + 1;
        edit.replace(
          doc.uri,
          new vscode.Range(line.lineNumber, box, line.lineNumber, box + 1),
          TOKEN[m.status as Status]
        );
        break;
      }
      case "text": {
        const line = at(m.line);
        if (!ISSUE.test(line.text)) {
          return false;
        }
        const afterBox = line.text.indexOf("]") + 1;
        let start = afterBox;
        while (/[ \t]/.test(line.text[start] ?? "")) {
          start += 1;
        }
        const gap = start === afterBox ? " " : "";
        edit.replace(
          doc.uri,
          new vscode.Range(line.lineNumber, start, line.lineNumber, line.text.length),
          gap + m.text + (m.addAfter ? "\n- [ ]" : "")
        );
        break;
      }
      case "addIssue":
        edit.insert(doc.uri, at(m.after).range.end, "\n- [ ]");
        break;
      case "deleteIssue": {
        const line = at(m.line);
        if (!ISSUE.test(line.text)) {
          return false;
        }
        edit.delete(doc.uri, lineSpan(doc, line.lineNumber, line.lineNumber));
        break;
      }
      case "addSection": {
        const last = doc.lineAt(doc.lineCount - 1);
        edit.insert(
          doc.uri,
          last.range.end,
          `${last.text.trim() ? "\n\n" : "\n"}## New section`
        );
        break;
      }
      case "renameSection": {
        const line = at(m.line);
        if (!SECTION.test(line.text) || !m.title.trim()) {
          return false;
        }
        edit.replace(doc.uri, line.range, `## ${m.title.trim()}`);
        break;
      }
      default:
        return false;
    }

    return vscode.workspace.applyEdit(edit);
  }

  private async deleteSection(doc: vscode.TextDocument, line: number): Promise<boolean> {
    const head = doc.lineAt(Math.max(0, Math.min(line, doc.lineCount - 1)));
    const title = SECTION.exec(head.text);
    if (!title) {
      return false;
    }

    let end = head.lineNumber + 1;
    let issues = 0;
    while (end < doc.lineCount && !SECTION.test(doc.lineAt(end).text)) {
      if (ISSUE.test(doc.lineAt(end).text)) {
        issues += 1;
      }
      end += 1;
    }

    if (issues > 0) {
      const confirm = await vscode.window.showWarningMessage(
        `Delete "${title[1]}" and its ${issues} ${issues === 1 ? "issue" : "issues"}?`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") {
        return false;
      }
    }

    const edit = new vscode.WorkspaceEdit();
    edit.delete(doc.uri, lineSpan(doc, head.lineNumber, end - 1));
    return vscode.workspace.applyEdit(edit);
  }
}

function page(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomUUID();
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${uri("planEditor.css")}" rel="stylesheet" />
  <title>Plan</title>
</head>
<body>
  <section class="hero">
    <div class="hero-top">
      <h1 id="title">Plan</h1>
      <div class="progress">
        <svg class="donut" viewBox="0 0 18 18" aria-hidden="true">
          <circle class="donut-track" cx="9" cy="9" r="7"/>
          <circle class="donut-fill" id="donut" cx="9" cy="9" r="7"/>
        </svg>
        <span id="pct">0%</span>
      </div>
    </div>
    <div class="hero-meta" id="meta"></div>
  </section>

  <main class="groups" id="sections"></main>

  <div id="empty" class="empty hidden">
    <svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <path d="M7 9.5h10M7 13h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <h2>No issues yet</h2>
    <p>Add a section below, or type directly in the file using <code>## Section</code> and <code>- [ ] Task</code>.</p>
  </div>

  <div class="footer">
    <button type="button" class="add-section" id="add-section">
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 2.5v7M2.5 6h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      Add section
    </button>
  </div>

  <script nonce="${nonce}" src="${uri("planEditor.js")}"></script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "pln.planEditor",
      new PlanEditor(context.extensionUri)
    )
  );
}
