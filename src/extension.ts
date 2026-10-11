import { randomUUID } from "crypto";
import * as vscode from "vscode";
import {
  INDENT,
  TASK,
  TOKEN,
  blockEnd,
  depths,
  descendants,
  formatDescription,
  normalizeDescription,
  parsePlan,
  taskMarkdown,
  type Status,
} from "./plan";

export type { Plan, Status, Task } from "./plan";
export { blockEnd, parsePlan, taskMarkdown } from "./plan";

/** Webview → host. Unknown `t` / invalid edits → `edit` returns false → resync. */
type WebviewToHost =
  | { t: "ready" }
  | { t: "viewMode"; mode: "raw" | "preview" }
  | { t: "copyTask"; line: number }
  | { t: "undo" }
  | { t: "redo" }
  | { t: "deleteTask"; line: number }
  | { t: "title"; text: string }
  | { t: "description"; text: string }
  | { t: "addTask"; parent: number | null }
  | { t: "status"; line: number; status: Status }
  | { t: "text"; line: number; text: string }
  | { t: "taskDescription"; line: number; text: string }
  | { t: "source"; text: string };

/**
 * Document range covering lines `[from, to]`, including the attaching newline.
 * Deleting that range removes the block cleanly whether or not it ends the file.
 */
function lineSpan(doc: vscode.TextDocument, from: number, to: number): vscode.Range {
  if (to < doc.lineCount - 1) {
    return new vscode.Range(from, 0, to + 1, 0);
  }
  const start = from > 0 ? doc.lineAt(from - 1).range.end : new vscode.Position(0, 0);
  return new vscode.Range(start, doc.lineAt(to).range.end);
}

/** Active plan editor panels, keyed by document URI. */
const panels = new Map<string, vscode.WebviewPanel>();

/** Last known raw-mode flag per document (for title-bar toggled state). */
const rawModeByDoc = new Map<string, boolean>();

/** Last plan panel that reported active (title-bar clicks clear `panel.active`). */
let lastActivePanel: vscode.WebviewPanel | undefined;

function setRawContext(docKey: string, raw: boolean): void {
  rawModeByDoc.set(docKey, raw);
  void vscode.commands.executeCommand("setContext", "pln.rawMode", raw);
}

function panelDocKey(panel: vscode.WebviewPanel): string | undefined {
  for (const [key, p] of panels) {
    if (p === panel) {
      return key;
    }
  }
  return undefined;
}

/**
 * Resolve the plan webview to target for title-bar Enter/Exit Raw.
 * Title-bar clicks often clear `panel.active` before the command runs, so
 * prefer the active custom editor tab, then an active panel, then the
 * last-active / sole open panel.
 */
function activePlanPanel(): vscode.WebviewPanel | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === "pln.planEditor") {
    const panel = panels.get(input.uri.toString());
    if (panel) {
      lastActivePanel = panel;
      return panel;
    }
  }

  for (const panel of panels.values()) {
    if (panel.active) {
      lastActivePanel = panel;
      return panel;
    }
  }

  if (lastActivePanel) {
    for (const panel of panels.values()) {
      if (panel === lastActivePanel) {
        return panel;
      }
    }
  }

  if (panels.size === 1) {
    return panels.values().next().value;
  }
  return undefined;
}

function setPlanView(mode: "preview" | "raw"): void {
  const panel = activePlanPanel();
  if (!panel) {
    return;
  }
  const key = panelDocKey(panel);
  if (key) {
    setRawContext(key, mode === "raw");
  }
  void panel.webview.postMessage({ t: "setView", mode });
}

/** Custom text editor that syncs a `.pln` {@link Plan} with the webview UI. */
class PlanEditor implements vscode.CustomTextEditorProvider {
  constructor(private readonly root: vscode.Uri) {}

  resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const media = vscode.Uri.joinPath(this.root, "media");
    const docKey = doc.uri.toString();
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = page(panel.webview, media);
    panels.set(docKey, panel);
    lastActivePanel = panel;
    setRawContext(docKey, rawModeByDoc.get(docKey) ?? false);

    const send = () => {
      const text = doc.getText();
      panel.webview.postMessage({
        ...parsePlan(text),
        source: text,
      });
    };

    let timer: ReturnType<typeof setTimeout>;
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === doc) {
        clearTimeout(timer);
        timer = setTimeout(send, 80);
      }
    });

    const viewSub = panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        lastActivePanel = e.webviewPanel;
        setRawContext(docKey, rawModeByDoc.get(docKey) ?? false);
      }
    });

    panel.onDidDispose(() => {
      clearTimeout(timer);
      sub.dispose();
      viewSub.dispose();
      panels.delete(docKey);
      if (lastActivePanel === panel) {
        lastActivePanel = undefined;
      }
      if (![...panels.keys()].some((key) => rawModeByDoc.get(key))) {
        void vscode.commands.executeCommand("setContext", "pln.rawMode", false);
      }
    });
    // Rejected edits produce no change event — push the current plan anyway.
    panel.webview.onDidReceiveMessage(async (m: WebviewToHost) => {
      if (m.t === "viewMode") {
        setRawContext(docKey, m.mode === "raw");
        return;
      }
      if (m.t === "copyTask") {
        const md = taskMarkdown(doc.getText(), m.line);
        if (md !== null) {
          await vscode.env.clipboard.writeText(md);
        }
        return;
      }
      if (m.t === "ready" || !(await this.edit(doc, m))) {
        send();
      }
    });
  }

  /**
   * Apply a webview edit message. Unknown `t` → `false` (resync).
   * @returns `false` if rejected (webview should resync).
   */
  private async edit(doc: vscode.TextDocument, m: WebviewToHost): Promise<boolean> {
    if (m.t === "undo") {
      await vscode.commands.executeCommand("undo");
      return true;
    }
    if (m.t === "redo") {
      await vscode.commands.executeCommand("redo");
      return true;
    }
    if (m.t === "deleteTask") {
      return this.deleteTask(doc, m.line);
    }

    const edit = new vscode.WorkspaceEdit();
    const at = (n: number) => doc.lineAt(Math.max(0, Math.min(n, doc.lineCount - 1)));
    const plan = parsePlan(doc.getText());

    switch (m.t) {
      case "title": {
        const text = m.text.trim();
        if (!text) {
          if (plan.titleLine < 0) {
            return false;
          }
          edit.delete(doc.uri, lineSpan(doc, plan.titleLine, plan.titleLine));
          break;
        }
        const heading = `# ${text}`;
        if (plan.titleLine < 0) {
          edit.insert(doc.uri, new vscode.Position(0, 0), `${heading}\n\n`);
        } else {
          edit.replace(doc.uri, at(plan.titleLine).range, heading);
        }
        break;
      }
      case "description": {
        if (typeof m.text !== "string") {
          return false;
        }
        const text = normalizeDescription(m.text);
        const end =
          plan.descriptionEnd >= 0 ? plan.descriptionEnd : plan.descriptionLine;
        if (plan.descriptionLine >= 0 && end >= 0) {
          if (text) {
            const last = at(end);
            edit.replace(
              doc.uri,
              new vscode.Range(plan.descriptionLine, 0, end, last.text.length),
              text
            );
          } else {
            edit.delete(doc.uri, lineSpan(doc, plan.descriptionLine, end));
          }
        } else if (text && plan.titleLine >= 0) {
          edit.insert(doc.uri, at(plan.titleLine).range.end, `\n${text}`);
        } else if (text) {
          edit.insert(doc.uri, new vscode.Position(0, 0), `${text}\n`);
        } else {
          return false;
        }
        break;
      }
      case "addTask": {
        if (m.parent === null || m.parent === undefined) {
          const last = doc.lineAt(doc.lineCount - 1);
          edit.insert(doc.uri, last.range.end, `${last.text.trim() ? "\n" : ""}- [ ]`);
          break;
        }
        const parent = plan.tasks.find((t) => t.line === m.parent);
        if (!parent) {
          return false;
        }
        const after = blockEnd(plan, m.parent);
        const depth = (depths(plan).get(m.parent) ?? 0) + 1;
        edit.insert(doc.uri, at(after).range.end, `\n${INDENT.repeat(depth)}- [ ]`);
        break;
      }
      case "status": {
        const line = at(m.line);
        if (!TASK.test(line.text) || !(m.status in TOKEN)) {
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
        if (!TASK.test(line.text)) {
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
          gap + m.text
        );
        break;
      }
      case "taskDescription": {
        const task = plan.tasks.find((t) => t.line === m.line);
        if (!task || typeof m.text !== "string") {
          return false;
        }
        const lead = (at(task.line).text.match(/^[ \t]*/) || [""])[0] + INDENT;
        const body = formatDescription(m.text, lead);
        if (task.descriptionLine >= 0 && task.descriptionEnd >= 0) {
          if (!body) {
            edit.delete(doc.uri, lineSpan(doc, task.descriptionLine, task.descriptionEnd));
          } else {
            const last = at(task.descriptionEnd);
            edit.replace(
              doc.uri,
              new vscode.Range(task.descriptionLine, 0, task.descriptionEnd, last.text.length),
              body
            );
          }
        } else if (body) {
          edit.insert(doc.uri, at(task.line).range.end, `\n${body}`);
        } else {
          return false;
        }
        break;
      }
      case "source": {
        if (typeof m.text !== "string") {
          return false;
        }
        const end = doc.lineCount > 0 ? at(doc.lineCount - 1) : null;
        const range = end
          ? new vscode.Range(0, 0, end.lineNumber, end.text.length)
          : new vscode.Range(0, 0, 0, 0);
        if (doc.getText() === m.text) {
          return false;
        }
        edit.replace(doc.uri, range, m.text);
        break;
      }
      default:
        return false;
    }

    return vscode.workspace.applyEdit(edit);
  }

  /**
   * Delete a task, its description, and its descendants.
   * Confirms first when the task has subtasks.
   */
  private async deleteTask(doc: vscode.TextDocument, line: number): Promise<boolean> {
    const plan = parsePlan(doc.getText());
    const task = plan.tasks.find((i) => i.line === line);
    if (!task) {
      return false;
    }

    const below = descendants(plan, line);
    if (below.length) {
      const confirm = await vscode.window.showWarningMessage(
        `Delete "${task.title || "Untitled"}" and its ${below.length} ` +
          `${below.length === 1 ? "subtask" : "subtasks"}?`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") {
        return false;
      }
    }

    const edit = new vscode.WorkspaceEdit();
    edit.delete(doc.uri, lineSpan(doc, line, blockEnd(plan, line)));
    return vscode.workspace.applyEdit(edit);
  }
}

/** HTML shell for the plan webview (assets loaded from `media/`). */
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
  <nav id="crumb" class="crumb" aria-label="Breadcrumb"></nav>

  <div id="editor" class="editor">
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
      <div class="hero-desc" id="description"></div>
      <div class="hero-meta" id="meta"></div>
    </section>

    <ul class="rows" id="tasks"></ul>

    <div id="empty" class="empty hidden">
      <svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
        <path d="M7 9.5h10M7 13h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <h2>Nothing planned yet</h2>
      <p>Add a task below.</p>
    </div>

    <div class="footer">
      <button type="button" class="add-btn" id="add-task">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 2.5v7M2.5 6h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        Add task
      </button>
    </div>
  </div>

  <textarea id="raw" class="raw hidden" aria-label="Raw Markdown" spellcheck="false"></textarea>

  <script nonce="${nonce}" src="${uri("planEditor.js")}"></script>
</body>
</html>`;
}

/** Register the Plan custom editor and title-bar Enter/Exit Raw actions. */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "pln.planEditor",
      new PlanEditor(context.extensionUri)
    ),
    vscode.commands.registerCommand("pln.view.enterRaw", () => setPlanView("raw")),
    vscode.commands.registerCommand("pln.view.exitRaw", () => setPlanView("preview"))
  );
}
