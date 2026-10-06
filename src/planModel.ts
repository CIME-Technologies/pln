export type IssueStatus = "todo" | "in_progress" | "done";

export interface PlanIssue {
  line: number;
  text: string;
  status: IssueStatus;
}

export interface PlanGroup {
  title: string;
  line: number;
  /** Line of the last issue in the group, or the heading line when empty. */
  endLine: number;
  issues: PlanIssue[];
}

export interface PlanDocument {
  title: string;
  groups: PlanGroup[];
  total: number;
  done: number;
  inProgress: number;
}

export interface IssueLineParts {
  indent: string;
  marker: string;
  status: IssueStatus;
  text: string;
}

/** Trailing text is optional so a freshly inserted "- [ ]" still parses. */
const ISSUE_RE = /^([ \t]*)([-*+])[ \t]+\[([ xX-])\](?:[ \t]+(.*))?$/;
const H1_RE = /^#[ \t]+(.+)$/;
const H2_RE = /^(#{2,})[ \t]+(.+)$/;

const STATUS_TOKEN: Record<IssueStatus, string> = {
  todo: " ",
  in_progress: "-",
  done: "x",
};

const NEXT_STATUS: Record<IssueStatus, IssueStatus> = {
  todo: "in_progress",
  in_progress: "done",
  done: "todo",
};

export function parseStatusToken(token: string): IssueStatus | undefined {
  if (token === " ") {
    return "todo";
  }
  if (token === "-") {
    return "in_progress";
  }
  if (token === "x" || token === "X") {
    return "done";
  }
  return undefined;
}

export function statusToToken(status: IssueStatus): string {
  return STATUS_TOKEN[status];
}

export function nextStatus(status: IssueStatus): IssueStatus {
  return NEXT_STATUS[status];
}

export function parseIssueLine(lineText: string): IssueLineParts | undefined {
  const match = ISSUE_RE.exec(lineText);
  if (!match) {
    return undefined;
  }
  const status = parseStatusToken(match[3]);
  if (!status) {
    return undefined;
  }
  return {
    indent: match[1],
    marker: match[2],
    status,
    text: match[4] ?? "",
  };
}

export function parseHeadingLine(
  lineText: string
): { hashes: string; title: string } | undefined {
  const match = H2_RE.exec(lineText);
  if (!match) {
    return undefined;
  }
  return { hashes: match[1], title: match[2] };
}

export function parsePlan(text: string, fallbackTitle: string): PlanDocument {
  const lines = text.split(/\r?\n/);
  let title = fallbackTitle;
  let titleFound = false;
  const groups: PlanGroup[] = [];
  let current: PlanGroup | undefined;

  const openGroup = (groupTitle: string, line: number): PlanGroup => {
    const group: PlanGroup = { title: groupTitle, line, endLine: line, issues: [] };
    groups.push(group);
    current = group;
    return group;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const h1 = H1_RE.exec(line);
    if (h1) {
      if (!titleFound) {
        title = h1[1].trim();
        titleFound = true;
      }
      continue;
    }

    const heading = parseHeadingLine(line);
    if (heading) {
      openGroup(heading.title.trim(), i);
      continue;
    }

    const parts = parseIssueLine(line);
    if (parts) {
      if (!current) {
        openGroup("Issues", i);
      }
      current!.issues.push({ line: i, text: parts.text, status: parts.status });
      current!.endLine = i;
      continue;
    }

    // A bare first line doubles as the title, matching plain markdown plans.
    if (!titleFound && line.trim() && !line.startsWith("#")) {
      title = line.trim();
      titleFound = true;
    }
  }

  let done = 0;
  let inProgress = 0;
  let total = 0;
  for (const group of groups) {
    for (const issue of group.issues) {
      total += 1;
      if (issue.status === "done") {
        done += 1;
      } else if (issue.status === "in_progress") {
        inProgress += 1;
      }
    }
  }

  return { title, groups, total, done, inProgress };
}

/** Character range of the status token inside the checkbox brackets. */
export function findCheckboxRange(
  lineText: string
): { start: number; end: number; status: IssueStatus } | undefined {
  const parts = parseIssueLine(lineText);
  if (!parts) {
    return undefined;
  }
  const bracketStart = lineText.indexOf("[", parts.indent.length);
  if (bracketStart < 0) {
    return undefined;
  }
  return { start: bracketStart + 1, end: bracketStart + 2, status: parts.status };
}

/**
 * Character range of an issue's title text. `needsSpace` is true when the line
 * has no gap after `]` yet, so the caller must prepend one.
 */
export function findTitleRange(
  lineText: string
): { start: number; end: number; needsSpace: boolean } | undefined {
  const checkbox = findCheckboxRange(lineText);
  if (!checkbox) {
    return undefined;
  }
  const afterBracket = checkbox.end + 1;
  let start = afterBracket;
  while (start < lineText.length && /[ \t]/.test(lineText[start])) {
    start += 1;
  }
  return { start, end: lineText.length, needsSpace: start === afterBracket };
}

export function buildIssueLine(
  indent: string,
  marker: string,
  status: IssueStatus,
  text: string
): string {
  const body = text ? ` ${text}` : "";
  return `${indent}${marker} [${statusToToken(status)}]${body}`;
}
