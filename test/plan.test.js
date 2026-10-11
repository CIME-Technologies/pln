// Exercises the extension through activate() against an in-memory document.
const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

/* ---------- vscode stub ---------- */

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(a, b, c, d) {
    this.start = a instanceof Position ? a : new Position(a, b);
    this.end = a instanceof Position ? b : new Position(c, d);
  }
}

class WorkspaceEdit {
  constructor() {
    this.ops = [];
  }
  replace(_uri, range, text) {
    this.ops.push({ range, text });
  }
  insert(_uri, position, text) {
    this.ops.push({ range: new Range(position, position), text });
  }
  delete(_uri, range) {
    this.ops.push({ range, text: "" });
  }
}

class TabInputCustom {
  constructor(uri, viewType) {
    this.uri = uri;
    this.viewType = viewType;
  }
}

class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}

/** Calls to `vscode.openWith` from title-bar commands. */
let openWithCalls = [];

class Doc {
  constructor(text, name = "plan") {
    this.text = text;
    this.fileName = `/tmp/${name}.pln`;
    this.uri = {
      path: `/tmp/${name}.pln`,
      toString: () => `file:///tmp/${name}.pln`,
    };
  }
  /** Document EOL; mirrors VS Code applying edits with the file's line endings. */
  get eol() {
    return this.text.includes("\r\n") ? "\r\n" : "\n";
  }
  get lines() {
    return this.text.split(/\r?\n/);
  }
  get lineCount() {
    return this.lines.length;
  }
  lineAt(i) {
    const text = this.lines[i];
    assert.notStrictEqual(text, undefined, `lineAt(${i}) out of range`);
    return { text, lineNumber: i, range: new Range(i, 0, i, text.length) };
  }
  getText() {
    return this.text;
  }
  apply(edit) {
    const eol = this.eol;
    const offset = (p) => {
      const lines = this.lines;
      assert.ok(p.line < lines.length && p.character <= lines[p.line].length, "bad position");
      return lines.slice(0, p.line).reduce((n, l) => n + l.length + eol.length, 0) + p.character;
    };
    const normalize = (text) => text.replace(/\r\n/g, "\n").replace(/\n/g, eol);
    for (const op of [...edit.ops].sort((a, b) => offset(b.range.start) - offset(a.range.start))) {
      this.text =
        this.text.slice(0, offset(op.range.start)) +
        normalize(op.text) +
        this.text.slice(offset(op.range.end));
    }
  }
}

let warning = { reply: "Delete", calls: [] };
let provider;
let docListener;
let activeTab;
const registeredCommands = {};
/** Snapshots of document text before each applyEdit (native undo stand-in). */
let undoStack = [];
let redoStack = [];

const vscode = {
  Position,
  Range,
  WorkspaceEdit,
  TabInputCustom,
  TabInputText,
  Uri: {
    file: (p) => ({ p, path: p, toString: () => `file://${p}` }),
    joinPath: (u, ...s) => ({ p: [u.p, ...s].join("/"), path: [u.p, ...s].join("/") }),
    parse: (s) => ({ p: s, path: s, toString: () => s }),
  },
  workspace: {
    applyEdit: async (edit) => {
      undoStack.push(activeDoc.text);
      redoStack = [];
      activeDoc.apply(edit);
      docListener?.({ document: activeDoc });
      return true;
    },
    onDidChangeTextDocument: (fn) => {
      docListener = fn;
      return { dispose() {} };
    },
  },
  commands: {
    registerCommand: (id, fn) => {
      registeredCommands[id] = fn;
      return { dispose() {} };
    },
    executeCommand: async (cmd, ...args) => {
      if (cmd === "setContext") {
        return;
      }
      if (cmd === "vscode.openWith") {
        openWithCalls.push(args);
        return;
      }
      if (cmd === "undo") {
        if (!undoStack.length) {
          return;
        }
        redoStack.push(activeDoc.text);
        activeDoc.text = undoStack.pop();
        docListener?.({ document: activeDoc });
        return;
      }
      if (cmd === "redo") {
        if (!redoStack.length) {
          return;
        }
        undoStack.push(activeDoc.text);
        activeDoc.text = redoStack.pop();
        docListener?.({ document: activeDoc });
      }
    },
  },
  window: {
    registerCustomEditorProvider: (_id, p) => {
      provider = p;
      return { dispose() {} };
    },
    showWarningMessage: async (message) => {
      warning.calls.push(message);
      return warning.reply;
    },
    tabGroups: {
      get activeTabGroup() {
        return { activeTab };
      },
    },
    get activeTextEditor() {
      return undefined;
    },
  },
  env: {
    clipboard: {
      text: "",
      writeText: async (text) => {
        vscode.env.clipboard.text = text;
      },
    },
  },
};

const load = Module._load;
Module._load = (request, ...rest) =>
  request === "vscode" ? vscode : load.call(Module, request, ...rest);

const {
  activate,
  parsePlan,
  blockEnd,
  taskMarkdown,
  taskInsertPrefix,
  statusToken,
  descriptionIndent,
  directChildProgress,
} = require("../out/extension.js");

/* ---------- harness ---------- */

let activeDoc;

activate({ extensionUri: { p: "/ext" }, subscriptions: [] });

/** Opens `text` in the editor and returns helpers to drive it. */
function open(text, name) {
  undoStack = [];
  redoStack = [];
  openWithCalls = [];
  activeDoc = new Doc(text, name);
  const sent = [];
  const panel = {
    active: true,
    webview: {
      cspSource: "vscode-webview:",
      asWebviewUri: (u) => u.p,
      postMessage: (m) => sent.push(m),
      onDidReceiveMessage: (fn) => {
        panel.send = fn;
      },
      options: {},
      html: "",
    },
    onDidChangeViewState: () => ({ dispose() {} }),
    onDidDispose() {},
  };
  provider.resolveCustomTextEditor(activeDoc, panel);
  activeTab = { input: new TabInputCustom(activeDoc.uri, "pln.planEditor") };
  panel.send({ t: "ready" }); // the webview asks for data once its script loads
  return {
    panel,
    sent,
    send: (m) => panel.send(m),
    get text() {
      return activeDoc.text;
    },
  };
}

const SAMPLE = `# Demo
A short plan.

- [ ] Alpha
  - [ ] one
  - [x] two
- [-] Omega
  - [-] three
`;

/** Tasks as [title, status, depth], using parent links to derive depth. */
function outline(plan) {
  const depth = new Map();
  return plan.tasks.map((i) => {
    const d = i.parent === null ? 0 : depth.get(i.parent) + 1;
    depth.set(i.line, d);
    return [i.title, i.status, d];
  });
}

/* ---------- parsing ---------- */

test("parses the project title, description, and the three statuses", () => {
  const plan = parsePlan(SAMPLE);
  assert.strictEqual(plan.title, "Demo");
  assert.strictEqual(plan.titleLine, 0);
  assert.strictEqual(plan.description, "A short plan.");
  assert.strictEqual(plan.descriptionLine, 1);
  assert.strictEqual(plan.descriptionEnd, 1);
  assert.deepStrictEqual(outline(plan), [
    ["Alpha", "todo", 0],
    ["one", "todo", 1],
    ["two", "done", 1],
    ["Omega", "in_progress", 0],
    ["three", "in_progress", 1],
  ]);
});

test("a task carries a title, status, parent, and description fields", () => {
  assert.deepStrictEqual(parsePlan("- [ ] A\n  - [x] B\n").tasks, [
    {
      line: 0,
      title: "A",
      status: "todo",
      parent: null,
      description: "",
      descriptionLine: -1,
      descriptionEnd: -1,
    },
    {
      line: 1,
      title: "B",
      status: "done",
      parent: 0,
      description: "",
      descriptionLine: -1,
      descriptionEnd: -1,
    },
  ]);
});

test("a missing title is empty rather than invented from the file name", () => {
  assert.strictEqual(parsePlan("- [ ] x\n").title, "");
  assert.strictEqual(parsePlan("- [ ] x\n").titleLine, -1);
});

test("nests subtasks several levels deep", () => {
  const plan = parsePlan("- [ ] a\n  - [ ] b\n    - [ ] c\n      - [x] d\n- [ ] e\n");
  assert.deepStrictEqual(
    plan.tasks.map((i) => [i.title, i.parent]),
    [
      ["a", null],
      ["b", 0],
      ["c", 1],
      ["d", 2],
      ["e", null],
    ]
  );
});

test("re-parents correctly when indentation steps back out", () => {
  const plan = parsePlan("- [ ] a\n    - [ ] b\n        - [ ] c\n    - [ ] d\n- [ ] e\n");
  assert.deepStrictEqual(outline(plan), [
    ["a", "todo", 0],
    ["b", "todo", 1],
    ["c", "todo", 2],
    ["d", "todo", 1],
    ["e", "todo", 0],
  ]);
});

test("accepts any consistent indentation width, including tabs", () => {
  for (const unit of ["  ", "    ", "\t", " "]) {
    const text = `- [ ] a\n${unit}- [ ] b\n${unit}- [ ] c\n${unit}${unit}- [ ] d\n`;
    assert.deepStrictEqual(
      parsePlan(text).tasks.map((i) => i.parent),
      [null, 0, 0, 2],
      JSON.stringify(unit)
    );
  }
});

test("parses task titles containing spaces and punctuation", () => {
  assert.deepStrictEqual(
    parsePlan("- [ ] Engineering & Infrastructure\n  - [x] Final  QA\n").tasks.map(
      (i) => i.title
    ),
    ["Engineering & Infrastructure", "Final  QA"]
  );
});

test("leaves the description empty when there is none", () => {
  for (const text of ["# Launch\n\n- [ ] a\n", "# Launch\n- [ ] a\nnot a description\n", "- [ ] a\n"]) {
    const plan = parsePlan(text);
    assert.strictEqual(plan.description, "", JSON.stringify(text));
    assert.strictEqual(plan.descriptionLine, -1);
    assert.strictEqual(plan.descriptionEnd, -1);
  }
});

test("parses a multiline plan description", () => {
  const plan = parsePlan(
    "# Launch\n\nGoal: ship it.\n>\n> More detail here.\n\n- [ ] First\n");
  assert.strictEqual(plan.description, "Goal: ship it.\n>\n> More detail here.");
  assert.strictEqual(plan.descriptionLine, 2);
  assert.strictEqual(plan.descriptionEnd, 4);
});

test("handles empty and malformed content without throwing", () => {
  assert.deepStrictEqual(parsePlan(""), {
    title: "",
    titleLine: -1,
    description: "",
    descriptionLine: -1,
    descriptionEnd: -1,
    tasks: [],
  });

  assert.deepStrictEqual(
    parsePlan("- [ ] orphan\n- plain bullet\n- [ ]x\nrandom text\n").tasks.map((i) => i.title),
    ["orphan"],
    "non-checkbox lines are ignored"
  );

  assert.deepStrictEqual(parsePlan("- [ ]\n").tasks[0], {
    line: 0,
    title: "",
    status: "todo",
    parent: null,
    description: "",
    descriptionLine: -1,
    descriptionEnd: -1,
  });

  assert.strictEqual(
    parsePlan("  * [X] starred\n").tasks[0].status,
    "done",
    "alternate markers and uppercase X are accepted"
  );
});

/* ---------- sections are gone ---------- */

test("heading lines are not treated as structure", () => {
  const plan = parsePlan("# T\n\n## Alpha\n\n- [ ] a\n  - [ ] b\n");
  assert.strictEqual(plan.title, "T");
  assert.strictEqual(plan.description, "", "a heading is never read as the description");
  assert.deepStrictEqual(outline(plan), [
    ["a", "todo", 0],
    ["b", "todo", 1],
  ]);
  assert.ok(!("sections" in plan));
});

test("section messages are rejected and leave the file alone", async () => {
  for (const m of [
    { t: "addSection" },
    { t: "renameSection", line: 3, title: "Nope" },
    { t: "deleteSection", line: 3 },
  ]) {
    const ed = open(SAMPLE);
    const before = ed.sent.length;
    await ed.send(m);
    assert.strictEqual(ed.text, SAMPLE, m.t);
    assert.strictEqual(ed.sent.length, before + 1, `${m.t} should resync the webview`);
  }
});

test("the webview shows no generated task identifiers", () => {
  const ed = open(SAMPLE);
  for (const task of ed.sent[0].tasks) {
    assert.deepStrictEqual(Object.keys(task).sort(), [
      "description",
      "descriptionEnd",
      "descriptionLine",
      "line",
      "parent",
      "status",
      "title",
    ]);
  }
  const fs = require("node:fs");
  const ui = ed.panel.webview.html + fs.readFileSync(`${__dirname}/../media/planEditor.js`, "utf8");
  assert.doesNotMatch(ui, /row-id|taskPrefix|nextId/);
});

test("the webview has a persistent breadcrumb and a View details menu action", () => {
  const ed = open(SAMPLE);
  assert.match(ed.panel.webview.html, /id="crumb"[^>]*aria-label="Breadcrumb"/);
  const fs = require("node:fs");
  const ui = fs.readFileSync(`${__dirname}/../media/planEditor.js`, "utf8");
  assert.match(ui, /View details/);
  assert.match(ui, /Copy task/);
  assert.match(ui, /copyTask/);
  assert.match(ui, /renderBreadcrumb/);
  assert.match(ui, /navigateTo\(task\.line\)/);
});

test("the webview has no raw textarea; Markdown opens the native text editor", () => {
  const ed = open(SAMPLE);
  assert.strictEqual(ed.sent[0].source, undefined);
  assert.doesNotMatch(ed.panel.webview.html, /id="raw"|raw-mode/);
  const fs = require("node:fs");
  const pkg = fs.readFileSync(`${__dirname}/../package.json`, "utf8");
  assert.match(pkg, /pln\.openMarkdown/);
  assert.match(pkg, /workbench\.editorAssociations/);
  assert.match(pkg, /\{git,gitlens\}:\/\*\*\/\*\.pln/);
});

test("hero title and description edit with auto-growing textareas", () => {
  const fs = require("node:fs");
  const ui = fs.readFileSync(`${__dirname}/../media/planEditor.js`, "utf8");
  const css = fs.readFileSync(`${__dirname}/../media/planEditor.css`, "utf8");
  assert.match(ui, /inline-title/);
  assert.match(ui, /editArea\(el\.description/);
  assert.match(ui, /editArea\(el\.title/);
  assert.match(css, /\.inline-title\s*\{/);
  assert.match(css, /\.inline-area\s*\{[^}]*min-height:\s*6\.2em/s);
});

/* ---------- opening ---------- */

test("sends the parsed plan once the webview reports ready", () => {
  const ed = open(SAMPLE);
  assert.strictEqual(ed.sent.length, 1);
  assert.strictEqual(ed.sent[0].title, "Demo");
  assert.strictEqual(ed.sent[0].tasks.length, 5);
});

/* ---------- status ---------- */

test("writes the status the webview asked for", () => {
  for (const [status, token] of [
    ["todo", " "],
    ["in_progress", "-"],
    ["done", "x"],
  ]) {
    const ed = open(SAMPLE);
    ed.send({ t: "status", line: 4, status });
    assert.strictEqual(ed.text.split("\n")[4], `  - [${token}] one`);
  }
});

test("rapid consecutive status changes land on the last one", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "status", line: 4, status: "in_progress" });
  ed.send({ t: "status", line: 4, status: "done" });
  assert.strictEqual(ed.text.split("\n")[4], "  - [x] one");
});

test("ignores edits aimed at a line that is no longer a task", async () => {
  const ed = open(SAMPLE);
  ed.send({ t: "status", line: 1, status: "done" });
  ed.send({ t: "status", line: 4, status: "nonsense" });
  await ed.send({ t: "deleteTask", line: 0 });
  ed.send({ t: "text", line: 2, text: "nope" });
  assert.strictEqual(ed.text, SAMPLE);
});

test("resyncs the webview when an edit is rejected", async () => {
  const ed = open(SAMPLE);
  const before = ed.sent.length;
  await ed.send({ t: "status", line: 1, status: "done" });
  assert.strictEqual(ed.sent.length, before + 1, "optimistic paint must be reverted");
  assert.strictEqual(ed.sent[before].tasks[0].status, "todo");
});

/* ---------- task titles ---------- */

test("renames a task without touching its status or parent", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "text", line: 5, text: "renamed" });
  assert.strictEqual(ed.text.split("\n")[5], "  - [x] renamed");
  assert.deepStrictEqual(outline(parsePlan(ed.text)), [
    ["Alpha", "todo", 0],
    ["one", "todo", 1],
    ["renamed", "done", 1],
    ["Omega", "in_progress", 0],
    ["three", "in_progress", 1],
  ]);
});

test("renaming keeps the indentation of a deeply nested task", () => {
  const ed = open("- [ ] a\n    - [ ] b\n        - [ ] c\n");
  ed.send({ t: "text", line: 2, text: "c renamed" });
  assert.strictEqual(ed.text, "- [ ] a\n    - [ ] b\n        - [ ] c renamed\n");
  assert.strictEqual(parsePlan(ed.text).tasks[2].parent, 1);
});

test("naming an untitled task inserts the missing space", () => {
  const ed = open("# T\n\n- [ ]\n");
  ed.send({ t: "text", line: 2, text: "Fresh" });
  assert.strictEqual(ed.text, "# T\n\n- [ ] Fresh\n");
});

test("clearing a task title keeps the task as untitled", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "text", line: 3, text: "" });
  assert.match(ed.text.split("\n")[3], /^- \[ \] ?$/);
  assert.deepStrictEqual(parsePlan(ed.text).tasks[0], {
    line: 3,
    title: "",
    status: "todo",
    parent: null,
    description: "",
    descriptionLine: -1,
    descriptionEnd: -1,
  });
  assert.strictEqual(parsePlan(ed.text).tasks.length, 5);
});

test("renaming a task never appends another task", () => {
  const ed = open(SAMPLE);
  const before = ed.text.split("\n").length;
  ed.send({ t: "text", line: 3, text: "first" });
  assert.strictEqual(ed.text.split("\n").length, before, "line count must not grow");
});

test("task titles keep internal spaces and punctuation", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "text", line: 3, text: "Review  Q3 & Q4  plans" });
  assert.strictEqual(ed.text.split("\n")[3], "- [ ] Review  Q3 & Q4  plans");
});

/* ---------- adding ---------- */

test("adds a top-level task at the end of the file", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "addTask", parent: null });
  assert.strictEqual(ed.text, SAMPLE + "- [ ]");
  const plan = parsePlan(ed.text);
  assert.strictEqual(plan.tasks[plan.tasks.length - 1].parent, null);
});

test("adds a top-level task to a file with no trailing newline", () => {
  const ed = open("# T\n\n- [ ] x");
  ed.send({ t: "addTask", parent: null });
  assert.strictEqual(ed.text, "# T\n\n- [ ] x\n- [ ]");
});

test("adds a top-level task to a file with only a title", () => {
  const ed = open("# T\n");
  ed.send({ t: "addTask", parent: null });
  assert.strictEqual(ed.text, "# T\n- [ ]");
});

test("adds a subtask below its parent's existing descendants", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "addTask", parent: 3 });
  assert.strictEqual(ed.text.split("\n").slice(3, 7).join("\n"), "- [ ] Alpha\n  - [ ] one\n  - [x] two\n  - [ ]");
  const plan = parsePlan(ed.text);
  assert.strictEqual(plan.tasks[3].parent, 3, "the new task belongs to Alpha");
});

test("adds a subtask one level deeper than its parent", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "addTask", parent: 4 });
  assert.strictEqual(ed.text.split("\n")[5], "    - [ ]");
  assert.strictEqual(parsePlan(ed.text).tasks[2].parent, 4);
});

test("adding a subtask skips a whole subtree, not just direct children", () => {
  const ed = open("- [ ] a\n  - [ ] b\n    - [ ] c\n- [ ] d\n");
  ed.send({ t: "addTask", parent: 0 });
  assert.strictEqual(ed.text, "- [ ] a\n  - [ ] b\n    - [ ] c\n  - [ ]\n- [ ] d\n");
});

test("a new subtask can be named and persists", () => {
  const ed = open("# T\n\n- [ ] Parent\n");
  ed.send({ t: "addTask", parent: 2 });
  ed.send({ t: "text", line: 3, text: "Call the design partners" });
  assert.strictEqual(ed.text, "# T\n\n- [ ] Parent\n  - [ ] Call the design partners\n");
  assert.deepStrictEqual(outline(parsePlan(ed.text)), [
    ["Parent", "todo", 0],
    ["Call the design partners", "todo", 1],
  ]);
});

/* ---------- deleting ---------- */

test("deletes a leaf task without asking", async () => {
  warning = { reply: "Delete", calls: [] };
  const ed = open(SAMPLE);
  await ed.send({ t: "deleteTask", line: 4 });
  assert.deepStrictEqual(warning.calls, []);
  assert.strictEqual(ed.text, "# Demo\nA short plan.\n\n- [ ] Alpha\n  - [x] two\n- [-] Omega\n  - [-] three\n");
});

test("deletes a task that is the last line of the file", async () => {
  const ed = open("- [ ] only");
  await ed.send({ t: "deleteTask", line: 0 });
  assert.strictEqual(ed.text, "");
});

test("confirms before deleting a task that has subtasks", async () => {
  warning = { reply: "Delete", calls: [] };
  const ed = open(SAMPLE);
  await ed.send({ t: "deleteTask", line: 3 });
  assert.match(warning.calls[0], /Delete "Alpha" and its 2 subtasks\?/);
  assert.strictEqual(ed.text, "# Demo\nA short plan.\n\n- [-] Omega\n  - [-] three\n");
});

test("deleting a parent removes the entire subtree", async () => {
  warning = { reply: "Delete", calls: [] };
  const ed = open("- [ ] a\n  - [ ] b\n    - [ ] c\n  - [ ] d\n- [ ] e\n");
  await ed.send({ t: "deleteTask", line: 0 });
  assert.match(warning.calls[0], /its 3 subtasks/);
  assert.strictEqual(ed.text, "- [ ] e\n");
});

test("cancelling the confirmation leaves the file untouched", async () => {
  warning = { reply: undefined, calls: [] };
  const ed = open(SAMPLE);
  await ed.send({ t: "deleteTask", line: 3 });
  assert.strictEqual(ed.text, SAMPLE);
});

/* ---------- header ---------- */

test("edits the title in place", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "title", text: "Product Launch" });
  assert.strictEqual(ed.text.split("\n")[0], "# Product Launch");
  assert.strictEqual(parsePlan(ed.text).title, "Product Launch");
});

test("adds a title to a file that has none", () => {
  const ed = open("- [ ] a\n");
  ed.send({ t: "title", text: "Named" });
  assert.strictEqual(ed.text, "# Named\n\n- [ ] a\n");
});

test("clearing the title removes its heading and shows as untitled", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "title", text: "   " });
  assert.strictEqual(ed.text, "A short plan.\n\n- [ ] Alpha\n  - [ ] one\n  - [x] two\n- [-] Omega\n  - [-] three\n");
  const plan = parsePlan(ed.text);
  assert.strictEqual(plan.title, "");
  assert.strictEqual(plan.titleLine, -1);
  assert.strictEqual(plan.description, "A short plan.");
});

test("clearing an absent title is a no-op", () => {
  const ed = open("- [ ] a\n");
  ed.send({ t: "title", text: "" });
  assert.strictEqual(ed.text, "- [ ] a\n");
});

test("writes a description under the title when there is none", () => {
  const ed = open("# Demo\n\n- [ ] a\n");
  ed.send({ t: "description", text: "Everything required to ship." });
  assert.strictEqual(ed.text, "# Demo\nEverything required to ship.\n\n- [ ] a\n");
  assert.strictEqual(parsePlan(ed.text).description, "Everything required to ship.");
});

test("replaces an existing description", () => {
  const ed = open("# Demo\nOld words.\n\n- [ ] a\n");
  ed.send({ t: "description", text: "New words, with punctuation." });
  assert.strictEqual(ed.text, "# Demo\nNew words, with punctuation.\n\n- [ ] a\n");
});

test("replaces a multiline plan description", () => {
  const ed = open("# Demo\nOld line.\nSecond line.\n\n- [ ] a\n");
  ed.send({ t: "description", text: "Goal: ship.\n>\n> Detail." });
  assert.strictEqual(ed.text, "# Demo\nGoal: ship.\n>\n> Detail.\n\n- [ ] a\n");
  const plan = parsePlan(ed.text);
  assert.strictEqual(plan.description, "Goal: ship.\n>\n> Detail.");
  assert.strictEqual(plan.descriptionEnd, 3);
});

test("clearing the description removes its line", () => {
  const ed = open("# Demo\nOld words.\n\n- [ ] a\n");
  ed.send({ t: "description", text: "" });
  assert.strictEqual(ed.text, "# Demo\n\n- [ ] a\n");
  assert.strictEqual(parsePlan(ed.text).description, "");
});

test("clearing an absent description is a no-op", () => {
  const ed = open("# Demo\n\n- [ ] a\n");
  ed.send({ t: "description", text: "" });
  assert.strictEqual(ed.text, "# Demo\n\n- [ ] a\n");
});

test("whitespace-only plan descriptions clear existing content", () => {
  const ed = open("# Demo\nOld words.\n\n- [ ] a\n");
  ed.send({ t: "description", text: "  \n\n  " });
  assert.strictEqual(ed.text, "# Demo\n\n- [ ] a\n");
  assert.strictEqual(parsePlan(ed.text).description, "");
});

test("plan descriptions normalize CRLF and surrounding blank lines", () => {
  const ed = open("# Demo\n\n- [ ] a\n");
  ed.send({ t: "description", text: "\r\nLine one.\r\nLine two.\r\n\r\n" });
  assert.strictEqual(ed.text, "# Demo\nLine one.\nLine two.\n\n- [ ] a\n");
  assert.strictEqual(parsePlan(ed.text).description, "Line one.\nLine two.");
});

test("whitespace-only task descriptions clear existing content", () => {
  const ed = open("- [ ] Auth\n  Keep me.\n");
  ed.send({ t: "taskDescription", line: 0, text: "\n  \n" });
  assert.strictEqual(ed.text, "- [ ] Auth\n");
});

test("task descriptions normalize CRLF and surrounding blank lines", () => {
  const ed = open("- [ ] Auth\n");
  ed.send({ t: "taskDescription", line: 0, text: "\r\nFirst.\r\n\r\nSecond.\r\n" });
  assert.strictEqual(ed.text, "- [ ] Auth\n  First.\n\n  Second.\n");
});

/* ---------- round trip ---------- */

test("the bundled example survives a parse and reports its hierarchy", () => {
  const fs = require("node:fs");
  const text = fs.readFileSync(`${__dirname}/../examples/product-launch.pln`, "utf8");
  const plan = parsePlan(text);
  assert.strictEqual(plan.title, "Product Launch");
  assert.ok(plan.description.length > 0);
  assert.ok(!/^##/m.test(text), "the example must not use sections");
  assert.strictEqual(plan.tasks.filter((i) => i.parent === null).length, 4);
  assert.ok(plan.tasks.some((i) => i.status === "in_progress"));
  assert.ok(plan.tasks.some((i) => i.status === "done"));
  assert.ok(outline(plan).some(([, , d]) => d === 2), "the example exercises deep nesting");
});

test("editing never loses hierarchy, titles, or statuses", async () => {
  const ed = open(SAMPLE);
  ed.send({ t: "addTask", parent: 3 });
  ed.send({ t: "text", line: 6, text: "four" });
  ed.send({ t: "status", line: 6, status: "done" });
  ed.send({ t: "addTask", parent: null });
  ed.send({ t: "text", line: 9, text: "Last" });
  assert.deepStrictEqual(outline(parsePlan(ed.text)), [
    ["Alpha", "todo", 0],
    ["one", "todo", 1],
    ["two", "done", 1],
    ["four", "done", 1],
    ["Omega", "in_progress", 0],
    ["three", "in_progress", 1],
    ["Last", "todo", 0],
  ]);
});

/* ---------- undo / redo ---------- */

test("undo and redo restore the document and push the plan to the webview", async () => {
  const ed = open(SAMPLE);
  await ed.send({ t: "status", line: 3, status: "done" });
  assert.strictEqual(ed.text.split("\n")[3], "- [x] Alpha");

  await ed.send({ t: "undo" });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(ed.text, SAMPLE);
  assert.strictEqual(ed.sent[ed.sent.length - 1].tasks[0].status, "todo");

  await ed.send({ t: "redo" });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(ed.text.split("\n")[3], "- [x] Alpha");
  assert.strictEqual(ed.sent[ed.sent.length - 1].tasks[0].status, "done");
});

test("multiple edits undo and redo in order without losing hierarchy", async () => {
  const ed = open(SAMPLE);
  await ed.send({ t: "status", line: 3, status: "done" });
  await ed.send({ t: "text", line: 3, text: "Renamed" });
  await ed.send({ t: "addTask", parent: 3 });
  assert.match(ed.text, /- \[x\] Renamed\n  - \[ \] one\n  - \[x\] two\n  - \[ \]/);

  await ed.send({ t: "undo" });
  assert.strictEqual(
    ed.text.split("\n").slice(3, 6).join("\n"),
    "- [x] Renamed\n  - [ ] one\n  - [x] two"
  );

  await ed.send({ t: "undo" });
  assert.strictEqual(ed.text.split("\n")[3], "- [x] Alpha");

  await ed.send({ t: "undo" });
  assert.strictEqual(ed.text, SAMPLE);
  assert.deepStrictEqual(outline(parsePlan(ed.text)), [
    ["Alpha", "todo", 0],
    ["one", "todo", 1],
    ["two", "done", 1],
    ["Omega", "in_progress", 0],
    ["three", "in_progress", 1],
  ]);

  await ed.send({ t: "redo" });
  await ed.send({ t: "redo" });
  assert.strictEqual(ed.text.split("\n")[3], "- [x] Renamed");
});

/* ---------- sync ---------- */

test("pushes a fresh plan to the webview after the document changes", async () => {
  const ed = open(SAMPLE);
  ed.send({ t: "status", line: 4, status: "done" });
  await new Promise((r) => setTimeout(r, 150));
  const latest = ed.sent[ed.sent.length - 1];
  assert.strictEqual(latest.tasks[1].status, "done");
  assert.ok(ed.sent.length > 1, "webview should receive an update after an edit");
});

/* ---------- task descriptions ---------- */

test("parses multiline task descriptions and nested tasks", () => {
  const plan = parsePlan(
    `- [-] Implement authentication
  First paragraph.

  Second paragraph.
  - [ ] Add login
    Create the login form.
`);
  assert.strictEqual(
    plan.tasks[0].description,
    "First paragraph.\n\nSecond paragraph."
  );
  assert.strictEqual(plan.tasks[1].title, "Add login");
  assert.strictEqual(plan.tasks[1].parent, 0);
  assert.strictEqual(plan.tasks[1].description, "Create the login form.");
});

test("ordinary Markdown bullets are description text, not tasks", () => {
  const plan = parsePlan(
    "- [ ] Parent\n  - plain bullet\n  - [ ] Real child\n");
  assert.strictEqual(plan.tasks.length, 2);
  assert.strictEqual(plan.tasks[0].description, "- plain bullet");
});

test("blockEnd covers descriptions and descendants", () => {
  const plan = parsePlan("- [ ] A\n  desc A\n  - [ ] B\n    desc B\n- [ ] C\n");
  assert.strictEqual(blockEnd(plan, 0), 3);
  assert.strictEqual(blockEnd(plan, 2), 3);
});

test("taskMarkdown copies a task with nested descendants, rebased to column 0", () => {
  const text =
    "- [ ] Keep\n- [-] Research\n  Understand the market.\n  - [x] Define audience\n  - [ ] Pricing\n    Capture gaps.\n    - [ ] Summarise\n- [ ] After\n";
  assert.strictEqual(
    taskMarkdown(text, 1),
    "- [-] Research\n  Understand the market.\n  - [x] Define audience\n  - [ ] Pricing\n    Capture gaps.\n    - [ ] Summarise"
  );
  assert.strictEqual(
    taskMarkdown(text, 4),
    "- [ ] Pricing\n  Capture gaps.\n  - [ ] Summarise"
  );
  assert.strictEqual(taskMarkdown(text, 99), null);
});

test("copyTask writes the task markdown to the clipboard", async () => {
  vscode.env.clipboard.text = "";
  const ed = open(
    "- [ ] Keep\n  - [-] Nested\n    Notes.\n    - [x] Leaf\n- [ ] After\n"
  );
  await ed.send({ t: "copyTask", line: 1 });
  assert.strictEqual(vscode.env.clipboard.text, "- [-] Nested\n  Notes.\n  - [x] Leaf");
  assert.strictEqual(ed.text, "- [ ] Keep\n  - [-] Nested\n    Notes.\n    - [x] Leaf\n- [ ] After\n");
});

test("writes and clears a task description", () => {
  const ed = open("# T\n\n- [ ] Auth\n  - [ ] Child\n");
  ed.send({ t: "taskDescription", line: 2, text: "Secure the app." });
  assert.strictEqual(ed.text, "# T\n\n- [ ] Auth\n  Secure the app.\n  - [ ] Child\n");
  ed.send({ t: "taskDescription", line: 2, text: "" });
  assert.strictEqual(ed.text, "# T\n\n- [ ] Auth\n  - [ ] Child\n");
});

test("adding a child inserts after descriptions and descendants", () => {
  const ed = open("- [ ] Parent\n  Parent blurb.\n  - [ ] Existing\n    Child blurb.\n");
  ed.send({ t: "addTask", parent: 0 });
  assert.strictEqual(
    ed.text,
    "- [ ] Parent\n  Parent blurb.\n  - [ ] Existing\n    Child blurb.\n  - [ ]\n"
  );
});

test("deleting a task removes its description and descendants", async () => {
  warning = { reply: "Delete", calls: [] };
  const ed = open(
    "- [ ] Keep\n- [ ] Remove\n  Gone.\n  - [ ] Nested\n    Notes.\n- [ ] After\n"
  );
  await ed.send({ t: "deleteTask", line: 1 });
  assert.strictEqual(ed.text, "- [ ] Keep\n- [ ] After\n");
});

test("status and rename leave the description intact", () => {
  const ed = open("- [ ] Auth\n  Keep me.\n");
  ed.send({ t: "status", line: 0, status: "done" });
  ed.send({ t: "text", line: 0, text: "Authentication" });
  assert.strictEqual(ed.text, "- [x] Authentication\n  Keep me.\n");
});

test("pushed plan includes task descriptions", () => {
  const ed = open("- [ ] Auth\n  Details.\n");
  assert.strictEqual(ed.sent[0].tasks[0].description, "Details.");
});

test("title-bar Open as Markdown / Open as Plan call vscode.openWith", async () => {
  const ed = open(SAMPLE, "switch-editor");
  ed.panel.active = false; // title-bar click clears active before the command runs
  openWithCalls = [];
  await registeredCommands["pln.openMarkdown"]();
  assert.strictEqual(openWithCalls.length, 1);
  assert.strictEqual(openWithCalls[0][1], "default");
  assert.strictEqual(openWithCalls[0][0].toString(), activeDoc.uri.toString());

  activeTab = { input: new TabInputText(activeDoc.uri) };
  openWithCalls = [];
  await registeredCommands["pln.openPlan"]();
  assert.strictEqual(openWithCalls.length, 1);
  assert.strictEqual(openWithCalls[0][1], "pln.planEditor");
});

/* ---------- nesting style / formatting preservation ---------- */

test("taskInsertPrefix matches 2-space, 4-space, and tab child indents", () => {
  assert.strictEqual(taskInsertPrefix("- [ ] a\n  - [ ] b\n", 0), "  - [ ]");
  assert.strictEqual(
    taskInsertPrefix("- [ ] a\n    - [ ] b\n        - [ ] c\n", 1),
    "        - [ ]"
  );
  assert.strictEqual(taskInsertPrefix("- [ ] a\n\t- [ ] b\n", 0), "\t- [ ]");
  assert.strictEqual(taskInsertPrefix("- [ ] a\n\t- [ ] b\n", 1), "\t\t- [ ]");
});

test("taskInsertPrefix inherits bullet markers from siblings or parent", () => {
  assert.strictEqual(taskInsertPrefix("* [ ] a\n  * [ ] b\n", 0), "  * [ ]");
  assert.strictEqual(taskInsertPrefix("+ [ ] a\n", 0), "  + [ ]");
  assert.strictEqual(taskInsertPrefix("* [ ] a\n* [ ] b\n", null), "* [ ]");
});

test("statusToken preserves uppercase X for done", () => {
  assert.strictEqual(statusToken("done", "X"), "X");
  assert.strictEqual(statusToken("done", "x"), "x");
  assert.strictEqual(statusToken("done", " "), "x");
  assert.strictEqual(statusToken("todo", "X"), " ");
});

test("adds a subtask with correct parent in a 4-space plan", () => {
  const ed = open("- [ ] a\n    - [ ] b\n        - [ ] c\n");
  ed.send({ t: "addTask", parent: 1 });
  assert.strictEqual(
    ed.text,
    "- [ ] a\n    - [ ] b\n        - [ ] c\n        - [ ]\n"
  );
  const plan = parsePlan(ed.text);
  const added = plan.tasks[plan.tasks.length - 1];
  assert.strictEqual(added.parent, 1, "new task must be a child of b");
  assert.strictEqual(added.title, "");
});

test("adds a subtask with correct parent in a tab-indented plan", () => {
  const ed = open("- [ ] a\n\t- [ ] b\n");
  ed.send({ t: "addTask", parent: 1 });
  assert.strictEqual(ed.text, "- [ ] a\n\t- [ ] b\n\t\t- [ ]\n");
  assert.strictEqual(parsePlan(ed.text).tasks[2].parent, 1);
});

test("adds a subtask using the sibling indent and bullet style", () => {
  const ed = open("* [ ] a\n    * [ ] b\n");
  ed.send({ t: "addTask", parent: 0 });
  assert.strictEqual(ed.text, "* [ ] a\n    * [ ] b\n    * [ ]\n");
  assert.strictEqual(parsePlan(ed.text).tasks[2].parent, 0);
});

test("top-level add inherits the root bullet marker", () => {
  const ed = open("+ [ ] only\n");
  ed.send({ t: "addTask", parent: null });
  assert.strictEqual(ed.text, "+ [ ] only\n+ [ ]");
});

test("preserves uppercase X when setting status to done", () => {
  const ed = open("- [X] Keep\n- [ ] Other\n");
  ed.send({ t: "status", line: 0, status: "done" });
  assert.strictEqual(ed.text, "- [X] Keep\n- [ ] Other\n");
});

test("setting done on a todo writes lowercase x", () => {
  const ed = open("- [ ] Keep\n");
  ed.send({ t: "status", line: 0, status: "done" });
  assert.strictEqual(ed.text, "- [x] Keep\n");
});

test("status and rename preserve untouched lines including markers and blanks", () => {
  const text = "* [ ] Alpha\n\n  + [X] beta\n\t- [-] gamma\n";
  const ed = open(text);
  ed.send({ t: "status", line: 0, status: "in_progress" });
  ed.send({ t: "text", line: 2, text: "beta renamed" });
  assert.strictEqual(
    ed.text,
    "* [-] Alpha\n\n  + [X] beta renamed\n\t- [-] gamma\n"
  );
});

test("editing a task description keeps its existing indent style", () => {
  const ed = open("- [ ] Auth\n    Keep four spaces.\n- [ ] Next\n");
  ed.send({ t: "taskDescription", line: 0, text: "Still four spaces." });
  assert.strictEqual(
    ed.text,
    "- [ ] Auth\n    Still four spaces.\n- [ ] Next\n"
  );
  assert.strictEqual(descriptionIndent(ed.text, 0, 1, 1), "    ");
});

test("editing a description does not reformat sibling tasks", () => {
  const ed = open(
    "- [ ] Parent\n    Notes here.\n    - [ ] Child\n        Child notes.\n"
  );
  ed.send({ t: "taskDescription", line: 0, text: "Updated notes." });
  assert.strictEqual(
    ed.text,
    "- [ ] Parent\n    Updated notes.\n    - [ ] Child\n        Child notes.\n"
  );
});

test("no-op title, task title, status, and description leave the document unchanged", () => {
  const text = "# Demo\nA short plan.\n\n- [X] Alpha\n  Keep me.\n";
  const ed = open(text);
  ed.send({ t: "title", text: "Demo" });
  ed.send({ t: "text", line: 3, text: "Alpha" });
  ed.send({ t: "status", line: 3, status: "done" });
  ed.send({ t: "taskDescription", line: 3, text: "Keep me." });
  ed.send({ t: "description", text: "A short plan." });
  assert.strictEqual(ed.text, text);
  assert.strictEqual(undoStack.length, 0, "no-ops must not push undo entries");
});

test("CRLF documents keep CRLF after status, rename, and add", () => {
  const text = "# Demo\r\n\r\n- [ ] Alpha\r\n    - [ ] child\r\n";
  const ed = open(text);
  ed.send({ t: "status", line: 2, status: "done" });
  ed.send({ t: "text", line: 2, text: "Alpha renamed" });
  ed.send({ t: "addTask", parent: 2 });
  assert.ok(ed.text.includes("\r\n"), "CRLF must be preserved");
  assert.ok(!ed.text.replace(/\r\n/g, "").includes("\n"), "no bare LF rows");
  assert.strictEqual(
    ed.text,
    "# Demo\r\n\r\n- [x] Alpha renamed\r\n    - [ ] child\r\n    - [ ]\r\n"
  );
  assert.strictEqual(parsePlan(ed.text).tasks[2].parent, 2);
});

/* ---------- parent progress (display-only) ---------- */

test("directChildProgress is null when a task has no children", () => {
  const plan = parsePlan("- [ ] Leaf\n- [x] Other\n");
  assert.strictEqual(directChildProgress(plan, 0), null);
  assert.strictEqual(directChildProgress(plan, 1), null);
});

test("directChildProgress reports 0/3 when no direct children are done", () => {
  const plan = parsePlan(
    "- [ ] Parent\n  - [ ] a\n  - [-] b\n  - [ ] c\n"
  );
  assert.deepStrictEqual(directChildProgress(plan, 0), { done: 0, total: 3 });
});

test("directChildProgress reports 2/5 for mixed direct children", () => {
  const plan = parsePlan(
    "- [ ] Parent\n  - [x] a\n  - [ ] b\n  - [X] c\n  - [-] d\n  - [ ] e\n"
  );
  assert.deepStrictEqual(directChildProgress(plan, 0), { done: 2, total: 5 });
});

test("directChildProgress reports all children completed", () => {
  const plan = parsePlan(
    "- [-] Parent\n  - [x] a\n  - [X] b\n  - [x] c\n"
  );
  assert.deepStrictEqual(directChildProgress(plan, 0), { done: 3, total: 3 });
});

test("directChildProgress ignores nested descendants", () => {
  const plan = parsePlan(
    `- [ ] Parent
  - [x] Child
    - [ ] Grandchild todo
    - [x] Grandchild done
  - [ ] Other
`
  );
  assert.deepStrictEqual(directChildProgress(plan, 0), { done: 1, total: 2 });
  assert.deepStrictEqual(directChildProgress(plan, 1), { done: 1, total: 2 });
});

test("changing a child status updates directChildProgress without rewriting the parent", () => {
  const text =
    "- [ ] Parent\n  - [ ] a\n  - [x] b\n  - [ ] c\n";
  const ed = open(text);
  assert.deepStrictEqual(directChildProgress(parsePlan(ed.text), 0), {
    done: 1,
    total: 3,
  });
  ed.send({ t: "status", line: 1, status: "done" });
  assert.deepStrictEqual(directChildProgress(parsePlan(ed.text), 0), {
    done: 2,
    total: 3,
  });
  assert.strictEqual(
    ed.text,
    "- [ ] Parent\n  - [x] a\n  - [x] b\n  - [ ] c\n",
    "only the child checkbox changes; parent status and structure stay put"
  );
});

test("parent progress UI is display-only and refreshes with status changes", () => {
  const fs = require("node:fs");
  const ui = fs.readFileSync(`${__dirname}/../media/planEditor.js`, "utf8");
  const css = fs.readFileSync(`${__dirname}/../media/planEditor.css`, "utf8");
  assert.match(ui, /doneChildren/);
  assert.match(ui, /row-progress/);
  assert.match(ui, /\$\{v\.doneChildren\}\/\$\{v\.children\}/);
  assert.match(ui, /function setStatus[\s\S]*render\(\)/);
  assert.match(css, /\.row-progress\s*\{[^}]*pointer-events:\s*none/s);
  assert.doesNotMatch(ui, /auto.*parent|rollup.*status|markParent/i);
});
