// One real Chrome, one profile, and a tab per session. The profile is the
// identity: whoever logged into it in the window is who every session is.
//
// A session is opened for some domains and can only ever land on them: the
// check is a request route in the browser that refuses a top-level
// navigation the session's guard does not allow, so a click that leads off
// the domains, or into /checkout, fails in the browser rather than being
// undone afterwards.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { Key } from "./keys.js";

export class BrowserError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

export const ACTIONS = ["navigate", "click", "type", "press", "select", "hover", "scroll", "back", "forward", "reload", "wait", "read"];

const SETTLE_MS = 400;
const NAVIGATION_TIMEOUT = 30_000;
const ACTION_TIMEOUT = 10_000;
const MAX_WAIT = 30;

export const CHROME_CANDIDATES = [
  join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
];

export function findChrome(explicit) {
  if (explicit) return explicit;
  return CHROME_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

export class Browser {
  constructor({
    profile,
    executable = null,
    headless = false,
    viewport = { width: 1280, height: 960 },
    audit = null,
    maxSessions = 4,
    ttl = 15 * 60,
    maxLife = 60 * 60,
    maxSnapshot = 60_000,
    locale = "en-US",
    timezone = null
  }) {
    this.profile = profile;
    this.executable = executable;
    this.headless = headless;
    this.viewport = viewport;
    this.audit = audit;
    this.maxSessions = maxSessions;
    this.ttl = ttl;
    this.maxLife = maxLife;
    this.maxSnapshot = maxSnapshot;
    this.locale = locale;
    this.timezone = timezone;
    this.context = null;
    this.launching = null;
    this.expecting = 0;
    this.sessions = new Map();
    this.sweeper = setInterval(() => this.sweep().catch(() => {}), 30_000);
    this.sweeper.unref();
  }

  // The context is launched on first use and relaunched if Chrome went away
  // (the window was closed by hand, say). Sessions die with it.
  async launch() {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const options = {
        headless: this.headless,
        viewport: this.viewport,
        locale: this.locale,
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--disable-blink-features=AutomationControlled", "--no-default-browser-check"]
      };
      if (this.timezone) options.timezoneId = this.timezone;
      if (this.executable) options.executablePath = this.executable;
      const context = await chromium.launchPersistentContext(this.profile, options);
      context.setDefaultTimeout(ACTION_TIMEOUT);
      context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
      await context.route("**/*", (route) => this.guard(route));
      context.on("page", (page) => this.adopt(page));
      context.on("close", () => {
        this.context = null;
        for (const session of this.sessions.values()) session.closed = "the browser closed";
        this.sessions.clear();
      });
      this.context = context;
      return context;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  // Every top-level navigation in the context passes here. A session's own
  // tab is judged by its guard. A popup's first navigation has no frame yet
  // (Playwright hands it over before the frame exists), so it is put down
  // to the session that is in the middle of an action, or, if that is not
  // one session, refused unless every live session's guard allows it; an
  // allowed popup is closed and its URL opened in the session's own tab. A
  // refusal is answered with a small page of gofer's own, not an aborted
  // request, so a tab stays a page and not a Chrome error.
  async guard(route) {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue();
    let page = null;
    try {
      const frame = request.frame();
      page = frame.page();
      if (frame !== page.mainFrame()) return route.continue();
    } catch {
      page = null; // a popup, before its frame exists
    }
    const url = request.url();
    let session = page && this.sessionFor(page);
    if (session) {
      const refusal = session.guard.refusal(url);
      if (!refusal) return route.continue();
      return this.refuse(route, session, url, refusal, false);
    }
    if (page) return route.continue(); // not ours: about:blank of a tab being made, say

    const live = [...this.sessions.values()].filter((candidate) => !candidate.closed);
    const acting = live.filter((candidate) => candidate.acting);
    session = acting.length === 1 ? acting[0] : null;
    const judges = session ? [session] : live;
    if (judges.length === 0) return route.fulfill({ status: 204, body: "" });
    const refusal = judges.map((judge) => judge.guard.refusal(url)).find(Boolean);
    if (refusal) return this.refuse(route, session ?? judges[0], url, refusal, true);
    if (session) session.redirect = url;
    return route.fulfill({ status: 204, body: "" });
  }

  refuse(route, session, url, reason, popup) {
    session.blocked = { url, reason };
    this.audit?.write({ key: session.key, session: session.id, op: "blocked", url, reason, popup });
    return route.fulfill({ status: 403, contentType: "text/html; charset=utf-8", body: refusalPage(url, reason) });
  }

  // A tab nobody asked for (a popup, or one opened by hand in the window)
  // is closed at once; its navigation was judged in guard(). A session's
  // own tab is announced before it is made, so it is left alone.
  adopt(page) {
    if (this.expecting > 0) {
      this.expecting -= 1;
      return;
    }
    page.close().catch(() => {});
  }

  sessionFor(page) {
    for (const session of this.sessions.values()) {
      if (session.page === page && !session.closed) return session;
    }
    return null;
  }

  async status() {
    const running = Boolean(this.context);
    let version = null;
    if (running) version = this.context.browser()?.version() ?? null;
    return {
      browser: { executable: this.executable ?? "playwright chromium", profile: this.profile, running, version, headless: this.headless },
      sessions: this.sessions.size,
      limits: { sessions: this.maxSessions, ttl: this.ttl, max_life: this.maxLife, snapshot_chars: this.maxSnapshot }
    };
  }

  // Open a session as a key, at a URL, confined to some domains. The
  // session's domains must sit inside the key's, and the URL inside both.
  async open(key, { url, domains = null, ttl = null } = {}) {
    if (!url) throw new BrowserError("url is required");
    if (domains !== null && (!Array.isArray(domains) || domains.some((domain) => typeof domain !== "string"))) {
      throw new BrowserError("domains is an array of domain names");
    }
    for (const domain of domains ?? []) {
      if (!key.allowsHost(domain.replace(/^\*\./, ""))) throw new BrowserError(`${domain} is outside this key's domains`);
    }
    const guard = new Key({ name: key.name, domains: domains ?? key.domains, blocked_paths: key.blocked_paths });
    const refusal = guard.refusal(url);
    if (refusal) throw new BrowserError(refusal);
    const live = [...this.sessions.values()].filter((session) => !session.closed);
    if (live.length >= this.maxSessions) throw new BrowserError(`${this.maxSessions} sessions are open; close one first`, 429);
    ttl = clamp(ttl ?? this.ttl, 30, this.maxLife);

    const context = await this.launch();
    this.expecting += 1;
    const page = await context.newPage();
    const session = new Session({ browser: this, key: key.name, guard, page, ttl });
    this.sessions.set(session.id, session);
    session.install();
    try {
      await session.run(async () => {
        await session.navigate(url);
        await session.settle();
      });
    } catch (error) {
      await session.close(`could not open ${url}`);
      throw error;
    }
    this.audit?.write({ key: key.name, session: session.id, op: "open", url, domains: guard.domains });
    return session;
  }

  // A session, if it is this key's and still alive.
  session(id, key) {
    const session = this.sessions.get(id);
    if (!session || session.key !== key.name) throw new BrowserError("no such session", 404);
    if (session.closed) throw new BrowserError(`session closed: ${session.closed}`, 410);
    if (session.expired()) {
      session.close("expired").catch(() => {});
      throw new BrowserError("session expired", 410);
    }
    return session;
  }

  list(key) {
    return [...this.sessions.values()].filter((session) => session.key === key.name && !session.closed && !session.expired());
  }

  async sweep() {
    for (const session of this.sessions.values()) {
      if (!session.closed && session.expired()) await session.close("expired");
    }
    for (const [id, session] of this.sessions) {
      if (session.closed && Date.now() - session.closedAt > 10 * 60_000) this.sessions.delete(id);
    }
  }

  async shutdown() {
    clearInterval(this.sweeper);
    for (const session of this.sessions.values()) await session.close("shutdown").catch(() => {});
    const context = this.context;
    this.context = null;
    await context?.close().catch(() => {});
  }
}

export class Session {
  constructor({ browser, key, guard, page, ttl }) {
    this.id = randomBytes(9).toString("base64url");
    this.browser = browser;
    this.key = key;
    this.guard = guard;
    this.page = page;
    this.ttl = ttl;
    this.createdAt = Date.now();
    this.touchedAt = this.createdAt;
    this.steps = 0;
    this.closed = null;
    this.closedAt = null;
    this.blocked = null;
    this.redirect = null;
    this.acting = false;
    this.lastScreenshot = null;
    this.queue = Promise.resolve();
  }

  install() {
    this.page.on("close", () => {
      if (!this.closed) this.closed = "the tab closed";
    });
  }

  expiresAt() {
    return Math.min(this.touchedAt + this.ttl * 1000, this.createdAt + this.browser.maxLife * 1000);
  }

  expired() {
    return Date.now() > this.expiresAt();
  }

  // Actions on one session run one at a time, in the order they arrived.
  run(work) {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  async navigate(url) {
    const refusal = this.guard.refusal(url);
    if (refusal) throw new BrowserError(refusal);
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (error) {
      throw new BrowserError(`could not open ${url}: ${firstLine(error.message)}`, 502);
    }
  }

  // After a step: a refused navigation left the tab on gofer's refusal
  // page, so step back off it; an allowed popup was closed, so go where it
  // was going in this tab instead.
  async afterStep() {
    if (this.blocked && this.page.url() === this.blocked.url) {
      await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    if (this.redirect) {
      const url = this.redirect;
      this.redirect = null;
      await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }

  // Do one thing, then report the page as it is afterwards.
  async act(body) {
    const { action, screenshot = false, max_chars, ...params } = body ?? {};
    if (!ACTIONS.includes(action)) throw new BrowserError(`action is one of ${ACTIONS.join(", ")}`);
    return this.run(async () => {
      this.touchedAt = Date.now();
      this.blocked = null;
      let text;
      const started = Date.now();
      this.acting = true;
      try {
        text = await this[`do_${action}`](params);
      } catch (error) {
        if (error instanceof BrowserError) throw error;
        throw new BrowserError(`${action} failed: ${describe(error)}`);
      } finally {
        this.acting = false;
      }
      this.steps += 1;
      await this.settle();
      await this.afterStep();
      this.browser.audit?.write({
        key: this.key, session: this.id, op: action, args: auditable(params), url: this.page.url(), ms: Date.now() - started
      });
      const state = await this.state({ screenshot, max_chars });
      if (text !== undefined) state.text = text;
      return state;
    });
  }

  async do_navigate({ url }) {
    if (!url) throw new BrowserError("navigate needs a url");
    await this.navigate(url);
  }

  async do_click({ ref, double = false, button = "left" }) {
    const locator = await this.locate(ref);
    if (double) await locator.dblclick({ button });
    else await locator.click({ button });
  }

  async do_type({ ref, text, submit = false, slowly = false }) {
    if (typeof text !== "string") throw new BrowserError("type needs text");
    const locator = await this.locate(ref);
    if (slowly) {
      await locator.click();
      await locator.pressSequentially(text, { delay: 40 });
    } else {
      await locator.fill(text);
    }
    if (submit) await locator.press("Enter");
  }

  async do_press({ key }) {
    if (!key) throw new BrowserError("press needs a key, like Enter or ArrowDown");
    await this.page.keyboard.press(key);
  }

  async do_select({ ref, values }) {
    if (!Array.isArray(values) || values.length === 0) throw new BrowserError("select needs values, an array of option values or labels");
    await (await this.locate(ref)).selectOption(values);
  }

  async do_hover({ ref }) {
    await (await this.locate(ref)).hover();
  }

  async do_scroll({ ref, direction = "down", amount = 0.8 }) {
    if (ref) {
      await (await this.locate(ref)).scrollIntoViewIfNeeded();
      return;
    }
    if (!["up", "down"].includes(direction)) throw new BrowserError("scroll direction is up or down");
    const height = this.page.viewportSize()?.height ?? 900;
    await this.page.mouse.wheel(0, Math.round(height * amount) * (direction === "up" ? -1 : 1));
  }

  async do_back() {
    await this.page.goBack({ waitUntil: "domcontentloaded" });
  }

  async do_forward() {
    await this.page.goForward({ waitUntil: "domcontentloaded" });
  }

  async do_reload() {
    await this.page.reload({ waitUntil: "domcontentloaded" });
  }

  async do_wait({ seconds = 2, text = null }) {
    seconds = clamp(Number(seconds) || 0, 0, MAX_WAIT);
    if (text) await this.page.getByText(text).first().waitFor({ timeout: seconds * 1000 || ACTION_TIMEOUT });
    else await this.page.waitForTimeout(seconds * 1000);
  }

  // The visible text of an element (or the page), for when the snapshot's
  // structure is in the way of its words.
  async do_read({ ref = null, max_chars = null }) {
    const target = ref ? await this.locate(ref) : this.page.locator("body");
    const text = await target.innerText();
    return truncate(text, clamp(max_chars ?? this.browser.maxSnapshot, 1000, 500_000));
  }

  // A ref that is not on the page any more (the page changed under it) is
  // said so at once, not after a timeout.
  async locate(ref) {
    if (!ref || !/^(f\d+)?e\d+$/.test(String(ref))) throw new BrowserError("ref is an element reference from the snapshot, like e12");
    const locator = this.page.locator(`aria-ref=${ref}`);
    if ((await locator.count().catch(() => 0)) === 0) throw new BrowserError(`${ref} is not on the page; take a fresh snapshot`);
    return locator;
  }

  // Pages that stream themselves in (Amazon's do) are empty at
  // domcontentloaded, so wait for load, then for the body to say something.
  async settle() {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await this.page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
    await this.page
      .waitForFunction(() => (document.body?.innerText ?? "").trim().length > 0 || document.title.length > 0, null, { timeout: 3000 })
      .catch(() => {});
    await this.page.waitForTimeout(SETTLE_MS);
  }

  async state({ screenshot = false, max_chars = null } = {}) {
    const limit = clamp(max_chars ?? this.browser.maxSnapshot, 1000, 500_000);
    let snapshot;
    try {
      snapshot = await this.page.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT });
    } catch (error) {
      snapshot = `(no snapshot: ${describe(error)})`;
    }
    const state = {
      id: this.id,
      key: this.key,
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      domains: this.guard.domains,
      created_at: new Date(this.createdAt).toISOString(),
      expires_at: new Date(this.expiresAt()).toISOString(),
      steps: this.steps,
      snapshot: truncate(snapshot, limit),
      truncated: snapshot.length > limit,
      blocked: this.blocked
    };
    if (screenshot) {
      this.lastScreenshot = await this.page.screenshot({ type: "png", scale: "css" });
      state.screenshot = this.lastScreenshot.toString("base64");
    }
    return state;
  }

  async screenshot() {
    return this.run(async () => {
      this.touchedAt = Date.now();
      this.lastScreenshot = await this.page.screenshot({ type: "png", scale: "css" });
      return this.lastScreenshot;
    });
  }

  async close(reason = "closed") {
    if (this.closed) return;
    this.closed = reason;
    this.closedAt = Date.now();
    this.browser.audit?.write({ key: this.key, session: this.id, op: "close", reason, steps: this.steps });
    await this.page.close().catch(() => {});
  }
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

function firstLine(message) {
  return String(message).split("\n")[0];
}

// Playwright's errors are a paragraph; the first line says what happened.
function describe(error) {
  return firstLine(error.message);
}

function refusalPage(url, reason) {
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html><html><head><title>Refused by gofer</title></head><body>
<h1>Refused by gofer</h1><p>${escape(reason)}</p><p><code>${escape(url)}</code></p></body></html>`;
}

function auditable(params) {
  const out = {};
  for (const [name, value] of Object.entries(params)) {
    out[name] = typeof value === "string" && value.length > 80 ? `${value.slice(0, 80)}… (${value.length} chars)` : value;
  }
  return out;
}
