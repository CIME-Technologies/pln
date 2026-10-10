/**
 * Webview UI for the Plan custom editor.
 * Receives a Plan from the extension host and posts mutations back as messages.
 */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = {
    crumb: $("crumb"),
    raw: $("raw"),
    editor: $("editor"),
    title: $("title"),
    description: $("description"),
    meta: $("meta"),
    donut: $("donut"),
    pct: $("pct"),
    list: $("tasks"),
    empty: $("empty"),
    addTask: $("add-task"),
  };

  const LABEL = { todo: "Todo", in_progress: "In Progress", done: "Done" };
  const ORDER = ["todo", "in_progress", "done"];
  /** Circumference of the hero progress ring (r = 7). */
  const DONUT = 2 * Math.PI * 7;
  const HOME = `<svg class="crumb-home" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 6.2L7 2.4l4.5 3.8V12H9.2V8.4H4.8V12H2.5V6.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

  const saved = vscode.getState() || {};
  const collapsed = new Set(saved.collapsed || []);
  /** Focused task line for the detail view, or `null` at the plan root. */
  let focusLine = typeof saved.focusLine === "number" ? saved.focusLine : null;
  let rawMode = !!saved.rawMode;
  const post = (m) => vscode.postMessage(m);
  const persist = () => vscode.setState({ collapsed: [...collapsed], focusLine, rawMode });

  let plan = { title: "Plan", description: "", tasks: [] };
  /** Full `.pln` source text for the Raw view. */
  let source = "";
  let menu = null;
  /**
   * After the next document push, start editing this task.
   * Either a line number, or `{ childOf }` for the newest child of that parent.
   * @type {number|{childOf: number|null}|null}
   */
  let focusAfterRender = null;
  /** Open inline `<input>`, if any. Document pushes are deferred while set. */
  let activeInput = null;
  /** Plan received while `activeInput` is open; applied on commit/cancel. */
  let queuedPlan = null;
  /** JSON of the plan currently painted; identical pushes skip a redraw. */
  let shown = "";

  /* ---------- icons ---------- */

  /**
   * @param {string} inner
   * @param {string} [box]
   * @returns {string}
   */
  const svg = (inner, box = "0 0 14 14") =>
    `<svg viewBox="${box}" aria-hidden="true">${inner}</svg>`;

  const OUTLINE = `<circle cx="7" cy="7" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/>`;

  /**
   * @param {"todo"|"in_progress"|"done"} status
   * @returns {string}
   */
  function statusIcon(status) {
    if (status === "done") {
      return svg(`<circle cx="7" cy="7" r="7" fill="currentColor"/>
        <path d="M4 7.3l2.1 2.1L10.2 5" fill="none" stroke="#fff" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    if (status === "in_progress") {
      return svg(`${OUTLINE}<path d="M7 3.1A3.9 3.9 0 0 1 7 10.9Z" fill="currentColor"/>`);
    }
    return svg(OUTLINE);
  }

  const CHEVRON = svg(
    `<path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    "0 0 12 12"
  );
  const PLUS = svg(
    `<path d="M6 2.5v7M2.5 6h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
    "0 0 12 12"
  );
  const DOTS = svg(
    `<circle cx="3" cy="6" r="1.1" fill="currentColor"/><circle cx="6" cy="6" r="1.1" fill="currentColor"/><circle cx="9" cy="6" r="1.1" fill="currentColor"/>`,
    "0 0 12 12"
  );
  const CHECK = svg(
    `<path d="M2.5 6.2l2.4 2.4L9.5 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    "0 0 12 12"
  );
  const PENCIL = svg(
    `<path d="M8.2 2.6l1.2 1.2-5 5-1.6.4.4-1.6z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>`,
    "0 0 12 12"
  );
  const TRASH = svg(
    `<path d="M2.8 3.6h6.4M4.8 3.6V2.8h2.4v.8M3.6 3.6l.4 5.2h4l.4-5.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    "0 0 12 12"
  );
  const DETAIL = svg(
    `<path d="M2.5 3.5h9v7h-9z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 6h5M4.5 8h3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`,
    "0 0 12 12"
  );

  /* ---------- markdown (escape-first, minimal) ---------- */

  /** @param {string} s */
  const escapeHtml = (s) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  /**
   * Safe, minimal Markdown: paragraphs, breaks, `code`, **bold**, *italic*, http(s) links.
   * @param {string} src
   * @returns {string}
   */
  function renderMarkdown(src) {
    if (!src) {
      return "";
    }
    const escaped = escapeHtml(src);
    const withCode = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
    const withBold = withCode.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    const withItalic = withBold.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    const withLinks = withItalic.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" rel="noreferrer">$1</a>'
    );
    return withLinks
      .split(/\n{2,}/)
      .map((block) => `<p>${block.replace(/\n/g, "<br />")}</p>`)
      .join("");
  }

  /* ---------- navigation ---------- */

  /** @returns {{line: number, title: string, status: string, parent: number|null}|null} */
  function focusedTask() {
    return focusLine === null ? null : plan.tasks.find((t) => t.line === focusLine) || null;
  }

  /** @param {number|null} line */
  function navigateTo(line) {
    if (line !== null && !plan.tasks.some((t) => t.line === line)) {
      return;
    }
    focusLine = line;
    persist();
    render();
  }

  /** Drop focus to the nearest surviving ancestor (or root) if the line is gone. */
  function reconcileNav() {
    if (focusLine === null) {
      return;
    }
    if (plan.tasks.some((t) => t.line === focusLine)) {
      return;
    }
    focusLine = null;
    persist();
  }

  /** Ancestor tasks from the root parent down to `task` (exclusive). */
  function ancestorChain(task) {
    const chain = [];
    let p = task.parent;
    while (p !== null) {
      const parent = plan.tasks.find((t) => t.line === p);
      if (!parent) {
        break;
      }
      chain.push(parent);
      p = parent.parent;
    }
    return chain.reverse();
  }

  function renderBreadcrumb() {
    const focused = focusedTask();
    const rootLabel = plan.title || "Untitled";
    const list = document.createElement("ol");
    list.className = "crumb-list";

    const rootLi = document.createElement("li");
    rootLi.className = "crumb-item";
    if (!focused) {
      const current = document.createElement("span");
      current.className = "crumb-current";
      current.setAttribute("aria-current", "page");
      current.innerHTML = `${HOME}<span class="crumb-label"></span>`;
      current.querySelector(".crumb-label").textContent = rootLabel;
      rootLi.appendChild(current);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "crumb-link";
      btn.innerHTML = `${HOME}<span class="crumb-label"></span>`;
      btn.querySelector(".crumb-label").textContent = rootLabel;
      btn.title = rootLabel;
      btn.setAttribute("aria-label", `Go to plan: ${rootLabel}`);
      btn.addEventListener("click", () => navigateTo(null));
      rootLi.appendChild(btn);
    }
    list.appendChild(rootLi);

    if (focused) {
      const chain = [...ancestorChain(focused), focused];
      for (let i = 0; i < chain.length; i++) {
        const task = chain[i];
        const isLast = i === chain.length - 1;
        const sep = document.createElement("li");
        sep.className = "crumb-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "/";
        list.appendChild(sep);

        const li = document.createElement("li");
        li.className = "crumb-item";
        const label = task.title || "Untitled";
        if (isLast) {
          const current = document.createElement("span");
          current.className = "crumb-current";
          current.setAttribute("aria-current", "page");
          current.textContent = label;
          current.title = label;
          li.appendChild(current);
        } else {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "crumb-link";
          btn.textContent = label;
          btn.title = label;
          btn.setAttribute("aria-label", `Go to task: ${label}`);
          btn.addEventListener("click", () => navigateTo(task.line));
          li.appendChild(btn);
        }
        list.appendChild(li);
      }
    }

    el.crumb.replaceChildren(list);
  }

  /* ---------- render ---------- */

  /**
   * Compute depth, child count, and collapse key for each task.
   * Keys use the title path so collapse survives line shifts.
   * @param {Array<{line: number, title: string, parent: number|null}>} tasks
   * @returns {Map<number, {depth: number, key: string, children: number, collapsed?: boolean}>}
   */
  function layout(tasks) {
    const view = new Map();
    const seen = new Map();

    for (const task of tasks) {
      const parent = task.parent === null ? null : view.get(task.parent);
      let key = (parent ? parent.key + "/" : "") + task.title;
      const nth = (seen.get(key) || 0) + 1;
      seen.set(key, nth);
      if (nth > 1) {
        key += `#${nth}`;
      }
      if (parent) {
        parent.children += 1;
      }
      view.set(task.line, { depth: parent ? parent.depth + 1 : 0, key, children: 0 });
    }

    for (const v of view.values()) {
      v.collapsed = v.children > 0 && collapsed.has(v.key);
    }
    return view;
  }

  /** Apply host payload: plan fields + optional `source` for Raw view. */
  function applyPayload(data) {
    source = typeof data.source === "string" ? data.source : source;
    const next = { ...data };
    delete next.source;
    plan = next;
  }

  /** Debounced write-back while editing Raw Markdown. */
  let rawTimer = 0;
  let rawDirty = false;

  function flushRaw() {
    if (rawTimer) {
      clearTimeout(rawTimer);
      rawTimer = 0;
    }
    if (!rawDirty) {
      return;
    }
    const text = el.raw.value;
    rawDirty = false;
    source = text;
    post({ t: "source", text });
  }

  function setRawMode(on) {
    const next = !!on;
    if (rawMode && !next) {
      flushRaw();
    }
    const changed = rawMode !== next;
    rawMode = next;
    document.body.classList.toggle("raw-mode", rawMode);
    el.raw.classList.toggle("hidden", !rawMode);
    persist();
    if (changed) {
      post({ t: "viewMode", mode: rawMode ? "raw" : "preview" });
    }
    if (rawMode) {
      closeMenu();
      if (!rawDirty && el.raw.value !== source) {
        el.raw.value = source;
      }
    }
  }

  /** Paint the current `plan` into the DOM. */
  function render() {
    closeMenu();
    reconcileNav();
    setRawMode(rawMode);

    if (rawMode) {
      // Don't clobber in-progress typing when the host echoes our own edit.
      if (!rawDirty && el.raw.value !== source) {
        el.raw.value = source;
      }
      shown = JSON.stringify({ plan, focusLine, source, rawMode });
      return;
    }

    const focused = focusedTask();
    const inDetail = !!focused;
    const view = layout(plan.tasks);
    const listed = inDetail
      ? plan.tasks.filter((t) => t.parent === focusLine)
      : plan.tasks;
    const scope = inDetail
      ? plan.tasks.filter((t) => {
          if (t.line === focused.line) {
            return true;
          }
          let p = t.parent;
          while (p !== null) {
            if (p === focused.line) {
              return true;
            }
            const parent = plan.tasks.find((x) => x.line === p);
            p = parent ? parent.parent : null;
          }
          return false;
        })
      : plan.tasks;
    const done = scope.filter((i) => i.status === "done").length;
    const active = scope.filter((i) => i.status === "in_progress").length;
    const ratio = scope.length ? done / scope.length : 0;

    renderBreadcrumb();

    el.description.classList.remove("hidden");
    if (inDetail) {
      el.title.textContent = focused.title || "Untitled";
      el.title.classList.toggle("placeholder", !focused.title);
      if (focused.description) {
        el.description.classList.remove("placeholder");
        el.description.innerHTML = renderMarkdown(focused.description);
      } else {
        el.description.classList.add("placeholder");
        el.description.textContent = "Add a description…";
      }
    } else {
      el.title.textContent = plan.title || "Untitled";
      el.title.classList.toggle("placeholder", !plan.title);
      if (plan.description) {
        el.description.classList.remove("placeholder");
        el.description.innerHTML = renderMarkdown(plan.description);
      } else {
        el.description.classList.add("placeholder");
        el.description.textContent = "Add a description…";
      }
    }

    el.pct.textContent = `${Math.round(ratio * 100)}%`;
    el.donut.setAttribute("stroke-dasharray", DONUT);
    el.donut.setAttribute("stroke-dashoffset", DONUT * (1 - ratio));
    const countLabel =
      listed.length === 1
        ? inDetail
          ? "subtask"
          : "task"
        : inDetail
          ? "subtasks"
          : "tasks";
    el.meta.innerHTML =
      chip("todo", scope.length - done - active) +
      chip("in_progress", active) +
      chip("done", done) +
      `<span class="chip">${listed.length} ${countLabel}</span>`;

    const live = new Set([...view.values()].map((v) => v.key));
    const stale = [...collapsed].filter((key) => !live.has(key));
    if (stale.length) {
      stale.forEach((key) => collapsed.delete(key));
      persist();
    }

    el.list.innerHTML = "";
    el.empty.classList.toggle("hidden", listed.length > 0);
    if (!listed.length) {
      el.empty.querySelector("h2").textContent = inDetail ? "No subtasks yet" : "Nothing planned yet";
      el.empty.querySelector("p").textContent = inDetail
        ? "Add a subtask below."
        : "Add a task below.";
    }

    if (inDetail) {
      const base = view.get(focused.line)?.depth ?? 0;
      for (const task of listed) {
        const v = view.get(task.line);
        el.list.appendChild(
          renderRow(task, {
            depth: Math.max(0, v.depth - base - 1),
            key: v.key,
            children: v.children,
            collapsed: false,
          })
        );
      }
    } else {
      let hideBelow = Infinity;
      for (const task of listed) {
        const v = view.get(task.line);
        if (v.depth > hideBelow) {
          continue;
        }
        hideBelow = v.collapsed ? v.depth : Infinity;
        el.list.appendChild(renderRow(task, v));
      }
    }

    const addText = inDetail ? " Add subtask" : " Add task";
    const textNodes = [...el.addTask.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE);
    if (textNodes.length) {
      textNodes[textNodes.length - 1].textContent = addText;
    }

    shown = JSON.stringify({ plan, focusLine, source, rawMode });
  }

  /**
   * @param {string} status
   * @param {number} count
   * @returns {string}
   */
  const chip = (status, count) =>
    `<span class="chip"><span class="swatch ${status}"></span><b>${count}</b> ${LABEL[status]}</span>`;

  /**
   * @param {{line: number, title: string, status: string}} task
   * @param {{depth: number, key: string, children: number, collapsed?: boolean}} v
   * @returns {HTMLLIElement}
   */
  function renderRow(task, v) {
    const row = document.createElement("li");
    row.className = "row" + (task.status === "done" ? " done" : "");
    row.dataset.line = task.line;
    row.style.paddingLeft = `${16 + v.depth * 20}px`;

    const twisty = document.createElement("button");
    twisty.type = "button";
    twisty.className =
      "twisty" + (v.children ? "" : " leaf") + (v.collapsed ? " collapsed" : "");
    twisty.innerHTML = CHEVRON;
    twisty.title = v.collapsed ? "Expand" : "Collapse";
    twisty.setAttribute("aria-label", twisty.title);
    twisty.addEventListener("click", () => {
      v.collapsed ? collapsed.delete(v.key) : collapsed.add(v.key);
      persist();
      render();
    });

    const status = document.createElement("button");
    status.type = "button";
    status.className = `status ${task.status}`;
    status.innerHTML = statusIcon(task.status);
    status.title = `${LABEL[task.status]} — click to change`;
    status.addEventListener("click", () =>
      setStatus(task, ORDER[(ORDER.indexOf(task.status) + 1) % ORDER.length])
    );

    const title = document.createElement("span");
    title.className = "row-title" + (task.title ? "" : " placeholder");
    title.textContent = task.title || "Untitled";
    title.addEventListener("click", () => editTask(row, task));

    const add = iconButton(PLUS, "Add subtask", () => {
      collapsed.delete(v.key);
      persist();
      focusAfterRender = { childOf: task.line };
      post({ t: "addTask", parent: task.line });
    });

    const more = iconButton(DOTS, "Task options", () =>
      openMenu(more, [
        ...ORDER.map((s) => ({
          label: LABEL[s],
          icon: statusIcon(s),
          iconClass: `status-glyph ${s}`,
          selected: s === task.status,
          run: () => setStatus(task, s),
        })),
        { separator: true },
        { label: "View details", icon: DETAIL, run: () => navigateTo(task.line) },
        { label: "Rename", icon: PENCIL, run: () => editTask(row, task) },
        {
          label: "Delete",
          icon: TRASH,
          danger: true,
          run: () => {
            if (focusLine === task.line) {
              focusLine = task.parent;
              persist();
            }
            post({ t: "deleteTask", line: task.line });
          },
        },
      ])
    );

    row.append(twisty, status, title, add, more);
    return row;
  }

  /**
   * @param {string} icon
   * @param {string} label
   * @param {() => void} run
   * @returns {HTMLButtonElement}
   */
  function iconButton(icon, label, run) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn";
    button.innerHTML = icon;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    return button;
  }

  /* ---------- editing ---------- */

  /**
   * Update status in the local plan immediately, then ask the host to write it.
   * @param {{line: number, status: string}} task
   * @param {string} status
   */
  function setStatus(task, status) {
    task.status = status;
    render();
    post({ t: "status", line: task.line, status });
  }

  /** Begin editing the project title, or the focused task title in detail view. */
  function editTitle() {
    const focused = focusedTask();
    if (focused) {
      editArea(el.title, focused.title, (value) => {
        const text = value.replace(/\s+/g, " ").trim();
        if (text === focused.title) {
          return false;
        }
        focused.title = text;
        post({ t: "text", line: focused.line, text: text });
        return true;
      }, { className: "inline-input inline-title", singleLine: true });
      return;
    }
    editArea(el.title, plan.title, (value) => {
      const text = value.replace(/\s+/g, " ").trim();
      if (text === plan.title) {
        return false;
      }
      plan.title = text;
      post({ t: "title", text: text });
      return true;
    }, { className: "inline-input inline-title", singleLine: true });
  }

  /** Begin editing the plan description (root) or task description (detail). */
  function editDescription() {
    const focused = focusedTask();
    if (focused) {
      editArea(el.description, focused.description || "", (value) => {
        if (value === focused.description) {
          return false;
        }
        focused.description = value;
        post({ t: "taskDescription", line: focused.line, text: value });
        return true;
      });
      return;
    }
    editArea(el.description, plan.description || "", (value) => {
      if (value === plan.description) {
        return false;
      }
      plan.description = value;
      post({ t: "description", text: value });
      return true;
    });
  }

  /**
   * Auto-growing textarea editor for titles and descriptions.
   * @param {HTMLElement|null} label
   * @param {string} initial
   * @param {(value: string) => boolean} commit
   * @param {{ className?: string, singleLine?: boolean }=} opts
   */
  function editArea(label, initial, commit, opts) {
    if (!label || activeInput) {
      return;
    }
    closeMenu();

    const options = opts || {};
    const singleLine = !!options.singleLine;
    const input = document.createElement("textarea");
    input.className = options.className || "inline-input inline-area";
    input.value = initial;
    input.spellcheck = false;
    input.rows = singleLine ? 1 : 4;
    label.replaceWith(input);
    input.scrollIntoView({ block: "nearest" });
    input.focus();
    if (singleLine) {
      input.select();
    }
    activeInput = input;

    const fitHeight = () => {
      input.style.height = "0px";
      input.style.height = `${input.scrollHeight}px`;
    };
    fitHeight();
    requestAnimationFrame(fitHeight);
    input.addEventListener("input", fitHeight);

    let settled = false;
    const finish = (save) => {
      if (settled) {
        return;
      }
      settled = true;
      activeInput = null;
      input.replaceWith(label);

      const raw = singleLine
        ? input.value
        : input.value.replace(/\s+$/g, "").replace(/^\n+/g, "");
      if (save && commit(raw)) {
        queuedPlan = null;
      } else if (queuedPlan) {
        applyPayload(queuedPlan);
        queuedPlan = null;
      }
      render();
    };

    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && (singleLine || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finish(true);
      }
    });
  }

  /**
   * Begin editing a task title. An empty title is kept and shown as Untitled.
   * @param {HTMLElement} row
   * @param {{line: number, title: string}} task
   */
  function editTask(row, task) {
    edit(row.querySelector(".row-title"), task.title, (value) => {
      if (value === task.title) {
        return false;
      }
      task.title = value;
      post({ t: "text", line: task.line, text: value });
      return true;
    });
  }

  /**
   * Replace a label with an `<input>` until Enter/blur (commit) or Escape (cancel).
   * @param {HTMLElement|null} label
   * @param {string} initial
   * @param {(value: string) => boolean} commit Return true if a host message was posted.
   */
  function edit(label, initial, commit) {
    if (!label || activeInput) {
      return;
    }
    closeMenu();

    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-input";
    input.value = initial;
    input.spellcheck = false;
    label.replaceWith(input);
    input.scrollIntoView({ block: "nearest" });
    input.focus();
    input.select();
    activeInput = input;

    let settled = false;
    const finish = (save) => {
      if (settled) {
        return;
      }
      settled = true;
      activeInput = null;
      input.replaceWith(label);

      if (save && commit(input.value.trim())) {
        queuedPlan = null;
      } else if (queuedPlan) {
        applyPayload(queuedPlan);
        queuedPlan = null;
      }
      render();
    };

    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        finish(e.key === "Enter");
      }
    });
  }

  /** Start editing the task indicated by `focusAfterRender`, if present. */
  function applyFocus() {
    if (focusAfterRender === null) {
      return;
    }
    if (typeof focusAfterRender === "object") {
      const siblings = plan.tasks.filter((i) => i.parent === focusAfterRender.childOf);
      const last = siblings[siblings.length - 1];
      focusAfterRender = last ? last.line : null;
    }
    const row = el.list.querySelector(`.row[data-line="${focusAfterRender}"]`);
    const task = plan.tasks.find((i) => i.line === focusAfterRender);
    if (row && task) {
      editTask(row, task);
    }
  }

  /* ---------- menu ---------- */

  /**
   * @param {HTMLElement} anchor
   * @param {Array<{separator?: boolean, label?: string, icon?: string, iconClass?: string, selected?: boolean, danger?: boolean, run?: () => void}>} items
   */
  function openMenu(anchor, items) {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "menu";

    for (const item of items) {
      if (item.separator) {
        const separator = document.createElement("div");
        separator.className = "menu-sep";
        menu.appendChild(separator);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-item" + (item.danger ? " danger" : "");
      button.innerHTML = `
        <span class="menu-icon ${item.iconClass || ""}">${item.icon}</span>
        <span class="menu-label"></span>
        <span class="menu-check">${item.selected ? CHECK : ""}</span>`;
      button.querySelector(".menu-label").textContent = item.label;
      button.addEventListener("click", () => {
        closeMenu();
        item.run();
      });
      menu.appendChild(button);
    }

    document.body.appendChild(menu);
    const box = anchor.getBoundingClientRect();
    menu.style.top = `${Math.max(8, Math.min(box.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
    menu.style.left = `${Math.max(8, Math.min(box.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    setTimeout(() => document.addEventListener("mousedown", onOutsideClick, true));
  }

  /** @param {MouseEvent} e */
  function onOutsideClick(e) {
    if (!menu.contains(e.target)) {
      closeMenu();
    }
  }

  function closeMenu() {
    if (menu) {
      document.removeEventListener("mousedown", onOutsideClick, true);
      menu.remove();
      menu = null;
    }
  }

  /* ---------- wiring ---------- */

  el.raw.addEventListener("input", () => {
    rawDirty = true;
    source = el.raw.value;
    if (rawTimer) {
      clearTimeout(rawTimer);
    }
    rawTimer = setTimeout(flushRaw, 200);
  });
  el.raw.addEventListener("blur", flushRaw);

  el.title.addEventListener("click", editTitle);
  el.description.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest("a")) {
      return;
    }
    editDescription();
  });

  el.addTask.addEventListener("click", () => {
    focusAfterRender = { childOf: focusLine };
    post({ t: "addTask", parent: focusLine });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (menu) {
        closeMenu();
        return;
      }
      if (rawMode) {
        setRawMode(false);
        render();
        return;
      }
      if (!activeInput && focusLine !== null) {
        const focused = focusedTask();
        navigateTo(focused ? focused.parent : null);
      }
      return;
    }
    // While typing in an inline field, let the browser undo local keystrokes.
    // Otherwise forward to VS Code so WorkspaceEdit history is undone/redone.
    if (activeInput || !(e.metaKey || e.ctrlKey)) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      post({ t: "undo" });
    } else if ((key === "z" && e.shiftKey) || (key === "y" && e.ctrlKey && !e.metaKey)) {
      e.preventDefault();
      post({ t: "redo" });
    }
  });

  window.addEventListener("message", (e) => {
    const data = e.data;
    if (data && data.t === "setView") {
      setRawMode(data.mode === "raw");
      render();
      if (rawMode) {
        el.raw.focus();
      }
      return;
    }
    if (activeInput) {
      queuedPlan = data;
      return;
    }
    const fingerprint = JSON.stringify({
      plan: (() => {
        const p = { ...data };
        delete p.source;
        return p;
      })(),
      focusLine,
      source: data.source,
      rawMode,
    });
    if (fingerprint === shown) {
      return;
    }
    applyPayload(data);
    reconcileNav();
    render();
    applyFocus();
    focusAfterRender = null;
  });

  setRawMode(rawMode);
  post({ t: "viewMode", mode: rawMode ? "raw" : "preview" });
  post({ t: "ready" });
})();
