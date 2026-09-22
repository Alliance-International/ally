import { initializeApp } from "./appLogic.js";
import { authenticatedJson } from "./apiClient.js";
import { createAutocompleteController, insertTopicLabels } from "./editorAI.js";
import {
  askDocumentQuestion,
  autocompleteText,
  clearGenerationRetry,
  detectDocumentTopics,
  generateMeeting,
  reviewActionItem,
} from "./aiClient.js";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.4.15/+esm";

const App = (() => {
  let currentUser;

  const RICH_TEXT_POLICY = Object.freeze({
    ALLOWED_TAGS: [
      "a", "blockquote", "br", "code", "em", "h1", "h2", "h3",
      "li", "ol", "p", "pre", "s", "span", "strong", "sub", "sup",
      "u", "ul",
    ],
    ALLOWED_ATTR: ["href", "title", "class"],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["iframe", "object", "embed", "script", "style", "video"],
    FORBID_ATTR: ["style"],
  });

  const sanitizeRichHtml = (value) =>
    DOMPurify.sanitize(String(value || ""), RICH_TEXT_POLICY);

  const state = {
    currentPage: 1,
    sourceText: "",
    result: "",
    plainTextResult: "",
    emailSubject: "",
    fileName: "",
    sourceType: "text",
    proposedActions: [],
    isDictating: false,
    isRecordingMedia: false,
    isAutocompleteEnabled: false,
    isStructured: false,
    emailContentSource: "summary",
    suggestions: [],
    activeSuggestionIndex: -1,
    isSuggestionBoxVisible: false,
    suggestionCursorIndex: 0,

    transcriptionLanguage: "auto",
  };

  let quill, inputQuill, emailQuill;
  let autocomplete;
  let transcriptionAbortController;
  let mixedMediaRecorder;
  let systemStream, micStreamForSystem;
  let micRecorder = null;
  let micStream = null;
  let recordingLoaderIndex = null;
  let currentResizableImage = null;

  const el = {};
  const elementIds = [
    "step-navigation",
    "alert-container",
    "page-1",
    "page-2",
    "page-3",
    "next-btn-1",
    "back-btn-2",
    "back-btn-3",
    "start-over-btn",
    "processing-controls",
    "generating-controls",
    "cancel-upload-btn",
    "file-upload",
    "file-name",
    "source-text-preview",
    "role-select",
    "role-other-input",
    "lang-select",
    "lang-other-input",
    "get-result-btn",
    "export-result",
    "export-transcript",
    "speech-to-text-container",
    "unified-language-select",
    "record-btn",
    "recording-indicator",
    "record-system-btn",
    "system-recording-indicator",
    "include-mic-checkbox",
    "email-modal",
    "email-form",
    "email-recipients",
    "email-subject",
    "cancel-email-btn",
    "send-email-btn",
    "email-spinner",
    "send-email-btn-text",
    "email-attachments",
    "file-preview",
    "autocomplete-toggle",
    "suggestion-box",
    "detect-topics-btn",
    "qa-question-input",
    "qa-ask-btn",
    "qa-answer-container",
    "pdf-loader",
    "qa-answer",
    "transcript-qa-question-input",
    "transcript-qa-ask-btn",
    "transcript-qa-answer-container",
    "transcript-qa-answer",
    "close-qa-btn",
    "close-transcript-qa-btn",
    "manage-action-logs-btn",
    "proposed-actions",
    "fullscreen-recording-overlay",
    "overlay-mic-icon",
    "year",
    "page-1-controls",
  ];
  elementIds.forEach((id) => {
    const camelCaseId = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    el[camelCaseId] = document.getElementById(id);
  });

  const ICONS = {
    MIC_ON: `<img
                      src="/img/micon.png"
                      alt="icon"
                      width="24"
                      height="24"
                      style="object-fit: contain"
                    />
                    `,
    MIC_OFF: `<img
                      src="/img/micoff.png"
                      alt="icon"
                      width="24"
                      height="24"
                      style="object-fit: contain"
                    />`,
  };
  let fileStore = new DataTransfer();

  const api = {
    async handleReq(endpoint, options) {
      try {
        return await authenticatedJson(endpoint, options);
      } catch (error) {
        const message =
          error?.status === 429 && error?.retryAfter
            ? `Too many requests. Try again in ${error.retryAfter} seconds.`
            : error?.message || "The request could not be completed.";
        showAlert(message, "danger");
        throw error;
      }
    },
    transcribe(formData, signal) {
      return this.handleReq("/transcribe/", {
        method: "POST",
        body: formData,
        signal,
      });
    },
    uploadDocument(formData, signal) {
      return this.handleReq("/upload-document/", {
        method: "POST",
        body: formData,
        signal,
      });
    },
    sendEmail(formData) {
      return this.handleReq("/send-email/", {
        method: "POST",
        body: formData,
      });
    },
  };

  function toggleRecordingOverlay(isRecording) {
    if (isRecording) {
      el.fullscreenRecordingOverlay.classList.remove("hidden");
      el.fullscreenRecordingOverlay.classList.add("flex");
    } else {
      el.fullscreenRecordingOverlay.classList.add("hidden");
      el.fullscreenRecordingOverlay.classList.remove("flex");
    }
  }

  function showAlert(message, type = "info") {
    const alertType =
      type === "danger"
        ? "bg-red-100 border-red-500 text-red-700"
        : type === "success"
        ? "bg-green-100 border-green-500 text-green-700"
        : "bg-blue-100 border-blue-500 text-blue-700";
    const title =
      type === "danger" ? "Error" : type === "success" ? "Success" : "Info";
    const tempId = `alert-${Date.now()}`;
    const alertEl = document.createElement("div");
    alertEl.id = tempId;
    const panel = document.createElement("div");
    panel.className = `${alertType} border-l-4 p-4`;
    panel.setAttribute("role", "alert");
    const heading = document.createElement("p");
    heading.className = "font-bold";
    heading.textContent = title;
    const body = document.createElement("p");
    body.textContent = String(message || "");
    panel.append(heading, body);
    alertEl.appendChild(panel);
    el.alertContainer.appendChild(alertEl);
    setTimeout(() => document.getElementById(tempId)?.remove(), 5000);
  }

  function sourceTypeForFile(file) {
    if (file?.type?.startsWith("video/")) return "video";
    if (file?.type?.startsWith("audio/")) return "audio";
    const extension = String(file?.name || "")
      .split(".")
      .pop()
      .toLocaleLowerCase();
    if (["mp4", "mov", "mkv", "avi"].includes(extension)) return "video";
    if (["mp3", "wav", "m4a", "webm", "ogg"].includes(extension)) {
      return "audio";
    }
    return "document";
  }

  function toggleCoreUI(shouldBeEnabled) {
    if (!shouldBeEnabled) autocomplete?.clear();
    if (inputQuill) {
      inputQuill.enable(shouldBeEnabled);
    }

    const elementsToToggle = [
      el.fileUpload,
      el.recordSystemBtn,
      el.recordBtn,
      el.includeMicCheckbox,
      el.unifiedLanguageSelect,
      el.nextBtn1,
      el.autocompleteToggle,
      el.detectTopicsBtn,
      el.transcriptQaQuestionInput,
      el.transcriptQaAskBtn,
    ];

    elementsToToggle.forEach((element) => {
      if (element) {
        element.disabled = !shouldBeEnabled;
      }
    });
  }

  function saveStateToLocalStorage() {
    if (!currentUser || !currentUser.id) return;
    const stateToSave = {
      sourceText: sanitizeRichHtml(state.sourceText),
      result: sanitizeRichHtml(state.result),
      plainTextResult: state.plainTextResult,
      emailSubject: state.emailSubject,
      fileName: state.fileName,
      sourceType: state.sourceType,
      currentPage: state.currentPage,
    };
    localStorage.setItem(
      `aiMeetingWizardState_${currentUser.id}`,
      JSON.stringify(stateToSave)
    );
  }

  function loadStateFromLocalStorage() {
    if (!currentUser || !currentUser.id) return;
    try {
      const savedState = localStorage.getItem(
        `aiMeetingWizardState_${currentUser.id}`
      );
      if (savedState) {
        const parsedState = JSON.parse(savedState);

        state.sourceText = sanitizeRichHtml(parsedState.sourceText);
        state.result = sanitizeRichHtml(parsedState.result);
        state.plainTextResult = parsedState.plainTextResult || "";
        state.emailSubject = parsedState.emailSubject || "";
        state.fileName = parsedState.fileName || "";
        state.sourceType = [
          "text",
          "document",
          "audio",
          "video",
          "microphone",
          "system_audio",
        ].includes(parsedState.sourceType)
          ? parsedState.sourceType
          : "text";
        state.currentPage = parsedState.currentPage || 1;

        if (inputQuill && state.sourceText) {
          inputQuill.clipboard.dangerouslyPasteHTML(state.sourceText);
        }
        if (quill && state.result) {
          quill.clipboard.dangerouslyPasteHTML(state.result);
        }
        if (el.fileName && state.fileName) {
          el.fileName.textContent = `File: ${state.fileName}`;
        }
      }
    } catch (error) {
      console.error("Could not load state from local storage:", error);
      localStorage.removeItem(`aiMeetingWizardState_${currentUser.id}`);
    }
  }

  function updateUI() {
    document
      .querySelectorAll(".page")
      .forEach((page) => page.classList.remove("active"));
    document
      .getElementById(`page-${state.currentPage}`)
      .classList.add("active");

    document.querySelectorAll(".step-indicator").forEach((indicator) => {
      const step = parseInt(indicator.dataset.step);
      indicator.classList.remove("active", "completed");
      if (step < state.currentPage) indicator.classList.add("completed");
      else if (step === state.currentPage) indicator.classList.add("active");
    });

    el.nextBtn1.disabled = inputQuill
      ? inputQuill.getLength() <= 1 && !state.fileName
      : !state.fileName;
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = sanitizeRichHtml(state.sourceText);
    el.sourceTextPreview.textContent = tempDiv.innerText;

    if (
      state.currentPage === 3 &&
      quill &&
      quill.getSemanticHTML() !== state.result
    ) {
      quill.clipboard.dangerouslyPasteHTML(sanitizeRichHtml(state.result));
    }
    renderExportButtons(el.exportResult, quill, "summary");
    renderExportButtons(el.exportTranscript, inputQuill, "transcript");
  }

  function goToPage(pageNumber) {
    autocomplete?.clear();
    state.currentPage = pageNumber;
    updateUI();
    saveStateToLocalStorage();
  }

  function toggleProcessingControls(isProcessing) {
    if (isProcessing) autocomplete?.clear();
    if (inputQuill) inputQuill.enable(!isProcessing);
    el.recordBtn.disabled = isProcessing;
    el.recordSystemBtn.disabled = isProcessing;
    el.fileUpload.disabled = isProcessing;
    el.unifiedLanguageSelect.disabled = isProcessing;
    const page1Buttons = el.page1Controls.querySelector(".flex");
    page1Buttons.classList.toggle("hidden", isProcessing);
    el.processingControls.classList.toggle("hidden", !isProcessing);
    el.processingControls.classList.toggle("flex", isProcessing);
  }

  function toggleGeneratingControls(isGenerating) {
    el.getResultBtn.disabled = isGenerating;
    el.roleSelect.disabled = isGenerating;
    el.langSelect.disabled = isGenerating;
    el.backBtn2.disabled = isGenerating;
    el.getResultBtn.classList.toggle("hidden", isGenerating);
    el.generatingControls.classList.toggle("hidden", !isGenerating);
    el.generatingControls.classList.toggle("flex", isGenerating);
  }

  function renderExportButtons(container, quillInstance, type) {
    if (!container || !quillInstance || quillInstance.getLength() <= 1) {
      if (container) container.innerHTML = "";
      return;
    }

    container.innerHTML = `
                <span class="text-sm font-semibold text-slate-600 mr-2">Export:</span>
                <button data-action="pdf" title="Download PDF" class="p-2 rounded-md hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"><img
                  src="/img/downloadpdf.png"
                  alt="Download icon"
                  width="20"
                  height="20"
                  style="object-fit: contain"
                /></button>
                <button data-action="docx" title="Download DOCX" class="p-2 rounded-md hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"><img
                  src="/img/downloaddocx.png"
                  alt="Download icon"
                  width="20"
                  height="20"
                  style="object-fit: contain"
                /></button>
                <button data-action="txt" title="Download TXT" class="p-2 rounded-md hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"><img
                  src="/img/downloadtxt.png"
                  alt="Download icon"
                  width="20"
                  height="20"
                  style="object-fit: contain"
                /></button>
                <button data-action="copy" title="Copy Content" class="p-2 rounded-md hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"><img
                  src="/img/copy.png"
                  alt="Download icon"
                  width="20"
                  height="20"
                  style="object-fit: contain"
                /></button>
                <button data-action="email" title="Email" class="p-2 rounded-md hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"><img
                  src="/img/email.png"
                  alt="Download icon"
                  width="20"
                  height="20"
                  style="object-fit: contain"
                /></button>
            `;

    container.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const action = e.currentTarget.dataset.action;
        const filename = `${type}`;
        const editorSelector =
          type === "summary"
            ? "#result-editor-wrapper .ql-editor"
            : "#input-editor-container-wrapper .ql-editor";
        if (action === "pdf") downloadPDF(filename + ".pdf", editorSelector);
        else if (action === "docx")
          downloadDOCX(filename + ".docx", quillInstance);
        else if (action === "txt")
          downloadTXT(filename + ".txt", quillInstance);
        else if (action === "copy") copyToClipboard(quillInstance);
        else if (action === "email") {
          state.emailContentSource = type;
          showEmailModal();
        }
      });
    });
  }

  async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    state.fileName = file.name;
    state.sourceType = sourceTypeForFile(file);
    state.proposedActions = [];
    el.fileName.textContent = "File: " + file.name;
    state.sourceText = "";
    state.isStructured = false;
    if (inputQuill) inputQuill.setText("", "api");
    transcriptionAbortController = new AbortController();
    toggleProcessingControls(true);

    try {
      const endpoint = /\.(mp3|wav|mp4|m4a|webm|ogg)$/i.test(file.name)
        ? "transcribe"
        : "uploadDocument";
      const formData = new FormData();
      formData.append("file", file);

      formData.append("language", state.transcriptionLanguage);

      const data = await api[endpoint](
        formData,
        transcriptionAbortController.signal
      );
      const newText = data.transcription || data.text || "";

      if (inputQuill) inputQuill.setText(newText, "api");
      state.sourceText = sanitizeRichHtml(inputQuill.root.innerHTML);
      updateUI();
      showAlert(
        "File processed successfully! Review the content and click 'Process Content'.",
        "success"
      );
    } catch (error) {
      if (error.name !== "AbortError") {
      } else {
        showAlert("Processing cancelled.");
      }
      state.fileName = "";
      el.fileName.textContent = "";
    } finally {
      toggleProcessingControls(false);
    }
  }

  function handleSuggestionKeyDown(e) {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      autocomplete.clear();
      return;
    }
    if (!state.isSuggestionBoxVisible) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.activeSuggestionIndex =
        (state.activeSuggestionIndex + 1) % state.suggestions.length;
      updateActiveSuggestion();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      state.activeSuggestionIndex =
        (state.activeSuggestionIndex - 1 + state.suggestions.length) %
        state.suggestions.length;
      updateActiveSuggestion();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopImmediatePropagation();
      acceptSuggestion(state.activeSuggestionIndex);
    }
  }

  function proposalField(labelText, value, type = "text") {
    const wrapper = document.createElement("label");
    wrapper.className = "block text-xs font-medium text-slate-700";
    const label = document.createElement("span");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = type;
    input.value = value || "";
    input.className = "mt-1 w-full rounded border border-slate-300 p-2 text-sm";
    wrapper.append(label, input);
    return { input, wrapper };
  }

  function renderProposedActions() {
    if (!el.proposedActions) return;
    el.proposedActions.replaceChildren();
    if (!state.proposedActions.length) {
      el.proposedActions.classList.add("hidden");
      return;
    }
    el.proposedActions.classList.remove("hidden");
    const heading = document.createElement("h3");
    heading.className = "text-lg font-bold text-slate-900";
    heading.textContent = "Proposed action items";
    const explanation = document.createElement("p");
    explanation.className = "mt-1 text-sm text-slate-600";
    explanation.textContent =
      "AI suggestions need your review. Confirming an item makes it eligible for reminders; check the recipient and dates carefully.";
    el.proposedActions.append(heading, explanation);

    state.proposedActions.forEach((action, index) => {
      const card = document.createElement("section");
      card.className = "mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4";
      const badge = document.createElement("span");
      badge.className = "inline-block rounded px-2 py-1 text-xs font-bold";
      badge.textContent =
        action.review_status === "confirmed"
          ? "Confirmed"
          : action.review_status === "rejected"
            ? "Rejected"
            : "Needs review";
      badge.classList.add(
        action.review_status === "confirmed"
          ? "bg-green-100"
          : action.review_status === "rejected"
            ? "bg-red-100"
            : "bg-amber-200"
      );
      const title = proposalField("Task", action.title);
      const assignee = proposalField("Assignee", action.assignee);
      const email = proposalField("Recipient email", action.assignee_email, "email");
      const start = proposalField("Start date", action.start_date, "date");
      const deadline = proposalField("Deadline", action.deadline, "date");
      const grid = document.createElement("div");
      grid.className = "mt-3 grid gap-3 sm:grid-cols-2";
      grid.append(
        title.wrapper,
        assignee.wrapper,
        email.wrapper,
        start.wrapper,
        deadline.wrapper
      );
      if (action.evidence) {
        const evidence = document.createElement("p");
        evidence.className = "mt-3 text-xs text-slate-600";
        evidence.textContent = `Source evidence: ${action.evidence}`;
        grid.appendChild(evidence);
      }
      const controls = document.createElement("div");
      controls.className = "mt-3 flex gap-2";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "rounded bg-green-700 px-3 py-2 text-sm font-bold text-white";
      confirm.textContent = "Confirm";
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "rounded bg-red-700 px-3 py-2 text-sm font-bold text-white";
      reject.textContent = "Reject";
      const submitReview = async (decision) => {
        confirm.disabled = true;
        reject.disabled = true;
        try {
          const reviewed = await reviewActionItem(
            action.id,
            {
              title: title.input.value,
              assignee: assignee.input.value,
              assigneeEmail: email.input.value,
              startDate: start.input.value || null,
              deadline: deadline.input.value || null,
            },
            decision
          );
          state.proposedActions[index] = reviewed;
          renderProposedActions();
          showAlert(
            decision === "confirmed"
              ? "Action confirmed and now eligible for reminders."
              : "Action rejected; reminders remain disabled.",
            "success"
          );
        } catch {
          showAlert("The review was not saved. The action remains unconfirmed.", "danger");
          confirm.disabled = false;
          reject.disabled = false;
        }
      };
      confirm.addEventListener("click", () => submitReview("confirmed"));
      reject.addEventListener("click", () => submitReview("rejected"));
      controls.append(confirm, reject);
      card.append(badge, grid, controls);
      el.proposedActions.appendChild(card);
    });
  }

  async function handleGetResult() {
    const role =
      el.roleSelect.value === "Other"
        ? el.roleOtherInput.value.trim()
        : el.roleSelect.value;
    const language =
      el.langSelect.value === "Other"
        ? el.langOtherInput.value.trim()
        : el.langSelect.value;
    toggleGeneratingControls(true);

    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = sanitizeRichHtml(state.sourceText);
    const sourceTextForAI = tempDiv.innerText;

    try {
      const data = await generateMeeting({
        source_text: sourceTextForAI,
        source_type: state.sourceType,
        source_filename: state.fileName || null,
        role: role,
        target_language: language,
      });

      state.result = sanitizeRichHtml(data.formatted_result);
      state.plainTextResult = data.plain_text_summary;
      state.emailSubject = data.email_subject;
      state.proposedActions = Array.isArray(data.actions) ? data.actions : [];
      renderProposedActions();
      showAlert(
        state.proposedActions.length
          ? "Result saved. Review each proposed action before reminders can be used."
          : "Result generated and saved to your history.",
        "success"
      );
      goToPage(3);
    } catch {
    } finally {
      toggleGeneratingControls(false);
    }
  }

  async function detectTopics(text) {
    const parsedJson = await detectDocumentTopics(text);
    return parsedJson.topics
      .filter((t) => typeof t.index === "number" && t.index >= 0)
      .sort((a, b) => a.index - b.index);
  }

  async function answerQuestion(question, context) {
    try {
      const result = await askDocumentQuestion(question, context);
      return result.text.trim();
    } catch (error) {
      return "Sorry, I could not process the answer at this moment.";
    }
  }

  function init(user) {
    currentUser = user;

    initCoreApp();
  }

  function initCoreApp() {
    el.year.textContent = new Date().getFullYear();
    el.recordBtn.innerHTML = ICONS.MIC_ON;

    initQuillEditors();

    loadStateFromLocalStorage();

    setupEventListeners();

    const languages = {
      auto: "Auto Detect Language",
      en_us: "English (US)",
      en_uk: "English (UK)",
      yo: "Yoruba",
      es: "Spanish",
      fr: "French",
      de: "German",
      it: "Italian",
      ja: "Japanese",
      pt: "Portuguese",
      ru: "Russian",
      zh: "Chinese (Mandarin)",
    };
    const roles = {
      "": "No Selection",
      Manager: "Manager",
      Engineer: "Engineer",
      Designer: "Designer",
      Stakeholder: "Stakeholder",
      Other: "Other...",
    };
    const translatioLanguages = {
      "No Translation": "No Translation",
      English: "English",
      French: "French",
      Spanish: "Spanish",
      German: "German",
      Japanese: "Japanese",
      Swahili: "Swahili",
    };

    const populateSelect = (selectElement, options) => {
      if (selectElement) {
        selectElement.innerHTML = "";
        Object.entries(options).forEach(([value, text]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          selectElement.appendChild(option);
        });
      }
    };

    populateSelect(el.unifiedLanguageSelect, languages);
    el.unifiedLanguageSelect.value = state.transcriptionLanguage;

    populateSelect(el.roleSelect, roles);
    populateSelect(el.langSelect, translatioLanguages);

    renderExportButtons(el.exportTranscript, inputQuill, "transcript");

    goToPage(state.currentPage || 1);
  }

  function initQuillEditors() {
    const BlockEmbed = Quill.import("blots/block/embed");
    class LoaderBlot extends BlockEmbed {
      static create(value) {
        let node = super.create();
        node.setAttribute("contenteditable", "false");
        const loader = document.createElement("div");
        loader.className = "ql-transcribing-loader";
        const spinner = document.createElement("div");
        spinner.className = "spinner";
        const message = document.createElement("span");
        message.textContent = value || "Transcribing audio...";
        loader.append(spinner, message);
        node.appendChild(loader);
        return node;
      }
      static value(node) {
        return node.querySelector("span").textContent;
      }
    }
    LoaderBlot.blotName = "loader";
    LoaderBlot.tagName = "div";
    LoaderBlot.className = "loader-blot-wrapper";
    Quill.register(LoaderBlot);

    const ImageFormat = Quill.import("formats/image");
    class ResizableImage extends ImageFormat {
      static create(value) {
        const node = super.create(value);
        const wrapper = document.createElement("span");
        wrapper.classList.add("resizable-image-wrapper");
        ["tl", "tr", "bl", "br"].forEach((handleName) => {
          const handle = document.createElement("div");
          handle.classList.add("resize-handle", handleName);
          wrapper.appendChild(handle);
        });
        wrapper.appendChild(node);
        return wrapper;
      }
      static value(domNode) {
        const img = domNode.querySelector("img");
        return img ? ImageFormat.value(img) : null;
      }
    }
    Quill.register(ResizableImage, true);

    const Font = Quill.import("formats/font");
    Font.whitelist = [
      "inter",
      "arial",
      "times",
      "courier",
      "georgia",
      "verdana",
      "tahoma",
      "comic",
      "lucida",
    ];
    Quill.register(Font, true);

    const toolbarOptions = [
      [{ font: Font.whitelist }, { size: ["small", false, "large", "huge"] }],
      ["bold", "italic", "underline", "strike"],
      [{ color: [] }, { background: [] }],
      [{ script: "sub" }, { script: "super" }],
      [{ header: 1 }, { header: 2 }, "blockquote", "code-block"],
      [
        { list: "ordered" },
        { list: "bullet" },
        { indent: "-1" },
        { indent: "+1" },
      ],
      [{ direction: "rtl" }, { align: [] }],
      ["link", "image", "video"],
      ["clean"],
    ];

    const resultEditorWrapper = document.getElementById(
      "result-editor-wrapper"
    );
    const resultEditorDiv = document.createElement("div");
    resultEditorDiv.id = "editor-container";
    resultEditorWrapper.appendChild(resultEditorDiv);
    quill = new Quill("#editor-container", {
      modules: { toolbar: toolbarOptions },
      theme: "snow",
    });
    const resultToolbar = quill.getModule("toolbar").container;
    resultEditorWrapper.prepend(resultToolbar);
    quill.on("text-change", (delta, oldDelta, source) => {
      if (source === "user") {
        state.result = sanitizeRichHtml(quill.getSemanticHTML());
        state.plainTextResult = quill.getText();
        renderExportButtons(el.exportResult, quill, "summary");
        saveStateToLocalStorage();
      }
    });

    const inputEditorWrapper = document.getElementById(
      "input-editor-container-wrapper"
    );
    const inputEditorDiv = document.createElement("div");
    inputEditorDiv.id = "input-editor-container";
    inputEditorWrapper.appendChild(inputEditorDiv);
    inputQuill = new Quill("#input-editor-container", {
      modules: {
        toolbar: [
          ["bold", "italic", "underline"],
          [{ list: "ordered" }, { list: "bullet" }],
          ["link", "image"],
          ["clean"],
        ],
      },
      theme: "snow",
      placeholder: "Paste notes, type, or click record to dictate...",
    });
    const inputToolbar = inputQuill.getModule("toolbar").container;
    inputEditorWrapper.prepend(inputToolbar);
    autocomplete = createAutocompleteController({
      editor: inputQuill,
      request: autocompleteText,
      onSuggestion: ({ text, index }) => {
        state.suggestions = [text];
        state.suggestionCursorIndex = index;
        showSuggestions();
      },
      onClear: hideSuggestions,
    });
    inputQuill.on("selection-change", autocomplete.selectionChanged);
    inputQuill.root.addEventListener("compositionstart", autocomplete.compositionStarted);
    inputQuill.root.addEventListener("compositionend", autocomplete.compositionEnded);
    inputQuill.on("text-change", (delta, oldDelta, source) => {
      if (source === "user") {
        state.sourceText = sanitizeRichHtml(inputQuill.root.innerHTML);
        if (state.fileName) {
          state.fileName = "";
          el.fileName.textContent = "";
          el.fileUpload.value = "";
        }
        state.sourceType = "text";
        state.proposedActions = [];
        state.isStructured = false;
        updateUI();
        saveStateToLocalStorage();
      }

      autocomplete.textChanged(delta, oldDelta, source);
    });

    emailQuill = new Quill("#email-quill-editor", {
      modules: {
        toolbar: [
          ["bold", "italic", "underline", "strike"],
          [{ list: "ordered" }, { list: "bullet" }],
          ["link", "clean"],
        ],
      },
      theme: "snow",
      placeholder: "Email content will be shown here...",
    });
  }

  function setupEventListeners() {
    el.nextBtn1.addEventListener("click", () => {
      if (!el.nextBtn1.disabled) goToPage(2);
    });
    el.backBtn2.addEventListener("click", () => goToPage(1));
    el.backBtn3.addEventListener("click", () => goToPage(2));
    el.startOverBtn.addEventListener("click", () => {
      Object.assign(state, {
        currentPage: 1,
        sourceText: "",
        result: "",
        plainTextResult: "",
        emailSubject: "",
        fileName: "",
        sourceType: "text",
        proposedActions: [],
        isStructured: false,
      });
      clearGenerationRetry();
      renderProposedActions();
      if (inputQuill) inputQuill.setContents([], "api");
      if (quill) quill.setContents([], "api");
      el.fileUpload.value = "";
      el.fileName.textContent = "";
      el.alertContainer.innerHTML = "";
      el.autocompleteToggle.checked = false;
      state.isAutocompleteEnabled = false;
      autocomplete.setEnabled(false);
      goToPage(1);
      saveStateToLocalStorage();
    });

    el.fileUpload.addEventListener("change", handleFileUpload);
    el.cancelUploadBtn.addEventListener("click", () =>
      transcriptionAbortController?.abort()
    );
    el.getResultBtn.addEventListener("click", handleGetResult);

    el.roleSelect.addEventListener("change", (e) =>
      el.roleOtherInput.classList.toggle("hidden", e.target.value !== "Other")
    );
    el.langSelect.addEventListener("change", (e) =>
      el.langOtherInput.classList.toggle("hidden", e.target.value !== "Other")
    );
    el.emailForm.addEventListener("submit", handleSendEmail);
    el.cancelEmailBtn.addEventListener("click", () =>
      el.emailModal.classList.remove("visible")
    );
    el.emailAttachments.addEventListener("change", handleAttachmentChange);

    el.autocompleteToggle.addEventListener("change", (e) => {
      state.isAutocompleteEnabled = e.target.checked;
      autocomplete.setEnabled(state.isAutocompleteEnabled);
    });
    el.detectTopicsBtn.addEventListener("click", handleDetectTopics);
    el.qaAskBtn.addEventListener("click", () => handleAskQuestion("summary"));
    el.transcriptQaAskBtn.addEventListener("click", () =>
      handleAskQuestion("transcript")
    );
    el.closeQaBtn.addEventListener("click", () => {
      el.qaAnswerContainer.style.display = "none";
    });
    el.closeTranscriptQaBtn.addEventListener("click", () => {
      el.transcriptQaAnswerContainer.style.display = "none";
    });
    el.transcriptQaQuestionInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        el.transcriptQaAskBtn.click();
      }
    });
    el.qaQuestionInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        el.qaAskBtn.click();
      }
    });

    el.unifiedLanguageSelect.addEventListener("change", (e) => {
      state.transcriptionLanguage = e.target.value;

      if (state.isDictating) {
        recognition.stop();
      }
    });

    el.overlayMicIcon.addEventListener("click", () => {
      if (state.isDictating) {
        stopMicRecording();
      } else if (state.isRecordingMedia) {
        stopSystemAudioRecording();
      }
    });

    el.recordBtn.addEventListener("click", () => {
      if (state.isDictating) {
        stopMicRecording();
      } else {
        startMicRecording();
      }
    });

    el.recordSystemBtn.addEventListener("click", () => {
      if (state.isRecordingMedia) stopSystemAudioRecording();
      else handleSystemAudioRecord();
    });

    quill.root.addEventListener("click", (e) => {
      let target = e.target;
      if (
        currentResizableImage &&
        !target.closest(".resizable-image-wrapper")
      ) {
        currentResizableImage.wrapper.classList.remove("selected");
        currentResizableImage = null;
      }
      if (target.closest(".resizable-image-wrapper")) {
        const wrapper = target.closest(".resizable-image-wrapper");
        if (
          currentResizableImage &&
          currentResizableImage.wrapper !== wrapper
        ) {
          currentResizableImage.wrapper.classList.remove("selected");
        }
        currentResizableImage = {
          wrapper: wrapper,
          img: wrapper.querySelector("img"),
          handle: target.classList.contains("resize-handle") ? target : null,
        };
        wrapper.classList.add("selected");
        if (currentResizableImage.handle) initResize(e);
        e.stopPropagation();
      }
    });

    inputQuill.root.addEventListener("keydown", handleSuggestionKeyDown, true);
  }

  function initResize(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = currentResizableImage.img.offsetWidth;
    const editorWidth = quill.root.clientWidth;

    function doResize(e) {
      if (!currentResizableImage) return;
      const dx = e.clientX - startX;
      let newWidth = startWidth + dx;
      newWidth = Math.min(newWidth, editorWidth - 4);
      newWidth = Math.max(newWidth, 50);
      currentResizableImage.img.style.width = newWidth + "px";
    }

    function stopResize() {
      document.removeEventListener("mousemove", doResize, false);
      document.removeEventListener("mouseup", stopResize, false);
      const blot = Quill.find(currentResizableImage.img);
      if (blot) {
        quill.formatText(
          quill.getIndex(blot),
          1,
          "width",
          currentResizableImage.img.style.width
        );
      }
    }
    document.addEventListener("mousemove", doResize, false);
    document.addEventListener("mouseup", stopResize, false);
  }

  async function handleSystemAudioRecord() {
    if (state.isDictating) {
      showAlert("Please stop live dictation before recording media.", "info");
      return;
    }

    try {
      systemStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { channelCount: 2, sampleRate: 48000 },
      });

      if (el.includeMicCheckbox.checked) {
        try {
          micStreamForSystem = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 2, sampleRate: 48000 },
          });
        } catch (micErr) {
          showAlert(
            "Could not access microphone, but system audio recording will continue without it.",
            "info"
          );
        }
      }

      const Delta = Quill.import("delta");
      const editorLength = inputQuill.getLength();
      recordingLoaderIndex = editorLength; // Use the global index

      inputQuill.updateContents(
        new Delta()
          .retain(editorLength - 1)
          .insert("\n")
          .insert({ loader: "Recording screen and audio..." }),
        "api"
      );
      inputQuill.root.scrollTop = inputQuill.root.scrollHeight;

      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      let hasAudio = false;

      if (systemStream.getAudioTracks().length > 0) {
        const systemSource = audioContext.createMediaStreamSource(systemStream);
        systemSource.connect(destination);
        hasAudio = true;
      }
      if (
        micStreamForSystem &&
        micStreamForSystem.getAudioTracks().length > 0
      ) {
        const micSource =
          audioContext.createMediaStreamSource(micStreamForSystem);
        micSource.connect(destination);
        hasAudio = true;
      }

      if (!hasAudio) {
        showAlert(
          "No audio source found (neither system nor microphone). Recording cancelled.",
          "danger"
        );
        stopSystemAudioRecording(true);
        return;
      }

      toggleRecordingOverlay(true);
      const mixedAudioStream = destination.stream;

      systemStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (state.isRecordingMedia) stopSystemAudioRecording();
      });

      toggleCoreUI(false);

      state.isRecordingMedia = true;
      el.recordBtn.disabled = true;
      el.systemRecordingIndicator.classList.remove("hidden");
      el.recordSystemBtn.classList.add("bg-red-600");
      el.recordSystemBtn.classList.remove("bg-blue-600");
      el.includeMicCheckbox.disabled = true;

      const chunks = [];
      const mediaRecorder = new MediaRecorder(mixedAudioStream, {
        mimeType: "audio/webm;codecs=opus",
      });

      mediaRecorder.ondataavailable = (e) =>
        e.data.size > 0 && chunks.push(e.data);
      mediaRecorder.start();

      mixedMediaRecorder = mediaRecorder;

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(chunks, { type: "audio/webm" });

        inputQuill.updateContents(
          new Delta()
            .retain(recordingLoaderIndex)
            .delete(1)
            .insert({ loader: "Transcribing recorded media..." }),
          "api"
        );

        const formData = new FormData();
        formData.append("file", audioBlob, "mixed_audio.webm");
        formData.append("language", state.transcriptionLanguage);

        transcriptionAbortController = new AbortController();
        try {
          const data = await api.transcribe(
            formData,
            transcriptionAbortController.signal
          );
          const newText = data.transcription || "";

          inputQuill.updateContents(
            new Delta()
              .retain(recordingLoaderIndex)
              .delete(1)
              .insert(newText ? newText.trim() + "\n" : ""),
            "api"
          );

          state.sourceText = sanitizeRichHtml(inputQuill.root.innerHTML);
          state.sourceType = "system_audio";
          state.fileName = "";
          state.proposedActions = [];
          updateUI();
          if (newText) showAlert("Media transcribed successfully!", "success");
        } catch (error) {
          if (error.name !== "AbortError") {
            inputQuill.updateContents(
              new Delta().retain(recordingLoaderIndex).delete(1),
              "api"
            );
          }
        } finally {
          toggleCoreUI(true);
          recordingLoaderIndex = null;
        }
      };
    } catch (err) {
      if (err.name === "NotAllowedError" || err.name === "AbortError") {
        showAlert("Screen recording permission was denied.", "info");
      } else {
        console.error("Recording failed:", err);
        showAlert(
          "Could not start system audio recording. Please grant permissions.",
          "danger"
        );
      }
      toggleRecordingOverlay(false);
      stopSystemAudioRecording(true);
    }
  }

  function stopSystemAudioRecording(isCleanup = false) {
    if (mixedMediaRecorder?.state === "recording") mixedMediaRecorder.stop();
    systemStream?.getTracks().forEach((track) => track.stop());
    micStreamForSystem?.getTracks().forEach((track) => track.stop());
    systemStream = micStreamForSystem = null;

    toggleRecordingOverlay(false);

    if (state.isRecordingMedia || isCleanup) {
      state.isRecordingMedia = false;
      el.recordBtn.disabled = false;
      el.systemRecordingIndicator.classList.add("hidden");
      el.recordSystemBtn.classList.add("bg-blue-600");
      el.recordSystemBtn.classList.remove("bg-red-600");
      el.includeMicCheckbox.disabled = false;
    }
  }

  async function startMicRecording() {
    if (state.isRecordingMedia) {
      showAlert(
        "Please stop media recording before starting dictation.",
        "info"
      );
      return;
    }

    try {
      // We ask for microphone permission FIRST.
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // tehn, if permission is granted, NOW update the UI and show the loader.

      const Delta = Quill.import("delta");
      const editorLength = inputQuill.getLength();
      recordingLoaderIndex = editorLength;

      inputQuill.updateContents(
        new Delta()
          .retain(editorLength - 1)
          .insert("\n")
          .insert({ loader: "Recording... Click the microphone to stop." }),
        "api"
      );
      inputQuill.root.scrollTop = inputQuill.root.scrollHeight;

      toggleRecordingOverlay(true);
      toggleCoreUI(false);
      state.isDictating = true;
      el.recordBtn.innerHTML = ICONS.MIC_OFF;
      el.recordingIndicator.classList.remove("hidden");

      const audioChunks = [];

      const mimeTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
      const supportedMimeType = mimeTypes.find((type) =>
        MediaRecorder.isTypeSupported(type)
      );

      if (!supportedMimeType) {
        showAlert(
          "Your browser does not support the required audio recording formats.",
          "danger"
        );
        stopMicRecording();
        return;
      }

      micRecorder = new MediaRecorder(micStream, {
        mimeType: supportedMimeType,
      });

      micRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      micRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });

        inputQuill.updateContents(
          new Delta()
            .retain(recordingLoaderIndex)
            .delete(1)
            .insert({ loader: "Transcribing your dictation..." }),
          "api"
        );

        const formData = new FormData();
        formData.append("file", audioBlob, "dictation.webm");
        formData.append("language", state.transcriptionLanguage);
        transcriptionAbortController = new AbortController();

        try {
          const data = await api.transcribe(
            formData,
            transcriptionAbortController.signal
          );
          const newText = data.transcription || "";

          inputQuill.updateContents(
            new Delta()
              .retain(recordingLoaderIndex)
              .delete(1)
              .insert(newText ? newText.trim() + "\n" : ""),
            "api"
          );
          state.sourceText = sanitizeRichHtml(inputQuill.root.innerHTML);
          state.sourceType = "microphone";
          state.fileName = "";
          state.proposedActions = [];
          updateUI();
          showAlert("Dictation transcribed successfully!", "success");
        } catch (error) {
          if (error.name !== "AbortError") {
            inputQuill.updateContents(
              new Delta().retain(recordingLoaderIndex).delete(1),
              "api"
            );
          }
        } finally {
          toggleCoreUI(true);
          recordingLoaderIndex = null;
        }
      };

      micRecorder.start();
    } catch (err) {
      console.error("Microphone access error:", err);
      showAlert(
        "Could not access microphone. Please grant permission in your browser settings.",
        "danger"
      );
      stopMicRecording();
    }
  }

  function stopMicRecording() {
    if (micRecorder && micRecorder.state === "recording") {
      micRecorder.stop();
    }

    micStream?.getTracks().forEach((track) => track.stop());
    micStream = null;

    toggleRecordingOverlay(false);

    state.isDictating = false;
    el.recordBtn.innerHTML = ICONS.MIC_ON;
    el.recordingIndicator.classList.add("hidden");
  }

  function showSuggestions() {
    if (state.suggestions.length === 0) {
      hideSuggestions();
      return;
    }
    const bounds = inputQuill.getBounds(state.suggestionCursorIndex);
    if (!bounds) return;
    el.suggestionBox.innerHTML = "";
    state.suggestions.forEach((suggestion, index) => {
      const item = document.createElement("div");
      item.className = "suggestion-item";
      item.textContent = suggestion;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        acceptSuggestion(index);
      });
      el.suggestionBox.appendChild(item);
    });
    state.activeSuggestionIndex = 0;
    updateActiveSuggestion();
    const editorRect = inputQuill.container.getBoundingClientRect();
    const wrapperRect = el.suggestionBox.parentElement.getBoundingClientRect();
    el.suggestionBox.style.display = "block";
    const left = bounds.left + editorRect.left - wrapperRect.left;
    el.suggestionBox.style.left = `${Math.max(0, Math.min(left, wrapperRect.width - el.suggestionBox.offsetWidth))}px`;
    el.suggestionBox.style.top = `${bounds.bottom + editorRect.top - wrapperRect.top + 5}px`;
    state.isSuggestionBoxVisible = true;
  }

  function hideSuggestions() {
    if (!state.isSuggestionBoxVisible) return;
    el.suggestionBox.style.display = "none";
    el.suggestionBox.innerHTML = "";
    state.isSuggestionBoxVisible = false;
    state.suggestions = [];
    state.activeSuggestionIndex = -1;
  }

  function updateActiveSuggestion() {
    el.suggestionBox.childNodes.forEach((child, index) => {
      child.classList.toggle("active", index === state.activeSuggestionIndex);
    });
  }

  function acceptSuggestion(index) {
    if (index < 0 || index >= state.suggestions.length) return;
    autocomplete.accept();
  }

  async function handleDetectTopics() {
    if (state.isStructured) {
      showAlert(
        "Topics have already been arranged. Please edit the text to re-enable.",
        "info"
      );
      return;
    }
    const sourceText = inputQuill.getText();
    if (!sourceText.trim()) {
      showAlert("Please provide some text first.", "info");
      return;
    }
    el.detectTopicsBtn.disabled = true;
    autocomplete.clear();
    el.detectTopicsBtn.innerHTML =
      '<div class="h-5 w-5 border-t-2 border-white rounded-full animate-spin mx-auto"></div>';
    try {
      const topics = await detectTopics(sourceText);
      if (inputQuill.getText() !== sourceText) {
        showAlert("The text changed while topics were being detected. Please try again.", "info");
        return;
      }
      if (insertTopicLabels(inputQuill, topics, Quill.import("delta")) > 0) {
        autocomplete.clear();
        state.sourceText = sanitizeRichHtml(inputQuill.root.innerHTML);
        state.isStructured = true;
        updateUI();
        saveStateToLocalStorage();
        showAlert("Topics detected and labeled in the text.", "success");
      } else {
        showAlert("No distinct topics were detected.", "info");
      }
    } catch (error) {
      showAlert(
        error?.message || "Topic detection is temporarily unavailable.",
        "danger"
      );
    } finally {
      el.detectTopicsBtn.disabled = false;
      el.detectTopicsBtn.textContent = "Detect & Label Topics";
    }
  }

  async function handleAskQuestion(source = "summary") {
    const isTranscript = source === "transcript";
    const questionInput = isTranscript
      ? el.transcriptQaQuestionInput
      : el.qaQuestionInput;
    const askBtn = isTranscript ? el.transcriptQaAskBtn : el.qaAskBtn;
    const answerContainer = isTranscript
      ? el.transcriptQaAnswerContainer
      : el.qaAnswerContainer;
    const answerEl = isTranscript ? el.transcriptQaAnswer : el.qaAnswer;
    const context = isTranscript ? inputQuill.getText() : quill.getText();
    const question = questionInput.value.trim();

    if (!question) {
      showAlert("Please enter a question.", "info");
      return;
    }
    if (!context.trim()) {
      showAlert(
        `There is no ${
          isTranscript ? "transcript" : "summary"
        } to ask questions about.`,
        "info"
      );
      return;
    }

    askBtn.disabled = true;
    askBtn.innerHTML =
      '<div class="h-5 w-5 border-t-2 border-white rounded-full animate-spin mx-auto"></div>';
    answerContainer.style.display = "none";

    try {
      const answer = await answerQuestion(question, context);
      answerEl.textContent = answer;
      answerContainer.style.display = "block";
    } finally {
      askBtn.disabled = false;
      askBtn.textContent = "Ask";
    }
  }

  async function showEmailModal() {
    let sourceQuill =
      state.emailContentSource === "transcript" ? inputQuill : quill;
    let subject =
      state.emailContentSource === "transcript"
        ? state.fileName
          ? `Transcript: ${state.fileName}`
          : "Ally - Transcript"
        : state.emailSubject || "AI Wizard Result";

    emailQuill.setContents(sourceQuill.getContents());
    el.emailSubject.value = subject;
    fileStore = new DataTransfer();
    updateFilePreview();
    el.emailModal.classList.add("visible");
  }

  function handleAttachmentChange() {
    for (const file of el.emailAttachments.files) fileStore.items.add(file);
    updateFilePreview();
  }

  function updateFilePreview() {
    el.filePreview.innerHTML = "";
    for (let i = 0; i < fileStore.files.length; i++) {
      const file = fileStore.files[i];
      const badge = document.createElement("div");
      badge.className = "file-preview-badge";
      badge.textContent = file.name;
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "×";
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        removeFile(i);
      };
      badge.appendChild(removeBtn);
      el.filePreview.appendChild(badge);
    }
    el.emailAttachments.files = fileStore.files;
  }

  function removeFile(index) {
    const newFiles = new DataTransfer();
    for (let i = 0; i < fileStore.files.length; i++) {
      if (i !== index) newFiles.items.add(fileStore.files[i]);
    }
    fileStore = newFiles;
    updateFilePreview();
  }

  async function handleSendEmail(e) {
    e.preventDefault();
    if (!emailQuill) {
      showAlert("Email editor is not ready.", "danger");
      return;
    }

    el.sendEmailBtn.disabled = true;
    el.emailSpinner.classList.remove("hidden");
    el.sendEmailBtnText.textContent = "Sending...";

    const formData = new FormData();
    formData.append("recipients", el.emailRecipients.value);
    formData.append("subject", el.emailSubject.value);

    const finalAttachments = new DataTransfer();
    for (const file of fileStore.files) finalAttachments.items.add(file);

    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = sanitizeRichHtml(emailQuill.root.innerHTML);
    const images = tempDiv.querySelectorAll("img");
    let imageCounter = 0;

    const dataURLtoFile = async (dataurl, filename) => {
      const res = await fetch(dataurl);
      const blob = await res.blob();
      return new File([blob], filename, { type: blob.type });
    };

    const imagePromises = Array.from(images).map((img) => {
      if (img.src.startsWith("data:")) {
        imageCounter++;
        return dataURLtoFile(img.src, `image-${imageCounter}.png`).then(
          (file) => {
            finalAttachments.items.add(file);
            img.parentNode.removeChild(img);
          }
        );
      }
      return Promise.resolve();
    });

    await Promise.all(imagePromises);
    formData.append("html_body", tempDiv.innerHTML);
    for (const file of finalAttachments.files)
      formData.append("attachments", file);
    if (!formData.has("attachments"))
      formData.append("attachments", new Blob(), "");

    try {
      await api.sendEmail(formData);
      showAlert("Email(s) queued for sending!", "success");
      el.emailModal.classList.remove("visible");
      el.emailForm.reset();
      if (emailQuill) emailQuill.setText("");
      fileStore = new DataTransfer();
      updateFilePreview();
    } finally {
      el.sendEmailBtn.disabled = false;
      el.emailSpinner.classList.add("hidden");
      el.sendEmailBtnText.textContent = "Send";
    }
  }

  function downloadPDF(filename, editorSelector) {
    el.pdfLoader.style.display = "flex";
    setTimeout(() => {
      try {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({
          orientation: "p",
          unit: "pt",
          format: "a4",
        });

        const editorRoot = document.querySelector(editorSelector);
        if (!editorRoot)
          throw new Error(
            `Editor content not found with selector: ${editorSelector}!`
          );

        const MARGIN = 40;
        const PAGE_WIDTH = pdf.internal.pageSize.getWidth();
        const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
        let y = MARGIN;

        const checkPageBreak = (neededHeight = 0) => {
          if (y + neededHeight > pdf.internal.pageSize.getHeight() - MARGIN) {
            pdf.addPage();
            y = MARGIN;
          }
        };

        const parseColor = (colorString) => {
          const defaults = { r: 0, g: 0, b: 0, a: 1 };
          if (!colorString || colorString === "transparent") return defaults;
          let match;
          if ((match = colorString.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/))) {
            return {
              r: parseInt(match[1]),
              g: parseInt(match[2]),
              b: parseInt(match[3]),
              a: 1,
            };
          }
          if (
            (match = colorString.match(
              /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)$/
            ))
          ) {
            return {
              r: parseInt(match[1]),
              g: parseInt(match[2]),
              b: parseInt(match[3]),
              a: parseFloat(match[4]),
            };
          }
          return defaults;
        };

        const processNode = (node) => {
          const img = node.querySelector("img");
          if (
            img &&
            img.src.startsWith("data:image") &&
            (!node.innerText || node.innerText.trim() === "")
          ) {
            const imgData = img.src;
            const aspectRatio =
              (img.naturalHeight || 200) / (img.naturalWidth || 200);
            let pdfImageWidth =
              img.width > CONTENT_WIDTH ? CONTENT_WIDTH : img.width;
            const pdfImageHeight = pdfImageWidth * aspectRatio;
            checkPageBreak(pdfImageHeight + 10);
            const alignment = node.classList.contains("ql-align-center")
              ? "center"
              : node.classList.contains("ql-align-right")
              ? "right"
              : "left";
            let xPos = MARGIN;
            if (alignment === "center") xPos = (PAGE_WIDTH - pdfImageWidth) / 2;
            else if (alignment === "right")
              xPos = PAGE_WIDTH - MARGIN - pdfImageWidth;
            try {
              const imageType = imgData.substring(
                imgData.indexOf("/") + 1,
                imgData.indexOf(";")
              );
              pdf.addImage(
                imgData,
                imageType.toUpperCase(),
                xPos,
                y,
                pdfImageWidth,
                pdfImageHeight
              );
              y += pdfImageHeight + 10;
            } catch (e) {
              console.error("Could not add image to PDF.", e);
            }
            return;
          }

          const alignment = node.classList.contains("ql-align-center")
            ? "center"
            : node.classList.contains("ql-align-right")
            ? "right"
            : "left";
          const listIndent =
            parseInt(node.className.match(/ql-indent-(\d+)/)?.[1] || 0) * 25;
          const isListItem = node.tagName === "LI";
          const fragments = [];
          const collectFragments = (currentNode, parentStyles) => {
            const styles = { ...parentStyles };
            if (currentNode.nodeType === Node.ELEMENT_NODE) {
              if (
                currentNode.tagName === "SPAN" &&
                currentNode.classList.contains("resizable-image-wrapper")
              )
                return;
              const computedStyle = window.getComputedStyle(currentNode);
              const tagName = currentNode.tagName.toLowerCase();
              styles.bold =
                ["strong", "b"].includes(tagName) ||
                computedStyle.fontWeight === "700" ||
                computedStyle.fontWeight === "bold";
              styles.italic =
                ["em", "i"].includes(tagName) ||
                computedStyle.fontStyle === "italic";
              styles.underline =
                ["u"].includes(tagName) ||
                computedStyle.textDecorationLine.includes("underline");
              styles.strikethrough =
                ["s"].includes(tagName) ||
                computedStyle.textDecorationLine.includes("line-through");
              styles.color = computedStyle.color;
              styles.bgColor = computedStyle.backgroundColor;
              let fontSize = parseFloat(computedStyle.fontSize) * 0.75;
              if (tagName.match(/^h[1-6]$/))
                fontSize =
                  { h1: 20, h2: 18, h3: 16, h4: 14, h5: 12, h6: 11 }[tagName] ||
                  fontSize;
              styles.fontSize = fontSize || 12;
              styles.lineHeight = styles.fontSize * 1.4;
            }
            for (const child of Array.from(currentNode.childNodes)) {
              if (child.nodeType === Node.TEXT_NODE && child.textContent)
                fragments.push({ text: child.textContent, styles });
              else if (child.nodeType === Node.ELEMENT_NODE)
                collectFragments(child, styles);
            }
          };
          collectFragments(node, {});

          if (fragments.length === 0 && node.tagName !== "SPAN") {
            y += 10;
            checkPageBreak();
            return;
          }

          const lines = [];
          let currentLine = [];
          let currentLineWidth = 0;
          const blockStartX = MARGIN + listIndent;
          const availableWidth =
            CONTENT_WIDTH - listIndent - (isListItem ? 15 : 0);

          fragments.forEach((fragment) => {
            const { text, styles } = fragment;
            let fontStyle =
              styles.bold && styles.italic
                ? "bolditalic"
                : styles.bold
                ? "bold"
                : styles.italic
                ? "italic"
                : "normal";
            pdf.setFont("helvetica", fontStyle);
            pdf.setFontSize(styles.fontSize);
            const words = text.split(/(\s+)/);
            words.forEach((word) => {
              if (!word) return;
              const wordWidth = pdf.getTextWidth(word);
              if (
                currentLineWidth + wordWidth > availableWidth &&
                currentLine.length > 0
              ) {
                lines.push({
                  fragments: currentLine,
                  width: currentLineWidth,
                  height: currentLine[0]?.styles.lineHeight || 12,
                });
                currentLine = [];
                currentLineWidth = 0;
              }
              currentLine.push({
                ...fragment,
                text: word,
                width: wordWidth,
              });
              currentLineWidth += wordWidth;
            });
          });
          if (currentLine.length > 0)
            lines.push({
              fragments: currentLine,
              width: currentLineWidth,
              height: currentLine[0]?.styles.lineHeight || 12,
            });

          y += 5;
          checkPageBreak(lines[0]?.height || 12);
          if (isListItem) pdf.text("•", MARGIN + listIndent, y);

          lines.forEach((line) => {
            let currentX = blockStartX + (isListItem ? 15 : 0);
            if (alignment === "center" && !isListItem)
              currentX = MARGIN + (CONTENT_WIDTH - line.width) / 2;
            else if (alignment === "right" && !isListItem)
              currentX = MARGIN + CONTENT_WIDTH - line.width;
            checkPageBreak(line.height);
            line.fragments.forEach((frag) => {
              const { text, styles, width } = frag;
              let fontStyle =
                styles.bold && styles.italic
                  ? "bolditalic"
                  : styles.bold
                  ? "bold"
                  : styles.italic
                  ? "italic"
                  : "normal";
              const textColor = parseColor(styles.color);
              const bgColor = parseColor(styles.bgColor);
              pdf.setFont("helvetica", fontStyle);
              pdf.setFontSize(styles.fontSize);
              pdf.setTextColor(textColor.r, textColor.g, textColor.b);
              if (bgColor.a > 0.1) {
                pdf.setFillColor(bgColor.r, bgColor.g, bgColor.b);
                pdf.rect(
                  currentX,
                  y - styles.fontSize + 3,
                  width,
                  styles.fontSize,
                  "F"
                );
              }
              pdf.text(text, currentX, y);
              if (styles.underline)
                pdf.line(currentX, y + 2, currentX + width, y + 2);
              if (styles.strikethrough)
                pdf.line(
                  currentX,
                  y - styles.fontSize / 3,
                  currentX + width,
                  y - styles.fontSize / 3
                );
              currentX += width;
            });
            y += line.height;
          });
        };
        Array.from(editorRoot.children).forEach(processNode);
        pdf.save(filename);
      } catch (error) {
        console.error("Error generating PDF:", error);
        showAlert(`Could not generate PDF. ${error.message}`, "danger");
      } finally {
        el.pdfLoader.style.display = "none";
      }
    }, 50);
  }

  function downloadTXT(filename, quillInstance) {
    try {
      if (!quillInstance) throw new Error("Editor instance is not available.");
      const text = quillInstance.getText();
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
      showAlert("TXT file downloaded.", "success");
    } catch (err) {
      console.error("Error downloading TXT:", err);
      showAlert("Could not download TXT file.", "danger");
    }
  }

  function downloadDOCX(filename, quillInstance) {
    try {
      if (!quillInstance) throw new Error("Editor instance is not available.");
      if (typeof htmlDocx === "undefined" || typeof saveAs === "undefined") {
        showAlert("DOCX generation library not loaded.", "danger");
        return;
      }
      const contentHtml = quillInstance.root.innerHTML;
      const converted = htmlDocx.asBlob(contentHtml, {
        orientation: "portrait",
        margins: { top: 720, bottom: 720, left: 720, right: 720 },
      });
      saveAs(converted, filename);
      showAlert("DOCX file downloaded.", "success");
    } catch (err) {
      console.error("Error generating DOCX:", err);
      showAlert("Could not generate DOCX file.", "danger");
    }
  }

  function copyToClipboard(quillInstance) {
    if (!quillInstance) {
      showAlert("Editor instance not available for copying.", "danger");
      return;
    }

    const html = quillInstance.root.innerHTML;
    const text = quillInstance.getText();

    const clipboardItem = new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    });

    navigator.clipboard
      .write([clipboardItem])
      .then(() => {
        showAlert("Copied to clipboard!", "success");
      })
      .catch(() => {
        showAlert("Failed to copy content.", "danger");
      });
  }

  return {
    init: init,
  };
})();

initializeApp((user) => {
  App.init(user);
});
