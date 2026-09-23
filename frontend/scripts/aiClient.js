import { authenticatedJson } from "./apiClient.js";

const GENERATION_STATE_KEY = "ally.ai-generation-request.v1";

function canonicalPayload(payload) {
  const ordered = {
    role: payload?.role || null,
    source_filename: payload?.source_filename || null,
    source_text: payload?.source_text || "",
    source_type: payload?.source_type || "text",
    target_language: payload?.target_language || null,
  };
  return JSON.stringify(ordered);
}

function generationState(payload) {
  const fingerprint = canonicalPayload(payload);
  try {
    const saved = JSON.parse(sessionStorage.getItem(GENERATION_STATE_KEY) || "null");
    if (
      saved?.fingerprint === fingerprint &&
      typeof saved?.idempotencyKey === "string"
    ) {
      return saved;
    }
  } catch {
    sessionStorage.removeItem(GENERATION_STATE_KEY);
  }
  const state = { fingerprint, idempotencyKey: crypto.randomUUID() };
  sessionStorage.setItem(GENERATION_STATE_KEY, JSON.stringify(state));
  return state;
}

export async function generateMeeting(payload) {
  const state = generationState(payload);
  try {
    const result = await authenticatedJson("/generate-result/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": state.idempotencyKey,
      },
      body: canonicalPayload(payload),
    });
    sessionStorage.removeItem(GENERATION_STATE_KEY);
    return result;
  } catch (error) {
    if (error?.status >= 400 && error?.status < 500 && error?.status !== 409) {
      sessionStorage.removeItem(GENERATION_STATE_KEY);
    }
    throw error;
  }
}

export function clearGenerationRetry() {
  sessionStorage.removeItem(GENERATION_STATE_KEY);
}

export function autocompleteText(text, signal) {
  return authenticatedJson("/ai/autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
}

export function askDocumentQuestion(question, context) {
  return authenticatedJson("/ai/question", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, context }),
  });
}

export function detectDocumentTopics(text, headingIndexes = []) {
  return authenticatedJson("/ai/topics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, heading_indexes: headingIndexes }),
  });
}

export function reviewActionItem(actionItemId, action, decision) {
  return authenticatedJson(
    `/action-items/${encodeURIComponent(actionItemId)}/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision,
        title: action.title,
        assignee: action.assignee || null,
        assignee_email: action.assigneeEmail || null,
        start_date: action.startDate || null,
        deadline: action.deadline || null,
      }),
    }
  );
}
