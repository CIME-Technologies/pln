import { randomUUID } from "crypto";
import * as path from "path";
import * as vscode from "vscode";

/** Task checkbox state written as `[ ]`, `[-]`, or `[x]`. */
export type Status = "todo" | "in_progress" | "done";

/** One checkbox line in a `.pln` file. */
export interface Task {
  /** 0-based line in the document. */
  line: number;
  title: string;
  status: Status;
  /** Parent task's line, or `null` for a top-level task. */
  parent: number | null;
}

/** Parsed contents of a `.pln` document. */
export interface Plan {
  title: string;
  /** Line of the `#` heading, or `-1` if absent. */
  titleLine: number;
  description: string;
  /** Line of the description prose, or `-1` if absent. */
  descriptionLine: number;
  /** Document order; each subtask follows its parent. */
  tasks: Task[];
}

const TASK = /^[ \t]*[-*+][ \t]+\[([ xX-])\](?:[ \t]+(.*))?$/;
const TITLE = /^#[ \t]+(.+)$/;
/** Canonical indent written for each nesting level. */
const INDENT = "  ";

const TOKEN: Record<Status, string> = { todo: " ", in_progress: "-", done: "x" };

/** @param token Character inside `[…]`. */
const statusOf = (token: string): Status =>
  token === "-" ? "in_progress" : token === " " ? "todo" : "done";

/** Leading whitespace width (`tab` counts as 2). */
function indentOf(raw: string): number {
  let n = 0;
  for (const ch of raw) {
    if (ch === " ") {
      n += 1;
    } else if (ch === "\t") {
      n += 2;
    } else {
      break;
    }
  }
  return n;
}

/**
 * Parse a `.pln` file into a {@link Plan}.
 * Indentation defines parent/child; `#` is the title; first prose before tasks is the description.
 * @param _fallbackTitle Unused; kept so call sites stay stable. Missing titles are `""`.
 */
export function parsePlan(text: string, _fallbackTitle = ""): Plan {
  const plan: Plan = {
    title: "",
    titleLine: -1,
    description: "",
    descriptionLine: -1,
    tasks: [],
  };
  /** Open ancestors, shallowest first — parent is the nearest less-indented task. */
  const open: { indent: number; line: number }[] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const task = TASK.exec(raw);
    if (task) {
      const indent = indentOf(raw);
      while (open.length && open[open.length - 1].indent >= indent) {
        open.pop();
      }
      plan.tasks.push({
        line: i,
        title: task[2] ?? "",
        status: statusOf(task[1]),
        parent: open.length ? open[open.length - 1].line : null,
      });
      open.push({ indent, line: i });
      return;
    }
    const title = TITLE.exec(raw);
    if (title && plan.titleLine < 0) {
      plan.title = title[1].trim();
      plan.titleLine = i;
      return;
    }
    const prose = raw.trim();
    if (
      prose &&
      !prose.startsWith("#") &&
      plan.descriptionLine < 0 &&
      !plan.tasks.length
    ) {
      plan.description = prose;
      plan.descriptionLine = i;
    }
  });

  return plan;
}

/** Descendants of `line` in document order (not including the task itself). */
function descendants(plan: Plan, line: number): Task[] {
  const inside = new Set([line]);
  return plan.tasks.filter((task) => {
    if (task.parent !== null && inside.has(task.parent)) {
      inside.add(task.line);
      return true;
    }
    return false;
  });
}

/** Nesting depth of each task, keyed by line. */
function depths(plan: Plan): Map<number, number> {
  const depth = new Map<number, number>();
  for (const task of plan.tasks) {
    depth.set(task.line, task.parent === null ? 0 : (depth.get(task.parent) ?? 0) + 1);
  }
  return depth;
}

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

/** Custom text editor that syncs a `.pln` {@link Plan} with the webview UI. */
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
    // Rejected edits produce no change event — push the current plan anyway.
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.t === "ready" || !(await this.edit(doc, m))) {
        send();
      }
    });
  }

  /**
   * Apply a webview message as a {@link vscode.WorkspaceEdit}.
   * Undo/redo run VS Code's native commands so the text-document stack is used.
   * @returns `false` if the message was rejected (webview should resync).
   */
  private async edit(doc: vscode.TextDocument, m: any): Promise<boolean> {
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
    const plan = parsePlan(doc.getText(), "");

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
        const text = m.text.trim();
        if (plan.descriptionLine >= 0) {
          const line = at(plan.descriptionLine);
          if (text) {
            edit.replace(doc.uri, line.range, text);
          } else {
            edit.delete(doc.uri, lineSpan(doc, line.lineNumber, line.lineNumber));
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
        const below = descendants(plan, m.parent);
        const after = below.length ? below[below.length - 1].line : m.parent;
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
      default:
        return false;
    }

    return vscode.workspace.applyEdit(edit);
  }

  /**
   * Delete a task and its descendants.
   * Confirms first when the task has subtasks.
   */
  private async deleteTask(doc: vscode.TextDocument, line: number): Promise<boolean> {
    const plan = parsePlan(doc.getText(), "");
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
    const end = below.length ? below[below.length - 1].line : line;
    edit.delete(doc.uri, lineSpan(doc, line, end));
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
    <p class="hero-desc" id="description"></p>
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

  <script nonce="${nonce}" src="${uri("planEditor.js")}"></script>
</body>
</html>`;
}

/** Register the Plan custom editor. */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "pln.planEditor",
      new PlanEditor(context.extensionUri)
    )
  );
}
