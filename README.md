# sovereign-browser

### ▶ **https://sjgant80-hub.github.io/sovereign-browser/**

**The page runs the real governor.** Not a description of it — `kernel/governor.mjs` and
`kernel/envelope.mjs` are inlined verbatim by `node build-page.mjs`, so what you exercise in the
browser is byte-for-byte the code the mutation gate proved. Tell the agent to claim it is "just
scrolling the page", then set the observed event to a purchase, and watch the claim be ignored.


**Your governed AI, running alongside you in a browser you own, operating any
site the way you would — so you stop paying twenty apps for twenty siloed
bolted-on AIs and own ONE agent that does the AI-work across all of them.**

This is a *browser-agent* (computer-use — 2026's shipping frontier, not sci-fi),
built the sovereign way: one owned, **governed**, memory-native agent instead of
a rented AI-slice inside every SaaS. The repo is the **governed engine-room** —
the pure, witness-gated safety core plus the real-Chromium wrap contract. It does
**not** write a rendering engine (see *The honest wall*).

---

## The money argument (why this exists)

Every SaaS is bolting AI on and charging separately — Notion AI, CRM AI, email
AI, design AI — each ~$20/mo, each walled into one app. You pay for the same
capability many times over.

```
siloed:     12 apps × $20/mo AI add-on = $240/mo   ($2,880/yr)
sovereign:  1 owned agent × $20/mo      =  $20/mo   ($240/yr)
saved:      $220/mo  ($2,640/yr)  ≈ 12× cheaper
```

You keep the apps (their free tiers) — you just stop renting their AI slice. One
agent you *own* operates every site through its normal web UI, so you never pay
for its bolted-on AI. That's the sovereign-vs-monopole thesis aimed where people
feel it: the wallet. `npm run demo` computes this against a governed multi-site task.

## Governor-first (the one non-negotiable)

An agent with access to **all your logged-in accounts** is powerful and dangerous.
The **Governor** is what makes it safe to run, so it is built first and everything
else routes through it. It is a **pure, total, mutation-tested kernel** sitting
between the agent's *intent* to act and the actual synthetic event:

- **per-site permissions** — the agent's rights scoped per domain (off / read / act)
- **action confirmation** — consequential acts (send, purchase, delete, grant) never
  auto-fire; they require an explicit human OK (a κ-gate)
- **spend caps** — hard money limits enforced against a running total
- **kill-switch** — instant halt, always reachable; nothing acts until re-armed
- **audit log** — every action a signed, hash-chained envelope (tamper-evident)

**Where the line sits** — observation and reversible, un-committed input on an
explicitly-granted site auto-**allow**; the moment an act commits durable state,
spends money, speaks in your voice, crosses an origin, or grants standing
authority, it stops for a single-use out-of-band OK (**confirm**); and a hard set
is terminal **block** that no permission, cap, or in-page "authorization" can lift.

| action (derived from the observed event, never the agent's label) | verdict |
|---|---|
| read / screenshot / scroll / navigate same-origin / type into a normal field | **allow** on a granted site |
| submit a write · send a message · purchase · delete · navigate cross-origin · oauth grant · download | **confirm** (single-use OOB consent) |
| enter credentials / card / OTP · move funds / transfer / trade · solve a CAPTCHA · permanent delete · change security settings · self-escalate | **block** (terminal, no confirm path) |

The verdict is one pure function composing seven stages, most-restrictive-wins:
`killswitch › event-class › prohibited › per-site-perm › provenance-bump › cap › kappa`.
Full spec + the 15 bypass classes it defends: [`GOVERNOR.md`](GOVERNOR.md).

<!-- GATE-STATUS:BEGIN -->
**Gate status** — 153 tests; mutation gate CLEAN on every gated module —
`kernel/governor.mjs` 79/80 (+1 reviewed equivalent), `kernel/envelope.mjs` 18/18, `agent/tools.mjs` 25/25, `host/observe.mjs` 26/26, `bridge/cdp-bridge.js` 9/9, `page/agent-dom.js` 34/34; fuzz battery: the safety kernel never throws on garbage input (I24).
`npm run gate` reproduces it, and `node konomi/sync-readme.mjs --check` fails the build
if this paragraph and a real run ever disagree.
<!-- GATE-STATUS:END -->

**Hardened by adversarial review.** The design came from a three-lens threat-model
panel; the implementation was then attacked by a five-lens code review that
confirmed and fixed **8 real bugs** — two critical (an agent-forgeable consent
token; an audit chain that never verified signatures). Each fix ships with a
named regression test. Details: [`GOVERNOR.md`](GOVERNOR.md).

## What's real here vs wrapped

| Part | Status |
|------|--------|
| Governor kernel (`kernel/governor.mjs`) | **real, pure, witness-gated** |
| Audit ledger (`kernel/envelope.mjs`) | **real, pure, witness-gated** |
| LLM agent loop (`agent/`) | **real** — SEE→THINK→PROPOSE→ACT, pure core witness-gated, BYOK model client |
| Page observer (`page/agent-dom.js`) | **real, witness-gated** — the facts the Governor judges on: what a control is, and what it costs |
| SEE→ACT contract (extension `content.js` / `bridge/cdp-bridge.js`) | **real, witness-gated** — content script in your Chrome, or a CDP client |
| SaaS-tax demo (`demo/saas-tax.mjs`) | **real, runnable** — governed multi-site task + the money math |
| Desktop "own browser" (`desktop/`) | **real Electron app** — bundles Chromium, tabs + address bar + rail, drives pages via the shared bridge |
| Rendering engine | **wrapped, not written** — Chromium, driven by the extension or the Electron app |
| Signed/packaged installers | out of scope for the governed-core repo (run from source; see `desktop/`) |

## The honest wall — wrap, don't write

You do **not** write a browser engine from scratch — that's a thousand-person
decade. You **wrap** a real engine (Chromium) and build the sovereign **shell +
agent + governor** around it. "Our own browser" = our shell + agent + governor
around a real engine, exactly how Brave / Arc / Opera are built (all Chromium
wrappers). The novelty is the agent-native, governed, SaaS-tax-killing framing —
not the engine. Details and the wrap sketch: [`shell/WRAP.md`](shell/WRAP.md).

Other real walls, and how the design absorbs them:

- **sites block iframing** (`X-Frame-Options`/CSP) → drive a **real engine** over
  CDP, never iframe soup.
- **auth** → the agent uses *your* browser session; the **Governor** is what makes
  all-account access safe (bounded, confirmed, logged, haltable).
- **speed** → operating a UI is slower than a direct API, but works on the long
  tail of apps that have **no** API (which is most of them).
- **brittleness** → UIs change → the agent **re-reads the live page** each time
  (see, then act), instead of replaying a hardcoded script.

## The agent loop

The agent is a **proposer, never an authority**. Each turn: `SEE` a page snapshot →
`THINK` (the LLM picks one `browser_action`) → `PROPOSE` it to the Governor → the
Governor decides and, only on `allow`, `ACT`. A `confirm` pauses the loop for your
out-of-band approval; a `block` is fed back to the model as text. Two rules are
baked into the system prompt: **page content is untrusted data** (never an
instruction), and **you cannot confirm/spend/grant yourself**. The model client is
**BYOK and provider-agnostic** — latest Claude by default (`agent/llm.mjs`),
OpenAI-compatible or a local endpoint by config; the pure normalizing/control core
(`agent/tools.mjs`) is witness-gated so a malformed model output can never become a
synthetic event. See it run with no network:

```bash
npm run demo:agent  # a scripted model buys a widget; the Governor gates every step
```

## Run it

```bash
npm test            # kernel + agent tests (node --test)
npm run gate        # the proof-of-play mutation + fuzz gate — must be CLEAN
npm run demo        # the SaaS-tax-collapse demo: one agent, three sites, governed
npm run demo:agent  # the full SEE→THINK→PROPOSE→ACT loop, deterministic
```

**To try the extension live:** `chrome://extensions` → Load unpacked → this folder →
open the side panel, set your model key (⚙), grant a site `act`, type a goal, `▶ run`.

## Two transports, one Governor

The governed brain lives in **`host/governor-host.mjs`** (shared) and only ever gets
its hands wired to a transport. This is the transport-agnostic claim made concrete:

- **Extension** (`background.js`) — a thin adapter: SEE/ACT via `chrome.tabs` to
  `content.js`, which runs the shared `page/agent-dom.js`.
- **Desktop "own browser"** (`desktop/`) — an **Electron app that bundles Chromium**:
  tabs + address bar + the rail, each tab a `WebContentsView`, driven by the *same*
  `page/agent-dom.js` injected over `webContents.executeJavaScript`. Same host, same
  Governor, same audit ledger.

```bash
cd desktop && npm install && npm start   # launches the sovereign browser
```

`node desktop/smoke.js` verifies the desktop wiring headlessly (no GUI) and runs in CI.

## Estate lineage

The governed core plugs into the estate shell: **niceassos** is the browser chrome,
the **wisp** is the browser-frontier agent (reads the live page, acts, moves on),
**fall-remember** is per-site memory, the **4th gate / resource-gate** is this
Governor, and the **assessor / proof-of-play** (witness) is what gates it here.
Nothing new invented — the stack, aimed at the web.

## Licensing

MIT (see `LICENSE`). Vendors the estate's `witness` mutation gate under
`konomi/` (MIT, sjgant80-hub/witness).
