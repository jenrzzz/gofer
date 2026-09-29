// The HTTP face: bearer keys, JSON in and out, one route per thing a
// session can do. Sessions belong to the key that opened them.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrowserError } from "./browser.js";
import { KeyError, secureEqual } from "./keys.js";

const MAX_BODY = 1_000_000;
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export class App {
  constructor({ browser, keys, audit = null, docs = null, adminToken = null }) {
    this.browser = browser;
    this.keys = keys;
    this.audit = audit;
    this.docs = docs ?? fileURLToPath(new URL("../API.md", import.meta.url));
    this.adminToken = adminToken;
  }

  server() {
    return createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        if (!response.headersSent) json(response, 500, { error: "internal error" });
        console.error(error);
      });
    });
  }

  async handle(request, response) {
    const url = new URL(request.url, "http://gofer");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "GET" && path === "/v1/docs") {
      let text;
      try {
        text = readFileSync(this.docs, "utf8");
      } catch {
        return json(response, 404, { error: "no docs here" });
      }
      response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      return response.end(text);
    }

    let adminMatch;
    if ((adminMatch = path.match(/^\/v1\/keys\/([^/]+)$/)) && method === "PATCH") {
      return this.handleKeyPatch(request, response, adminMatch[1]);
    }

    const key = this.keys.authenticate(bearer(request));
    if (!key) return json(response, 401, { error: "unauthorized" });

    try {
      let match;
      if (method === "GET" && path === "/v1/status") {
        return json(response, 200, { gofer: VERSION, ...(await this.browser.status()), key });
      }
      if (method === "GET" && path === "/v1/sessions") {
        return json(response, 200, { sessions: this.browser.list(key).map(brief) });
      }
      if (method === "POST" && path === "/v1/sessions") {
        const body = await readJson(request);
        const session = await this.browser.open(key, body);
        return json(response, 201, await session.state({ screenshot: body.screenshot === true, max_chars: body.max_chars }));
      }
      if ((match = path.match(/^\/v1\/sessions\/([A-Za-z0-9_-]+)$/))) {
        const session = this.browser.session(match[1], key);
        if (method === "GET") {
          const state = await session.run(() =>
            session.state({ screenshot: url.searchParams.get("screenshot") === "1", max_chars: numberOrNull(url.searchParams.get("max_chars")) })
          );
          return json(response, 200, state);
        }
        if (method === "DELETE") {
          await session.close("closed by the caller");
          return json(response, 200, { id: session.id, closed: true, steps: session.steps });
        }
      }
      if ((match = path.match(/^\/v1\/sessions\/([A-Za-z0-9_-]+)\/actions$/)) && method === "POST") {
        const session = this.browser.session(match[1], key);
        const body = await readJson(request);
        return json(response, 200, await session.act(body));
      }
      if ((match = path.match(/^\/v1\/sessions\/([A-Za-z0-9_-]+)\/screenshot\.png$/)) && method === "GET") {
        const session = this.browser.session(match[1], key);
        const png = await session.screenshot();
        response.writeHead(200, { "content-type": "image/png", "content-length": png.length });
        return response.end(png);
      }
      return json(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof BrowserError) return json(response, error.status, { error: error.message });
      if (error instanceof BodyError) return json(response, 400, { error: error.message });
      throw error;
    }
  }

  // Widen or narrow a key's domains without touching its token. Needs
  // GOFER_ADMIN_TOKEN, a credential separate from any browsing key.
  async handleKeyPatch(request, response, name) {
    const admin = adminActor(request);
    if (!this.adminToken || !admin.token || !secureEqual(admin.token, this.adminToken)) {
      return json(response, 401, { error: "unauthorized" });
    }

    let domains;
    try {
      const body = await readJson(request);
      domains = normalizeDomains(body.domains);
    } catch (error) {
      if (error instanceof BodyError) {
        this.audit?.write({ op: "key-update", key: name, admin: admin.actor, ok: false, error: error.message });
        return json(response, 400, { error: error.message });
      }
      throw error;
    }

    let before;
    try {
      before = this.keys.setDomains(name, domains);
    } catch (error) {
      if (error instanceof KeyError) {
        this.audit?.write({ op: "key-update", key: name, admin: admin.actor, ok: false, error: error.message });
        return json(response, 404, { error: error.message });
      }
      throw error;
    }

    this.audit?.write({ op: "key-update", key: name, admin: admin.actor, ok: true, old_domains: before, new_domains: domains });
    return json(response, 200, { name, domains });
  }
}

class BodyError extends Error {}

// The admin's bearer token, and an optional name for the audit log
// (X-Admin-Actor), since GOFER_ADMIN_TOKEN is one shared secret.
function adminActor(request) {
  return { token: bearer(request), actor: request.headers["x-admin-actor"] || "admin" };
}

function normalizeDomains(domains) {
  if (!Array.isArray(domains)) throw new BodyError("domains must be an array of strings");
  return domains.map((entry) => {
    if (typeof entry !== "string") throw new BodyError("each domain must be a string");
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) throw new BodyError("a domain may not be an empty string");
    return trimmed;
  });
}

function bearer(request) {
  const header = request.headers.authorization ?? "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BodyError("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const body = JSON.parse(text);
        if (!body || typeof body !== "object" || Array.isArray(body)) return reject(new BodyError("body must be a JSON object"));
        resolve(body);
      } catch {
        reject(new BodyError("body is not JSON"));
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function numberOrNull(value) {
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function brief(session) {
  return {
    id: session.id,
    url: session.page.url(),
    domains: session.guard.domains,
    steps: session.steps,
    created_at: new Date(session.createdAt).toISOString(),
    expires_at: new Date(session.expiresAt()).toISOString()
  };
}
