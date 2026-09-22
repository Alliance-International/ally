const COMPLETION_CONTEXT_CHARS = 4000;

// Own the lifetime of a suggestion, so a late response cannot insert text into
// a different selection or a changed document (even at the same cursor index).
export function createAutocompleteController({ editor, request, onSuggestion, onClear }) {
  let enabled = false;
  let composing = false;
  let timer;
  let controller;
  let version = 0;
  let suggestion = null;

  function clear() {
    version += 1;
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    suggestion = null;
    onClear();
  }

  function isCurrent(snapshot) {
    const range = editor.getSelection();
    return enabled && !composing && editor.isEnabled() &&
      snapshot.version === version && range?.length === 0 &&
      range.index === snapshot.index &&
      editor.getText(0, range.index) === snapshot.prefix;
  }

  function schedule() {
    clear();
    if (!enabled || composing || !editor.isEnabled()) return;
    const scheduledVersion = version;
    // Quill updates the selection after text-change; read it after the debounce.
    timer = setTimeout(async () => {
      const range = editor.getSelection();
      if (scheduledVersion !== version || !range || range.length || !editor.isEnabled()) return;
      const prefix = editor.getText(0, range.index);
      if (!prefix.trim() || /[\p{L}\p{N}\p{M}]/u.test(editor.getText(range.index, 1))) return;
      const snapshot = { version, index: range.index, prefix };
      controller = new AbortController();
      const signal = controller.signal;
      try {
        // Avoid starting the bounded context halfway through an emoji.
        const context = prefix.slice(-COMPLETION_CONTEXT_CHARS).replace(/^[\uDC00-\uDFFF]/, "");
        const result = await request(context, signal);
        if (signal.aborted || !isCurrent(snapshot)) return;
        if (typeof result?.text !== "string" || !result.text.trim() || /[\r\n]/.test(result.text)) return;
        // The server returns the exact insertion, including any needed space
        // or the remaining letters of an unfinished word. Never trim it.
        suggestion = { ...snapshot, text: result.text };
        onSuggestion(suggestion);
      } catch {
        // Autocomplete is optional; a cancelled/unavailable request should not
        // interrupt typing or clear a newer suggestion.
      }
    }, 750);
  }

  return {
    clear,
    setEnabled(value) {
      enabled = Boolean(value);
      clear();
    },
    textChanged(delta, _oldDelta, source) {
      if (source === "user" && delta.ops.some((op) => typeof op.insert === "string" || op.delete)) {
        schedule();
      } else {
        clear();
      }
    },
    selectionChanged(range, _oldRange, source) {
      // API selection updates can be part of normal typing. A user cursor move,
      // selection, or blur invalidates both visible and in-flight suggestions.
      if (!range || range.length || source === "user") clear();
    },
    compositionStarted() {
      composing = true;
      clear();
    },
    compositionEnded() {
      composing = false;
      schedule();
    },
    accept() {
      if (!suggestion || !isCurrent(suggestion)) {
        clear();
        return false;
      }
      const { index, text } = suggestion;
      clear();
      editor.history.cutoff();
      editor.insertText(index, text, "user");
      editor.setSelection(index + text.length, 0, "api");
      editor.history.cutoff();
      return true;
    },
  };
}

function topicBoundary(text, index) {
  if (index === 0 || text[index - 1] === "\n") return index;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] === "\n") return i + 1;
    if (/[.!?]/.test(text[i]) && text[i + 1] === " ") return i + 2;
  }
  return 0;
}

// Quill's getText omits embeds, but its document indexes count each embed as 1.
function documentIndex(contents, textIndex) {
  let remaining = textIndex;
  let index = 0;
  for (const op of contents.ops) {
    if (typeof op.insert !== "string") {
      index += 1;
    } else if (remaining < op.insert.length) {
      return index + remaining;
    } else {
      remaining -= op.insert.length;
      index += op.insert.length;
    }
  }
  return index;
}

export function insertTopicLabels(editor, topics, Delta) {
  const text = editor.getText();
  const contents = editor.getContents();
  const boundaries = new Map();
  for (const topic of topics) {
    if (!Number.isInteger(topic.index) || topic.index < 0 || topic.index >= text.length ||
        typeof topic.topic !== "string" || !topic.topic.trim() || /[\r\n]/.test(topic.topic)) continue;
    const index = topicBoundary(text, topic.index);
    if (!boundaries.has(index)) boundaries.set(index, topic.topic.trim());
  }
  if (!boundaries.size) return 0;

  const change = new Delta();
  let previous = 0;
  for (const [textIndex, title] of [...boundaries].sort((a, b) => a[0] - b[0])) {
    const index = documentIndex(contents, textIndex);
    change.retain(index - previous);
    if (textIndex > 0 && text[textIndex - 1] !== "\n") change.insert("\n");
    change.insert(title, { bold: true }).insert("\n");
    previous = index;
  }
  // A single undoable change preserves source formatting and embeds.
  editor.history.cutoff();
  editor.updateContents(change, "user");
  editor.history.cutoff();
  return boundaries.size;
}
