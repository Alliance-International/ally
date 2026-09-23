const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const scriptsDirectory = path.resolve(__dirname, "..", "scripts");

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function createContext(overrides = {}) {
  return vm.createContext({
    AbortController,
    FormData,
    Headers,
    Response,
    URL,
    clearTimeout,
    console: { error() {}, log() {}, warn() {} },
    queueMicrotask,
    setTimeout,
    ...overrides,
  });
}

function syntheticModule(context, exports) {
  return new vm.SyntheticModule(
    Object.keys(exports),
    function initialize() {
      for (const [name, value] of Object.entries(exports)) {
        this.setExport(name, value);
      }
    },
    { context }
  );
}

async function loadScript(filename, context, imports) {
  const source = fs.readFileSync(path.join(scriptsDirectory, filename), "utf8");
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: filename,
  });
  await module.link(async (specifier) => {
    if (!(specifier in imports)) {
      throw new Error(`Unexpected import: ${specifier}`);
    }
    return syntheticModule(context, imports[specifier]);
  });
  await module.evaluate();
  return module.namespace;
}

async function loadSupabaseClient() {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  let clientOptions;
  const context = createContext({ localStorage, sessionStorage });
  const namespace = await loadScript("supabaseClient.js", context, {
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm": {
      createClient(_url, _key, options) {
        clientOptions = options;
        return { marker: "client" };
      },
    },
    "./runtimeConfig.js": {
      runtimeConfig: {
        supabasePublishableKey: "sb_publishable_test",
        supabaseUrl: "https://project.supabase.co",
      },
    },
  });
  return { clientOptions, localStorage, namespace, sessionStorage };
}

test("Supabase client uses pinned PKCE configuration and remembered storage", async () => {
  const { clientOptions, localStorage, namespace, sessionStorage } =
    await loadSupabaseClient();
  const storage = clientOptions.auth.storage;

  assert.equal(clientOptions.auth.flowType, "pkce");
  assert.equal(clientOptions.auth.autoRefreshToken, true);
  assert.equal(clientOptions.auth.persistSession, true);
  assert.equal(clientOptions.auth.detectSessionInUrl, true);

  sessionStorage.setItem("ally.supabase.auth", "stale");
  namespace.setAuthPersistenceMode(true);
  storage.setItem("ally.supabase.auth", "remembered");
  assert.equal(localStorage.getItem("ally.supabase.auth"), "remembered");
  assert.equal(sessionStorage.getItem("ally.supabase.auth"), null);

  storage.setItem("ally.supabase.auth-code-verifier", "temporary");
  assert.equal(
    localStorage.getItem("ally.supabase.auth-code-verifier"),
    "temporary"
  );
  namespace.clearTransientAuthStorage();
  assert.equal(localStorage.getItem("ally.supabase.auth"), "remembered");
  assert.equal(localStorage.getItem("ally.supabase.auth-code-verifier"), null);
});

test("session-only mode removes remembered tokens and does not copy them", async () => {
  const { clientOptions, localStorage, namespace, sessionStorage } =
    await loadSupabaseClient();
  const storage = clientOptions.auth.storage;

  namespace.setAuthPersistenceMode(true);
  storage.setItem("ally.supabase.auth", "remembered");
  namespace.setAuthPersistenceMode(false);
  storage.setItem("ally.supabase.auth", "session-only");

  assert.equal(localStorage.getItem("ally.supabase.auth"), null);
  assert.equal(sessionStorage.getItem("ally.supabase.auth"), "session-only");
  assert.equal(new MemoryStorage().getItem("ally.supabase.auth"), null);
});

async function loadAuthService(authOverrides = {}, windowOverrides = {}) {
  const calls = { cleanup: 0, persistence: [], signup: [] };
  const auth = {
    exchangeCodeForSession: async () => ({ data: { session: null }, error: null }),
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    refreshSession: async () => ({ data: { session: null }, error: null }),
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
    signInWithPassword: async () => ({ data: {}, error: null }),
    signOut: async () => ({ error: null }),
    signUp: async (options) => {
      calls.signup.push(options);
      return { data: { session: null }, error: null };
    },
    updateUser: async () => ({ data: {}, error: null }),
    ...authOverrides,
  };
  const historyCalls = [];
  const window = {
    history: {
      replaceState(...args) {
        historyCalls.push(args);
      },
    },
    location: {
      href: "https://app.example/auth-callback.html",
      pathname: "/auth-callback.html",
    },
    ...windowOverrides,
  };
  const context = createContext({ document: { title: "Ally" }, window });
  const namespace = await loadScript("authService.js", context, {
    "./runtimeConfig.js": {
      runtimeConfig: {
        captchaSiteKey: "",
        publicFrontendBaseUrl: "https://app.example",
      },
    },
    "./supabaseClient.js": {
      clearTransientAuthStorage() {
        calls.cleanup += 1;
      },
      setAuthPersistenceMode(value) {
        calls.persistence.push(value);
      },
      supabase: {
        auth,
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        }),
      },
    },
  });
  return { calls, historyCalls, namespace };
}

test("signup is session-only and sends only display metadata plus fixed callback", async () => {
  const { calls, namespace } = await loadAuthService();
  await namespace.signUp({
    captchaToken: "captcha",
    displayName: "Alice",
    email: "alice@example.com",
    password: "not-altered",
  });

  assert.deepEqual(calls.persistence, [false]);
  assert.equal(calls.signup[0].password, "not-altered");
  assert.equal(calls.signup[0].options.emailRedirectTo, "https://app.example/auth-callback.html");
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.signup[0].options.data)),
    { display_name: "Alice" }
  );
  assert.equal("role" in calls.signup[0].options.data, false);
});

test("callback exchanges a code once, removes it from the URL, and clears PKCE state", async () => {
  let exchanges = 0;
  const session = { access_token: "not-logged" };
  const { calls, historyCalls, namespace } = await loadAuthService(
    {
      exchangeCodeForSession: async () => {
        exchanges += 1;
        return { data: { session }, error: null };
      },
    },
    {
      location: {
        href: "https://app.example/auth-callback.html?code=sensitive",
        pathname: "/auth-callback.html",
      },
    }
  );

  assert.equal(await namespace.processAuthRedirect(), session);
  assert.equal(exchanges, 1);
  assert.equal(historyCalls[0][2], "/auth-callback.html");
  assert.equal(calls.cleanup, 1);
});

test("invalid callbacks still clear transient PKCE state", async () => {
  const { calls, namespace } = await loadAuthService(
    {
      exchangeCodeForSession: async () => ({
        data: {},
        error: new Error("invalid"),
      }),
    },
    {
      location: {
        href: "https://app.example/auth-callback.html?code=invalid",
        pathname: "/auth-callback.html",
      },
    }
  );

  await assert.rejects(namespace.processAuthRedirect());
  assert.equal(calls.cleanup, 1);
});

test("password recovery always uses the fixed same-origin reset page", async () => {
  let request;
  const { namespace } = await loadAuthService({
    resetPasswordForEmail: async (...args) => {
      request = args;
      return { data: {}, error: null };
    },
  });
  await namespace.requestPasswordReset("alice@example.com", "captcha");
  assert.equal(request[1].redirectTo, "https://app.example/reset-password.html");
  assert.equal(request[1].captchaToken, "captcha");
});

test("hCaptcha widgets use the public sitekey and clear single-use tokens", async () => {
  let renderCalls = 0;
  let renderOptions;
  const resetCalls = [];
  const container = {};
  const statusElement = { textContent: "" };
  const tokenInput = { value: "" };
  const hcaptcha = {
    render(receivedContainer, options) {
      assert.equal(receivedContainer, container);
      renderCalls += 1;
      renderOptions = options;
      return 17;
    },
    reset(widgetId) {
      resetCalls.push(widgetId);
    },
  };
  const context = createContext({
    document: {},
    window: {
      hcaptcha,
      matchMedia: () => ({ matches: false }),
    },
  });
  const namespace = await loadScript("captchaService.js", context, {
    "./runtimeConfig.js": {
      runtimeConfig: {
        captchaSiteKey: "8114ffbe-45f0-4fe2-989c-a2009946fa88",
      },
    },
  });
  const widget = namespace.createCaptchaWidget({
    container,
    statusElement,
    tokenInput,
  });

  await widget.mount();
  await widget.mount();
  assert.equal(renderCalls, 1);
  assert.equal(
    renderOptions.sitekey,
    "8114ffbe-45f0-4fe2-989c-a2009946fa88"
  );
  assert.equal(renderOptions.theme, "dark");

  renderOptions.callback("one-time-token");
  assert.equal(widget.getToken(), "one-time-token");
  widget.reset();
  assert.equal(widget.getToken(), undefined);
  assert.deepEqual(resetCalls, [17]);

  renderOptions.callback("expiring-token");
  renderOptions["expired-callback"]();
  assert.equal(widget.getToken(), undefined);
  assert.match(statusElement.textContent, /expired/i);
});

test("CAPTCHA failures are detected without exposing provider details", async () => {
  const context = createContext({ window: {} });
  const namespace = await loadScript("captchaService.js", context, {
    "./runtimeConfig.js": {
      runtimeConfig: { captchaSiteKey: "public-sitekey" },
    },
  });

  assert.equal(namespace.isCaptchaFailure({ code: "captcha_failed" }), true);
  assert.equal(
    namespace.isCaptchaFailure({ message: "captcha verification process failed" }),
    true
  );
  assert.equal(namespace.isCaptchaFailure({ code: "invalid_credentials" }), false);
});

async function loadApiClient({ session, refresh, responses }) {
  const calls = { fetch: [], refresh: 0, signout: 0 };
  const redirects = [];
  const context = createContext({
    fetch: async (url, options) => {
      calls.fetch.push({ options, url });
      return responses.shift();
    },
    window: {
      location: {
        assign(value) {
          redirects.push(value);
        },
        pathname: "/home.html",
      },
    },
  });
  const namespace = await loadScript("apiClient.js", context, {
    "./authService.js": {
      getCurrentSession: async () => session,
      refreshSession: async () => {
        calls.refresh += 1;
        if (refresh instanceof Error) throw refresh;
        return refresh;
      },
      signOut: async () => {
        calls.signout += 1;
      },
    },
    "./runtimeConfig.js": {
      runtimeConfig: { apiBaseUrl: "https://api.example" },
    },
  });
  return { calls, namespace, redirects };
}

test("API client sends bearer token, preserves abort signal, and leaves FormData boundary to fetch", async () => {
  const response = new Response(null, { status: 204 });
  const { calls, namespace } = await loadApiClient({
    refresh: null,
    responses: [response],
    session: { access_token: "first-token" },
  });
  const body = new FormData();
  body.append("file", "value");
  const controller = new AbortController();
  await namespace.authenticatedFetch("/upload-document/", {
    body,
    headers: { "Content-Type": "incorrect/manual" },
    method: "POST",
    signal: controller.signal,
  });

  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].options.headers.get("Authorization"), "Bearer first-token");
  assert.equal(calls.fetch[0].options.headers.has("Content-Type"), false);
  assert.equal(calls.fetch[0].options.signal, controller.signal);
});

test("API client refreshes and retries exactly once after 401", async () => {
  const { calls, namespace } = await loadApiClient({
    refresh: { access_token: "second-token" },
    responses: [
      new Response(null, { status: 401 }),
      new Response("{}", { status: 200 }),
    ],
    session: { access_token: "first-token" },
  });
  const response = await namespace.authenticatedFetch("/ai-helper", {
    method: "POST",
  });

  assert.equal(response.status, 200);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.fetch.length, 2);
  assert.equal(calls.fetch[1].options.headers.get("Authorization"), "Bearer second-token");
});

test("API client does not refresh on 403 and exposes 429 Retry-After safely", async () => {
  const forbidden = await loadApiClient({
    refresh: { access_token: "unused" },
    responses: [new Response(null, { status: 403 })],
    session: { access_token: "token" },
  });
  assert.equal((await forbidden.namespace.authenticatedFetch("/test")).status, 403);
  assert.equal(forbidden.calls.refresh, 0);

  const limited = await loadApiClient({
    refresh: null,
    responses: [
      new Response(JSON.stringify({ detail: "Please wait." }), {
        headers: { "Content-Type": "application/json", "Retry-After": "30" },
        status: 429,
      }),
    ],
    session: { access_token: "token" },
  });
  await assert.rejects(
    limited.namespace.authenticatedJson("/test"),
    (error) => error.status === 429 && error.retryAfter === "30"
  );
});

test("API client fails closed and redirects when a session is absent", async () => {
  const { calls, namespace, redirects } = await loadApiClient({
    refresh: null,
    responses: [],
    session: null,
  });
  await assert.rejects(namespace.authenticatedFetch("/ai-helper"));
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.signout, 1);
  assert.deepEqual(redirects, ["login.html"]);
});

test("manual reminders send only the action path and retain one retry key", async () => {
  const calls = [];
  const generated = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ];
  let shouldFail = true;
  const sessionStorage = new MemoryStorage();
  const context = createContext({
    crypto: { randomUUID: () => generated.shift() },
    sessionStorage,
  });
  const namespace = await loadScript("reminderClient.js", context, {
    "./apiClient.js": {
      async authenticatedJson(path, options) {
        calls.push({ path, options });
        if (shouldFail) {
          shouldFail = false;
          throw new Error("uncertain network outcome");
        }
        return { delivery_id: "delivery", status: "sent" };
      },
    },
  });
  const actionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  await assert.rejects(namespace.requestManualReminder(actionId));
  assert.equal(
    sessionStorage.getItem(`ally.reminder-request.${actionId}`),
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  );
  await namespace.requestManualReminder(actionId);
  assert.equal(sessionStorage.getItem(`ally.reminder-request.${actionId}`), null);
  await namespace.requestManualReminder(actionId);

  assert.deepEqual(calls.map((call) => call.path), [
    `/action-items/${actionId}/reminders`,
    `/action-items/${actionId}/reminders`,
    `/action-items/${actionId}/reminders`,
  ]);
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers["Idempotency-Key"], calls[1].options.headers["Idempotency-Key"]);
  assert.notEqual(calls[1].options.headers["Idempotency-Key"], calls[2].options.headers["Idempotency-Key"]);
  assert.equal(JSON.stringify(calls).includes("recipient"), false);
  assert.equal(JSON.stringify(calls).includes("userId"), false);
});

test("meeting generation reuses uncertain keys and creates a new key after success", async () => {
  const calls = [];
  const generated = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ];
  let shouldFail = true;
  const sessionStorage = new MemoryStorage();
  const context = createContext({
    crypto: { randomUUID: () => generated.shift() },
    sessionStorage,
  });
  const namespace = await loadScript("aiClient.js", context, {
    "./apiClient.js": {
      async authenticatedJson(path, options) {
        calls.push({ path, options });
        if (shouldFail) {
          shouldFail = false;
          throw Object.assign(new Error("uncertain"), { status: 503 });
        }
        return { meeting_id: "meeting" };
      },
    },
  });
  const payload = {
    source_text: "Meeting source",
    source_type: "text",
    role: null,
    target_language: null,
  };

  await assert.rejects(namespace.generateMeeting(payload));
  await namespace.generateMeeting(payload);
  await namespace.generateMeeting(payload);

  assert.deepEqual(calls.map((call) => call.path), [
    "/generate-result/",
    "/generate-result/",
    "/generate-result/",
  ]);
  assert.equal(
    calls[0].options.headers["Idempotency-Key"],
    calls[1].options.headers["Idempotency-Key"]
  );
  assert.notEqual(
    calls[1].options.headers["Idempotency-Key"],
    calls[2].options.headers["Idempotency-Key"]
  );
  assert.equal(JSON.stringify(calls).includes("ai_provider"), false);
  assert.equal(JSON.stringify(calls).includes("model"), false);
});

test("topic requests carry existing heading positions without provider controls", async () => {
  const calls = [];
  const namespace = await loadScript("aiClient.js", createContext(), {
    "./apiClient.js": {
      async authenticatedJson(path, options) {
        calls.push({ path, options });
        return { topics: [] };
      },
    },
  });
  const text = "Intro.\nExisting heading\nBody.\n";
  await namespace.detectDocumentTopics(text, [7]);
  assert.equal(calls[0].path, "/ai/topics");
  assert.deepEqual(JSON.parse(calls[0].options.body), { text, heading_indexes: [7] });
});

class FakeElement {
  constructor() {
    this.children = [];
    this.disabled = false;
    this.listeners = {};
    this.style = {};
    this.textContent = "";
  }

  addEventListener(event, callback) {
    this.listeners[event] = callback;
  }

  append(...values) {
    this.children.push(...values);
  }

  appendChild(value) {
    this.children.push(value);
  }

  replaceChildren(...values) {
    this.children = values;
  }
}

async function loadAppLogic(user) {
  const elements = { "welcome-message": new FakeElement() };
  const redirects = [];
  const context = createContext({
    document: {
      createElement: () => new FakeElement(),
      getElementById: (id) => elements[id] ?? null,
    },
    localStorage: new MemoryStorage(),
    window: {
      addEventListener() {},
      location: {
        pathname: "/home.html",
        replace(value) {
          redirects.push(value);
        },
      },
    },
  });
  const namespace = await loadScript("appLogic.js", context, {
    "./authService.js": {
      getProfileDisplayName: async () => null,
      onAuthStateChange: () => () => undefined,
      requireAuthenticatedUser: async () => user,
      signOut: async () => undefined,
    },
    "./dataService.js": {
      stopAllSubscriptions() {},
    },
  });
  return { elements, namespace, redirects };
}

test("protected-page guard redirects logged-out visitors", async () => {
  const { namespace, redirects } = await loadAppLogic(null);
  await namespace.initializeApp();
  assert.deepEqual(redirects, ["login.html"]);
});

test("display names containing HTML are assigned as text, not parsed markup", async () => {
  const malicious = '<img src=x onerror="steal()">';
  const { elements, namespace } = await loadAppLogic({
    email: "fallback@example.com",
    id: "00000000-0000-4000-8000-000000000001",
    user_metadata: { display_name: malicious },
  });
  await namespace.initializeApp();

  const strong = elements["welcome-message"].children[0];
  const name = strong.children[1];
  assert.equal(name.textContent, malicious);
  assert.equal(name.children.length, 0);
});

test("page scripts retain generic Auth/recovery errors and required safe flow hooks", () => {
  const login = fs.readFileSync(path.join(scriptsDirectory, "login.js"), "utf8");
  const signup = fs.readFileSync(path.join(scriptsDirectory, "signup.js"), "utf8");
  const callback = fs.readFileSync(path.join(scriptsDirectory, "authCallback.js"), "utf8");
  const reset = fs.readFileSync(path.join(scriptsDirectory, "resetPassword.js"), "utf8");
  const home = fs.readFileSync(path.join(scriptsDirectory, "home.js"), "utf8");
  const captcha = fs.readFileSync(
    path.join(scriptsDirectory, "captchaService.js"),
    "utf8"
  );
  const runtimeConfig = fs.readFileSync(
    path.join(scriptsDirectory, "runtimeConfig.js"),
    "utf8"
  );
  const loginHtml = fs.readFileSync(
    path.resolve(scriptsDirectory, "..", "login.html"),
    "utf8"
  );
  const signupHtml = fs.readFileSync(
    path.resolve(scriptsDirectory, "..", "signup.html"),
    "utf8"
  );

  assert.match(login, /Invalid email or password/);
  assert.match(login, /If an account exists for this email/);
  assert.match(login, /error\?\.status === 429/);
  assert.match(signup, /if \(data\.session\)/);
  assert.match(signup, /confirmation email will arrive shortly/);
  assert.doesNotMatch(signup, /send-welcome-email/);
  assert.match(callback, /invalid, expired, or has already been used/);
  assert.match(reset, /Passwords do not match/);
  assert.match(reset, /await signOut\(\)/);
  assert.match(home, /DOMPurify\.sanitize/);
  assert.match(home, /textContent/);
  assert.match(captcha, /https:\/\/js\.hcaptcha\.com\/1\/api\.js\?render=explicit/);
  assert.match(captcha, /api\.reset\(widgetId\)/);
  assert.match(runtimeConfig, /8114ffbe-45f0-4fe2-989c-a2009946fa88/);
  assert.match(loginHtml, /id="login-captcha"/);
  assert.match(loginHtml, /id="reset-captcha"/);
  assert.match(signupHtml, /id="signup-captcha"/);
  assert.match(login, /resetCaptcha\.getToken\(\)/);
  assert.match(signup, /signupCaptcha\.getToken\(\)/);
});

async function loadDataService({ userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } = {}) {
  const calls = {
    channels: [],
    deletes: [],
    eq: [],
    from: [],
    inserts: [],
    removes: [],
    rpc: [],
    updates: [],
  };
  const responses = {
    list: { data: [], error: null },
    single: { data: null, error: null },
    rpc: {
      data: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      error: null,
    },
  };

  function builder(table) {
    const query = {
      delete() {
        calls.deletes.push(table);
        return query;
      },
      eq(column, value) {
        calls.eq.push({ column, table, value });
        return query;
      },
      insert(value) {
        calls.inserts.push({ table, value });
        return query;
      },
      limit() {
        return Promise.resolve(responses.list);
      },
      maybeSingle() {
        return Promise.resolve(responses.single);
      },
      order() {
        return query;
      },
      range() {
        return Promise.resolve(responses.list);
      },
      select() {
        return query;
      },
      update(value) {
        calls.updates.push({ table, value });
        return query;
      },
    };
    return query;
  }

  const supabase = {
    channel(name) {
      const channel = {
        callback: null,
        config: null,
        name,
        on(_type, config, callback) {
          channel.config = config;
          channel.callback = callback;
          return channel;
        },
        subscribe(callback) {
          channel.statusCallback = callback;
          return channel;
        },
      };
      calls.channels.push(channel);
      return channel;
    },
    from(table) {
      calls.from.push(table);
      return builder(table);
    },
    removeChannel(channel) {
      calls.removes.push(channel.name);
      return Promise.resolve("ok");
    },
    async rpc(name, value) {
      calls.rpc.push({ name, value });
      return responses.rpc;
    },
  };

  const context = createContext();
  const namespace = await loadScript("dataService.js", context, {
    "./authService.js": {
      getCurrentUser: async () => ({ id: userId }),
    },
    "./supabaseClient.js": { supabase },
  });
  return { calls, namespace, responses, userId };
}

test("browser data service cannot persist AI provenance or generated actions", async () => {
  const dataService = fs.readFileSync(path.join(scriptsDirectory, "dataService.js"), "utf8");
  assert.doesNotMatch(dataService, /save_meeting_with_actions/);
  assert.doesNotMatch(dataService, /p_ai_provider|p_ai_model|p_actions/);

  const { namespace } = await loadDataService();
  const mapped = namespace.mapActionRow({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    source: "ai_generated",
    review_status: "pending",
    title: "Review the release",
  });
  assert.equal(mapped.reviewStatus, "pending");
});

test("action create sets only the verified owner and editable manual fields", async () => {
  const { calls, namespace, responses, userId } = await loadDataService();
  responses.single = {
    data: {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      user_id: userId,
      meeting_id: null,
      title: "Manual action",
      assignee: "Unassigned",
      assignee_email: null,
      status: "not_started",
      source: "manual",
      start_date: null,
      deadline: null,
      created_at: "2026-09-20T12:00:00Z",
    },
    error: null,
  };

  await namespace.createActionItem({
    title: "Manual action",
    assignee: "",
    assigneeEmail: "",
    startDate: null,
    deadline: null,
    status: "completed",
    source: "ai_generated",
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.inserts[0].value)),
    {
      user_id: userId,
      title: "Manual action",
      assignee: "Unassigned",
      assignee_email: null,
      start_date: null,
      deadline: null,
    }
  );
});

test("action update and delete use both row ID and verified owner filters", async () => {
  const { calls, namespace, responses, userId } = await loadDataService();
  const actionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  responses.single = {
    data: {
      id: actionId,
      meeting_id: null,
      title: "Updated",
      assignee: "Alice",
      assignee_email: null,
      status: "in_progress",
      source: "manual",
      start_date: null,
      deadline: null,
      created_at: "2026-09-20T12:00:00Z",
    },
    error: null,
  };
  await namespace.updateActionItem(actionId, {
    title: "Updated",
    assignee: "Alice",
    assigneeEmail: null,
    status: "in_progress",
    startDate: null,
    deadline: null,
    user_id: "attacker",
    source: "ai_generated",
  });

  assert.deepEqual(Object.keys(calls.updates[0].value).sort(), [
    "assignee",
    "assignee_email",
    "deadline",
    "start_date",
    "status",
    "title",
  ]);
  assert.deepEqual(calls.eq.slice(-2), [
    { column: "id", table: "action_items", value: actionId },
    { column: "user_id", table: "action_items", value: userId },
  ]);

  responses.single = { data: { id: actionId }, error: null };
  await namespace.deleteActionItem(actionId);
  assert.deepEqual(calls.eq.slice(-2), [
    { column: "id", table: "action_items", value: actionId },
    { column: "user_id", table: "action_items", value: userId },
  ]);
});

test("Realtime subscriptions are owner-filtered, reject mismatched payloads, and clean up", async () => {
  const { calls, namespace, userId } = await loadDataService();
  const received = [];
  const cleanup = await namespace.subscribeToMeetingRecords((row) => received.push(row));
  const channel = calls.channels[0];
  assert.equal(channel.config.table, "meeting_records");
  assert.equal(channel.config.filter, `user_id=eq.${userId}`);

  channel.callback({
    new: {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      user_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      source_text: "Cross user",
      summary_text: "Blocked",
      extracted_actions_snapshot: [],
    },
  });
  assert.equal(received.length, 0);

  channel.callback({
    new: {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      user_id: userId,
      source_text: "Own source",
      summary_text: "Own summary",
      extracted_actions_snapshot: [],
    },
  });
  assert.equal(received.length, 1);
  cleanup();
  assert.deepEqual(calls.removes, [`meeting-records:${userId}`]);
});

test("date-only overdue checks do not parse dates through UTC", async () => {
  const { namespace } = await loadDataService();
  const today = new Date(2026, 8, 20, 23, 59, 59);
  assert.equal(namespace.isDateOverdue("2026-09-19", "not_started", today), true);
  assert.equal(namespace.isDateOverdue("2026-09-20", "not_started", today), false);
  assert.equal(namespace.isDateOverdue("2026-09-19", "completed", today), false);
});

test("migrated page scripts have no Firebase runtime or unsafe stored-content interpolation", () => {
  const dataService = fs.readFileSync(path.join(scriptsDirectory, "dataService.js"), "utf8");
  const history = fs.readFileSync(path.join(scriptsDirectory, "history.js"), "utf8");
  const action = fs.readFileSync(path.join(scriptsDirectory, "action.js"), "utf8");
  const reminderClient = fs.readFileSync(path.join(scriptsDirectory, "reminderClient.js"), "utf8");
  const aiClient = fs.readFileSync(path.join(scriptsDirectory, "aiClient.js"), "utf8");
  const home = fs.readFileSync(path.join(scriptsDirectory, "home.js"), "utf8");

  for (const source of [dataService, history, action, home, reminderClient, aiClient]) {
    assert.doesNotMatch(source, /firebase|firestore|currentUser\.uid|user\.uid/i);
  }
  assert.doesNotMatch(history, /innerHTML/);
  assert.doesNotMatch(action, /innerHTML/);
  assert.doesNotMatch(action, /send-manual-reminder/);
  assert.match(action, /requestManualReminder/);
  assert.match(reminderClient, /Idempotency-Key/);
  assert.match(aiClient, /crypto\.randomUUID\(\)/);
  assert.match(aiClient, /Idempotency-Key/);
  assert.doesNotMatch(home, /saveMeetingWithActions|ai_provider|ai_model|is_json/);
  assert.match(home, /Needs review/);
  assert.match(action, /reviewStatus === "confirmed"/);
  assert.match(home, /await reviewActionItem[\s\S]*state\.proposedActions\[index\] = reviewed/);
  assert.match(home, /catch[\s\S]*action remains unconfirmed/);
  assert.doesNotMatch(home, /Promise\.all[\s\S]*reviewActionItem|confirmAll|bulkConfirm/i);
  assert.match(history, /Search covers the records currently loaded/);
});
