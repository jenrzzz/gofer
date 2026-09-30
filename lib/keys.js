// Who may call. A key is a name, the domains it may browse (empty means
// any), and the URL paths it must never reach (checkout, say). Only a digest
// of the token is kept; the token is shown once, when it is made.
//
// The file is reread when it changes, so `bin/gofer key ...` takes effect on
// a running server.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PREFIX = "gfr_";

export class KeyError extends Error {}

export class Key {
  constructor({ name, domains = [], blocked_paths = [], created_at }) {
    this.name = name;
    this.domains = domains;
    this.blocked_paths = blocked_paths;
    this.created_at = created_at;
  }

  // A domain pattern matches itself and its subdomains: "amazon.com" covers
  // "www.amazon.com"; "*.amazon.com" says the same thing more explicitly.
  allowsHost(host) {
    if (this.domains.length === 0) return true;
    host = host.toLowerCase();
    return this.domains.some((pattern) => {
      const bare = pattern.toLowerCase().replace(/^\*\./, "");
      return host === bare || host.endsWith(`.${bare}`);
    });
  }

  // A blocked path is a prefix of the URL's path ("/checkout") or, with a
  // leading "~", a regular expression.
  blocksPath(path) {
    return this.blocked_paths.some((pattern) =>
      pattern.startsWith("~") ? new RegExp(pattern.slice(1)).test(path) : path.startsWith(pattern)
    );
  }

  // The reason a URL may not be opened by this key, or null.
  refusal(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return `not a URL: ${url}`;
    }
    if (parsed.protocol === "about:") return null;
    if (!["http:", "https:"].includes(parsed.protocol)) return `only http and https: ${url}`;
    if (!this.allowsHost(parsed.hostname)) return `${parsed.hostname} is outside this key's domains`;
    if (this.blocksPath(parsed.pathname)) return `${parsed.pathname} is a path this key may not reach`;
    return null;
  }

  toJSON() {
    return { name: this.name, domains: this.domains, blocked_paths: this.blocked_paths, created_at: this.created_at };
  }
}

export class Keys {
  constructor(path) {
    this.path = path;
    this.loadedAt = null;
    this.rows = [];
  }

  authenticate(token) {
    if (!token) return null;
    const digest = sha256(token);
    const row = this.load().find((candidate) => secureEqual(candidate.digest, digest));
    return row ? new Key(row) : null;
  }

  all() {
    return this.load().map((row) => new Key(row));
  }

  // Make a key, or rotate one that exists. Returns the token, once.
  add(name, { domains = [], blocked_paths = [] } = {}) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new KeyError(`a key name is lowercase letters, digits and dashes: ${name}`);
    for (const pattern of blocked_paths) {
      if (!pattern.startsWith("/") && !pattern.startsWith("~")) throw new KeyError(`a blocked path starts with / or ~: ${pattern}`);
      if (pattern.startsWith("~")) new RegExp(pattern.slice(1)); // throws on a bad expression
    }
    const token = PREFIX + randomBytes(24).toString("base64url");
    const rows = this.load().filter((row) => row.name !== name);
    rows.push({ name, digest: sha256(token), domains, blocked_paths, created_at: new Date().toISOString() });
    this.save(rows);
    return token;
  }

  revoke(name) {
    const rows = this.load();
    const kept = rows.filter((row) => row.name !== name);
    if (kept.length === rows.length) throw new KeyError(`no key named ${name}`);
    this.save(kept);
  }

  // Replace a key's domains in place: the digest, blocked_paths and
  // created_at are untouched, so the token stays valid. Returns the
  // domains as they were before, for an audit entry.
  setDomains(name, domains) {
    const rows = this.load();
    const index = rows.findIndex((row) => row.name === name);
    if (index === -1) throw new KeyError(`no key named ${name}`);
    const before = rows[index].domains;
    const next = rows.slice();
    next[index] = { ...rows[index], domains };
    this.save(next);
    return before;
  }

  load() {
    let mtime = null;
    try {
      mtime = statSync(this.path).mtimeMs;
    } catch {
      this.rows = [];
      this.loadedAt = null;
      return this.rows;
    }
    if (mtime !== this.loadedAt) {
      this.rows = JSON.parse(readFileSync(this.path, "utf8")).keys ?? [];
      this.loadedAt = mtime;
    }
    return this.rows;
  }

  save(rows) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ keys: rows }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.loadedAt = null;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function secureEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
