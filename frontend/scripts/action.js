import { initializeApp } from "./appLogic.js";
import {
  createActionItem,
  deleteActionItem,
  isDateOverdue,
  listActionItems,
  sourceLabel,
  statusLabel,
  subscribeToActionItems,
  updateActionItem,
} from "./dataService.js";
import { requestManualReminder } from "./reminderClient.js";
import { reviewActionItem } from "./aiClient.js";

const STATUS_OPTIONS = Object.freeze([
  ["not_started", "Not Started"],
  ["in_progress", "In Progress"],
  ["completed", "Completed"],
]);

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function actionPage() {
  const elements = {
    tableBody: document.getElementById("action-items-tbody"),
    search: document.getElementById("search-input"),
    modal: document.getElementById("task-modal"),
    form: document.getElementById("task-form"),
    modalTitle: document.getElementById("modal-title"),
    id: document.getElementById("task-id"),
    title: document.getElementById("task-title"),
    assignee: document.getElementById("task-assignee"),
    email: document.getElementById("task-assignee-email"),
    status: document.getElementById("task-status"),
    startDate: document.getElementById("task-start-date"),
    deadline: document.getElementById("task-deadline"),
    dateError: document.getElementById("date-error"),
    create: document.getElementById("create-task-btn"),
    cancel: document.getElementById("cancel-btn"),
    clearFilters: document.getElementById("clear-filters-btn"),
    assigneeDropdown: document.getElementById("assignee-dropdown"),
    statusDropdown: document.getElementById("status-dropdown"),
    tableShell: document.getElementById("action-table-shell"),
    scrollHint: document.getElementById("table-scroll-hint"),
  };
  if (Object.values(elements).some((element) => !element)) return;

  const tasks = new Map();
  let filters = { search: "", assignee: "All", status: "All" };
  let unsubscribe = null;
  let realtimeTimer = null;
  let loadSequence = 0;

  const table = elements.tableBody.closest("table");
  function updateScrollHint() {
    const shell = elements.tableShell;
    const canScrollRight =
      shell.scrollWidth - shell.clientWidth > 8 &&
      shell.scrollLeft + shell.clientWidth < shell.scrollWidth - 8;
    elements.scrollHint.hidden = !canScrollRight;
  }
  const notice = createElement(
    "div",
    "mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900",
    "Reminders are sent to the assignee email stored on the action item."
  );
  const reminderStatus = createElement("p", "mt-2 text-sm text-blue-800");
  reminderStatus.setAttribute("role", "status");
  reminderStatus.setAttribute("aria-live", "polite");
  const connection = createElement("p", "mt-2 text-xs text-slate-500");
  connection.setAttribute("role", "status");
  connection.setAttribute("aria-live", "polite");
  notice.append(reminderStatus, connection);
  table?.parentElement?.insertAdjacentElement("beforebegin", notice);

  function showTableMessage(message, className = "text-gray-500") {
    elements.scrollHint.hidden = true;
    const row = document.createElement("tr");
    row.className = "table-message-row";
    const cell = createElement("td", `p-8 text-center ${className}`, message);
    cell.colSpan = 6;
    row.appendChild(cell);
    elements.tableBody.replaceChildren(row);
  }

  function statusClass(status) {
    if (status === "completed") return "bg-green-100 text-green-800";
    if (status === "in_progress") return "bg-yellow-100 text-yellow-800";
    return "bg-gray-100 text-gray-800";
  }

  function taskRow(task) {
    const row = document.createElement("tr");
    row.className = "task-row";
    row.dataset.taskId = task.id;

    const titleCell = createElement(
      "td",
      "p-4 text-sm text-left text-[#0d141c]"
    );
    titleCell.dataset.label = "Task";
    titleCell.appendChild(createElement("span", "block", task.title));
    const source = createElement(
      "span",
      task.source === "ai_generated"
        ? "mt-1 inline-block rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-800"
        : "mt-1 inline-block rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600",
      sourceLabel(task.source)
    );
    titleCell.appendChild(source);
    if (task.source === "ai_generated") {
      const review = createElement(
        "span",
        task.reviewStatus === "confirmed"
          ? "ml-2 inline-block rounded bg-green-100 px-2 py-0.5 text-xs text-green-800"
          : task.reviewStatus === "rejected"
            ? "ml-2 inline-block rounded bg-red-100 px-2 py-0.5 text-xs text-red-800"
            : "ml-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900",
        task.reviewStatus === "confirmed"
          ? "Confirmed"
          : task.reviewStatus === "rejected"
            ? "Rejected"
            : "Needs review"
      );
      titleCell.appendChild(review);
    }

    const assigneeCell = createElement(
      "td",
      "p-4 text-sm text-left text-[#49739c]"
    );
    assigneeCell.dataset.label = "Assignee";
    assigneeCell.appendChild(
      createElement("span", "block font-medium text-[#0d141c]", task.assignee)
    );
    if (task.assigneeEmail) {
      assigneeCell.appendChild(createElement("span", "block text-xs", task.assigneeEmail));
    }

    const startCell = createElement(
      "td",
      "p-4 text-sm text-left text-[#49739c]",
      task.startDate || "N/A"
    );
    startCell.dataset.label = "Start Date";

    const deadlineCell = createElement(
      "td",
      `p-4 text-sm text-left ${
        isDateOverdue(task.deadline, task.status) ? "text-danger" : "text-[#49739c]"
      }`,
      task.deadline || "N/A"
    );
    deadlineCell.dataset.label = "Deadline";

    const statusCell = createElement("td", "p-4 text-sm text-left");
    statusCell.dataset.label = "Status";
    statusCell.appendChild(
      createElement(
        "span",
        `inline-block rounded-md px-3 py-1 text-xs font-medium ${statusClass(
          task.status
        )}`,
        statusLabel(task.status)
      )
    );

    const actionsCell = createElement("td", "p-4 text-sm text-left");
    actionsCell.dataset.label = "Actions";
    const actions = createElement("div", "task-actions");
    const toggle = createElement("button", "action-menu-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", `task-menu-${task.id}`);
    toggle.setAttribute("aria-label", `Actions for ${task.title}`);
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.classList.add("action-menu-chevron");
    chevron.setAttribute("viewBox", "0 0 20 20");
    chevron.setAttribute("fill", "none");
    chevron.setAttribute("aria-hidden", "true");
    const chevronPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    chevronPath.setAttribute("d", "m5 7.5 5 5 5-5");
    chevronPath.setAttribute("stroke", "currentColor");
    chevronPath.setAttribute("stroke-width", "1.8");
    chevronPath.setAttribute("stroke-linecap", "round");
    chevronPath.setAttribute("stroke-linejoin", "round");
    chevron.appendChild(chevronPath);
    toggle.append(
      createElement("span", "", "Actions"),
      chevron
    );
    const menu = createElement("div", "action-menu");
    menu.id = `task-menu-${task.id}`;
    menu.hidden = true;
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", `Actions for ${task.title}`);
    const edit = createElement(
      "button",
      "edit-btn action-menu-item",
      "Edit"
    );
    edit.type = "button";
    edit.dataset.id = task.id;
    edit.title = "Edit task";
    const remove = createElement(
      "button",
      "delete-btn action-menu-item action-menu-item-danger action-menu-item-separated",
      "Delete"
    );
    remove.type = "button";
    remove.dataset.id = task.id;
    remove.title = "Delete task";
    const remind = createElement(
      "button",
      "reminder-btn action-menu-item",
      "Remind"
    );
    remind.type = "button";
    remind.dataset.id = task.id;
    const reviewEligible =
      task.source !== "ai_generated" || task.reviewStatus === "confirmed";
    remind.disabled =
      !task.assigneeEmail || task.status === "completed" || !reviewEligible;
    remind.title = !task.assigneeEmail
      ? "Add an assignee email before sending a reminder"
      : !reviewEligible
        ? "Review and confirm this AI-proposed action before sending reminders"
      : task.status === "completed"
        ? "Completed actions do not need reminders"
        : "Send a reminder to the stored assignee email";
    if (task.source === "ai_generated") {
      if (task.reviewStatus !== "confirmed") {
        const confirm = createElement(
          "button",
          "confirm-btn action-menu-item action-menu-item-approve",
          "Confirm"
        );
        confirm.type = "button";
        confirm.dataset.id = task.id;
        confirm.title = "Confirm the visible task, recipient, and dates";
        menu.appendChild(confirm);
      }
      if (task.reviewStatus !== "rejected") {
        const reject = createElement(
          "button",
          "reject-btn action-menu-item action-menu-item-danger",
          "Reject"
        );
        reject.type = "button";
        reject.dataset.id = task.id;
        reject.title = "Reject this AI proposal and disable reminders";
        menu.appendChild(reject);
      }
    }
    menu.append(remind, edit, remove);
    actions.append(toggle, menu);
    actionsCell.appendChild(actions);

    row.append(
      titleCell,
      assigneeCell,
      startCell,
      deadlineCell,
      statusCell,
      actionsCell
    );
    return row;
  }

  function orderedTasks() {
    return [...tasks.values()].sort((left, right) => {
      const byDate = String(right.createdAt || "").localeCompare(
        String(left.createdAt || "")
      );
      return byDate || String(right.id).localeCompare(String(left.id));
    });
  }

  function filteredTasks() {
    const term = filters.search.toLocaleLowerCase();
    return orderedTasks().filter((task) => {
      const searchMatch =
        !term ||
        [task.title, task.assignee, task.assigneeEmail]
          .filter(Boolean)
          .some((value) => value.toLocaleLowerCase().includes(term));
      const assigneeMatch =
        filters.assignee === "All" || task.assignee === filters.assignee;
      const statusMatch = filters.status === "All" || task.status === filters.status;
      return searchMatch && assigneeMatch && statusMatch;
    });
  }

  function renderTable() {
    closeActionMenu();
    const visible = filteredTasks();
    if (!visible.length) {
      showTableMessage(
        tasks.size
          ? "No action items match the current filters."
          : "No action items found."
      );
      return;
    }
    elements.tableBody.replaceChildren(...visible.map(taskRow));
    window.requestAnimationFrame(updateScrollHint);
  }

  function closeActionMenu({ restoreFocus = false } = {}) {
    const toggle = elements.tableBody.querySelector(
      '.action-menu-toggle[aria-expanded="true"]'
    );
    if (!toggle) return;
    toggle.setAttribute("aria-expanded", "false");
    const menu = toggle.nextElementSibling;
    menu.hidden = true;
    menu.style.removeProperty("max-height");
    menu.style.removeProperty("left");
    menu.style.removeProperty("top");
    toggle.closest("tr")?.classList.remove("menu-open");
    if (restoreFocus) toggle.focus();
  }

  function toggleActionMenu(toggle) {
    const wasOpen = toggle.getAttribute("aria-expanded") === "true";
    closeActionMenu();
    if (wasOpen) return;
    const menu = toggle.nextElementSibling;
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    toggle.closest("tr")?.classList.add("menu-open");
    const anchor = toggle.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    const gap = 8;
    const roomBelow = window.innerHeight - anchor.bottom - gap;
    const roomAbove = anchor.top - gap;
    const openAbove = roomBelow < menuBounds.height && roomAbove > roomBelow;
    const availableHeight = Math.max(64, (openAbove ? roomAbove : roomBelow) - gap);
    const menuHeight = Math.min(menuBounds.height, availableHeight);
    menu.style.maxHeight = `${availableHeight}px`;
    menu.style.left = `${Math.max(gap, Math.min(anchor.right - menuBounds.width, window.innerWidth - menuBounds.width - gap))}px`;
    menu.style.top = `${openAbove ? anchor.top - menuHeight - gap : anchor.bottom + gap}px`;
  }

  function dropdownLink(label, value) {
    const link = createElement(
      "a",
      "block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100",
      label
    );
    link.href = "#";
    link.dataset.value = value;
    return link;
  }

  function populateDropdown(element, options, allLabel) {
    element.replaceChildren(dropdownLink(allLabel, "All"));
    options.forEach(([value, label]) =>
      element.appendChild(dropdownLink(label, value))
    );
  }

  function updateFilterDropdowns() {
    const assignees = [...new Set(orderedTasks().map((task) => task.assignee))]
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    populateDropdown(
      elements.assigneeDropdown,
      assignees.map((assignee) => [assignee, assignee]),
      "All Assignees"
    );
    populateDropdown(elements.statusDropdown, STATUS_OPTIONS, "All Statuses");
  }

  async function loadTasks({ showLoading = false } = {}) {
    const sequence = ++loadSequence;
    if (showLoading) showTableMessage("Loading action items…");
    try {
      const rows = await listActionItems();
      if (sequence !== loadSequence) return;
      tasks.clear();
      rows.forEach((task) => tasks.set(task.id, task));
      updateFilterDropdowns();
      renderTable();
    } catch {
      if (sequence === loadSequence) {
        showTableMessage(
          "Action items could not be loaded. Check your connection and reload this page.",
          "text-red-600"
        );
      }
    }
  }

  function validateDates() {
    const invalid = Boolean(
      elements.startDate.value &&
        elements.deadline.value &&
        elements.deadline.value < elements.startDate.value
    );
    elements.dateError.classList.toggle("hidden", !invalid);
    elements.deadline.classList.toggle("border-red-500", invalid);
    elements.deadline.classList.toggle("focus:border-red-500", invalid);
    elements.deadline.classList.toggle("focus:ring-red-500", invalid);
    return !invalid;
  }

  function populateStatusSelect() {
    elements.status.replaceChildren();
    STATUS_OPTIONS.forEach(([value, label]) => {
      const option = createElement("option", "", label);
      option.value = value;
      elements.status.appendChild(option);
    });
  }

  function openModal(mode, id = null) {
    elements.form.reset();
    populateStatusSelect();
    elements.dateError.classList.add("hidden");
    elements.deadline.min = "";
    if (mode === "edit") {
      const task = tasks.get(id);
      if (!task) return;
      elements.modalTitle.textContent = "Edit Task";
      elements.id.value = task.id;
      elements.title.value = task.title;
      elements.assignee.value = task.assignee;
      elements.email.value = task.assigneeEmail || "";
      elements.status.value = task.status;
      elements.startDate.value = task.startDate || "";
      elements.deadline.value = task.deadline || "";
      elements.deadline.min = task.startDate || "";
    } else {
      elements.modalTitle.textContent = "Create Task";
      elements.id.value = "";
      elements.status.value = "not_started";
    }
    elements.modal.classList.remove("hidden");
    elements.modal.classList.add("flex");
  }

  function closeModal() {
    elements.modal.classList.add("hidden");
    elements.modal.classList.remove("flex");
  }

  elements.startDate.addEventListener("change", () => {
    elements.deadline.min = elements.startDate.value || "";
    validateDates();
  });
  elements.deadline.addEventListener("change", validateDates);

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!validateDates()) return;
    const submit = elements.form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    const id = elements.id.value;
    const action = {
      title: elements.title.value,
      assignee: elements.assignee.value,
      assigneeEmail: elements.email.value,
      status: elements.status.value,
      startDate: elements.startDate.value || null,
      deadline: elements.deadline.value || null,
    };
    try {
      const saved = id
        ? await updateActionItem(id, action)
        : await createActionItem(action);
      tasks.set(saved.id, saved);
      closeModal();
      updateFilterDropdowns();
      renderTable();
    } catch {
      window.alert("The action item could not be saved. Check the fields and try again.");
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  elements.tableBody.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (button?.classList.contains("action-menu-toggle")) {
      toggleActionMenu(button);
      return;
    }
    const id = button?.dataset.id;
    if (!button || !id) return;
    closeActionMenu();
    if (
      button.classList.contains("confirm-btn") ||
      button.classList.contains("reject-btn")
    ) {
      const task = tasks.get(id);
      if (!task) return;
      const decision = button.classList.contains("confirm-btn")
        ? "confirmed"
        : "rejected";
      button.disabled = true;
      try {
        const reviewed = await reviewActionItem(id, task, decision);
        tasks.set(id, {
          ...task,
          title: reviewed.title,
          assignee: reviewed.assignee,
          assigneeEmail: reviewed.assignee_email,
          startDate: reviewed.start_date,
          deadline: reviewed.deadline,
          reviewStatus: reviewed.review_status,
          reviewedAt: reviewed.reviewed_at,
        });
        reminderStatus.textContent =
          decision === "confirmed"
            ? "Action confirmed. Reminder eligibility now uses the visible recipient and dates."
            : "Action rejected. Reminders are disabled for it.";
        renderTable();
      } catch {
        button.disabled = false;
        reminderStatus.textContent =
          "The review was not saved. The action remains in its previous review state.";
      }
      return;
    }
    if (button.classList.contains("reminder-btn")) {
      if (button.disabled) return;
      button.disabled = true;
      reminderStatus.textContent = "Sending reminder…";
      try {
        const result = await requestManualReminder(id);
        if (result.status === "sent") {
          reminderStatus.textContent = "Reminder accepted by the email provider.";
        } else if (result.status === "unknown") {
          reminderStatus.textContent =
            "The provider outcome is being reviewed. Please do not resend yet.";
        } else {
          reminderStatus.textContent =
            "The reminder request was recorded and will be retried safely if eligible.";
        }
      } catch (error) {
        if (error?.status === 429) {
          reminderStatus.textContent = "Too many reminder requests. Please wait and try again.";
        } else if (error?.status === 404 || error?.status === 409) {
          reminderStatus.textContent =
            "A reminder is not available for this action item.";
        } else {
          reminderStatus.textContent =
            "The reminder could not be confirmed. Retrying will reuse the same request key.";
        }
      } finally {
        const task = tasks.get(id);
        button.disabled =
          !task?.assigneeEmail ||
          task?.status === "completed" ||
          (task?.source === "ai_generated" && task?.reviewStatus !== "confirmed");
      }
      return;
    }
    if (button.classList.contains("edit-btn")) {
      openModal("edit", id);
      return;
    }
    if (!button.classList.contains("delete-btn")) return;
    if (!window.confirm("Are you sure you want to delete this task?")) return;
    button.disabled = true;
    try {
      await deleteActionItem(id);
      tasks.delete(id);
      updateFilterDropdowns();
      renderTable();
    } catch {
      button.disabled = false;
      window.alert("The action item could not be deleted. Reload and try again.");
    }
  });

  elements.search.addEventListener("input", (event) => {
    filters.search = event.target.value.trim();
    renderTable();
  });

  document.querySelectorAll(".filter-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeActionMenu();
      const dropdown = button.nextElementSibling;
      document.querySelectorAll(".filter-dropdown").forEach((candidate) => {
        if (candidate !== dropdown) candidate.style.display = "none";
      });
      dropdown.style.display =
        dropdown.style.display === "block" ? "none" : "block";
    });
  });

  document.querySelectorAll(".filter-dropdown").forEach((dropdown) => {
    dropdown.addEventListener("click", (event) => {
      event.preventDefault();
      const target = event.target.closest("a");
      if (!target) return;
      const type = dropdown.previousElementSibling.dataset.filterType;
      filters[type] = target.dataset.value;
      const label = target.textContent;
      dropdown.previousElementSibling.querySelector("p").textContent = label;
      dropdown.style.display = "none";
      renderTable();
    });
  });

  elements.clearFilters.addEventListener("click", () => {
    filters = { search: "", assignee: "All", status: "All" };
    elements.search.value = "";
    document
      .getElementById("assignee-filter-btn")
      .querySelector("p").textContent = "Assignee";
    document
      .getElementById("status-filter-btn")
      .querySelector("p").textContent = "Status";
    renderTable();
  });

  elements.create.addEventListener("click", () => openModal("create"));
  elements.cancel.addEventListener("click", closeModal);
  elements.modal.addEventListener("click", (event) => {
    if (event.target === elements.modal) closeModal();
  });
  window.addEventListener("click", () => {
    document
      .querySelectorAll(".filter-dropdown")
      .forEach((dropdown) => (dropdown.style.display = "none"));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".task-actions")) closeActionMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeActionMenu({ restoreFocus: true });
  });
  table.closest("main")?.addEventListener("scroll", () => closeActionMenu());
  window.addEventListener("scroll", () => closeActionMenu(), { passive: true });
  elements.tableShell.addEventListener(
    "scroll",
    () => {
      closeActionMenu();
      updateScrollHint();
    },
    { passive: true }
  );
  window.addEventListener("resize", () => {
    closeActionMenu();
    updateScrollHint();
  });
  updateScrollHint();

  await loadTasks({ showLoading: true });
  try {
    unsubscribe = await subscribeToActionItems(
      () => {
        window.clearTimeout(realtimeTimer);
        realtimeTimer = window.setTimeout(() => void loadTasks(), 150);
      },
      (status) => {
        if (status === "SUBSCRIBED") {
          connection.textContent = "Live updates connected";
          connection.className = "mt-2 text-xs text-emerald-700";
        } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
          connection.textContent = "Live updates disconnected — reload to refresh action items";
          connection.className = "mt-2 text-xs text-amber-700";
        }
      }
    );
  } catch {
    connection.textContent = "Live updates unavailable — reload to refresh action items";
    connection.className = "mt-2 text-xs text-amber-700";
  }

  window.addEventListener(
    "pagehide",
    () => {
      window.clearTimeout(realtimeTimer);
      unsubscribe?.();
      unsubscribe = null;
    },
    { once: true }
  );
}

initializeApp(actionPage);
