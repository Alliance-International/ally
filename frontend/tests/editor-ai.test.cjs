const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

async function loadEditorAI() {
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    AbortController,
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  const module = new vm.SourceTextModule(fs.readFileSync(
    path.resolve(__dirname, "../scripts/editorAI.js"), "utf8"
  ), { context });
  await module.link(() => { throw new Error("Unexpected import"); });
  await module.evaluate();
  return {
    ...module.namespace,
    tick() {
      const pending = [...timers.values()];
      timers.clear();
      return Promise.all(pending.map((callback) => callback()));
    },
  };
}

class Delta {
  ops = [];
  retain(count) { if (count) this.ops.push({ retain: count }); return this; }
  insert(value, attributes) { this.ops.push({ insert: value, attributes }); return this; }
}

function editorFor(text, contents = [{ insert: text }]) {
  let cells = contents.flatMap((op) => typeof op.insert === "string"
    ? op.insert.split("").map((insert) => ({ insert, attributes: op.attributes }))
    : [op]);
  return {
    text,
    range: { index: text.length - 1, length: 0 },
    enabled: true,
    history: { cutoff() {} },
    getSelection() { return this.range; },
    isEnabled() { return this.enabled; },
    getText(index = 0, length = this.text.length) { return this.text.slice(index, index + length); },
    getContents() { return { ops: cells }; },
    setSelection(index, length) { this.range = { index, length }; },
    insertText(index, value, source) {
      this.text = this.text.slice(0, index) + value + this.text.slice(index);
      this.inserted = { index, value, source };
    },
    updateContents(change, source) {
      const result = [];
      let offset = 0;
      for (const op of change.ops) {
        if (op.retain) {
          result.push(...cells.slice(offset, offset + op.retain));
          offset += op.retain;
        } else {
          result.push(...op.insert.split("").map((insert) => ({ insert, attributes: op.attributes })));
        }
      }
      cells = result.concat(cells.slice(offset));
      this.text = cells.map((cell) => typeof cell.insert === "string" ? cell.insert : "").join("");
      this.updated = { change, source };
    },
  };
}

async function completionHarness(text = "I am going to the \n") {
  const ai = await loadEditorAI();
  const editor = editorFor(text);
  const calls = [];
  let visible = null;
  const controller = ai.createAutocompleteController({
    editor,
    request(text, signal) {
      return new Promise((resolve, reject) => calls.push({ text, signal, resolve, reject }));
    },
    onSuggestion(value) { visible = value; },
    onClear() { visible = null; },
  });
  controller.setEnabled(true);
  return { ai, editor, calls, controller, visible: () => visible };
}

const type = (controller) => controller.textChanged({ ops: [{ insert: "x" }] }, null, "user");

test("completion uses previous paragraphs, keeps trailing space, and works beyond 200 characters", async () => {
  const prefix = "Market shopping notes. ".repeat(20) + "\nI am going to the ";
  const h = await completionHarness(prefix + "\n");
  type(h.controller);
  const pending = h.ai.tick();
  assert.equal(h.calls[0].text, prefix);
  h.calls[0].resolve({ text: "market" });
  await pending;
  assert.equal(h.visible().text, "market");
  assert.equal(h.controller.accept(), true);
  assert.equal(h.editor.text, prefix + "market\n");
  assert.equal(h.editor.range.index, prefix.length + 6);
});

test("completion sends at most 4000 characters before the cursor", async () => {
  const prefix = "Earlier context. ".repeat(400) + "I am going to the ";
  const h = await completionHarness(prefix + "after the cursor\n");
  h.editor.range.index = prefix.length;
  // A word already follows the cursor: leave it alone.
  type(h.controller);
  await h.ai.tick();
  assert.equal(h.calls.length, 0);
  h.editor.text = prefix + "\n";
  type(h.controller);
  const pending = h.ai.tick();
  assert.equal(h.calls[0].text, prefix.slice(-4000));
  h.calls[0].resolve({ text: "market" });
  await pending;
});

test("completion accepts exactly the returned spacing or partial-word suffix", async () => {
  for (const [prefix, insertion] of [["I am going to the", " market"], ["I am going to the mar", "ket"]]) {
    const h = await completionHarness(prefix + "\n");
    type(h.controller);
    const pending = h.ai.tick();
    h.calls[0].resolve({ text: insertion });
    await pending;
    h.controller.accept();
    assert.equal(h.editor.text, "I am going to the market\n");
    assert.equal(h.editor.inserted.source, "user");
  }
});

test("completion inserts a contextual multi-word suggestion as one editor change", async () => {
  const prefix = "The meeting was productive. We agreed to";
  const h = await completionHarness(prefix + "\n");
  type(h.controller);
  const pending = h.ai.tick();
  h.calls[0].resolve({ text: " review the proposal again on Friday." });
  await pending;
  assert.equal(h.visible().text, " review the proposal again on Friday.");
  assert.equal(h.controller.accept(), true);
  assert.equal(
    h.editor.text,
    "The meeting was productive. We agreed to review the proposal again on Friday.\n"
  );
});

test("short input is eligible and debounce sends only the last typing request", async () => {
  const h = await completionHarness("I \n");
  type(h.controller);
  type(h.controller);
  type(h.controller);
  const pending = h.ai.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].text, "I ");
  h.calls[0].resolve({ text: "am" });
  await pending;
});

test("a late response cannot replace a newer suggestion at the same cursor index", async () => {
  const h = await completionHarness();
  type(h.controller);
  const old = h.ai.tick();
  h.editor.text = "We go over to the \n";
  h.editor.range.index = h.editor.text.length - 1;
  type(h.controller);
  const current = h.ai.tick();
  assert.equal(h.calls[0].signal.aborted, true);
  h.calls[1].resolve({ text: "office" });
  await current;
  h.calls[0].resolve({ text: "market" });
  await old;
  assert.equal(h.visible().text, "office");
});

test("deletion, toggle off, cursor moves, blur, selection, API edits and Escape invalidate requests", async () => {
  const invalidate = [
    (h) => h.controller.textChanged({ ops: [{ delete: 1 }] }, null, "user"),
    (h) => h.controller.setEnabled(false),
    (h) => h.controller.selectionChanged({ index: 1, length: 0 }, null, "user"),
    (h) => h.controller.selectionChanged(null, null, "api"),
    (h) => h.controller.selectionChanged({ index: 1, length: 2 }, null, "api"),
    (h) => h.controller.textChanged({ ops: [{ insert: "x" }] }, null, "api"),
    (h) => h.controller.clear(),
  ];
  for (const cancel of invalidate) {
    const h = await completionHarness();
    type(h.controller);
    const pending = h.ai.tick();
    cancel(h);
    h.calls[0].resolve({ text: "market" });
    await pending;
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.visible(), null);
    assert.equal(h.controller.accept(), false);
  }
});

test("visible suggestions disappear immediately when text changes", async () => {
  const h = await completionHarness();
  type(h.controller);
  const pending = h.ai.tick();
  h.calls[0].resolve({ text: "market" });
  await pending;
  assert.ok(h.visible());
  type(h.controller);
  assert.equal(h.visible(), null);
});

test("composition waits until committed and failures leave the document untouched", async () => {
  const h = await completionHarness();
  h.controller.compositionStarted();
  type(h.controller);
  await h.ai.tick();
  assert.equal(h.calls.length, 0);
  h.controller.compositionEnded();
  const pending = h.ai.tick();
  h.calls[0].reject(new Error("AI unavailable"));
  await pending;
  assert.equal(h.visible(), null);
  assert.equal(h.editor.text, "I am going to the \n");
});

test("topic labels keep emoji offsets and existing formatting in one undoable edit", async () => {
  const { insertTopicLabels } = await loadEditorAI();
  const text = "🚀 Launch approved.\nHiring starts Monday.\n";
  const editor = editorFor(text, [{ insert: text, attributes: { italic: true } }]);
  const count = insertTopicLabels(editor, [
    { topic: "Hiring", index: text.indexOf("Hiring") },
    { topic: "Launch", index: 0 },
  ], Delta);
  assert.equal(count, 2);
  assert.equal(editor.text, "Launch\n🚀 Launch approved.\nHiring\nHiring starts Monday.\n");
  assert.equal(editor.updated.source, "user");
  assert.equal(editor.getContents().ops[0].attributes.bold, true);
  assert.equal(editor.getContents().ops[7].attributes.italic, true);
});

test("topic labels account for embeds omitted by getText", async () => {
  const { insertTopicLabels } = await loadEditorAI();
  const text = "First.\nSecond.\n";
  const embed = { insert: { image: "test-image" } };
  const editor = editorFor(text, [{ insert: "First." }, embed, { insert: "\nSecond.\n" }]);
  insertTopicLabels(editor, [{ topic: "Second topic", index: 7 }], Delta);
  assert.equal(editor.text, "First.\nSecond topic\nSecond.\n");
  assert.ok(editor.getContents().ops.includes(embed));
});

test("topics sharing an insertion boundary are deduplicated and bad indexes are ignored", async () => {
  const { insertTopicLabels } = await loadEditorAI();
  const editor = editorFor("First paragraph here.\nSecond paragraph.\n");
  const count = insertTopicLabels(editor, [
    { topic: "First", index: 0 }, { topic: "Duplicate", index: 8 },
    { topic: "Bad", index: -1 }, { topic: "Bad", index: 1000 },
    { topic: "Bad", index: 1.5 }, { topic: "Bad\nHeading", index: 22 },
  ], Delta);
  assert.equal(count, 1);
  assert.equal(editor.text, "First\nFirst paragraph here.\nSecond paragraph.\n");
});

test("repeated detection cannot add renamed labels at headings or inside their body after reload", async () => {
  const { insertTopicLabels, hasUntitledTopicSections } = await loadEditorAI();
  const editor = editorFor("We approved spending.\nHiring starts Monday.\n");
  assert.equal(insertTopicLabels(editor, [{ topic: "Project update", index: 0 }], Delta), 1);
  const reloaded = editorFor(editor.text, editor.getContents().ops);
  assert.equal(hasUntitledTopicSections(reloaded), false);
  assert.equal(insertTopicLabels(reloaded, [
    { topic: "Another update", index: 0 },
    { topic: "Different label", index: reloaded.text.indexOf("We approved") },
    { topic: "Hiring duplicate", index: reloaded.text.indexOf("Hiring") },
  ], Delta), 0);
  assert.equal(reloaded.text, editor.text);
  assert.equal(reloaded.updated, undefined);
});

test("plain-text headings protect their body while untitled sections can still be labelled", async () => {
  const { insertTopicLabels, hasUntitledTopicSections } = await loadEditorAI();
  for (const heading of ["TECHNICAL SKILLS", "Technical skills", "# Technical skills", "**Technical skills**", "2. Technical skills", "Skills:"]) {
    const text = `${heading}\n\nWe build APIs.\n\nA separate section needs a heading.\n`;
    const editor = editorFor(text);
    assert.equal(hasUntitledTopicSections(editor), true);
    assert.equal(insertTopicLabels(editor, [
      { topic: "Duplicate", index: 0 },
      { topic: "Inside body", index: text.indexOf("We build") },
      { topic: "New section", index: text.indexOf("A separate") },
    ], Delta), 1);
    assert.equal(editor.text, text.replace("A separate", "New section\nA separate"));
  }
});

test("formatted headings use plain-text UTF-16 offsets even with an earlier embed", async () => {
  const { topicHeadingIndexes, insertTopicLabels } = await loadEditorAI();
  const text = "🚀 Intro text.\nexisting title\nKeep this body.\n\nNew section starts here.\n";
  for (const heading of [
    [{ insert: "existing title", attributes: { bold: true } }, { insert: "\n" }],
    [{ insert: "existing title" }, { insert: "\n", attributes: { header: 2 } }],
  ]) {
    const editor = editorFor(text, [
      { insert: "🚀 Intro text." }, { insert: { image: "example" } }, { insert: "\n" },
      ...heading, { insert: "Keep this body.\n\nNew section starts here.\n" },
    ]);
    assert.deepEqual([...topicHeadingIndexes(editor)], [text.indexOf("existing title")]);
    assert.equal(insertTopicLabels(editor, [
      { topic: "Duplicate", index: text.indexOf("existing title") },
      { topic: "Nested duplicate", index: text.indexOf("Keep this") },
      { topic: "New", index: text.indexOf("New section") },
    ], Delta), 1);
    assert.equal(editor.text, text.replace("New section", "New\nNew section"));
  }
});

test("malformed labels cannot inject markup or multiline headings into untitled text", async () => {
  const { insertTopicLabels } = await loadEditorAI();
  const editor = editorFor("This section has no heading.\n");
  assert.equal(insertTopicLabels(editor, [
    { topic: "<b>Injected</b>", index: 0 },
    { topic: "Injected\nheading", index: 0 },
    { topic: "x".repeat(201), index: 0 },
  ], Delta), 0);
  assert.equal(editor.updated, undefined);
});

test("unpunctuated prose stays eligible for topic labels", async () => {
  const { insertTopicLabels, hasUntitledTopicSections } = await loadEditorAI();
  const text = "We need to hire two engineers\nThe service processes customer requests\n";
  const editor = editorFor(text);
  assert.equal(hasUntitledTopicSections(editor), true);
  assert.equal(insertTopicLabels(editor, [{ topic: "Hiring plan", index: 0 }], Delta), 1);
  assert.equal(editor.text, "Hiring plan\n" + text);
});

test("speaker labels and wrapped transcript lines are not treated as topic headings", async () => {
  const { insertTopicLabels, hasUntitledTopicSections } = await loadEditorAI();
  const text = [
    "Speaker A: The mock checkout button is unclear.",
    "Speaker B: I agree. Swipe down for more",
    "looks promising, but we should test it.",
    "Speaker A: How will delivery tracking work?",
    "Speaker C: Right. something for the",
    "support team to review.",
    "",
  ].join("\n");
  const editor = editorFor(text);
  assert.equal(hasUntitledTopicSections(editor), true);
  assert.equal(insertTopicLabels(editor, [{ topic: "Checkout and delivery discussion", index: 0 }], Delta), 1);
  assert.equal(editor.text, "Checkout and delivery discussion\n" + text);
});

test("bold speaker lines are dialogue, while real formatted titles stay protected", async () => {
  const { topicHeadingIndexes, hasUntitledTopicSections } = await loadEditorAI();
  const text = "Speaker A: Swipe down for more\nSpeaker B: I agree.\n\nReal title\nBody text.\n";
  const editor = editorFor(text, [
    { insert: "Speaker A: Swipe down for more", attributes: { bold: true } },
    { insert: "\nSpeaker B: I agree.\n\n" },
    { insert: "Real title", attributes: { bold: true } },
    { insert: "\nBody text.\n" },
  ]);
  assert.deepEqual([...topicHeadingIndexes(editor)], [text.indexOf("Real title")]);
  assert.equal(hasUntitledTopicSections(editor), true);
});
