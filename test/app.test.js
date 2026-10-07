// The whole API against Playwright's Chromium, headless, over a small site
// served from this process. Domains in the fixture: the site answers as
// "shop.test" and "elsewhere.test" through a host map, so the guard has
// something to refuse.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Audit, Browser, Keys } from "../lib/gofer.js";

const PAGES = {
  "/": `<html><head><title>Shop</title></head><body>
    <h1>Shop</h1>
    <nav><a href="/orders">Your orders</a> <a href="/checkout">Checkout</a> <a href="http://elsewhere.test:PORT/">Elsewhere</a>
    <a href="/orders" target="_blank">Orders in a new tab</a> <a href="http://elsewhere.test:PORT/" target="_blank">Elsewhere in a new tab</a></nav>
    <form action="/search"><label>Search <input name="q"></label><button>Go</button></form>
    <select aria-label="Sort"><option value="new">Newest</option><option value="old">Oldest</option></select>
    </body></html>`,
  "/orders": `<html><head><title>Orders</title></head><body><h1>Your orders</h1>
    <ul><li>Order 111-222 · $12.34 · Widget</li><li>Order 333-444 · $56.78 · Gadget</li></ul>
    <a href="/">Home</a></body></html>`,
  "/search": `<html><head><title>Results</title></head><body><h1>Results</h1><p id="q"></p>
    <script>document.getElementById("q").textContent = "you searched for " + new URLSearchParams(location.search).get("q")</script></body></html>`,
  "/checkout": `<html><head><title>Checkout</title></head><body><h1>Buy now</h1></body></html>`
};

let site, port, browser, app, server, base, keys, token, home;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "gofer-test-"));
  site = createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    const html = PAGES[path];
    if (!html) {
      response.writeHead(404);
      return response.end("nope");
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html.replaceAll("PORT", String(port)));
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  port = site.address().port;

  // The browser must reach shop.test: launch it with a host-resolver rule so
  // the names land on the fixture without touching /etc/hosts.
  const { chromium } = await import("playwright");
  const original = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = (dir, options) =>
    original(dir, { ...options, args: [...(options.args ?? []), `--host-resolver-rules=MAP shop.test 127.0.0.1:${port}, MAP elsewhere.test 127.0.0.1:${port}`] });

  browser = new Browser({ profile: join(home, "profile"), headless: true, audit: new Audit(join(home, "audit.jsonl")), maxSessions: 2, ttl: 60 });
  keys = new Keys(join(home, "keys.json"));
  token = keys.add("hob", { domains: ["shop.test"], blocked_paths: ["/checkout"] });
  app = new App({ browser, keys, docs: join(home, "missing.md") });
  server = app.server();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await browser.shutdown();
  server.close();
  site.close();
});

async function call(method, path, body, auth = token) {
  const response = await fetch(base + path, {
    method,
    headers: { authorization: auth ? `Bearer ${auth}` : "", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, body: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}

const home_url = () => `http://shop.test:${port}/`;

test("no key, no entry; docs are open", async () => {
  assert.equal((await call("GET", "/v1/status", null, null)).status, 401);
  assert.equal((await call("GET", "/v1/status", null, "gfr_wrong")).status, 401);
  assert.equal((await call("GET", "/v1/docs", null, null)).status, 404); // no API.md in the tmp home
});

test("status names the key", async () => {
  const { status, body } = await call("GET", "/v1/status");
  assert.equal(status, 200);
  assert.equal(body.key.name, "hob");
  assert.equal(body.limits.sessions, 2);
});

test("a session opens with a ref snapshot, acts by ref, and closes", async () => {
  const opened = await call("POST", "/v1/sessions", { url: home_url() });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const session = opened.body;
  assert.equal(session.title, "Shop");
  assert.match(session.snapshot, /link "Your orders" \[ref=(?:f\d+)?e\d+\]/);
  assert.deepEqual(session.domains, ["shop.test"]);
  assert.equal(session.steps, 0);

  const orders = session.snapshot.match(/link "Your orders" \[ref=((?:f\d+)?e\d+)\]/)[1];
  const clicked = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "click", ref: orders });
  assert.equal(clicked.status, 200, JSON.stringify(clicked.body));
  assert.equal(clicked.body.title, "Orders");
  assert.match(clicked.body.snapshot, /Order 111-222/);
  assert.equal(clicked.body.steps, 1);

  const read = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "read" });
  assert.match(read.body.text, /Order 333-444 · \$56.78 · Gadget/);

  const html = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "html" });
  assert.match(html.body.text, /^<html><head><title>Orders<\/title>/);
  assert.match(html.body.text, /<li>Order 111-222 · \$12.34 · Widget<\/li>/);

  const back = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "back" });
  assert.equal(back.body.title, "Shop");

  const search = back.body.snapshot.match(/textbox "Search" \[ref=((?:f\d+)?e\d+)\]/)[1];
  const typed = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "type", ref: search, text: "widgets", submit: true });
  assert.equal(typed.body.title, "Results", JSON.stringify(typed.body));
  assert.match(typed.body.snapshot, /you searched for widgets/);

  const navigated = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "navigate", url: home_url() });
  const sort = navigated.body.snapshot.match(/combobox "Sort" \[ref=((?:f\d+)?e\d+)\]/)[1];
  const selected = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "select", ref: sort, values: ["old"] });
  assert.match(selected.body.snapshot, /combobox "Sort"[^\n]*\n[^\n]*"Newest"[\s\S]*"Oldest" \[selected\]/);

  const listed = await call("GET", "/v1/sessions");
  assert.equal(listed.body.sessions.length, 1);
  assert.equal(listed.body.sessions[0].steps, 7);

  const closed = await call("DELETE", `/v1/sessions/${session.id}`);
  assert.deepEqual(closed.body, { id: session.id, closed: true, steps: 7 });
  assert.equal((await call("GET", `/v1/sessions/${session.id}`)).status, 410);
});

test("a screenshot comes inline when asked and as a png", async () => {
  const { body: session } = await call("POST", "/v1/sessions", { url: home_url(), screenshot: true });
  assert.ok(session.screenshot.length > 1000);
  assert.ok(Buffer.from(session.screenshot, "base64").subarray(1, 4).equals(Buffer.from("PNG")));
  const png = await call("GET", `/v1/sessions/${session.id}/screenshot.png`);
  assert.equal(png.status, 200);
  assert.ok(png.body.subarray(1, 4).equals(Buffer.from("PNG")));
  const plain = await call("GET", `/v1/sessions/${session.id}`);
  assert.equal(plain.body.screenshot, undefined);
  await call("DELETE", `/v1/sessions/${session.id}`);
});

test("the guard refuses other domains and blocked paths, in the browser", async () => {
  const { body: session } = await call("POST", "/v1/sessions", { url: home_url() });

  const away = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "navigate", url: `http://elsewhere.test:${port}/` });
  assert.equal(away.status, 422);
  assert.match(away.body.error, /outside this key's domains/);

  const checkout = session.snapshot.match(/link "Checkout" \[ref=((?:f\d+)?e\d+)\]/)[1];
  const clicked = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "click", ref: checkout });
  assert.equal(clicked.status, 200, JSON.stringify(clicked.body));
  assert.equal(clicked.body.title, "Shop", JSON.stringify(clicked.body).slice(0, 300));
  assert.match(clicked.body.blocked.reason, /may not reach/);
  assert.match(clicked.body.blocked.url, /\/checkout$/);

  // Refs belong to a page load: after stepping back, take them from the fresh snapshot.
  const elsewhere = clicked.body.snapshot.match(/link "Elsewhere" \[ref=((?:f\d+)?e\d+)\]/)[1];
  const followed = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "click", ref: elsewhere });
  assert.equal(followed.body.title, "Shop");
  assert.match(followed.body.blocked.reason, /outside/);

  const fresh = await call("GET", `/v1/sessions/${session.id}`);
  assert.equal(fresh.body.blocked.reason.length > 0, true, "the last refusal stays until the next action");
  await call("DELETE", `/v1/sessions/${session.id}`);
});

test("a popup is folded into the session's tab, or refused, and never stays open", async () => {
  const { body: session } = await call("POST", "/v1/sessions", { url: home_url() });
  const allowed = session.snapshot.match(/link "Orders in a new tab" \[ref=((?:f\d+)?e\d+)\]/)[1];
  const followed = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "click", ref: allowed });
  assert.equal(followed.body.title, "Orders", JSON.stringify(followed.body).slice(0, 300));
  assert.equal(followed.body.blocked, null);

  const back = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "back" });
  const refused = back.body.snapshot.match(/link "Elsewhere in a new tab" \[ref=((?:f\d+)?e\d+)\]/)[1];
  const stayed = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "click", ref: refused });
  assert.equal(stayed.body.title, "Shop");
  assert.match(stayed.body.blocked.reason, /outside/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(browser.context.pages().filter((page) => page.url() !== "about:blank").map((page) => page.url()), [home_url()], "no stray tabs");
  await call("DELETE", `/v1/sessions/${session.id}`);
});

test("opening outside the key's domains, or narrowing beyond them, is refused", async () => {
  const away = await call("POST", "/v1/sessions", { url: `http://elsewhere.test:${port}/` });
  assert.equal(away.status, 422);
  const wider = await call("POST", "/v1/sessions", { url: home_url(), domains: ["elsewhere.test"] });
  assert.equal(wider.status, 422);
  const blocked = await call("POST", "/v1/sessions", { url: `http://shop.test:${port}/checkout` });
  assert.equal(blocked.status, 422);
  const missing = await call("POST", "/v1/sessions", {});
  assert.equal(missing.status, 422);
});

test("a bad ref, a bad action, and a stale session say so", async () => {
  const { body: session } = await call("POST", "/v1/sessions", { url: home_url() });
  const stale = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "click", ref: "e999" });
  assert.equal(stale.status, 422);
  assert.match(stale.body.error, /e999 is not on the page/);
  const bad = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "purchase" });
  assert.match(bad.body.error, /action is one of/);
  const noRef = await call("POST", `/v1/sessions/${session.id}/actions`, { action: "click", ref: "button" });
  assert.match(noRef.body.error, /like e12/);
  await call("DELETE", `/v1/sessions/${session.id}`);
  assert.equal((await call("POST", "/v1/sessions/nope/actions", { action: "reload" })).status, 404);
});

test("sessions belong to the key that opened them", async () => {
  const other = keys.add("other", { domains: ["shop.test"] });
  const { body: session } = await call("POST", "/v1/sessions", { url: home_url() });
  assert.equal((await call("GET", `/v1/sessions/${session.id}`, null, other)).status, 404);
  assert.equal((await call("GET", "/v1/sessions", null, other)).body.sessions.length, 0);
  await call("DELETE", `/v1/sessions/${session.id}`);
});

test("the session cap holds", async () => {
  const a = await call("POST", "/v1/sessions", { url: home_url() });
  const b = await call("POST", "/v1/sessions", { url: home_url() });
  const c = await call("POST", "/v1/sessions", { url: home_url() });
  assert.equal(c.status, 429);
  await call("DELETE", `/v1/sessions/${a.body.id}`);
  await call("DELETE", `/v1/sessions/${b.body.id}`);
});
