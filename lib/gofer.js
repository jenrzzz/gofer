// Settings from the environment, and the server they make.
import { homedir } from "node:os";
import { join } from "node:path";
import { App } from "./app.js";
import { Audit } from "./audit.js";
import { Browser, findChrome } from "./browser.js";
import { Keys } from "./keys.js";

export { App, Audit, Browser, Keys };

export function settings(env = process.env) {
  const home = env.GOFER_HOME ?? join(homedir(), ".config/gofer");
  return {
    home,
    bind: env.GOFER_BIND ?? "127.0.0.1",
    port: Number(env.GOFER_PORT ?? 8378),
    keysPath: join(home, "keys.json"),
    profile: env.GOFER_PROFILE ?? join(home, "profile"),
    executable: findChrome(env.GOFER_CHROME),
    headless: env.GOFER_HEADLESS === "1",
    auditPath: env.GOFER_AUDIT_LOG ?? join(homedir(), "Library/Logs/gofer/audit.jsonl"),
    ttl: Number(env.GOFER_TTL ?? 900),
    maxLife: Number(env.GOFER_MAX_LIFE ?? 3600),
    maxSessions: Number(env.GOFER_SESSIONS ?? 4),
    timezone: env.GOFER_TIMEZONE ?? null
  };
}

export async function serve(config) {
  const audit = new Audit(config.auditPath);
  const browser = new Browser({
    profile: config.profile,
    executable: config.executable,
    headless: config.headless,
    audit,
    ttl: config.ttl,
    maxLife: config.maxLife,
    maxSessions: config.maxSessions,
    timezone: config.timezone
  });
  const app = new App({ browser, keys: new Keys(config.keysPath), audit });
  const servers = [];
  for (const address of config.bind.split(",").map((item) => item.trim()).filter(Boolean)) {
    const server = app.server();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, address, () => {
        server.off("error", reject);
        resolve();
      });
    });
    servers.push(server);
    console.log(`gofer listening on ${address}:${config.port} (${config.executable ?? "playwright chromium"}, profile ${config.profile})`);
  }
  const stop = async () => {
    for (const server of servers) server.close();
    await browser.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { app, browser, servers };
}
