# pi-sidepanel Framework — AGENTS.md

Guidelines for AI agents extending the pi-sidepanel framework. A decoupled,
content-agnostic right-side overlay engine with tabbed views driven by an
event-hook system. Tab plugins are **separate extensions** that register
against this framework — the framework itself contains zero domain knowledge.

## Architecture

```
pi-sidepanel/          ← Framework: tabs + layout + events + sanitization
  index.ts             ← SidepanelComponent class + extension entry point
  sanitize.ts          ← Defensive ANSI/control-character stripper
  package.json         ← "pi-sidepanel" package with pi.extensions entry

pi-sidepanel-{name}/   ← Tab plugins (one per package)
  index.ts             ← Component + event wiring + registration
  package.json         ← "pi-sidepanel-{name}" package

Each tab plugin:
  1. Creates a component class/object implementing the Component interface
  2. Registers via pi.events.emit("sidepanel:register", { id, label, component })
  3. Wires pi.on("session_start") for session replay + registration
  4. Wires pi.events.on("sidepanel:ready") as fallback re-registration
  5. Emits pi.events.emit("sidepanel:invalidate", { tabId }) on data changes
```

### Event flow

```
Tab plugin loads
  └─ loads → pi.events.emit("sidepanel:register", ...)
                  └─ Framework buffers if panel closed, adds inline if open

Framework opens panel (F2 / auto-open)
  └─ Flushes pending registrations into SidepanelComponent
  └─ Each tab renders lazily when first viewed (per-tab cache)

Tab data changes (tool_call, tool_result, etc.)
  └─ Tab emits pi.events.emit("sidepanel:invalidate", { tabId })
        └─ Framework clears that tab's cache, re-renders if active

User switches tabs (Tab / Shift+Tab / 1-9)
  └─ Framework calls onDeactivate() on old tab
  └─ Switches activeIdx
  └─ Framework calls onActivate() on new tab
  └─ Renders from cache if available, otherwise calls tab.render()
```

## Directory structure

A complete sidepanel tab extension:

```
pi-sidepanel-{name}/           ← Git repo root
├── .github/
│   └── workflows/
│       └── test.yml               ← CI: `node --test test/*.test.ts`
├── .gitignore                     ← node_modules/ *.log .DS_Store
├── LICENSE                        ← MIT
├── README.md                      ← Purpose, keybindings, install, previews
├── package.json                   ← name, version, "pi-package" keyword, pi.extensions
├── index.ts                       ← Entry point: event wiring ONLY (thin)
├── {domain}.ts                    ← Data model + rendering (no pi imports;
│                                     pi-tui utilities injected by index.ts)
└── test/
    ├── _harness/                  ← Vendored test harness (see Testing)
    │   ├── fake-pi.ts             ← FakePi: fake ExtensionAPI
    │   ├── stub-hooks.mjs         ← module.register() resolve hook
    │   ├── pi-tui-stub.mjs        ← stub matchesKey/truncate/visibleWidth
    │   └── pi-coding-agent-stub.mjs
    ├── {domain}.test.ts           ← Unit tests importing the REAL {domain}.ts
    └── integration.test.ts        ← Tests importing the REAL index.ts via FakePi
```

### package.json schema

```json
{
  "name": "pi-sidepanel-{name}",
  "version": "0.1.0",
  "type": "module",
  "description": "...",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

The `"pi-package"` keyword and `pi.extensions` array are required for pi's
extension loader to discover and load the extension.

### CI workflow

```yaml
# .github/workflows/test.yml
name: Test
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: ["22"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
      - run: node --test test/*.test.ts
```

No npm install needed — tests use only `node:test` and `node:assert/strict`.
Avoid Node.js 23+ in CI matrix (experimental features may break).

## Plugin API

### Registration

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let registered = false;

  // The component that will be rendered inside a tab
  const component = {
    render(width: number): string[] { /* ... */ },
    handleInput(data: string): void { /* ... */ },
    invalidate(): void { /* ... */ },
    setTheme(t: ThemeColors): void { /* ... */ },
    // Optional lifecycle:
    onActivate?(): void { /* ... */ },
    onDeactivate?(): void { /* ... */ },
  };

  function registerTab(): void {
    if (registered) return;
    registered = true;
    pi.events.emit("sidepanel:register", {
      id: "my-tab",        // unique string id — used for dedup and ordering
      label: "My Tab",     // 3-12 chars recommended — shown in tab bar
      component,
    });
  }

  // Primary registration: on session_start, replay session data, then register
  pi.on("session_start", async (_event, ctx) => {
    registered = false;
    // 1. Reset component state
    // 2. Replay session history from ctx.sessionManager.getEntries()
    // 3. Register the tab (always — even on empty state)
    registerTab();
  });

  // Fallback: the framework resets its registry on ITS session_start and
  // emits "sidepanel:ready" afterwards. If this extension's session_start
  // handler ran first (handler order follows extension load order), the
  // registration above was wiped. Re-register UNCONDITIONALLY — do not
  // guard on `registered` (it is already true at this point, so a guard
  // would skip the recovery). Re-registration is idempotent: the
  // framework dedups by id.
  pi.events.on("sidepanel:ready", () => {
    registered = false;
    registerTab();
  });
}
```

**Important**: Always register from `session_start` (with session replay first)
so the tab persists across pi restarts. Always have the `sidepanel:ready`
fallback for load-order issues, and make it re-register unconditionally — a
`if (!registered)` guard does not survive the framework's registry wipe.

### Unregistration

```typescript
pi.events.emit("sidepanel:unregister", { id: "my-tab" });
```

### Invalidation (re-render trigger)

```typescript
// Specific tab:
pi.events.emit("sidepanel:invalidate", { tabId: "my-tab" });

// All tabs (use sparingly):
pi.events.emit("sidepanel:invalidate", {});
```

### Busy / loading state

Around slow synchronous work (e.g. session replay), flag the tab busy so the
framework shows a "Loading…" placeholder instead of a frozen view. The
optional `message` is rendered under the placeholder. Busy state set while
the panel is closed is buffered and applied when it opens.

```typescript
pi.events.emit("sidepanel:busy", {
  tabId: "my-tab",
  busy: true,
  message: "replaying session…", // optional
});
// ... slow work ...
pi.events.emit("sidepanel:busy", { tabId: "my-tab", busy: false });
```

### Event wiring pattern

Tab plugins listen to pi events and emit invalidation:

```typescript
pi.on("tool_call", (event) => {
  if (event.toolName !== "my-tool") return;
  // ... update component state ...
  pi.events.emit("sidepanel:invalidate", { tabId: "my-tab" });
});

pi.on("tool_result", (event) => {
  if (event.toolName !== "my-tool") return;
  // ... update component state ...
  pi.events.emit("sidepanel:invalidate", { tabId: "my-tab" });
});
```

## Component interface

A tab component must satisfy this shape (all methods required unless noted):

```typescript
interface Component {
  /** Return lines for the content area. Width is the inner panel width
   *  (borders excluded). Must return string[] — never null/undefined.
   *  Each line must be <= width visible characters. Framework caches
   *  per-tab by width. */
  render(width: number): string[];

  /** Optional. Called for keyboard input when this tab is active.
   *  Arrow keys, Enter, Tab, etc. are consumed by the framework for
   *  tab switching — only delegates remaining input. Tab component
   *  must NOT consume Tab/Shift+Tab/F2/F3/Ctrl+C. */
  handleInput?(data: string): void;

  /** Clear any internal render cache. Called when panel becomes stale.
   *  Framework will call render() on next requestRender(). */
  invalidate(): void;

  /** Optional. Called before each render to pass the current theme.
   *  Use for color-coded output that follows pi's active theme. */
  setTheme?(theme: ThemeColors): void;

  /** Optional. Called when user switches TO this tab. Start polling,
   *  resume updates, etc. */
  onActivate?(): void;

  /** Optional. Called when user switches AWAY from this tab. Pause
   *  timers, stop fetching, etc. */
  onDeactivate?(): void;
}

interface ThemeColors {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
}
```

### Supported theme color names

Used as the first argument to `fg()` / `bg()`:

| Name | Typical use |
|------|-------------|
| `"accent"` | Active elements, selected, highlights |
| `"muted"` | Labels, secondary info |
| `"dim"` | Inactive, empty states, hints |
| `"text"` | Primary content |
| `"success"` | Completed, positive indicators |
| `"warning"` | Pending, attention |
| `"error"` | Failures, bad exit codes |
| `"border"` | Separators, decorative |
| `"syntaxNumber"` | Directories (in tree views) |
| `"syntaxFunction"` | Markdown files, function names |

### Default theme (no-op passthrough)

```typescript
const defaultTheme: ThemeColors = {
  fg: (_c, s) => s,
  bg: (_c, s) => s,
  bold: (s) => s,
};
```

Use this as fallback when `this.theme` is null:

```typescript
render(width: number): string[] {
  const th = this.theme ?? defaultTheme;
  // ... use th.fg(), th.bg(), th.bold() ...
}
```

### Render cache pattern

Components should implement their own width-based render cache to avoid
expensive recomputation:

```typescript
class MyComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    // ... compute lines ...
    this.cachedWidth = width;
    this.cachedLines = computedLines;
    return computedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

The framework itself also has a per-tab cache (`tabCaches` in
`SidepanelComponent`), so switching tabs and back does not re-render.
But your component's own cache is still important for within-tab interactions
(j/k navigation, search, etc.) where the user stays on the same tab.

## Defensive rendering (sanitization)

The framework runs every line from `render()` through `sanitizeLine()` before
display. This protects the panel's box shape against malformed output:

- **Newlines** (`\n`, `\r`, `\r\n`) → collapsed (prevents vertical border break)
- **CSI cursor movement** (`\x1b[A`…`\x1b[H`) → stripped
- **Screen clearing** (`\x1b[2J`, `\x1b[K`) → stripped
- **Scroll sequences** (`\x1b[S`, `\x1b[T`) → stripped
- **Terminal reset** (`\x1bc`) → stripped
- **OSC sequences** (set title, etc.) → stripped
- **Character set selection** (`\x1b(A`) → stripped
- **Shift-in/out** (`\x0e`, `\x0f`) → stripped
- **Backspace chains** → collapsed
- **SGR color codes** (`\x1b[…m`) → **preserved**

Tab authors normally don't need to call this — the framework handles it.
If you need pre-sanitization, import it via a relative path (tab plugins are
sibling packages; there is no npm-resolvable "pi-sidepanel" module) or vendor
`sanitize.ts` — it's dependency-free:

```typescript
import { sanitizeLine } from "../pi-sidepanel/sanitize.ts";
```

### Truncation and padding

Always use `truncateToWidth` and `visibleWidth` from `@earendil-works/pi-tui`:

```typescript
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const truncated = truncateToWidth(line, innerW, "…");
const vw = visibleWidth(truncated);
const padding = " ".repeat(Math.max(0, innerW - vw));
```

Never use `.length` on ANSI-colored strings — it counts escape codes.

## Keybindings

### Framework-level (handled by SidepanelComponent — tabs must NOT consume)

| Key | Action |
|-----|--------|
| F2 | Close panel (or toggle from chat) |
| F3 | Unfocus panel (return to chat) |
| Tab | Next tab |
| Shift+Tab | Previous tab |
| 1-9 | Jump to tab by index |
| Ctrl+C | Close panel |

### Tab-level (delegated to active tab's handleInput)

Common conventions across existing tabs:

| Key | Convention |
|-----|-----------|
| `j` / ↓ | Scroll down / cursor down |
| `k` / ↑ | Scroll up / cursor up |
| Enter | Expand/collapse, toggle detail, confirm |
| Escape | Close overlay, exit search mode |
| PgUp/PgDn | Page scroll |
| `g` | Go to top |
| `G` | Go to bottom |

## Session replay

Tab plugins must survive pi restarts. On `session_start`, replay the
session's tool calls and results to rebuild state:

```typescript
pi.on("session_start", async (_event, ctx) => {
  registered = false;
  myComponent.reset();

  try {
    const entries = ctx.sessionManager.getEntries();
    // Cap: don't replay unbounded sessions
    const capped = entries.slice(-300);

    for (const e of capped) {
      if (e.type !== "message") continue;
      const msg = e.message;
      if (!msg) continue;

      if (msg.role === "assistant") {
        for (const block of (msg.content ?? [])) {
          if (block.type === "toolCall" && block.name === "my-tool") {
            // reconstruct state from block.arguments
          }
        }
      } else if (msg.role === "toolResult" && msg.toolName === "my-tool") {
        // reconstruct state from msg.content
      }
    }
  } finally {
    // Always register — even on empty state or replay failure
    registerTab();
  }
});
```

**Caps**: Always cap replay to ~300 entries to prevent memory blowup on very
long sessions. Also cap node counts (500 max for tree views, 300 max for
flat lists).

## Converting standalone overlays to sidepanel tabs

The existing `/context` and `/dash` extensions are standalone overlay commands.
To convert them into sidepanel tabs:

### 1. Identify the data model

Extract state into a component class with `render()`, `handleInput()`,
`invalidate()`, and `setTheme()`:

```
Before (standalone overlay):
  export default function (pi: ExtensionAPI) {
    let state = { ... };
    pi.registerCommand("dash", { handler: (args, ctx) => { ... } });
    pi.on("tool_call", (event) => { /* mutate state */ });
    pi.on("agent_start", ...);
  }

After (sidepanel tab):
  class MyTabComponent {
    // state lives here
    setTheme(t): void { ... }
    render(width): string[] { ... }
    handleInput(data): void { ... }
    invalidate(): void { ... }
  }

  export default function (pi: ExtensionAPI) {
    const comp = new MyTabComponent();
    // event wiring (same as before, but emit invalidate)
    pi.on("tool_call", (event) => {
      // mutate comp state
      pi.events.emit("sidepanel:invalidate", { tabId: "mytab" });
    });
    // registration (session_start + sidepanel:ready)
  }
```

### 2. Replace overlay rendering with tab rendering

- Remove `ctx.ui.custom(...)` and the overlay component class
- Remove the `/dash` or `/context` `registerCommand` call
- Add `pi.events.emit("sidepanel:register", { id, label, component })`
- The framework handles the box borders, tab bar, and footer — your
  component only renders content lines
- Width passed to `render()` is the inner panel width (borders excluded)

### 3. Keep event wiring identical

The event listeners (`pi.on("tool_call", ...)`, `pi.on("agent_start", ...)`,
etc.) stay the same. Just add `pi.events.emit("sidepanel:invalidate", ...)`
after each state mutation.

### 4. Add session replay

Standalone overlays typically don't replay session state on restart — they
just show live data. Sidepanel tabs should replay for a persistent experience:

```typescript
pi.on("session_start", async (_event, ctx) => {
  registered = false;
  comp.reset();
  try {
    const entries = ctx.sessionManager.getEntries();
    // ... replay relevant tool calls ...
  } finally {
    registerTab();
  }
});
```

### 5. Remove toggle/close logic

The framework handles F2/F3/Esc/Ctrl+C. Don't register your own close
keybindings — delegate unsupported input to the framework by not consuming it.

## Testing

**Always test the real code. Never write "mirror" copies of production
logic inside test files** — mirrors drift silently and pass while the real
code is broken (this happened here: a registration bug, a node leak, and a
render crash all lived behind green mirror suites). Two layers, both
running under plain `node --test test/*.test.ts` with zero dependencies:

### Layer 1 — Unit tests import the real `{domain}.ts`

The data model lives in `{domain}.ts` with **no pi imports**: the pi-tui
utilities it needs are injected by `index.ts` (production) or by the
vendored stub (tests):

```typescript
// test/{domain}.test.ts
import { MyComponent } from "../{domain}.ts";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "./_harness/pi-tui-stub.mjs";

const comp = new MyComponent({ matchesKey, truncateToWidth, visibleWidth });
```

In `index.ts`, pass the real ones:

```typescript
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
const comp = new MyComponent({ matchesKey, truncateToWidth, visibleWidth });
```

### Layer 2 — Integration tests import the real `index.ts`

`test/_harness/` (vendored; the canonical copy lives in
`pi-sidepanel/test/_harness/` — keep copies in sync) provides:

- **`stub-hooks.mjs`** — a `module.register()` resolve hook mapping
  `@earendil-works/*` to local stubs, so the production entry point
  imports cleanly outside pi. Registration must precede a **dynamic**
  import of the extension (static imports resolve too early):

  ```typescript
  import { register } from "node:module";
  register("./_harness/stub-hooks.mjs", import.meta.url);
  const extension = (await import("../index.ts")).default;
  ```

- **`fake-pi.ts`** — `FakePi` (events bus, `on`/`fire`, command/shortcut
  recording, `sendUserMessage` capture, tool listing) plus helpers:
  `sessionCtx(entries)`, `captureRegistrations(pi)`, `captureBusy(pi)`,
  `identityTheme`, `tick()`.

Every tab plugin's integration suite must cover at least:

1. **Registers on session_start** (with a session fixture).
2. **Re-registers on `sidepanel:ready`** — fire `session_start`, then emit
   `sidepanel:ready`, and assert a SECOND registration arrives. This is
   the load-order regression test; an `if (!registered)` guard fails it.
3. **Session replay** — fixture entries (`toolCall` / `toolResult`
   messages) produce the expected render.
4. **Live events** — `pi.fire("tool_call", …)` / `tool_result` update the
   render; other tools are ignored.
5. **Busy lifecycle** — `sidepanel:busy` true (with `message`) then false
   around replay.

The framework repo additionally drives the real `SidepanelComponent`
through a fake `ctx.ui.custom` (see `pi-sidepanel/test/integration.test.ts`),
covering tab switching, removal index fixups, per-tab cache behavior, busy
buffering with a deferred factory, and box-shape geometry.

### Sanitization tests

If your component emits ANSI codes, test that `sanitizeLine()` preserves
them (see `test/sanitize.test.ts` for reference). Run:

```bash
node --test test/*.test.ts
```

## Existing tabs reference

| Tab ID | Label | Package | What it tracks |
|--------|-------|---------|----------------|
| `"dash"` | Dash | `pi-sidepanel-dash` | Session dashboard — goal, model, turn, context budget, tool defs |
| `"explorer"` | Inputs | `pi-sidepanel-inputs` | File explorer tree from read/ls/find calls — collapsible, color-coded |
| `"skills"` | Skills | `pi-sidepanel-skills` | Fetched skills — `/` explicit or `~` auto-loaded, with descriptions |
| `"files"` | Outputs | `pi-sidepanel-outputs` | Modified files from write/edit — [W]/[E] tags, always-expanded tree |
| `"bash"` | Bash | `pi-sidepanel-bash` | Bash commands — vim-style cursor, search, expand/collapse output |

## Idioms and patterns

### Guard against duplicate registration

```typescript
let registered = false;

function registerTab(): void {
  if (registered) return;
  registered = true;
  pi.events.emit("sidepanel:register", { ... });
}
```

### Wrap registration in try/catch

Registration failure should be silent — the panel stays usable with other
tabs:

```typescript
try {
  pi.events.emit("sidepanel:register", { id, label, component });
} catch {
  // Registration failed — tab won't show, but panel stays usable
}
```

### Theme passthrough wrapper

When wrapping an internal component class for registration, create a
themed adapter:

```typescript
const themedComponent = {
  handleInput(data: string): void {
    myComponent.handleInput(data);
  },
  render(width: number): string[] {
    return myComponent.render(width);
  },
  invalidate(): void {
    myComponent.invalidate();
  },
  setTheme(t: ThemeColors): void {
    myComponent.setTheme(t);
  },
};

pi.events.emit("sidepanel:register", {
  id: "mytab",
  label: "My Tab",
  component: themedComponent,
});
```

### Cap mutable collections

Always cap arrays and maps to prevent unbounded growth:

```typescript
private static readonly MAX_ITEMS = 300;

addItem(item: Item): void {
  this.items.push(item);
  while (this.items.length > MyComponent.MAX_ITEMS) {
    this.items.shift();
  }
}
```

For tree structures, use LRU eviction with an insertion-order array:

```typescript
private static readonly MAX_NODES = 500;
private nodeMap = new Map<string, TreeNode>();
private nodeOrder: string[] = [];

// On insert, evict oldest if over cap:
while (this.nodeMap.size >= EXPLORER_MAX_NODES) {
  const oldest = this.nodeOrder.shift();
  if (oldest) {
    const node = this.nodeMap.get(oldest);
    // Remove from parent's children, then delete
    this.nodeMap.delete(oldest);
  }
}
```

### Keep index.ts thin: data model lives in {domain}.ts

The entry point holds event wiring and registration ONLY. All data model
and rendering logic lives in a separate pi-free module (pi-tui utilities
injected), so unit tests exercise the real class — see Testing:

```
pi-sidepanel-bash/
├── index.ts            ← Event wiring + registration (thin)
├── log.ts              ← BashLog class: data model, rendering, search
└── test/
    └── bash.test.ts    ← Tests for BashLog in isolation
```

## Do not

- ❌ Register tabs before `session_start` fires — tabs won't survive restarts
- ❌ Consume Tab, Shift+Tab, F2, F3, Ctrl+C in `handleInput()` — those are
  framework-level keys
- ❌ Return non-array, null, or non-string[] from `render()`
- ❌ Render lines wider than the requested `width` (in visible characters)
- ❌ Count string `.length` on ANSI-colored strings — use `visibleWidth()`
- ❌ Include newlines in render output — the framework collapses them, but
  it wastes compute and may produce unexpected results
- ❌ Mutate `this.tabs` directly in tab plugins — tabs only communicate via
  `pi.events`; the framework owns the tab collection
- ❌ Register the same `id` from multiple locations — first registration wins
  (or replaces), but it's confusing
