export const GIMG_ORIGIN = "https://gimg.mtcacg.top";
export const GIMG_SITEKEY = "0x4AAAAAAFTJSOtoMzTQgkm3";

export function isGimgUrl(value) {
  try { return new URL(value).origin === GIMG_ORIGIN; } catch { return false; }
}

// No tokens or cookie values are persisted; the browser owns the HttpOnly cookie.
export function createGimgSession({
  fetch: request = globalThis.fetch.bind(globalThis),
  challenge,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onFailure = () => {},
  onReady = () => {},
  requestTimeout = 8000,
  renewalLead = 60000
} = {}) {
  let state = null;
  let flight = null;
  let recovery = null;
  let timer = null;
  let checkedAt = -Infinity;
  let nextRecovery = 0;
  let failure = null;
  let legacy = false;
  let recoveryChecks = 0;
  let generation = 0;
  const valid = () => state?.authenticated === true && state.expiresAt * 1000 > now();
  const ready = () => legacy || (state && state.mode !== "enforce") || valid();

  async function exchange(token) {
    const controller = new AbortController();
    const timeout = setTimer(() => controller.abort(), requestTimeout);
    try {
      const response = await request(`${GIMG_ORIGIN}/session`, {
        method: token === undefined ? "GET" : "POST",
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
        headers: token === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        ...(token === undefined ? {} : { body: JSON.stringify({ token }) })
      });
      if (response.status === 404 && token === undefined && state?.mode !== "enforce") {
        legacy = true;
        return { ok: true, mode: "off", authenticated: false, expiresAt: null };
      }
      const data = await response.json();
      if (!response.ok || data?.ok !== true || !["off", "observe", "enforce"].includes(data.mode)
          || typeof data.authenticated !== "boolean"
          || (data.expiresAt !== null && (!Number.isFinite(data.expiresAt) || data.expiresAt <= 0))
          || (data.authenticated && data.expiresAt === null)) {
        throw new Error(`Gimg session request failed (${response.status})`);
      }
      return data;
    } finally { clearTimer(timeout); }
  }

  function schedule() {
    clearTimer(timer);
    timer = null;
    if (state?.mode !== "enforce" || !valid()) return;
    // A short server TTL gets a proportional lead instead of a tight renewal loop.
    const remaining = state.expiresAt * 1000 - now();
    const lead = Math.min(renewalLead, remaining / 5);
    timer = setTimer(() => { ensure({ renew: true }).catch(() => {}); }, Math.min(2147483647, Math.max(1000, remaining - lead)));
  }

  async function run({ renew = false, force = false, verify = false } = {}) {
    if (legacy) return state;
    if (failure) throw failure;
    if (!force && !renew && !verify && state && (state.mode === "enforce" ? valid() : now() - checkedAt < 60000)) return state;
    try {
      state = await exchange();
      checkedAt = now();
      if ((state.mode === "enforce" && (!valid() || renew)) || (verify && state.mode === "observe")) {
        const token = await challenge();
        if (typeof token !== "string" || !token) throw new Error("Verification returned no token");
        state = await exchange(token);
        // POST can succeed even when the browser blocks Set-Cookie.
        state = await exchange();
        if ((state.mode === "enforce" || verify) && !valid()) throw new Error("Session cookie was not established");
        generation += 1;
      }
      schedule();
      onReady(state);
      return state;
    } catch (error) {
      checkedAt = now();
      if (state?.mode !== "enforce") {
        if (verify) onFailure(error);
        state ||= { ok: true, mode: "observe", authenticated: false, expiresAt: null };
        return state;
      }
      failure = error;
      clearTimer(timer);
      onFailure(error);
      throw error;
    }
  }

  function ensure(options) {
    if (!flight) flight = run(options).finally(() => { flight = null; });
    return flight;
  }

  function recoverImage() {
    if (recovery) return recovery;
    if (legacy || failure || now() < nextRecovery || recoveryChecks >= 2) return Promise.resolve(false);
    nextRecovery = now() + 60000;
    recoveryChecks += 1;
    recovery = (async () => {
      // An image error has no HTTP status. Never challenge a still-valid session.
      const previousExpiry = state?.expiresAt;
      const previousGeneration = generation;
      await ensure({ force: true });
      return state?.mode === "enforce" && valid() && (generation !== previousGeneration || state.expiresAt !== previousExpiry);
    })().catch(() => false).finally(() => { recovery = null; });
    return recovery;
  }

  return {
    ensure,
    recoverImage,
    ready,
    retry(options = {}) { failure = null; recoveryChecks = 0; nextRecovery = 0; return ensure({ force: true, ...options }); },
    dispose() { clearTimer(timer); },
    getState: () => state
  };
}

export function createTurnstilePanel({ document, window, onRetry }) {
  let scriptFlight;
  let active;
  let panel;
  let status;
  let slot;
  let retry;
  let previousFocus;
  const text = {
    title: "\u7ee7\u7eed\u6d4f\u89c8\u5149\u5f71\u6863\u6848",
    pending: "\u8bf7\u5b8c\u6210\u4e00\u6b21\u9a8c\u8bc1\uff0c\u5373\u53ef\u7ee7\u7eed\u6d4f\u89c8\u56fe\u7247\u3002",
    failed: "\u9a8c\u8bc1\u6682\u672a\u5b8c\u6210\u3002\u8bf7\u68c0\u67e5\u7f51\u7edc\u6216\u6d4f\u89c8\u5668 Cookie \u8bbe\u7f6e\uff0c\u7136\u540e\u91cd\u8bd5\u3002",
    retry: "\u91cd\u65b0\u9a8c\u8bc1"
  };
  function show() {
    if (!panel) {
      panel = document.createElement("section");
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-labelledby", "gimg-session-title");
      panel.setAttribute("data-lenis-prevent", "");
      panel.style.cssText = "position:fixed;z-index:100000;inset:auto 16px 24px;margin:auto;max-width:420px;max-height:85vh;overflow:auto;box-sizing:border-box;padding:24px;border:1px solid #b49770;border-radius:16px;background:#201c1b;color:#f2e8da;box-shadow:0 12px 48px #0008;font:15px/1.7 system-ui,sans-serif";
      const title = document.createElement("h2");
      title.id = "gimg-session-title";
      title.textContent = text.title;
      title.style.cssText = "font-size:20px;margin:0 0 8px";
      status = document.createElement("p");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      slot = document.createElement("div");
      retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = text.retry;
      retry.style.cssText = "padding:10px 18px;border:1px solid #d9bf99;border-radius:8px;background:#ead6b8;color:#201c1b;cursor:pointer;font:inherit";
      retry.addEventListener("click", () => { retry.disabled = true; onRetry(); });
      panel.append(title, status, slot, retry);
      document.body.append(panel);
    }
    if (panel.hidden) previousFocus = document.activeElement;
    panel.hidden = false;
    status.textContent = text.pending;
    retry.hidden = true;
  }
  function load() {
    if (window.turnstile?.render) return Promise.resolve(window.turnstile);
    if (!scriptFlight) {
      scriptFlight = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        const timer = window.setTimeout(() => finish(new Error("Verification script timed out")), 12000);
        const finish = (error) => {
          window.clearTimeout(timer);
          script.onload = script.onerror = null;
          if (error) { script.remove(); reject(error); }
          else resolve(window.turnstile);
        };
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.onload = () => finish(window.turnstile?.render ? null : new Error("Verification API unavailable"));
        script.onerror = () => finish(new Error("Verification script unavailable"));
        document.head.append(script);
      }).catch((error) => { scriptFlight = null; throw error; });
    }
    return scriptFlight;
  }
  return {
    challenge() {
      if (active) return active;
      show();
      active = load().then((api) => new Promise((resolve, reject) => {
        let widget;
        let settled = false;
        const timer = window.setTimeout(() => finish(new Error("Verification timed out")), 120000);
        function finish(error, token) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (widget !== undefined) api.remove(widget);
          error ? reject(error) : resolve(token);
        }
        try {
          widget = api.render(slot, {
            sitekey: GIMG_SITEKEY, action: "gimg_session", theme: "auto", size: "flexible",
            retry: "never", "refresh-expired": "never", "refresh-timeout": "never",
            callback: (token) => finish(null, token),
            "error-callback": () => { finish(new Error("Verification failed")); return true; },
            "expired-callback": () => finish(new Error("Verification expired")),
            "timeout-callback": () => finish(new Error("Verification timed out"))
          });
        } catch (error) { finish(error); }
      })).finally(() => { active = null; });
      return active;
    },
    failure() {
      show();
      status.textContent = text.failed;
      retry.hidden = false;
      retry.disabled = false;
    },
    hide() {
      if (panel) panel.hidden = true;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }
  };
}
