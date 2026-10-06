(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    crumb: document.getElementById("crumb-title"),
    title: document.getElementById("title"),
    meta: document.getElementById("hero-meta"),
    donutFill: document.getElementById("donut-fill"),
    pct: document.getElementById("pct"),
    toolbarLabel: document.getElementById("toolbar-label"),
    collapseAll: document.getElementById("collapse-all"),
    collapseAllLabel: document.getElementById("collapse-all-label"),
    groups: document.getElementById("groups"),
    empty: document.getElementById("empty"),
    addSection: document.getElementById("add-section"),
  };

  const STATUS_LABEL = {
    todo: "Todo",
    in_progress: "In Progress",
    done: "Done",
  };
  const STATUS_ORDER = ["todo", "in_progress", "done"];

  const DONUT_C = 2 * Math.PI * 7;
  const RING_R = 5.5;
  const RING_C = 2 * Math.PI * RING_R;

  const collapsed = new Set((vscode.getState() || {}).collapsed || []);
  let lastPlan = null;
  let pendingFocus = null;
  let openMenuEl = null;

  const post = (message) => vscode.postMessage(message);
  const persist = () => vscode.setState({ collapsed: Array.from(collapsed) });
  const groupKeyOf = (group) => group.key;

  /**
   * Collapse state is keyed by title rather than line, since any insert or
   * delete shifts the line numbers of every group below it.
   */
  function assignGroupKeys(groups) {
    const seen = new Map();
    for (const group of groups) {
      const nth = (seen.get(group.title) || 0) + 1;
      seen.set(group.title, nth);
      group.key = nth === 1 ? group.title : `${group.title}#${nth}`;
    }
  }

  /* ---------- icons ---------- */

  function svg(inner, viewBox) {
    return `<svg viewBox="${viewBox || "0 0 14 14"}" aria-hidden="true">${inner}</svg>`;
  }

  function statusIcon(status) {
    if (status === "done") {
      return svg(`
        <circle cx="7" cy="7" r="7" fill="currentColor"/>
        <path d="M4 7.3l2.1 2.1L10.2 5" fill="none" stroke="#fff" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round"/>
      `);
    }
    if (status === "in_progress") {
      return svg(`
        <circle cx="7" cy="7" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/>
        <path d="M7 3.1A3.9 3.9 0 0 1 7 10.9Z" fill="currentColor"/>
      `);
    }
    return svg(
      `<circle cx="7" cy="7" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/>`
    );
  }

  const ICON_PLUS = svg(
    `<path d="M6 2.5v7M2.5 6h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
    "0 0 12 12"
  );
  const ICON_DOTS = svg(
    `<circle cx="3" cy="6" r="1.1" fill="currentColor"/><circle cx="6" cy="6" r="1.1" fill="currentColor"/><circle cx="9" cy="6" r="1.1" fill="currentColor"/>`,
    "0 0 12 12"
  );
  const ICON_CHECK = svg(
    `<path d="M2.5 6.2l2.4 2.4L9.5 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    "0 0 12 12"
  );
  const ICON_RENAME = svg(
    `<path d="M8.2 2.6l1.2 1.2-5 5-1.6.4.4-1.6z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>`,
    "0 0 12 12"
  );
  const ICON_TRASH = svg(
    `<path d="M2.8 3.6h6.4M4.8 3.6V2.8h2.4v.8M3.6 3.6l.4 5.2h4l.4-5.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    "0 0 12 12"
  );

  /** Derive a team key: "Product Launch Plan" -> "PLP". */
  function teamKey(title) {
    const words = String(title || "")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (words.length === 0) {
      return "PLN";
    }
    if (words.length === 1) {
      return words[0].slice(0, 3).toUpperCase().padEnd(3, "N");
    }
    return words
      .filter((w) => !/^\d+$/.test(w))
      .slice(0, 3)
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .padEnd(2, "N");
  }

  /* ---------- render ---------- */

  function render(plan) {
    lastPlan = plan;
    assignGroupKeys(plan.groups);
    closeMenu();

    const { total, done, inProgress } = plan;
    const todo = total - done - inProgress;
    const ratio = total === 0 ? 0 : done / total;

    el.crumb.textContent = plan.title || "Plan";
    el.title.textContent = plan.title || "Plan";
    el.pct.textContent = `${Math.round(ratio * 100)}%`;
    el.donutFill.setAttribute("stroke-dasharray", String(DONUT_C));
    el.donutFill.setAttribute("stroke-dashoffset", String(DONUT_C * (1 - ratio)));

    el.meta.innerHTML = [
      chip("todo", todo, "Todo"),
      chip("in_progress", inProgress, "In Progress"),
      chip("done", done, "Done"),
      `<span class="chip">${total} ${total === 1 ? "issue" : "issues"}</span>`,
    ].join("");

    const key = teamKey(plan.title);
    const groups = plan.groups;
    pruneCollapsed(groups);

    el.groups.innerHTML = "";
    el.collapseAll.classList.toggle("hidden", groups.length === 0);
    el.empty.classList.toggle("hidden", groups.length > 0);
    el.toolbarLabel.textContent =
      groups.length === 0
        ? "No sections"
        : `${groups.length} ${groups.length === 1 ? "section" : "sections"}`;

    let counter = 0;
    for (const group of groups) {
      el.groups.appendChild(renderGroup(group, key, () => ++counter));
    }

    syncCollapseAllLabel();
    applyPendingFocus();
  }

  /** Forget sections that no longer exist so a re-created name starts expanded. */
  function pruneCollapsed(groups) {
    const live = new Set(groups.map((g) => g.key));
    let changed = false;
    for (const key of collapsed) {
      if (!live.has(key)) {
        collapsed.delete(key);
        changed = true;
      }
    }
    if (changed) {
      persist();
    }
  }

  function chip(status, count, label) {
    return `<span class="chip"><span class="swatch ${status}"></span><b>${count}</b> ${label}</span>`;
  }

  function renderGroup(group, key, nextIndex) {
    const gKey = groupKeyOf(group);
    const isCollapsed = collapsed.has(gKey);

    const section = document.createElement("section");
    section.className = "group" + (isCollapsed ? " collapsed" : "");

    const groupDone = group.issues.filter((i) => i.status === "done").length;
    const pct = group.issues.length === 0 ? 0 : groupDone / group.issues.length;

    const header = document.createElement("div");
    header.className = "group-header";

    const main = document.createElement("div");
    main.className = "group-main";
    main.dataset.line = String(group.line);
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
                stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C * (1 - pct)}"/>
      </svg>
      <span class="group-name"></span>
      <span class="group-count">${group.issues.length}</span>
    `;
    main.querySelector(".group-name").textContent = group.title;

    const toggle = () => {
      if (main.querySelector("input")) {
        return;
      }
      const nowCollapsed = !collapsed.has(gKey);
      if (nowCollapsed) {
        collapsed.add(gKey);
      } else {
        collapsed.delete(gKey);
      }
      section.classList.toggle("collapsed", nowCollapsed);
      main.setAttribute("aria-expanded", String(!nowCollapsed));
      persist();
      syncCollapseAllLabel();
    };

    main.addEventListener("click", toggle);
    main.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });

    const ratio = document.createElement("span");
    ratio.className = "group-ratio";
    ratio.textContent = `${groupDone}/${group.issues.length}`;

    const addBtn = iconButton(ICON_PLUS, "Add issue", (e) => {
      e.stopPropagation();
      collapsed.delete(gKey);
      persist();
      post({ type: "addIssue", groupLine: group.line });
    });

    const menuBtn = iconButton(ICON_DOTS, "Section options", (e) => {
      e.stopPropagation();
      openMenu(menuBtn, [
        {
          label: "Rename section",
          icon: ICON_RENAME,
          run: () => editGroup(main, group),
        },
        {
          label: "Delete section",
          icon: ICON_TRASH,
          danger: true,
          run: () => post({ type: "deleteGroup", line: group.line }),
        },
      ]);
    });

    header.append(main, ratio, addBtn, menuBtn);

    const list = document.createElement("ul");
    list.className = "rows";
    for (const issue of group.issues) {
      list.appendChild(renderRow(issue, key, nextIndex()));
    }

    section.append(header, list);
    return section;
  }

  function renderRow(issue, key, index) {
    const li = document.createElement("li");
    li.className = "row" + (issue.status === "done" ? " done" : "");
    li.dataset.line = String(issue.line);

    const status = document.createElement("button");
    status.type = "button";
    status.className = `status ${issue.status}`;
    status.innerHTML = statusIcon(issue.status);
    status.title = `${STATUS_LABEL[issue.status]} — click to change`;
    status.setAttribute("aria-label", `Status ${STATUS_LABEL[issue.status]}. Change status.`);
    status.addEventListener("click", () => post({ type: "toggleStatus", line: issue.line }));

    const id = document.createElement("span");
    id.className = "row-id";
    id.textContent = `${key}-${index}`;

    const title = document.createElement("span");
    title.className = "row-title" + (issue.text ? "" : " placeholder");
    title.textContent = issue.text || "Untitled";
    title.addEventListener("click", () => editIssue(li, issue));

    const menuBtn = iconButton(ICON_DOTS, "Issue options", (e) => {
      e.stopPropagation();
      openMenu(menuBtn, [
        ...STATUS_ORDER.map((s) => ({
          label: STATUS_LABEL[s],
          icon: statusIcon(s),
          iconClass: `status-glyph ${s}`,
          selected: s === issue.status,
          run: () => post({ type: "toggleStatus", line: issue.line, status: s }),
        })),
        { separator: true },
        { label: "Rename", icon: ICON_RENAME, run: () => editIssue(li, issue) },
        {
          label: "Delete",
          icon: ICON_TRASH,
          danger: true,
          run: () => post({ type: "deleteIssue", line: issue.line }),
        },
      ]);
    });

    li.append(status, id, title, menuBtn);
    return li;
  }

  function iconButton(icon, label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn";
    btn.innerHTML = icon;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", onClick);
    return btn;
  }

  /* ---------- inline editing ---------- */

  function editIssue(row, issue) {
    beginEdit(row.querySelector(".row-title"), issue.text, (value, viaEnter) => {
      if (!value) {
        post({ type: "deleteIssue", line: issue.line });
        return true;
      }
      let changed = false;
      if (value !== issue.text) {
        post({ type: "updateIssue", line: issue.line, text: value });
        changed = true;
      }
      if (viaEnter) {
        post({ type: "addIssueAfter", line: issue.line });
        changed = true;
      }
      return changed;
    });
  }

  function editGroup(main, group) {
    beginEdit(main.querySelector(".group-name"), group.title, (value) => {
      if (!value || value === group.title) {
        return false;
      }
      // Carry collapse state across the rename, since the key is the title.
      if (collapsed.delete(group.key)) {
        collapsed.add(value);
        persist();
      }
      post({ type: "renameGroup", line: group.line, title: value });
      return true;
    });
  }

  /**
   * Swaps a label for an input. `commit` returns true when it triggered a
   * document edit, meaning the re-render will restore the label for us.
   */
  function beginEdit(label, initial, commit) {
    if (!label || label.tagName === "INPUT") {
      return;
    }
    closeMenu();

    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-input";
    input.value = initial;
    input.spellcheck = false;
    label.replaceWith(input);
    input.focus();
    input.select();
    input.scrollIntoView({ block: "nearest" });

    let settled = false;
    const finish = (save, viaEnter) => {
      if (settled) {
        return;
      }
      settled = true;
      const edited = save ? commit(input.value.trim(), viaEnter) : false;
      if (!edited && lastPlan) {
        render(lastPlan);
      }
    };

    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false, false);
      }
    });
    input.addEventListener("blur", () => finish(true, false));
  }

  function applyPendingFocus() {
    if (!pendingFocus || !lastPlan) {
      return;
    }
    // The focus message arrives before the debounced re-render, so keep the
    // request queued until the target row actually exists.
    const { kind, line } = pendingFocus;

    if (kind === "issue") {
      const row = el.groups.querySelector(`.row[data-line="${line}"]`);
      const issue = findIssue(line);
      if (row && issue) {
        pendingFocus = null;
        editIssue(row, issue);
      }
      return;
    }

    const main = el.groups.querySelector(`.group-main[data-line="${line}"]`);
    const group = lastPlan.groups.find((g) => g.line === line);
    if (main && group) {
      pendingFocus = null;
      editGroup(main, group);
    }
  }

  function findIssue(line) {
    for (const group of lastPlan.groups) {
      for (const issue of group.issues) {
        if (issue.line === line) {
          return issue;
        }
      }
    }
    return undefined;
  }

  /* ---------- context menu ---------- */

  function openMenu(anchor, items) {
    closeMenu();

    const menu = document.createElement("div");
    menu.className = "menu";

    for (const item of items) {
      if (item.separator) {
        menu.appendChild(Object.assign(document.createElement("div"), { className: "menu-sep" }));
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-item" + (item.danger ? " danger" : "");
      button.innerHTML = `
        <span class="menu-icon ${item.iconClass || ""}">${item.icon || ""}</span>
        <span class="menu-label"></span>
        <span class="menu-check">${item.selected ? ICON_CHECK : ""}</span>
      `;
      button.querySelector(".menu-label").textContent = item.label;
      button.addEventListener("click", () => {
        closeMenu();
        item.run();
      });
      menu.appendChild(button);
    }

    document.body.appendChild(menu);

    const rect = anchor.getBoundingClientRect();
    const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    const left = Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, left)}px`;

    openMenuEl = menu;
    setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
  }

  function onOutside(e) {
    if (openMenuEl && !openMenuEl.contains(e.target)) {
      closeMenu();
    }
  }

  function closeMenu() {
    if (!openMenuEl) {
      return;
    }
    document.removeEventListener("mousedown", onOutside, true);
    openMenuEl.remove();
    openMenuEl = null;
  }

  /* ---------- toolbar ---------- */

  function syncCollapseAllLabel() {
    if (!lastPlan) {
      return;
    }
    const groups = lastPlan.groups;
    const allCollapsed =
      groups.length > 0 && groups.every((g) => collapsed.has(groupKeyOf(g)));
    el.collapseAllLabel.textContent = allCollapsed ? "Expand all" : "Collapse all";
  }

  el.collapseAll.addEventListener("click", () => {
    if (!lastPlan) {
      return;
    }
    const groups = lastPlan.groups;
    const allCollapsed = groups.every((g) => collapsed.has(groupKeyOf(g)));
    for (const group of groups) {
      if (allCollapsed) {
        collapsed.delete(groupKeyOf(group));
      } else {
        collapsed.add(groupKeyOf(group));
      }
    }
    persist();
    render(lastPlan);
  });

  el.addSection.addEventListener("click", () => post({ type: "addGroup" }));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMenu();
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) {
      return;
    }
    if (message.type === "update" && message.plan) {
      render(message.plan);
    } else if (message.type === "focus") {
      pendingFocus = { kind: message.kind, line: message.line };
      applyPendingFocus();
    }
  });

  post({ type: "ready" });
})();
