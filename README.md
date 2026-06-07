# pi-sidepanel

A decoupled, content-agnostic side-panel display engine for [pi](https://pi.dev). Provides a persistent right-side overlay with tabbed views driven by an event-hook system. Tab plugins are separate extensions that register against this framework — the framework itself contains zero content-specific knowledge.

<p align="center"><em>Framework: tabs + layout + events. Content: you.</em></p>

## Installation

```bash
# Clone the repo and install as a pi package
pi install git:github.com/WernerVdM97/pi-sidepanel

# Or for development, symlink into your extensions directory
ln -s $(pwd)/pi-sidepanel ~/.pi/agent/extensions/pi-sidepanel
```

## Quick Start

Load the extension and open the panel:

```
F2            → toggle panel open/close
```

The panel auto-opens on the first tool call or agent event in each session.

## Keybindings

| Key | Context | Action |
|-----|---------|--------|
| **F2** | Anywhere | Toggle panel open/close |
| **F3** | Panel focused | Unfocus (return to chat, panel stays visible) |
| **F3** | Panel visible, unfocused | Re-focus panel |
| **Tab** | Panel focused | Next tab |
| **Shift+Tab** | Panel focused | Previous tab |
| **1-9** | Panel focused | Jump to tab by number |
| **Ctrl+C** | Panel focused | Close panel |
| `/sidepanel` | Anywhere | Toggle (same as F2) |
| `/sidepanel auto-on` | Anywhere | Enable auto-open on first event |
| `/sidepanel auto-off` | Anywhere | Disable auto-open |

Content-specific keys (arrows, Enter, search, etc.) are delegated to the active tab component. See each tab plugin's documentation for its keybindings.

## Focus indication

When the panel has input focus, borders render in **bold**. When unfocused (F3), borders switch to **dimmed** text — a visible distinction that works in every terminal regardless of color scheme.

## Plugin API

Tab plugins register via pi's inter-extension event bus. A tab plugin supplies an `id`, `label`, and a TUI `Component`.

### Registration

```typescript
// In your tab extension (separate file/package):
export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    pi.events.emit("sidepanel:register", {
      id: "my-tab",          // unique identifier
      label: "My Tab",       // shown in tab bar
      component: {
        render(width: number): string[] { ... },
        handleInput?(data: string): void { ... },
        invalidate(): void { ... },
      },
    });
  });
}
```

### Unregistration

```typescript
pi.events.emit("sidepanel:unregister", { id: "my-tab" });
```

### Triggering Re-renders

When your tab's data changes, emit an invalidation event:

```typescript
pi.events.emit("sidepanel:invalidate", { tabId: "my-tab" });
// Omit tabId to invalidate all tabs:
pi.events.emit("sidepanel:invalidate", {});
```

### Theme Support

If your component exposes a `setTheme(theme)` method, the framework calls it before each render. Use it for color-coded output that follows pi's active theme:

```typescript
interface ThemeColors {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

class MyComponent {
  private theme: ThemeColors | null = null;

  setTheme(theme: ThemeColors): void {
    this.theme = theme;
  }

  render(width: number): string[] {
    const th = this.theme;
    return [th.fg("accent", "Hello"), th.fg("muted", "World")];
  }
}
```

### Activation Lifecycle

Components can optionally implement `onActivate()` and `onDeactivate()` — called when the user switches to/from your tab:

```typescript
class MyComponent {
  onActivate(): void {
    // Tab just became visible — start polling, resume updates
  }
  onDeactivate(): void {
    // Tab hidden — pause timers, stop fetching
  }
}
```

## Defensive rendering

The framework **sanitizes every rendered line** from tab components before display. This protects the panel's box shape against buggy or deliberately malformed tab output:

- **Newlines** (`\n`, `\r`, `\r\n`) are collapsed — prevents vertical border breakage
- **ANSI cursor movement** (`\x1b[A`…`\x1b[H`) is stripped — prevents coordinate injection
- **Screen clearing** (`\x1b[2J`, `\x1b[K`) is stripped — prevents border erasure
- **Scroll sequences** (`\x1b[S`, `\x1b[T`) are stripped
- **Terminal reset** (`\x1bc`) is stripped
- **OSC sequences** (set title, etc.) are stripped
- **Backspace chains** are collapsed
- **SGR color codes** (`\x1b[…m`) are **preserved** — colors from theme-aware tabs pass through

The `sanitizeLine()` function is exported for tab plugin authors who want to pre-sanitize their own content:

```typescript
import { sanitizeLine } from "pi-sidepanel";
```

The framework also guards against `null`/`undefined`/non-array render results, non-string array items, and thrown exceptions. In all cases the box shape (borders, corners, consistent height) is maintained.

## Example: Minimal Tab

```typescript
// ~/.pi/agent/extensions/my-counter-tab/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  let count = 0;

  const component = {
    render(width: number): string[] {
      count++;
      return [truncateToWidth(`Rendered ${count} times`, width, "")];
    },
    invalidate(): void {},
    setTheme(t: any): void { /* optional */ },
  };

  pi.on("session_start", () => {
    pi.events.emit("sidepanel:register", {
      id: "counter",
      label: "Count",
      component,
    });
  });

  pi.on("tool_call", () => {
    pi.events.emit("sidepanel:invalidate", { tabId: "counter" });
  });
}
```

## Bundled Tab Plugins

These are separate extensions that ship independently:

| Plugin | Description |
|--------|-------------|
| [`pi-sidepanel-bash`](../pi-sidepanel-bash) | Bash command history — vim-style cursor, search, output viewer, theme colors |
| [`pi-sidepanel-files`](../pi-sidepanel-files) | Files modified by the agent (write/edit) |

## Architecture

```
pi-sidepanel (framework)
  ├── overlay management (open/close/focus)
  ├── tab bar + content area rendering
  ├── keyboard input routing
  ├── defensive line sanitization
  └── pi.events registration API

pi-sidepanel-bash (tab plugin)
  ├── subscribes to pi tool_call/tool_result events
  ├── buffers bash commands with exit codes and output
  └── registers via sidepanel:register

pi-sidepanel-files (tab plugin)
  ├── subscribes to pi tool_call events
  ├── tracks write/edit file paths
  └── registers via sidepanel:register
```

The framework has zero knowledge of bash, files, or any content domain. Tab plugins have zero knowledge of overlay positioning, tab switching, or focus management.

## License

MIT
