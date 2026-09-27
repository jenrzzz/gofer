# gofer

*Goes and gets things.* An HTTP API over a real Google Chrome on this Mac,
so agents can browse as the household: from the house's own address, in a
profile somebody has logged into, on a screen a person can walk up to.

The problem it solves: an agent that lives in a datacenter is turned away
by sites that mind (Amazon most of all) and has no cookies of yours.
gofer's Chrome is neither of those things. It is headed, it keeps a
profile of its own under `~/.config/gofer/profile`, and its window is a
real one in your login session: log into Amazon there once and every
session after is you; when a site asks for a captcha or a password again,
the page is on the Mac's screen for you to answer.

[API.md](API.md) is the contract, written for the agents that will use it
(the server also hands it out at `GET /v1/docs`). In short: open a
session at a URL, get the page back as an accessibility snapshot with a
ref on every element, act by ref (click, type, press, select, scroll,
navigate, back, read), get a fresh snapshot after each step; a screenshot
when asked. Keys confine what a session may reach, and every step is
logged.

## Running

Node 22+ and, ideally, Google Chrome. Without Chrome, gofer drives
Playwright's Chromium, which works but looks less like a person's browser.

```sh
npm install
npx playwright install chromium             # only if there is no Google Chrome
bin/gofer key add hob --domains amazon.com --block /checkout,/gp/buy,/buy
bin/gofer serve                             # 127.0.0.1:8378
curl -H "Authorization: Bearer gfr_..." -d '{"url":"https://www.amazon.com/"}' localhost:8378/v1/sessions
```

To keep it running across logins, and reachable from the tailnet:

```sh
GOFER_BIND=127.0.0.1,100.90.105.100 bin/gofer install   # a launchd agent
bin/gofer open amazon.com                               # a tab in the window: go log in
bin/gofer check                                         # up? which Chrome? which profile?
bin/gofer sessions
bin/gofer uninstall
```

It is a Launch*Agent* on purpose: the window has to be in the login
session to be on the screen, so the Mac stays logged in (the screen can
lock). Bind to loopback and the tailnet address, never `0.0.0.0`: the
tailnet is the transport security, and the keys are the authorization.

| env | default | |
|---|---|---|
| `GOFER_BIND` | `127.0.0.1` | comma list of addresses to listen on |
| `GOFER_PORT` | `8378` | |
| `GOFER_HOME` | `~/.config/gofer` | `keys.json` (digests only, mode 600), `local.key` (the CLI's own key), and the profile |
| `GOFER_PROFILE` | `$GOFER_HOME/profile` | Chrome's user data directory: the cookies, the logins |
| `GOFER_CHROME` | `~/Applications` or `/Applications` Google Chrome | the browser to drive; unset and absent, Playwright's Chromium |
| `GOFER_HEADLESS` | unset | `1` to run without a window (tests; not for Amazon) |
| `GOFER_AUDIT_LOG` | `~/Library/Logs/gofer/audit.jsonl` | one line per session opened, step taken, navigation refused, session closed |
| `GOFER_TTL` | `900` | seconds a session lives without a call |
| `GOFER_MAX_LIFE` | `3600` | seconds a session lives at most |
| `GOFER_SESSIONS` | `4` | sessions open at once |
| `GOFER_TIMEZONE` | the Mac's | the browser's timezone, if it should differ |

## Keys

```sh
bin/gofer key add hob --domains amazon.com --block /checkout,/gp/buy,/buy
bin/gofer key add anywhere
bin/gofer key list
bin/gofer key revoke anywhere
```

The token prints once; gofer stores a SHA-256 digest. Adding a name that
exists rotates it. Changes take effect on the running server at once.

**Domains** are where a key's sessions may go: a name covers its
subdomains (`amazon.com` is also `www.amazon.com`), and a session may
narrow the list further but never widen it. **Blocked paths** are URL
paths the key must never reach, as prefixes (`/checkout`) or, with a
leading `~`, regular expressions. Both are enforced *in the browser*: a
request route refuses any top-level navigation outside them, so a link
that leads to checkout, a redirect that leaves the site, or a
`target=_blank` that opens elsewhere all fail in Chrome, not after the
fact. The refusal shows up on the session as `blocked: { url, reason }`,
and the tab stays where it was.

The profile is the blast radius. gofer cannot tell "Place your order"
from any other button; what it can do is keep a key off the pages where
that button lives. Log the profile into an account whose worst case you
can live with, turn 1-Click off, and block the buying paths.

## How it works

```
agent ──HTTP──▶ App                    auth, sessions, JSON, audit
                 │
                 ▼
                Browser                one persistent Chrome context; a page per session;
                 │                     one request route judging every top-level navigation
                 ▼
                Chrome (headed)        ~/.config/gofer/profile, --enable-automation off
```

Playwright drives Chrome over its own protocol; `page.ariaSnapshot({ mode:
"ai" })` is the snapshot and `aria-ref=` the way back from a ref to the
element. Steps on one session run in the order they arrive; sessions run
side by side as tabs. Each step waits for the page to settle (load, then
the body saying something: Amazon streams its pages in after
`domcontentloaded`) before it snapshots. A tab gofer did not open, a popup
or one made by hand in the window, is closed at once; a popup's
destination is judged by the guard and, if allowed, opened in the
session's own tab instead.

Not built: a browsing agent of its own. gofer is hands, not a head; the
agent that calls it decides what to click. Also not built: file uploads,
downloads, running script in the page, more than one window.

## Tests

```sh
npm test      # keys offline; the whole API against headless Chromium over a site served from the test
```

The API test maps `shop.test` and `elsewhere.test` onto a fixture server
with Chrome's host-resolver rules, so the guard has a foreign domain to
refuse without the network.

## hob

In [hob](../hob) a gofer server is one *browser*: a row with this server's
URL, a key, and a realm. Agents reach it as the `browse.*` sentinel
capabilities; see hob's `BROWSE.md`.
