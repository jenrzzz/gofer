// One line per thing done in the browser: when, which key, which session,
// what, where it landed, and how it went. Text an agent typed is kept to a
// length; a page's contents are never written here.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Audit {
  constructor(path) {
    this.path = path;
    this.ready = false;
  }

  write(entry) {
    if (!this.path) return;
    if (!this.ready) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.ready = true;
    }
    appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  }
}
