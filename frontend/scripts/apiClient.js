import {
  getCurrentSession,
  refreshSession,
  signOut,
} from "./authService.js";
import { runtimeConfig } from "./runtimeConfig.js";

export class ApiError extends Error {
  constructor(message, status, retryAfter = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function redirectToLogin() {
  await signOut().catch(() => undefined);
  if (!window.location.pathname.endsWith("/login.html")) {
    window.location.assign("login.html");
  }
}

async function responseError(response) {
  const fallback = response.status === 429
    ? "Too many requests. Please wait and try again."
    : response.status === 413
      ? "This document is too long. Try a shorter section."
    : "The request could not be completed.";
  let message = fallback;
  try {
    const payload = await response.json();
    if (typeof payload?.detail === "string" && payload.detail.length <= 300) {
      message = payload.detail;
    }
  } catch {
    // Keep the generic fallback for non-JSON errors.
  }
  return new ApiError(message, response.status, response.headers.get("Retry-After"));
}

async function requestWithSession(path, options, session, allowRefresh) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${session.access_token}`);
  if (options.body instanceof FormData) {
    headers.delete("Content-Type");
  }

  const response = await fetch(`${runtimeConfig.apiBaseUrl}${path}`, {
    ...options,
    headers,
  });
  if (response.status === 401 && allowRefresh) {
    try {
      const refreshed = await refreshSession();
      if (!refreshed?.access_token) throw new Error("No refreshed session");
      return requestWithSession(path, options, refreshed, false);
    } catch {
      await redirectToLogin();
      throw new ApiError("Your session has expired. Please sign in again.", 401);
    }
  }
  return response;
}

export async function authenticatedFetch(path, options = {}) {
  const session = await getCurrentSession();
  if (!session?.access_token) {
    await redirectToLogin();
    throw new ApiError("Authentication required.", 401);
  }
  return requestWithSession(path, options, session, true);
}

export async function authenticatedJson(path, options = {}) {
  const response = await authenticatedFetch(path, options);
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return null;
  return response.json();
}
