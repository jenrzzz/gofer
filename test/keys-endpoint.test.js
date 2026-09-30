// PATCH /v1/keys/:name against a plain App: no Chrome involved, since the
// route never touches the browser.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Audit, Keys } from "../lib/gofer.js";

const ADMIN_TOKEN = "admin-secret-token";

let app, server, base, keys, browsingToken, home, auditPath;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "gofer-keys-endpoint-"));
  auditPath = join(home, "audit.jsonl");
  keys = new Keys(join(home, "keys.json"));
  browsingToken = keys.add("hob", { domains: ["amazon.com"], blocked_paths: ["/checkout"] });
  app = new App({ browser: {}, keys, audit: new Audit(auditPath), adminToken: ADMIN_TOKEN, docs: join(home, "missing.md") });
  server = app.server();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

async function patch(name, body, token = ADMIN_TOKEN, extraHeaders = {}) {
  const headers = { "content-type": "application/json", ...extraHeaders };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/v1/keys/${name}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

function auditLines() {
  return readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("an admin can widen or narrow a key's domains without rotating its token", async () => {
  const { status, body } = await patch("hob", { domains: [" Amazon.com ", "YNAB.com"] });
  assert.equal(status, 200);
  assert.deepEqual(body.domains, ["amazon.com", "ynab.com"]);

  const key = keys.authenticate(browsingToken);
  assert.ok(key, "the original token still authenticates");
  assert.deepEqual(key.domains, ["amazon.com", "ynab.com"]);

  const entry = auditLines().find((line) => line.op === "key-update" && line.ok && line.admin === "admin");
  assert.ok(entry, "a successful update is audited");
  assert.equal(entry.key, "hob");
  assert.deepEqual(entry.old_domains, ["amazon.com"]);
  assert.deepEqual(entry.new_domains, ["amazon.com", "ynab.com"]);
  assert.ok(entry.at);
});

test("an empty array means unrestricted", async () => {
  const { status, body } = await patch("hob", { domains: [] });
  assert.equal(status, 200);
  assert.deepEqual(body.domains, []);
  assert.equal(keys.authenticate(browsingToken).refusal("https://anywhere.example/"), null);
});

test("invalid domains are rejected with 400, and audited", async () => {
  keys.setDomains("hob", ["amazon.com"]);

  const notArray = await patch("hob", { domains: "amazon.com" });
  assert.equal(notArray.status, 400);
  assert.match(notArray.body.error, /array/);

  const notString = await patch("hob", { domains: ["amazon.com", 7] });
  assert.equal(notString.status, 400);
  assert.match(notString.body.error, /string/);

  const empty = await patch("hob", { domains: ["amazon.com", "  "] });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /empty/);

  // the key is untouched by any of the rejected attempts
  assert.deepEqual(keys.authenticate(browsingToken).domains, ["amazon.com"]);

  const rejections = auditLines().filter((line) => line.op === "key-update" && !line.ok);
  assert.ok(rejections.length >= 3, "each rejected attempt is audited");
});

test("404 for a key that does not exist", async () => {
  const { status, body } = await patch("nosuchkey", { domains: ["amazon.com"] });
  assert.equal(status, 404);
  assert.match(body.error, /no key named/);
  assert.ok(auditLines().some((line) => line.op === "key-update" && !line.ok && line.key === "nosuchkey"));
});

test("401 without admin credentials, with the wrong token, or using a browsing key", async () => {
  assert.equal((await patch("hob", { domains: [] }, null)).status, 401);
  assert.equal((await patch("hob", { domains: [] }, "wrong-token")).status, 401);
  assert.equal((await patch("hob", { domains: [] }, browsingToken)).status, 401);
});

test("an admin actor name is recorded when given", async () => {
  await patch("hob", { domains: ["amazon.com"] }, ADMIN_TOKEN, { "x-admin-actor": "jenner" });
  const entry = auditLines().find((line) => line.admin === "jenner");
  assert.ok(entry);
});
