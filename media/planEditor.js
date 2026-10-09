/**
 * Webview UI for the Plan custom editor.
 * Receives a Plan from the extension host and posts mutations back as messages.
 */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = {
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

  const collapsed = new Set((vscode.getState() || {}).collapsed || []);
  const post = (m) => vscode.postMessage(m);
  const persist = () => vscode.setState({ collapsed: [...collapsed] });

  let plan = { title: "Plan", description: "", tasks: [] };
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

  /** Paint the current `plan` into the DOM. */
  function render() {
    closeMenu();

    const tasks = plan.tasks;
    const done = tasks.filter((i) => i.status === "done").length;
    const active = tasks.filter((i) => i.status === "in_progress").length;
    const ratio = tasks.length ? done / tasks.length : 0;

    el.title.textContent = plan.title || "Untitled";
    el.title.classList.toggle("placeholder", !plan.title);
    el.description.textContent = plan.description || "Add a description…";
    el.description.classList.toggle("placeholder", !plan.description);
    el.pct.textContent = `${Math.round(ratio * 100)}%`;
    el.donut.setAttribute("stroke-dasharray", DONUT);
    el.donut.setAttribute("stroke-dashoffset", DONUT * (1 - ratio));
    el.meta.innerHTML =
      chip("todo", tasks.length - done - active) +
      chip("in_progress", active) +
      chip("done", done) +
      `<span class="chip">${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}</span>`;

    const view = layout(tasks);

    const live = new Set([...view.values()].map((v) => v.key));
    const stale = [...collapsed].filter((key) => !live.has(key));
    if (stale.length) {
      stale.forEach((key) => collapsed.delete(key));
      persist();
    }

    el.list.innerHTML = "";
    el.empty.classList.toggle("hidden", tasks.length > 0);

    let hideBelow = Infinity;
    for (const task of tasks) {
      const v = view.get(task.line);
      if (v.depth > hideBelow) {
        continue;
      }
      hideBelow = v.collapsed ? v.depth : Infinity;
      el.list.appendChild(renderRow(task, v));
    }

    shown = JSON.stringify(plan);
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
        { label: "Rename", icon: PENCIL, run: () => editTask(row, task) },
        {
          label: "Delete",
          icon: TRASH,
          danger: true,
          run: () => post({ t: "deleteTask", line: task.line }),
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

  /** Begin editing the project title. */
  function editTitle() {
    edit(el.title, plan.title, (value) => {
      if (value === plan.title) {
        return false;
      }
      plan.title = value;
      post({ t: "title", text: value });
      return true;
    });
  }

  /** Begin editing the project description. */
  function editDescription() {
    edit(el.description, plan.description, (value) => {
      if (value === plan.description) {
        return false;
      }
      plan.description = value;
      post({ t: "description", text: value });
      return true;
    });
  }

  /**
   * Begin editing a task title. An empty commit deletes the task.
   * @param {HTMLElement} row
   * @param {{line: number, title: string}} task
   */
  function editTask(row, task) {
    edit(row.querySelector(".row-title"), task.title, (value) => {
      if (!value) {
        post({ t: "deleteTask", line: task.line });
        return true;
      }
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
        plan = queuedPlan;
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

  el.title.addEventListener("click", editTitle);
  el.description.addEventListener("click", editDescription);

  el.addTask.addEventListener("click", () => {
    focusAfterRender = { childOf: null };
    post({ t: "addTask", parent: null });
  });

  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

  window.addEventListener("message", (e) => {
    if (activeInput) {
      queuedPlan = e.data;
      return;
    }
    if (JSON.stringify(e.data) === shown) {
      return;
    }
    plan = e.data;
    render();
    applyFocus();
    focusAfterRender = null;
  });

  post({ t: "ready" });
})();
