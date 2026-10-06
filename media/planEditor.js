(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = {
    title: $("title"),
    meta: $("meta"),
    donut: $("donut"),
    pct: $("pct"),
    sections: $("sections"),
    empty: $("empty"),
    addSection: $("add-section"),
  };

  const LABEL = { todo: "Todo", in_progress: "In Progress", done: "Done" };
  const ORDER = ["todo", "in_progress", "done"];
  const DONUT = 2 * Math.PI * 7;
  const RING_R = 5.5;
  const RING = 2 * Math.PI * RING_R;

  const collapsed = new Set((vscode.getState() || {}).collapsed || []);
  const post = (m) => vscode.postMessage(m);
  const persist = () => vscode.setState({ collapsed: [...collapsed] });

  let plan = { title: "Plan", sections: [] };
  let menu = null;
  /** Row line to edit, or "lastSection", once the next render contains it. */
  let focusAfterRender = null;
  /** The open inline input, if any. Renders are deferred while it exists. */
  let activeInput = null;
  let queuedPlan = null;

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

  /** "Product Launch Plan" -> "PLP", "Roadmap" -> "ROA". */
  function issuePrefix(title) {
    const words = title.match(/[A-Za-z]+/g) || [];
    const key =
      words.length === 1 ? words[0].slice(0, 3) : words.map((w) => w[0]).join("").slice(0, 3);
    return (key || "PLN").toUpperCase();
  }

  /* ---------- render ---------- */

  function render() {
    closeMenu();

    const issues = plan.sections.flatMap((s) => s.issues);
    const done = issues.filter((i) => i.status === "done").length;
    const active = issues.filter((i) => i.status === "in_progress").length;
    const ratio = issues.length ? done / issues.length : 0;

    el.title.textContent = plan.title;
    el.pct.textContent = `${Math.round(ratio * 100)}%`;
    el.donut.setAttribute("stroke-dasharray", DONUT);
    el.donut.setAttribute("stroke-dashoffset", DONUT * (1 - ratio));
    el.meta.innerHTML =
      chip("todo", issues.length - done - active) +
      chip("in_progress", active) +
      chip("done", done) +
      `<span class="chip">${issues.length} ${issues.length === 1 ? "issue" : "issues"}</span>`;

    // Collapse state is keyed by title: any edit shifts the line numbers below it.
    const seen = new Map();
    const live = new Set();
    for (const section of plan.sections) {
      const nth = (seen.get(section.title) || 0) + 1;
      seen.set(section.title, nth);
      section.key = nth === 1 ? section.title : `${section.title}#${nth}`;
      live.add(section.key);
    }

    // Forget deleted sections so a section that reuses the name starts expanded.
    const stale = [...collapsed].filter((key) => !live.has(key));
    if (stale.length) {
      stale.forEach((key) => collapsed.delete(key));
      persist();
    }

    const prefix = issuePrefix(plan.title);
    let n = 0;
    el.sections.innerHTML = "";
    el.empty.classList.toggle("hidden", plan.sections.length > 0);
    for (const section of plan.sections) {
      el.sections.appendChild(renderSection(section, () => `${prefix}-${++n}`));
    }

  }

  const chip = (status, count) =>
    `<span class="chip"><span class="swatch ${status}"></span><b>${count}</b> ${LABEL[status]}</span>`;

  function renderSection(section, nextId) {
    const node = document.createElement("section");
    const isCollapsed = collapsed.has(section.key);
    node.className = "group" + (isCollapsed ? " collapsed" : "");

    const done = section.issues.filter((i) => i.status === "done").length;
    const ratio = section.issues.length ? done / section.issues.length : 0;

    const main = document.createElement("div");
    main.className = "group-main";
    main.setAttribute("role", "button");
    main.setAttribute("tabindex", "0");
    main.setAttribute("aria-expanded", String(!isCollapsed));
    main.innerHTML = `
      <svg class="chevron" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <svg class="group-donut" viewBox="0 0 14 14" aria-hidden="true">
        <circle class="ring-track" cx="7" cy="7" r="${RING_R}"/>
        <circle class="ring-fill" cx="7" cy="7" r="${RING_R}"
                stroke-dasharray="${RING}" stroke-dashoffset="${RING * (1 - ratio)}"/>
      </svg>
      <span class="group-name"></span>
      <span class="group-count">${section.issues.length}</span>`;
    main.querySelector(".group-name").textContent = section.title;

    const toggle = () => {
      if (main.querySelector("input")) {
        return;
      }
      const next = !collapsed.has(section.key);
      next ? collapsed.add(section.key) : collapsed.delete(section.key);
      node.classList.toggle("collapsed", next);
      main.setAttribute("aria-expanded", String(!next));
      persist();
    };
    main.addEventListener("click", toggle);
    main.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });

    const add = iconButton(PLUS, "Add issue", () => {
      collapsed.delete(section.key);
      persist();
      const last = section.issues[section.issues.length - 1];
      const after = last ? last.line : section.line;
      focusAfterRender = after + 1;
      post({ t: "addIssue", after });
    });

    const more = iconButton(DOTS, "Section options", () =>
      openMenu(more, [
        { label: "Rename section", icon: PENCIL, run: () => editSection(main, section) },
        {
          label: "Delete section",
          icon: TRASH,
          danger: true,
          run: () => post({ t: "deleteSection", line: section.line }),
        },
      ])
    );

    const header = document.createElement("div");
    header.className = "group-header";
    header.append(main, add, more);

    const list = document.createElement("ul");
    list.className = "rows";
    section.issues.forEach((issue) => list.appendChild(renderRow(issue, nextId())));

    node.append(header, list);
    return node;
  }

  function renderRow(issue, id) {
    const row = document.createElement("li");
    row.className = "row" + (issue.status === "done" ? " done" : "");
    row.dataset.line = issue.line;

    const status = document.createElement("button");
    status.type = "button";
    status.className = `status ${issue.status}`;
    status.innerHTML = statusIcon(issue.status);
    status.title = `${LABEL[issue.status]} — click to change`;
    status.addEventListener("click", () =>
      setStatus(issue, ORDER[(ORDER.indexOf(issue.status) + 1) % ORDER.length])
    );

    const label = document.createElement("span");
    label.className = "row-id";
    label.textContent = id;

    const title = document.createElement("span");
    title.className = "row-title" + (issue.text ? "" : " placeholder");
    title.textContent = issue.text || "Untitled";

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

    row.append(status, label, title, more);
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

  function editIssue(row, issue) {
    edit(row.querySelector(".row-title"), issue.text, (value, viaEnter) => {
      if (!value) {
        post({ t: "deleteIssue", line: issue.line });
        return true;
      }
      if (value === issue.text && !viaEnter) {
        return false;
      }
      if (viaEnter) {
        focusAfterRender = issue.line + 1;
      }
      post({ t: "text", line: issue.line, text: value, addAfter: viaEnter });
      return true;
    });
  }

  function editSection(main, section) {
    edit(main.querySelector(".group-name"), section.title, (value) => {
      if (!value || value === section.title) {
        return false;
      }
      if (collapsed.delete(section.key)) {
        collapsed.add(value);
        persist();
      }
      post({ t: "renameSection", line: section.line, title: value });
      return true;
    });
  }

  /**
   * Swap a label for an input. `commit` reports whether it changed the
   * document; if it did, the resulting update redraws the label for us.
   */
  function edit(label, initial, commit) {
    if (!label) {
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
    const finish = (save, viaEnter) => {
      if (settled) {
        return;
      }
      settled = true;
      activeInput = null;

      // A commit changes the document, and that update redraws the label.
      if (save && commit(input.value.trim(), viaEnter)) {
        queuedPlan = null;
        return;
      }
      if (queuedPlan) {
        plan = queuedPlan;
        queuedPlan = null;
      }
      render();
    };

    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("blur", () => finish(true, false));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        finish(e.key === "Enter", e.key === "Enter");
      }
    });
  }

  function applyFocus() {
    if (focusAfterRender === null) {
      return;
    }
    if (focusAfterRender === "lastSection") {
      const last = el.sections.lastElementChild;
      if (last) {
        editSection(last.querySelector(".group-main"), plan.sections[plan.sections.length - 1]);
      }
      return;
    }
    const row = el.sections.querySelector(`.row[data-line="${focusAfterRender}"]`);
    const issue = plan.sections
      .flatMap((s) => s.issues)
      .find((i) => i.line === focusAfterRender);
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

  el.addSection.addEventListener("click", () => {
    focusAfterRender = "lastSection";
    post({ t: "addSection" });
  });

  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

  window.addEventListener("message", (e) => {
    // Redrawing would destroy an open input along with its focus and selection.
    if (activeInput) {
      queuedPlan = e.data;
      return;
    }
    plan = e.data;
    render();
    applyFocus(); // only a document update can contain the row we asked to edit
    focusAfterRender = null;
  });

  post({ t: "ready" });
})();
