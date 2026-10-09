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

class Doc {
  constructor(text, name = "plan") {
    this.text = text;
    this.fileName = `/tmp/${name}.pln`;
    this.uri = {};
  }
  get lines() {
    return this.text.split("\n");
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
    const offset = (p) => {
      const lines = this.lines;
      assert.ok(p.line < lines.length && p.character <= lines[p.line].length, "bad position");
      return lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    };
    for (const op of [...edit.ops].sort((a, b) => offset(b.range.start) - offset(a.range.start))) {
      this.text =
        this.text.slice(0, offset(op.range.start)) + op.text + this.text.slice(offset(op.range.end));
    }
  }
}

let warning = { reply: "Delete", calls: [] };
let provider;
let docListener;

const vscode = {
  Position,
  Range,
  WorkspaceEdit,
  Uri: { file: (p) => ({ p }), joinPath: (u, ...s) => ({ p: [u.p, ...s].join("/") }) },
  workspace: {
    applyEdit: async (edit) => {
      activeDoc.apply(edit);
      docListener?.({ document: activeDoc });
      return true;
    },
    onDidChangeTextDocument: (fn) => {
      docListener = fn;
      return { dispose() {} };
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
  },
};

const load = Module._load;
Module._load = (request, ...rest) =>
  request === "vscode" ? vscode : load.call(Module, request, ...rest);

const { activate, parsePlan } = require("../out/extension.js");

/* ---------- harness ---------- */

let activeDoc;

activate({ extensionUri: { p: "/ext" }, subscriptions: [] });

/** Opens `text` in the editor and returns helpers to drive it. */
function open(text, name) {
  activeDoc = new Doc(text, name);
  const sent = [];
  const panel = {
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
    onDidDispose() {},
  };
  provider.resolveCustomTextEditor(activeDoc, panel);
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
  const plan = parsePlan(SAMPLE, "fallback");
  assert.strictEqual(plan.title, "Demo");
  assert.strictEqual(plan.titleLine, 0);
  assert.strictEqual(plan.description, "A short plan.");
  assert.strictEqual(plan.descriptionLine, 1);
  assert.deepStrictEqual(outline(plan), [
    ["Alpha", "todo", 0],
    ["one", "todo", 1],
    ["two", "done", 1],
    ["Omega", "in_progress", 0],
    ["three", "in_progress", 1],
  ]);
});

test("a task carries only a title, a status, and a parent", () => {
  assert.deepStrictEqual(parsePlan("- [ ] A\n  - [x] B\n", "x").tasks, [
    { line: 0, title: "A", status: "todo", parent: null },
    { line: 1, title: "B", status: "done", parent: 0 },
  ]);
});

test("falls back to the file name when there is no title", () => {
  assert.strictEqual(parsePlan("- [ ] x\n", "my-plan").title, "my-plan");
});

test("nests subtasks several levels deep", () => {
  const plan = parsePlan("- [ ] a\n  - [ ] b\n    - [ ] c\n      - [x] d\n- [ ] e\n", "x");
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
  const plan = parsePlan("- [ ] a\n    - [ ] b\n        - [ ] c\n    - [ ] d\n- [ ] e\n", "x");
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
      parsePlan(text, "x").tasks.map((i) => i.parent),
      [null, 0, 0, 2],
      JSON.stringify(unit)
    );
  }
});

test("parses task titles containing spaces and punctuation", () => {
  assert.deepStrictEqual(
    parsePlan("- [ ] Engineering & Infrastructure\n  - [x] Final  QA\n", "x").tasks.map(
      (i) => i.title
    ),
    ["Engineering & Infrastructure", "Final  QA"]
  );
});

test("leaves the description empty when there is none", () => {
  for (const text of ["# Launch\n\n- [ ] a\n", "# Launch\n- [ ] a\nnot a description\n", "- [ ] a\n"]) {
    const plan = parsePlan(text, "x");
    assert.strictEqual(plan.description, "", JSON.stringify(text));
    assert.strictEqual(plan.descriptionLine, -1);
  }
});

test("handles empty and malformed content without throwing", () => {
  assert.deepStrictEqual(parsePlan("", "empty"), {
    title: "empty",
    titleLine: -1,
    description: "",
    descriptionLine: -1,
    tasks: [],
  });

  assert.deepStrictEqual(
    parsePlan("- [ ] orphan\n- plain bullet\n- [ ]x\nrandom text\n", "x").tasks.map((i) => i.title),
    ["orphan"],
    "non-checkbox lines are ignored"
  );

  assert.deepStrictEqual(parsePlan("- [ ]\n", "x").tasks[0], {
    line: 0,
    title: "",
    status: "todo",
    parent: null,
  });

  assert.strictEqual(
    parsePlan("  * [X] starred\n", "x").tasks[0].status,
    "done",
    "alternate markers and uppercase X are accepted"
  );
});

/* ---------- sections are gone ---------- */

test("heading lines are not treated as structure", () => {
  const plan = parsePlan("# T\n\n## Alpha\n\n- [ ] a\n  - [ ] b\n", "x");
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
    assert.deepStrictEqual(Object.keys(task).sort(), ["line", "parent", "status", "title"]);
  }
  const fs = require("node:fs");
  const ui = ed.panel.webview.html + fs.readFileSync(`${__dirname}/../media/planEditor.js`, "utf8");
  assert.doesNotMatch(ui, /row-id|taskPrefix|nextId/);
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
  assert.deepStrictEqual(outline(parsePlan(ed.text, "x")), [
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
  assert.strictEqual(parsePlan(ed.text, "x").tasks[2].parent, 1);
});

test("naming an untitled task inserts the missing space", () => {
  const ed = open("# T\n\n- [ ]\n");
  ed.send({ t: "text", line: 2, text: "Fresh" });
  assert.strictEqual(ed.text, "# T\n\n- [ ] Fresh\n");
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
  const plan = parsePlan(ed.text, "x");
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
  const plan = parsePlan(ed.text, "x");
  assert.strictEqual(plan.tasks[3].parent, 3, "the new task belongs to Alpha");
});

test("adds a subtask one level deeper than its parent", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "addTask", parent: 4 });
  assert.strictEqual(ed.text.split("\n")[5], "    - [ ]");
  assert.strictEqual(parsePlan(ed.text, "x").tasks[2].parent, 4);
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
  assert.deepStrictEqual(outline(parsePlan(ed.text, "x")), [
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
  assert.strictEqual(parsePlan(ed.text, "x").title, "Product Launch");
});

test("adds a title to a file that has none", () => {
  const ed = open("- [ ] a\n");
  ed.send({ t: "title", text: "Named" });
  assert.strictEqual(ed.text, "# Named\n\n- [ ] a\n");
});

test("refuses to blank the title", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "title", text: "   " });
  assert.strictEqual(ed.text, SAMPLE);
});

test("writes a description under the title when there is none", () => {
  const ed = open("# Demo\n\n- [ ] a\n");
  ed.send({ t: "description", text: "Everything required to ship." });
  assert.strictEqual(ed.text, "# Demo\nEverything required to ship.\n\n- [ ] a\n");
  assert.strictEqual(parsePlan(ed.text, "x").description, "Everything required to ship.");
});

test("replaces an existing description", () => {
  const ed = open("# Demo\nOld words.\n\n- [ ] a\n");
  ed.send({ t: "description", text: "New words, with punctuation." });
  assert.strictEqual(ed.text, "# Demo\nNew words, with punctuation.\n\n- [ ] a\n");
});

test("clearing the description removes its line", () => {
  const ed = open("# Demo\nOld words.\n\n- [ ] a\n");
  ed.send({ t: "description", text: "" });
  assert.strictEqual(ed.text, "# Demo\n\n- [ ] a\n");
  assert.strictEqual(parsePlan(ed.text, "x").description, "");
});

test("clearing an absent description is a no-op", () => {
  const ed = open("# Demo\n\n- [ ] a\n");
  ed.send({ t: "description", text: "" });
  assert.strictEqual(ed.text, "# Demo\n\n- [ ] a\n");
});

/* ---------- round trip ---------- */

test("the bundled example survives a parse and reports its hierarchy", () => {
  const fs = require("node:fs");
  const text = fs.readFileSync(`${__dirname}/../examples/product-launch.pln`, "utf8");
  const plan = parsePlan(text, "x");
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
  assert.deepStrictEqual(outline(parsePlan(ed.text, "x")), [
    ["Alpha", "todo", 0],
    ["one", "todo", 1],
    ["two", "done", 1],
    ["four", "done", 1],
    ["Omega", "in_progress", 0],
    ["three", "in_progress", 1],
    ["Last", "todo", 0],
  ]);
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
