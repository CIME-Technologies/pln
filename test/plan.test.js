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

## Alpha

- [ ] one
- [x] two

## Empty

## Omega

- [-] three
`;

/* ---------- parsing ---------- */

test("parses title, sections, and the three statuses", () => {
  const plan = parsePlan(SAMPLE, "fallback");
  assert.strictEqual(plan.title, "Demo");
  assert.deepStrictEqual(
    plan.sections.map((s) => [s.title, s.issues.length]),
    [
      ["Alpha", 2],
      ["Empty", 0],
      ["Omega", 1],
    ]
  );
  assert.deepStrictEqual(
    plan.sections[0].issues.map((i) => [i.text, i.status, i.line]),
    [
      ["one", "todo", 4],
      ["two", "done", 5],
    ]
  );
  assert.strictEqual(plan.sections[2].issues[0].status, "in_progress");
});

test("falls back to the file name when there is no title", () => {
  assert.strictEqual(parsePlan("## A\n\n- [ ] x\n", "my-plan").title, "my-plan");
});

test("parses section titles containing spaces and punctuation", () => {
  const plan = parsePlan(
    "# T\n\n## Product Launch\n## Prepare  Product   Launch\n## Engineering & Infrastructure\n## Final QA\n",
    "x"
  );
  assert.deepStrictEqual(
    plan.sections.map((s) => s.title),
    ["Product Launch", "Prepare  Product   Launch", "Engineering & Infrastructure", "Final QA"]
  );
});

test("parses a description under the title", () => {
  const plan = parsePlan("# Launch\nEverything we need to ship.\n\n## A\n- [ ] x\n", "x");
  assert.strictEqual(plan.title, "Launch");
  assert.strictEqual(plan.titleLine, 0);
  assert.strictEqual(plan.description, "Everything we need to ship.");
  assert.strictEqual(plan.descriptionLine, 1);
});

test("leaves the description empty when there is none", () => {
  for (const text of ["# Launch\n\n## A\n", "# Launch\n- [ ] task\nnot a description\n", "## A\n"]) {
    const plan = parsePlan(text, "x");
    assert.strictEqual(plan.description, "", JSON.stringify(text));
    assert.strictEqual(plan.descriptionLine, -1);
  }
});

test("separates top-level tasks from section tasks", () => {
  const plan = parsePlan(
    "# P\nDesc\n- [ ] top one\n- [x] top two\n## Engineering\n- [ ] section task\n",
    "x"
  );
  assert.deepStrictEqual(
    plan.tasks.map((i) => [i.text, i.status, i.line]),
    [
      ["top one", "todo", 2],
      ["top two", "done", 3],
    ]
  );
  assert.deepStrictEqual(
    plan.sections.map((s) => [s.title, s.issues.map((i) => i.text)]),
    [["Engineering", ["section task"]]]
  );
});

test("handles empty and malformed content without throwing", () => {
  assert.deepStrictEqual(parsePlan("", "empty"), {
    title: "empty",
    titleLine: -1,
    description: "",
    descriptionLine: -1,
    tasks: [],
    sections: [],
  });

  const loose = parsePlan("- [ ] orphan\n- plain bullet\n- [ ]x\nrandom text\n", "x");
  assert.strictEqual(loose.sections.length, 0, "no section is invented for orphan tasks");
  assert.deepStrictEqual(
    loose.tasks.map((i) => i.text),
    ["orphan"],
    "non-checkbox lines are ignored"
  );

  assert.deepStrictEqual(parsePlan("## A\n\n- [ ]\n", "x").sections[0].issues[0], {
    line: 2,
    text: "",
    status: "todo",
  });

  assert.deepStrictEqual(
    parsePlan("## A\n\n  * [X] starred\n", "x").sections[0].issues[0].status,
    "done",
    "alternate markers, indentation and uppercase X are accepted"
  );
});

/* ---------- opening ---------- */

test("sends the parsed plan once the webview reports ready", () => {
  const ed = open(SAMPLE);
  assert.strictEqual(ed.sent.length, 1);
  assert.strictEqual(ed.sent[0].title, "Demo");
  assert.strictEqual(ed.sent[0].sections.length, 3);
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
    assert.strictEqual(ed.text.split("\n")[4], `- [${token}] one`);
  }
});

test("rapid consecutive status changes land on the last one", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "status", line: 4, status: "in_progress" });
  ed.send({ t: "status", line: 4, status: "done" });
  assert.strictEqual(ed.text.split("\n")[4], "- [x] one");
});

test("ignores edits aimed at a line that is no longer an issue", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "status", line: 2, status: "done" });
  ed.send({ t: "status", line: 4, status: "nonsense" });
  ed.send({ t: "deleteIssue", line: 0 });
  ed.send({ t: "text", line: 2, text: "nope" });
  assert.strictEqual(ed.text, SAMPLE);
});

test("resyncs the webview when an edit is rejected", async () => {
  const ed = open(SAMPLE);
  const before = ed.sent.length;
  await ed.send({ t: "status", line: 2, status: "done" });
  assert.strictEqual(ed.sent.length, before + 1, "optimistic paint must be reverted");
  assert.strictEqual(ed.sent[before].sections[0].issues[0].status, "todo");
});

/* ---------- issue text ---------- */

test("renames an issue without touching its status", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "text", line: 5, text: "renamed" });
  assert.strictEqual(ed.text.split("\n")[5], "- [x] renamed");
});

test("naming an untitled issue inserts the missing space", () => {
  const ed = open("## A\n\n- [ ]\n");
  ed.send({ t: "text", line: 2, text: "Fresh" });
  assert.strictEqual(ed.text, "## A\n\n- [ ] Fresh\n");
});

test("renaming a task never appends another task", () => {
  const ed = open(SAMPLE);
  const before = ed.text.split("\n").length;
  ed.send({ t: "text", line: 4, text: "first" });
  assert.strictEqual(ed.text.split("\n").slice(4, 6).join("\n"), "- [ ] first\n- [x] two");
  assert.strictEqual(ed.text.split("\n").length, before, "line count must not grow");
});

test("renaming a sub-task keeps its indentation and adds nothing", () => {
  const ed = open("# T\n\n## A\n\n- [ ] parent\n    - [ ] sub\n");
  ed.send({ t: "text", line: 5, text: "sub task" });
  assert.strictEqual(ed.text, "# T\n\n## A\n\n- [ ] parent\n    - [ ] sub task\n");
});

test("task text keeps internal spaces and punctuation", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "text", line: 4, text: "Review  Q3 & Q4  plans" });
  assert.strictEqual(ed.text.split("\n")[4], "- [ ] Review  Q3 & Q4  plans");
});

/* ---------- adding ---------- */

test("adds an issue after the last issue of a section", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "addIssue", after: 5 });
  assert.strictEqual(ed.text.split("\n").slice(4, 7).join("\n"), "- [ ] one\n- [x] two\n- [ ]");
});

test("adds the first issue of an empty section directly below its heading", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "addIssue", after: 7 });
  assert.strictEqual(ed.text.split("\n").slice(7, 9).join("\n"), "## Empty\n- [ ]");
});

test("adds a top-level task above the first section", () => {
  const ed = open("# T\nDesc\n\n## A\n\n- [ ] x\n");
  ed.send({ t: "addTask" });
  assert.strictEqual(ed.text, "# T\nDesc\n- [ ]\n\n## A\n\n- [ ] x\n");
  assert.deepStrictEqual(parsePlan(ed.text, "x").tasks.map((i) => i.text), [""]);
});

test("adds further top-level tasks after the existing ones", () => {
  const ed = open("# T\n- [ ] first\n\n## A\n");
  ed.send({ t: "addTask" });
  assert.strictEqual(ed.text, "# T\n- [ ] first\n- [ ]\n\n## A\n");
});

test("adds a top-level task to a file with only a title", () => {
  const ed = open("# T\n");
  ed.send({ t: "addTask" });
  assert.strictEqual(ed.text, "# T\n- [ ]\n");
});

test("a new top-level task can be named and persists", () => {
  const ed = open("# T\n\n## A\n");
  ed.send({ t: "addTask" });
  const task = parsePlan(ed.text, "x").tasks[0];
  ed.send({ t: "text", line: task.line, text: "Call the design partners" });
  assert.strictEqual(ed.text, "# T\n- [ ] Call the design partners\n\n## A\n");
  assert.deepStrictEqual(
    parsePlan(ed.text, "x").tasks.map((i) => i.text),
    ["Call the design partners"]
  );
});

test("adds a section at the end, with or without a trailing blank line", () => {
  let ed = open("# T\n\n## A\n\n- [ ] x");
  ed.send({ t: "addSection" });
  assert.strictEqual(ed.text, "# T\n\n## A\n\n- [ ] x\n\n## New section");

  ed = open("# T\n\n## A\n\n- [ ] x\n");
  ed.send({ t: "addSection" });
  assert.strictEqual(ed.text, "# T\n\n## A\n\n- [ ] x\n\n## New section");
});

/* ---------- deleting ---------- */

test("deletes an issue", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "deleteIssue", line: 4 });
  assert.strictEqual(ed.text.split("\n").slice(2, 6).join("\n"), "## Alpha\n\n- [x] two\n");
});

test("deletes an issue that is the last line of the file", () => {
  const ed = open("## A\n\n- [ ] only");
  ed.send({ t: "deleteIssue", line: 2 });
  assert.strictEqual(ed.text, "## A\n");
});

test("renames a section", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "renameSection", line: 2, title: "Renamed" });
  assert.strictEqual(ed.text.split("\n")[2], "## Renamed");
});

test("renames a section to a title with spaces and punctuation", () => {
  for (const title of ["Product Launch", "Engineering & Infrastructure", "Final  QA"]) {
    const ed = open(SAMPLE);
    ed.send({ t: "renameSection", line: 2, title });
    assert.strictEqual(ed.text.split("\n")[2], `## ${title}`);
    assert.strictEqual(parsePlan(ed.text, "x").sections[0].title, title);
  }
});

/* ---------- header ---------- */

test("edits the title in place", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "title", text: "Product Launch Plan" });
  assert.strictEqual(ed.text.split("\n")[0], "# Product Launch Plan");
  assert.strictEqual(parsePlan(ed.text, "x").title, "Product Launch Plan");
});

test("adds a title to a file that has none", () => {
  const ed = open("## A\n");
  ed.send({ t: "title", text: "Named" });
  assert.strictEqual(ed.text, "# Named\n\n## A\n");
});

test("refuses to blank the title", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "title", text: "   " });
  assert.strictEqual(ed.text, SAMPLE);
});

test("writes a description under the title when there is none", () => {
  const ed = open("# Demo\n\n## A\n");
  ed.send({ t: "description", text: "Everything required to ship." });
  assert.strictEqual(ed.text, "# Demo\nEverything required to ship.\n\n## A\n");
  assert.strictEqual(parsePlan(ed.text, "x").description, "Everything required to ship.");
});

test("replaces an existing description", () => {
  const ed = open("# Demo\nOld words.\n\n## A\n");
  ed.send({ t: "description", text: "New words, with punctuation." });
  assert.strictEqual(ed.text, "# Demo\nNew words, with punctuation.\n\n## A\n");
});

test("clearing the description removes its line", () => {
  const ed = open("# Demo\nOld words.\n\n## A\n");
  ed.send({ t: "description", text: "" });
  assert.strictEqual(ed.text, "# Demo\n\n## A\n");
  assert.strictEqual(parsePlan(ed.text, "x").description, "");
});

test("clearing an absent description is a no-op", () => {
  const ed = open("# Demo\n\n## A\n");
  ed.send({ t: "description", text: "" });
  assert.strictEqual(ed.text, "# Demo\n\n## A\n");
});

test("deletes an empty section without asking", async () => {
  warning = { reply: "Delete", calls: [] };
  const ed = open(SAMPLE);
  await ed.send({ t: "deleteSection", line: 7 });
  assert.deepStrictEqual(warning.calls, []);
  assert.strictEqual(ed.text, "# Demo\n\n## Alpha\n\n- [ ] one\n- [x] two\n\n## Omega\n\n- [-] three\n");
});

test("confirms before deleting a section that has issues", async () => {
  warning = { reply: "Delete", calls: [] };
  const ed = open(SAMPLE);
  await ed.send({ t: "deleteSection", line: 2 });
  assert.match(warning.calls[0], /Delete "Alpha" and its 2 issues\?/);
  assert.strictEqual(ed.text, "# Demo\n\n## Empty\n\n## Omega\n\n- [-] three\n");
});

test("cancelling the confirmation leaves the file untouched", async () => {
  warning = { reply: undefined, calls: [] };
  const ed = open(SAMPLE);
  await ed.send({ t: "deleteSection", line: 2 });
  assert.strictEqual(ed.text, SAMPLE);
});

test("deletes the final section", async () => {
  warning = { reply: "Delete", calls: [] };
  const ed = open(SAMPLE);
  await ed.send({ t: "deleteSection", line: 9 });
  assert.strictEqual(ed.text, "# Demo\n\n## Alpha\n\n- [ ] one\n- [x] two\n\n## Empty\n");
});

/* ---------- sync ---------- */

test("pushes a fresh plan to the webview after the document changes", async () => {
  const ed = open(SAMPLE);
  ed.send({ t: "status", line: 4, status: "done" });
  await new Promise((r) => setTimeout(r, 150));
  const latest = ed.sent[ed.sent.length - 1];
  assert.strictEqual(latest.sections[0].issues[0].status, "done");
  assert.ok(ed.sent.length > 1, "webview should receive an update after an edit");
});
