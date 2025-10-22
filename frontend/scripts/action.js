import { initializeApp } from "./appLogic.js";

import {
  collection,
  query,
  onSnapshot,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";

const actionPage = (user, db) => {
  const MY_API = "https://ally-back.onrender.com";
  const currentUser = user;
  const actionLogsCollectionRef = collection(
    db,
    `users/${user.uid}/actionLogs`
  );
  let unsubscribeFromTasks = null;

  let tasks = [];
  const allStatuses = [
    "Not Started",
    "In Progress",
    "Completed",
    "Generated from Summary",
  ];
  const getAllAssignees = () => {
    const assignees = [
      ...new Set(tasks.map((t) => t.assignee).filter(Boolean)),
    ].sort();
    return assignees;
  };

  const tableBody = document.getElementById("action-items-tbody");
  const searchInput = document.getElementById("search-input");
  const taskModal = document.getElementById("task-modal");
  const taskForm = document.getElementById("task-form");
  const modalTitle = document.getElementById("modal-title");
  const taskIdInput = document.getElementById("task-id");
  const taskTitleInput = document.getElementById("task-title");
  const taskAssigneeInput = document.getElementById("task-assignee");
  const taskAssigneeEmailInput = document.getElementById("task-assignee-email");
  const taskStatusSelect = document.getElementById("task-status");
  const taskStartDateInput = document.getElementById("task-start-date");
  const taskDeadlineInput = document.getElementById("task-deadline");
  const dateError = document.getElementById("date-error");
  const createTaskBtn = document.getElementById("create-task-btn");
  const cancelBtn = document.getElementById("cancel-btn");
  const clearFiltersBtn = document.getElementById("clear-filters-btn");

  const renderTable = (tasksToRender) => {
    tableBody.innerHTML = "";
    if (tasksToRender.length === 0) {
      tableBody.innerHTML = `<tr>
        <td colspan="6" class="p-8">
          <div class="flex items-center justify-center text-center text-gray-500 h-full w-full">
            No action items found.
          </div>
        </td>
      </tr>`;
      return;
    }

    tasksToRender.forEach((task) => {
      const row = document.createElement("tr");
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const isOverdue =
        task.deadline &&
        new Date(task.deadline) < today &&
        task.status !== "Completed";

      const startDateText = task.startDate ? task.startDate : "N/A";
      const deadlineText = task.deadline ? task.deadline : "N/A";

      row.innerHTML = `
                        <td data-label="Task" class="p-4 text-sm text-left text-[#0d141c]">${
                          task.title || "No Title"
                        }</td>
                        <td data-label="Assignee" class="p-4 text-sm text-left text-[#49739c]">
                            <div class="flex flex-col">
                                <span class="font-medium text-[#0d141c]">${
                                  task.assignee || "Unassigned"
                                }</span>
                                <span class="text-xs">${
                                  task.assigneeEmail || ""
                                }</span>
                            </div>
                        </td>
                        <td data-label="Start Date" class="p-4 text-sm text-left text-[#49739c]">${startDateText}</td>
                        <td data-label="Deadline" class="p-4 text-sm text-left ${
                          isOverdue ? "text-danger" : "text-[#49739c]"
                        }">${deadlineText}</td>
                        <td data-label="Status" class="p-4 text-sm text-left"><span class="inline-block px-3 py-1 rounded-md text-xs font-medium ${
                          task.status === "Completed"
                            ? "bg-green-100 text-green-800"
                            : task.status === "In Progress"
                            ? "bg-yellow-100 text-yellow-800"
                            : task.status === "Generated from Summary"
                            ? "bg-purple-100 text-purple-800"
                            : "bg-gray-100 text-gray-800"
                        }">${task.status}</span></td>
                        <td data-label="Actions" class="p-4 text-sm text-left">
                            <div class="action-buttons-container">
                                <button class="send-email-btn text-green-600 hover:text-green-800" data-id="${
                                  task.id
                                }" title="Send Reminder Email">
                                    <img
                                      src="/img/email.png"
                                      alt="icon"
                                      width="20"
                                      height="20"
                                      style="object-fit: contain"
                                    />
                                </button>
                                <button class="edit-btn text-blue-600 hover:text-blue-800" data-id="${
                                  task.id
                                }" title="Edit Task">
                                    <img
                                      src="/img/edit.png"
                                      alt="icon"
                                      width="20"
                                      height="20"
                                      style="object-fit: contain"
                                    />
                                </button>
                                <button class="delete-btn text-red-600 hover:text-red-800" data-id="${
                                  task.id
                                }" title="Delete Task">
                                    <img
                                      src="/img/delete.png"
                                      alt="icon"
                                      width="20"
                                      height="20"
                                      style="object-fit: contain"
                                    />
                                </button>
                            </div>
                        </td>
                    `;
      tableBody.appendChild(row);
    });
  };

  const populateDropdown = (element, options, filterType) => {
    element.innerHTML = `<a href="#" class="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100" data-value="All">All ${filterType}s</a>`;
    options.forEach((opt) => {
      element.innerHTML += `<a href="#" class="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100" data-value="${opt}">${opt}</a>`;
    });
  };

  let currentFilters = { search: "", assignee: "All", status: "All" };

  const applyFilters = () => {
    let filteredTasks = [...tasks];
    if (currentFilters.search) {
      const searchTerm = currentFilters.search.toLowerCase();
      filteredTasks = filteredTasks.filter(
        (t) =>
          (t.title || "").toLowerCase().includes(searchTerm) ||
          (t.assignee || "").toLowerCase().includes(searchTerm) ||
          (t.assigneeEmail || "").toLowerCase().includes(searchTerm)
      );
    }
    if (currentFilters.assignee !== "All") {
      filteredTasks = filteredTasks.filter(
        (t) => (t.assignee || "Unassigned") === currentFilters.assignee
      );
    }
    if (currentFilters.status !== "All") {
      filteredTasks = filteredTasks.filter(
        (t) => t.status === currentFilters.status
      );
    }
    renderTable(filteredTasks);
  };

  const validateDates = () => {
    if (
      taskStartDateInput.value &&
      taskDeadlineInput.value &&
      taskDeadlineInput.value < taskStartDateInput.value
    ) {
      dateError.classList.remove("hidden");
      taskDeadlineInput.classList.add(
        "border-red-500",
        "focus:border-red-500",
        "focus:ring-red-500"
      );
      return false;
    } else {
      dateError.classList.add("hidden");
      taskDeadlineInput.classList.remove(
        "border-red-500",
        "focus:border-red-500",
        "focus:ring-red-500"
      );
      return true;
    }
  };

  taskStartDateInput.addEventListener("change", () => {
    if (taskStartDateInput.value) {
      taskDeadlineInput.min = taskStartDateInput.value;

      validateDates();
    }
  });
  taskDeadlineInput.addEventListener("change", validateDates);

  const openModal = (mode, taskId = null) => {
    taskForm.reset();

    dateError.classList.add("hidden");
    taskDeadlineInput.classList.remove(
      "border-red-500",
      "focus:border-red-500",
      "focus:ring-red-500"
    );
    taskDeadlineInput.min = "";

    populateDropdownOptions(
      taskStatusSelect,
      allStatuses.filter((s) => s !== "Generated from Summary")
    );

    if (mode === "edit") {
      const task = tasks.find((t) => t.id === taskId);
      modalTitle.textContent = "Edit Task";
      taskIdInput.value = task.id;
      taskTitleInput.value = task.title;
      taskAssigneeInput.value = task.assignee;
      taskAssigneeEmailInput.value = task.assigneeEmail || "";
      if (task.status === "In Progress" || task.status === "Completed") {
        taskStatusSelect.value = task.status;
      } else {
        taskStatusSelect.value = "Not Started";
      }
      taskStartDateInput.value = task.startDate || "";
      taskDeadlineInput.value = task.deadline || "";

      if (task.startDate) {
        taskDeadlineInput.min = task.startDate;
      }
    } else {
      modalTitle.textContent = "Create Task";
      taskIdInput.value = "";
      taskStatusSelect.value = "Not Started";
    }
    taskModal.classList.remove("hidden");
    taskModal.classList.add("flex");
  };

  const closeModal = () => {
    taskModal.classList.add("hidden");
    taskModal.classList.remove("flex");
  };

  const populateDropdownOptions = (selectElement, options) => {
    selectElement.innerHTML = "";
    options.forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = opt;
      selectElement.appendChild(option);
    });
  };

  const fetchAndRenderTasks = () => {
    if (!currentUser || !actionLogsCollectionRef) return;

    tableBody.innerHTML =
      '<tr><td colspan="6" class="text-center p-8 text-gray-500">Loading tasks...</td></tr>';

    const q = query(actionLogsCollectionRef);

    if (unsubscribeFromTasks) {
      unsubscribeFromTasks();
    }

    unsubscribeFromTasks = onSnapshot(
      q,
      (querySnapshot) => {
        tasks = [];
        querySnapshot.forEach((doc) => {
          tasks.push({ id: doc.id, ...doc.data() });
        });

        tasks.sort(
          (a, b) =>
            (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0)
        );
        applyFilters();
        updateFilterDropdowns();
      },
      (error) => {
        console.error("Error fetching tasks:", error);
        tableBody.innerHTML = `<tr><td colspan="6" class="text-center p-8 text-red-500">Error: Could not load action items.</td></tr>`;
      }
    );
  };

  taskForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!validateDates()) {
      return;
    }

    if (!actionLogsCollectionRef) return;

    const id = taskIdInput.value;
    const taskData = {
      title: taskTitleInput.value,
      assignee: taskAssigneeInput.value,
      assigneeEmail: taskAssigneeEmailInput.value,
      status: taskStatusSelect.value,
      startDate: taskStartDateInput.value || null,
      deadline: taskDeadlineInput.value || null,
    };

    try {
      if (id) {
        const taskDocRef = doc(db, `users/${currentUser.uid}/actionLogs`, id);
        await updateDoc(taskDocRef, taskData);
      } else {
        taskData.createdAt = serverTimestamp();
        await addDoc(actionLogsCollectionRef, taskData);
      }
      closeModal();
    } catch (error) {
      console.error("Failed to save task:", error);
      alert("Could not save task. Please check the connection and try again.");
    }
  });

  tableBody.addEventListener("click", async (e) => {
    const button = e.target.closest("button");
    if (!button) return;

    const id = button.dataset.id;

    if (button.classList.contains("edit-btn")) {
      openModal("edit", id);
    } else if (button.classList.contains("delete-btn")) {
      if (confirm("Are you sure you want to delete this task?")) {
        try {
          const taskDocRef = doc(db, `users/${currentUser.uid}/actionLogs`, id);
          await deleteDoc(taskDocRef);
        } catch (error) {
          console.error("Failed to delete task:", error);
          alert("Could not delete task. Please try again.");
        }
      }
    } else if (button.classList.contains("send-email-btn")) {
      const task = tasks.find((t) => t.id === id);

      if (task.status === "Completed") {
        alert("Cannot send a reminder for the task that is already completed.");
        return;
      }

      if (!task || !task.assigneeEmail) {
        alert("Cannot send email: Assignee email is missing for this task.");
        return;
      }

      const originalContent = button.innerHTML;
      button.innerHTML = `
                    <img src="/img/loading.gif" alt="Loading Spinner" width="40">`;
      button.disabled = true;

      try {
        const response = await fetch(`${MY_API}/send-manual-reminder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: task, userId: currentUser.uid }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || "Failed to send email.");
        }

        alert("Reminder email sent successfully!");
      } catch (error) {
        console.error("Failed to send manual reminder:", error);
        alert(`Error: ${error.message}`);
      } finally {
        button.innerHTML = originalContent;
        button.disabled = false;
      }
    }
  });

  const updateFilterDropdowns = () => {
    let assignees = getAllAssignees();

    if (tasks.some((t) => !t.assignee)) {
      if (!assignees.includes("Unassigned")) {
        assignees.push("Unassigned");
      }
    }
    if (assignees.length === 0) {
      assignees = ["Unassigned"];
    }

    populateDropdown(
      document.getElementById("assignee-dropdown"),
      assignees.sort(),
      "Assignee"
    );

    const statusesForFilter = allStatuses.filter(
      (s) => s !== "Generated from Summary"
    );
    populateDropdown(
      document.getElementById("status-dropdown"),
      statusesForFilter,
      "Status"
    );
  };

  const initializePageListeners = () => {
    searchInput.addEventListener("input", (e) => {
      currentFilters.search = e.target.value;
      applyFilters();
    });

    document.querySelectorAll(".filter-btn").forEach((button) => {
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        const dropdown = button.nextElementSibling;

        document.querySelectorAll(".filter-dropdown").forEach((d) => {
          if (d !== dropdown) d.style.display = "none";
        });
        dropdown.style.display =
          dropdown.style.display === "block" ? "none" : "block";
      });
    });

    document.querySelectorAll(".filter-dropdown").forEach((dropdown) => {
      dropdown.addEventListener("click", (e) => {
        e.preventDefault();
        const target = e.target.closest("a");
        if (!target) return;
        const filterType = dropdown.previousElementSibling.dataset.filterType;
        const value = target.dataset.value;
        currentFilters[filterType] = value;
        const btnText =
          value === "All"
            ? filterType.charAt(0).toUpperCase() + filterType.slice(1)
            : value;
        dropdown.previousElementSibling.querySelector("p").textContent =
          btnText;
        applyFilters();
        dropdown.style.display = "none";
      });
    });

    clearFiltersBtn.addEventListener("click", () => {
      currentFilters = { search: "", assignee: "All", status: "All" };
      searchInput.value = "";
      document
        .getElementById("assignee-filter-btn")
        .querySelector("p").textContent = "Assignee";
      document
        .getElementById("status-filter-btn")
        .querySelector("p").textContent = "Status";
      applyFilters();
    });

    createTaskBtn.addEventListener("click", () => openModal("create"));
    cancelBtn.addEventListener("click", closeModal);
    taskModal.addEventListener("click", (e) => {
      if (e.target === taskModal) closeModal();
    });

    window.addEventListener("click", () => {
      document
        .querySelectorAll(".filter-dropdown")
        .forEach((d) => (d.style.display = "none"));
    });
  };

  initializePageListeners();
  fetchAndRenderTasks();
};

initializeApp(actionPage);
