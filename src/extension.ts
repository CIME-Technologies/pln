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
  /** Body beneath the checkbox until the next task; may contain newlines. */
  description: string;
  /** First description line, or `-1` if none. */
  descriptionLine: number;
  /** Last description line (inclusive), or `-1` if none. */
  descriptionEnd: number;
}

/** Parsed contents of a `.pln` document. */
export interface Plan {
  title: string;
  /** Line of the `#` heading, or `-1` if absent. */
  titleLine: number;
  description: string;
  /** First description line, or `-1` if absent. */
  descriptionLine: number;
  /** Last description line (inclusive), or `-1` if none. */
  descriptionEnd: number;
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

/** Strip leading whitespace up to `width` (`tab` counts as 2), matching {@link indentOf}. */
function stripIndent(raw: string, width: number): string {
  let n = 0;
  let i = 0;
  while (i < raw.length && n < width) {
    if (raw[i] === " ") {
      n += 1;
      i += 1;
    } else if (raw[i] === "\t") {
      n += 2;
      i += 1;
    } else {
      break;
    }
  }
  return raw.slice(i);
}

/**
 * Parse a `.pln` file into a {@link Plan}.
 * Indentation defines parent/child; `#` is the title; first prose before tasks is the plan description.
 * Non-checkbox lines after a task belong to that task’s description until the next checkbox task.
 * @param _fallbackTitle Unused; kept so call sites stay stable. Missing titles are `""`.
 */
export function parsePlan(text: string, _fallbackTitle = ""): Plan {
  const plan: Plan = {
    title: "",
    titleLine: -1,
    description: "",
    descriptionLine: -1,
    descriptionEnd: -1,
    tasks: [],
  };
  /** Open ancestors, shallowest first — parent is the nearest less-indented task. */
  const open: { indent: number; line: number }[] = [];
  /** Raw description lines for the most recent task (document order). */
  let pending: { taskIndex: number; lines: { line: number; raw: string }[] } | null = null;
  /** Prose lines before the first task (plan description). */
  const planDesc: { line: number; raw: string }[] = [];

  const trimSlice = (rows: { line: number; raw: string }[]) => {
    let start = 0;
    let end = rows.length;
    while (start < end && !rows[start].raw.trim()) {
      start += 1;
    }
    while (end > start && !rows[end - 1].raw.trim()) {
      end -= 1;
    }
    return rows.slice(start, end);
  };

  const flushDescription = () => {
    if (!pending) {
      return;
    }
    const task = plan.tasks[pending.taskIndex];
    const slice = trimSlice(pending.lines);
    if (slice.length) {
      const widths = slice.filter((r) => r.raw.trim()).map((r) => indentOf(r.raw));
      const base = widths.length ? Math.min(...widths) : 0;
      task.description = slice.map((r) => stripIndent(r.raw, base)).join("\n");
      task.descriptionLine = slice[0].line;
      task.descriptionEnd = slice[slice.length - 1].line;
    }
    pending = null;
  };

  const flushPlanDescription = () => {
    if (plan.descriptionLine >= 0) {
      return;
    }
    const slice = trimSlice(
      planDesc.filter((row) => {
        const t = row.raw.trim();
        return !t.startsWith("#");
      })
    );
    if (!slice.length) {
      return;
    }
    plan.description = slice.map((r) => r.raw.replace(/\s+$/g, "")).join("\n");
    plan.descriptionLine = slice[0].line;
    plan.descriptionEnd = slice[slice.length - 1].line;
  };

  text.split(/\r?\n/).forEach((raw, i) => {
    const task = TASK.exec(raw);
    if (task) {
      flushPlanDescription();
      flushDescription();
      const indent = indentOf(raw);
      while (open.length && open[open.length - 1].indent >= indent) {
        open.pop();
      }
      plan.tasks.push({
        line: i,
        title: task[2] ?? "",
        status: statusOf(task[1]),
        parent: open.length ? open[open.length - 1].line : null,
        description: "",
        descriptionLine: -1,
        descriptionEnd: -1,
      });
      open.push({ indent, line: i });
      pending = { taskIndex: plan.tasks.length - 1, lines: [] };
      return;
    }
    if (pending) {
      pending.lines.push({ line: i, raw });
      return;
    }
    const title = TITLE.exec(raw);
    if (title && plan.titleLine < 0) {
      plan.title = title[1].trim();
      plan.titleLine = i;
      return;
    }
    if (!plan.tasks.length) {
      planDesc.push({ line: i, raw });
    }
  });

  flushPlanDescription();
  flushDescription();
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

/**
 * Last document line owned by `line`’s task: its description and all nested
 * descendants (and their descriptions).
 */
export function blockEnd(plan: Plan, line: number): number {
  const task = plan.tasks.find((t) => t.line === line);
  if (!task) {
    return line;
  }
  let end = task.descriptionEnd >= 0 ? task.descriptionEnd : task.line;
  for (const child of descendants(plan, line)) {
    const childEnd = child.descriptionEnd >= 0 ? child.descriptionEnd : child.line;
    if (childEnd > end) {
      end = childEnd;
    }
  }
  return end;
}

/** Format a description body with `prefix` on non-empty lines. */
function formatDescription(text: string, prefix: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n+$/g, "").replace(/^\n+/g, "");
  if (!normalized) {
    return "";
  }
  return normalized
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : prefix + line))
    .join("\n");
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
        ...parsePlan(text, path.basename(doc.fileName, ".pln")),
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
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.t === "viewMode") {
        setRawContext(docKey, m.mode === "raw");
        return;
      }
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
        if (typeof m.text !== "string") {
          return false;
        }
        const text = m.text.replace(/\r\n/g, "\n").replace(/\n+$/g, "").replace(/^\n+/g, "");
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
