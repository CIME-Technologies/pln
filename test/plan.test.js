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

test("handles empty and malformed content without throwing", () => {
  assert.deepStrictEqual(parsePlan("", "empty"), { title: "empty", sections: [] });

  const loose = parsePlan("- [ ] orphan\n- plain bullet\n- [ ]x\nrandom text\n", "x");
  assert.strictEqual(loose.sections.length, 1, "orphan issues get an implicit section");
  assert.deepStrictEqual(
    loose.sections[0].issues.map((i) => i.text),
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

test("enter renames and appends a sibling in one edit", () => {
  const ed = open(SAMPLE);
  ed.send({ t: "text", line: 4, text: "first", addAfter: true });
  assert.strictEqual(ed.text.split("\n").slice(4, 7).join("\n"), "- [ ] first\n- [ ]\n- [x] two");
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
