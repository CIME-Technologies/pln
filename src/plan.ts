/** Task checkbox state written as `[ ]`, `[-]`, or `[x]`. */
export type Status = "todo" | "in_progress" | "done";

/**
 * One checkbox line in a `.pln` file.
 * `line` is 0-based; `parent` is the parent task's line or `null` at the root;
 * `description` is the body until the next task; `descriptionLine`/`descriptionEnd`
 * are inclusive source lines, or `-1` if none.
 */
export interface Task {
  line: number;
  title: string;
  status: Status;
  parent: number | null;
  description: string;
  descriptionLine: number;
  descriptionEnd: number;
}

/**
 * Parsed contents of a `.pln` document.
 * `titleLine` is the `#` heading line or `-1`; `descriptionLine`/`descriptionEnd`
 * are inclusive plan-description lines or `-1`; `tasks` are in document order
 * with each subtask following its parent.
 */
export interface Plan {
  title: string;
  titleLine: number;
  description: string;
  descriptionLine: number;
  descriptionEnd: number;
  tasks: Task[];
}

export const TASK = /^[ \t]*[-*+][ \t]+\[([ xX-])\](?:[ \t]+(.*))?$/;
const TITLE = /^#[ \t]+(.+)$/;
/** Canonical indent written for each nesting level. */
export const INDENT = "  ";

export const TOKEN: Record<Status, string> = { todo: " ", in_progress: "-", done: "x" };

const statusOf = (token: string): Status =>
  token === "-" ? "in_progress" : token === " " ? "todo" : "done";

/** Leading whitespace width; `tab` counts as 2. */
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

/** Strip leading whitespace up to `width` (`tab` counts as 2). */
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
 * Missing titles are `""`.
 *
 * Locals: `open` is the ancestor stack (shallowest first); `pending` collects the
 * current task’s description lines; `planDesc` collects prose before the first task.
 */
export function parsePlan(text: string): Plan {
  const plan: Plan = {
    title: "",
    titleLine: -1,
    description: "",
    descriptionLine: -1,
    descriptionEnd: -1,
    tasks: [],
  };
  const open: { indent: number; line: number }[] = [];
  let pending: { taskIndex: number; lines: { line: number; raw: string }[] } | null = null;
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
export function descendants(plan: Plan, line: number): Task[] {
  const inside = new Set([line]);
  return plan.tasks.filter((task) => {
    if (task.parent !== null && inside.has(task.parent)) {
      inside.add(task.line);
      return true;
    }
    return false;
  });
}

/** Last line owned by the task block (description + nested descendants). */
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

/** Task + nested descendants as markdown, rebased to column 0; `null` if not a task. */
export function taskMarkdown(text: string, line: number): string | null {
  const plan = parsePlan(text);
  if (!plan.tasks.some((t) => t.line === line)) {
    return null;
  }
  const lines = text.split(/\r?\n/).slice(line, blockEnd(plan, line) + 1);
  const base = indentOf(lines[0] ?? "");
  return lines.map((row) => stripIndent(row, base)).join("\n");
}

/** Normalize CRLF and trim leading/trailing blank lines. */
export function normalizeDescription(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n+$/g, "").replace(/^\n+/g, "");
  return normalized.trim() === "" ? "" : normalized;
}

/** Format a description body with `prefix` on non-empty lines. */
export function formatDescription(text: string, prefix: string): string {
  const normalized = normalizeDescription(text);
  if (!normalized) {
    return "";
  }
  return normalized
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : prefix + line))
    .join("\n");
}

/** Nesting depth of each task, keyed by line. */
export function depths(plan: Plan): Map<number, number> {
  const depth = new Map<number, number>();
  for (const task of plan.tasks) {
    depth.set(task.line, task.parent === null ? 0 : (depth.get(task.parent) ?? 0) + 1);
  }
  return depth;
}
