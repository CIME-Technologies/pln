(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = {
    title: $("title"),
    description: $("description"),
    meta: $("meta"),
    donut: $("donut"),
    pct: $("pct"),
    list: $("issues"),
    empty: $("empty"),
    addIssue: $("add-issue"),
  };

  const LABEL = { todo: "Todo", in_progress: "In Progress", done: "Done" };
  const ORDER = ["todo", "in_progress", "done"];
  const DONUT = 2 * Math.PI * 7;

  const collapsed = new Set((vscode.getState() || {}).collapsed || []);
  const post = (m) => vscode.postMessage(m);
  const persist = () => vscode.setState({ collapsed: [...collapsed] });

  let plan = { title: "Plan", description: "", issues: [] };
  let menu = null;
  /** A line to edit, or { childOf } to edit the newest child of that parent. */
  let focusAfterRender = null;
  /** The open inline input, if any. Renders are deferred while it exists. */
  let activeInput = null;
  let queuedPlan = null;
  /** The plan currently on screen, so identical pushes can be skipped. */
  let shown = "";

  /* ---------- icons ---------- */

  const svg = (inner, box = "0 0 14 14") =>
    `<svg viewBox="${box}" aria-hidden="true">${inner}</svg>`;

  const OUTLINE = `<circle cx="7" cy="7" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/>`;

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
   * Depth, child count and collapse key for every issue, in one pass. Collapse
   * is keyed by title path rather than line, since any edit shifts the lines
   * below it.
   */
  function layout(issues) {
    const view = new Map();
    const seen = new Map();

    for (const issue of issues) {
      const parent = issue.parent === null ? null : view.get(issue.parent);
      let key = (parent ? parent.key + "/" : "") + issue.title;
      const nth = (seen.get(key) || 0) + 1;
      seen.set(key, nth);
      if (nth > 1) {
        key += `#${nth}`;
      }
      if (parent) {
        parent.children += 1;
      }
      view.set(issue.line, { depth: parent ? parent.depth + 1 : 0, key, children: 0 });
    }

    for (const v of view.values()) {
      v.collapsed = v.children > 0 && collapsed.has(v.key);
    }
    return view;
  }

  function render() {
    closeMenu();

    const issues = plan.issues;
    const done = issues.filter((i) => i.status === "done").length;
    const active = issues.filter((i) => i.status === "in_progress").length;
    const ratio = issues.length ? done / issues.length : 0;

    el.title.textContent = plan.title;
    el.description.textContent = plan.description || "Add a description…";
    el.description.classList.toggle("placeholder", !plan.description);
    el.pct.textContent = `${Math.round(ratio * 100)}%`;
    el.donut.setAttribute("stroke-dasharray", DONUT);
    el.donut.setAttribute("stroke-dashoffset", DONUT * (1 - ratio));
    el.meta.innerHTML =
      chip("todo", issues.length - done - active) +
      chip("in_progress", active) +
      chip("done", done) +
      `<span class="chip">${issues.length} ${issues.length === 1 ? "issue" : "issues"}</span>`;

    const view = layout(issues);

    // Forget issues that are gone, so a re-created title starts expanded.
    const live = new Set([...view.values()].map((v) => v.key));
    const stale = [...collapsed].filter((key) => !live.has(key));
    if (stale.length) {
      stale.forEach((key) => collapsed.delete(key));
      persist();
    }

    el.list.innerHTML = "";
    el.empty.classList.toggle("hidden", issues.length > 0);

    let hideBelow = Infinity;
    for (const issue of issues) {
      const v = view.get(issue.line);
      if (v.depth > hideBelow) {
        continue;
      }
      hideBelow = v.collapsed ? v.depth : Infinity;
      el.list.appendChild(renderRow(issue, v));
    }

    shown = JSON.stringify(plan);
  }

  const chip = (status, count) =>
    `<span class="chip"><span class="swatch ${status}"></span><b>${count}</b> ${LABEL[status]}</span>`;

  function renderRow(issue, v) {
    const row = document.createElement("li");
    row.className = "row" + (issue.status === "done" ? " done" : "");
    row.dataset.line = issue.line;
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
    status.className = `status ${issue.status}`;
    status.innerHTML = statusIcon(issue.status);
    status.title = `${LABEL[issue.status]} — click to change`;
    status.addEventListener("click", () =>
      setStatus(issue, ORDER[(ORDER.indexOf(issue.status) + 1) % ORDER.length])
    );

    const title = document.createElement("span");
    title.className = "row-title" + (issue.title ? "" : " placeholder");
    title.textContent = issue.title || "Untitled";
    title.addEventListener("click", () => editIssue(row, issue));

    const add = iconButton(PLUS, "Add sub-issue", () => {
      collapsed.delete(v.key);
      persist();
      focusAfterRender = { childOf: issue.line };
      post({ t: "addIssue", parent: issue.line });
    });

    const more = iconButton(DOTS, "Issue options", () =>
      openMenu(more, [
        ...ORDER.map((s) => ({
          label: LABEL[s],
          icon: statusIcon(s),
          iconClass: `status-glyph ${s}`,
          selected: s === issue.status,
          run: () => setStatus(issue, s),
        })),
        { separator: true },
        { label: "Rename", icon: PENCIL, run: () => editIssue(row, issue) },
        {
          label: "Delete",
          icon: TRASH,
          danger: true,
          run: () => post({ t: "deleteIssue", line: issue.line }),
        },
      ])
    );

    row.append(twisty, status, title, add, more);
    return row;
  }

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
   * Paint the new status straight away instead of waiting out the provider's
   * debounce. The document stays authoritative: its next push overwrites this.
   */
  function setStatus(issue, status) {
    issue.status = status;
    render();
    post({ t: "status", line: issue.line, status });
  }

  function editTitle() {
    edit(el.title, plan.title, (value) => {
      if (!value || value === plan.title) {
        return false;
      }
      plan.title = value;
      post({ t: "title", text: value });
      return true;
    });
  }

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

  function editIssue(row, issue) {
    edit(row.querySelector(".row-title"), issue.title, (value) => {
      if (!value) {
        post({ t: "deleteIssue", line: issue.line });
        return true;
      }
      if (value === issue.title) {
        return false;
      }
      issue.title = value;
      post({ t: "text", line: issue.line, text: value });
      return true;
    });
  }

  /**
   * Swap a label for an input until the user commits or cancels. `commit`
   * applies the change locally and reports whether it also changed the
   * document, so the matching push back from the provider is a no-op.
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
        queuedPlan = null; // our edit supersedes anything that arrived meanwhile
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

  function applyFocus() {
    if (focusAfterRender === null) {
      return;
    }
    if (typeof focusAfterRender === "object") {
      // The issue we just asked for is the newest child of that parent.
      const siblings = plan.issues.filter((i) => i.parent === focusAfterRender.childOf);
      const last = siblings[siblings.length - 1];
      focusAfterRender = last ? last.line : null;
    }
    const row = el.list.querySelector(`.row[data-line="${focusAfterRender}"]`);
    const issue = plan.issues.find((i) => i.line === focusAfterRender);
    if (row && issue) {
      editIssue(row, issue);
    }
  }

  /* ---------- menu ---------- */

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

  el.addIssue.addEventListener("click", () => {
    focusAfterRender = { childOf: null };
    post({ t: "addIssue", parent: null });
  });

  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

  window.addEventListener("message", (e) => {
    // Redrawing would destroy an open input along with its focus and selection.
    if (activeInput) {
      queuedPlan = e.data;
      return;
    }
    // Redrawing identical content would still replace every node, throwing away
    // the hover state of whatever the pointer is resting on.
    if (JSON.stringify(e.data) === shown) {
      return;
    }
    plan = e.data;
    render();
    applyFocus(); // only a document update can contain the row we asked to edit
    focusAfterRender = null;
  });

  post({ t: "ready" });
})();
