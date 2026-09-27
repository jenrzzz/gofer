import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keys, KeyError, PREFIX } from "../lib/keys.js";

function fresh() {
  return new Keys(join(mkdtempSync(join(tmpdir(), "gofer-keys-")), "keys.json"));
}

test("a key is made once, kept as a digest, and authenticates", () => {
  const keys = fresh();
  const token = keys.add("hob", { domains: ["amazon.com"], blocked_paths: ["/checkout"] });
  assert.ok(token.startsWith(PREFIX));
  assert.ok(!readFileSync(keys.path, "utf8").includes(token));
  const key = keys.authenticate(token);
  assert.equal(key.name, "hob");
  assert.deepEqual(key.domains, ["amazon.com"]);
  assert.equal(keys.authenticate("gfr_nope"), null);
  assert.equal(keys.authenticate(""), null);
});

test("adding a name again rotates it; revoking forgets it", () => {
  const keys = fresh();
  const first = keys.add("hob");
  const second = keys.add("hob");
  assert.equal(keys.authenticate(first), null);
  assert.equal(keys.authenticate(second).name, "hob");
  assert.equal(keys.all().length, 1);
  keys.revoke("hob");
  assert.equal(keys.authenticate(second), null);
  assert.throws(() => keys.revoke("hob"), KeyError);
});

test("names and blocked paths are validated", () => {
  const keys = fresh();
  assert.throws(() => keys.add("Hob!"), KeyError);
  assert.throws(() => keys.add("hob", { blocked_paths: ["checkout"] }), KeyError);
  assert.throws(() => keys.add("hob", { blocked_paths: ["~("] }), SyntaxError);
});

test("domains cover subdomains; blocked paths are prefixes or expressions", () => {
  const keys = fresh();
  const key = keys.authenticate(keys.add("hob", { domains: ["amazon.com", "*.ynab.com"], blocked_paths: ["/checkout", "~/buy/"] }));
  assert.equal(key.refusal("https://www.amazon.com/gp/your-account/order-history"), null);
  assert.equal(key.refusal("https://amazon.com/"), null);
  assert.equal(key.refusal("https://app.ynab.com/"), null);
  assert.match(key.refusal("https://notamazon.com/"), /outside/);
  assert.match(key.refusal("https://amazon.com.evil.net/"), /outside/);
  assert.match(key.refusal("https://www.amazon.com/checkout/p/x"), /may not reach/);
  assert.match(key.refusal("https://www.amazon.com/gp/buy/spc"), /may not reach/);
  assert.match(key.refusal("ftp://amazon.com/"), /only http/);
  assert.match(key.refusal("nope"), /not a URL/);
  assert.equal(key.refusal("about:blank"), null);
});

test("a key with no domains browses anywhere", () => {
  const keys = fresh();
  const key = keys.authenticate(keys.add("local"));
  assert.equal(key.refusal("https://example.org/"), null);
});
