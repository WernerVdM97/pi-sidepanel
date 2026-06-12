/**
 * pi-sidepanel — Generic side-panel display engine for pi
 *
 * Provides a persistent right-side overlay with tabbed views. Tab plugins
 * (separate extensions) register via `pi.events` and supply their own
 * rendering components. This framework is content-agnostic — no knowledge
 * of bash, files, or any specific domain.
 *
 * Tab plugins:
 *   pi.events.emit("sidepanel:register", { id, label, component })
 *   pi.events.emit("sidepanel:unregister", { id })
 *   pi.events.emit("sidepanel:invalidate", { tabId? })
 *   pi.events.emit("sidepanel:busy", { tabId, busy, message? })
 *
 * Commands:
 *   /sidepanel         — toggle panel visibility
 *   /sidepanel auto-on  — enable auto-open on first event
 *   /sidepanel auto-off — disable auto-open
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

// ── Defensive line sanitizer ────────────────────────────────────────────

// Single source of truth lives in sanitize.ts (where the tests point).
// Relative .ts imports resolve fine in pi's extension loader — the bash
// tab plugin already imports ./log.ts the same way.
import { sanitizeLine } from "./sanitize.ts";
export { sanitizeLine };

// ── Interfaces ────────────────────────────────────────────────────────────

/** Tab plugins supply a Component that the framework renders in the content area. */
export interface TabProvider {
	/** Unique identifier (e.g. "bash", "files"). Used for stable ordering. */
	id: string;
	/** Display label shown in the tab bar (3-12 chars recommended). */
	label: string;
	/** The TUI component for this tab's content. */
	component: Component;
}

interface RegisteredTab {
	provider: TabProvider;
}

// ── SidepanelComponent ────────────────────────────────────────────────────

class SidepanelComponent implements Component {
	private tui: TUI;
	private theme: Theme;
	private tabs: RegisteredTab[];
	private activeIdx: number;
	private done: () => void;
	private onUnfocus: () => void;

	/** Whether the panel currently has input focus */
	focused = true;

	// cached render output (keyed by width AND content height so a vertical
	// terminal resize busts the cache even when the width is unchanged)
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines?: string[];

	/** Tabs currently loading (show fallback instead of calling render).
	 *  Value is an optional tab-supplied status message. */
	private busyTabs = new Map<string, string | undefined>();

	/** Per-tab stable render output. Keyed by tab id (not index — avoids stale cache on reorder). */
	private tabCaches = new Map<
		string,
		{ width: number; height: number; lines: string[] }
	>();

	constructor(
		tui: TUI,
		theme: Theme,
		tabs: RegisteredTab[],
		activeIdx: number,
		done: () => void,
		onUnfocus: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.tabs = tabs;
		this.activeIdx = activeIdx;
		this.done = done;
		this.onUnfocus = onUnfocus;
	}

	/** Active tab index — exposed so the entry point can persist the
	 *  selection across panel close/reopen. */
	getActiveIndex(): number {
		return this.activeIdx;
	}

	/** Compute the content-area height from the live terminal size.
	 *  The overlay is capped at 90% of terminal height; the framework draws
	 *  6 chrome rows (top border, header, header separator, footer separator,
	 *  one footer line, bottom border) around the content. Falls back to the
	 *  historical fixed height when the terminal size is unavailable (e.g.
	 *  under test or before the first real render). */
	private contentHeight(): number {
		const FALLBACK = 40;
		const CHROME = 6;
		const rows = this.tui?.terminal?.rows;
		if (!rows || rows < 12) return FALLBACK;
		const overlayRows = Math.floor(rows * 0.9);
		return Math.max(8, Math.min(80, overlayRows - CHROME));
	}

	// ── public API for framework ──────────────────────────────────────

	/** Sort tabs so dash is always first, rest maintain insertion order. */
	private sortTabs(): void {
		const activeId = this.tabs[this.activeIdx]?.provider.id;
		this.tabs.sort((a, b) => {
			if (a.provider.id === "dash") return -1;
			if (b.provider.id === "dash") return 1;
			return 0;
		});
		// Restore active tab position after sort
		if (activeId) {
			const newIdx = this.tabs.findIndex((t) => t.provider.id === activeId);
			if (newIdx >= 0) this.activeIdx = newIdx;
		}
	}

	/** Mark a tab as busy (loading) or ready. While busy, a placeholder is shown. */
	setTabBusy(id: string, busy: boolean, message?: string): void {
		if (busy) {
			this.busyTabs.set(id, message);
		} else {
			this.busyTabs.delete(id);
		}
		// Drop this tab's cache + the panel-level cache so the loading
		// placeholder (or, once cleared, the real content) repaints. Leave
		// other tabs' caches intact.
		this.tabCaches.delete(id);
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	addTab(tab: TabProvider): void {
		// Deduplicate by id
		const existing = this.tabs.findIndex((t) => t.provider.id === tab.id);
		if (existing >= 0) {
			this.tabs[existing] = { provider: tab };
		} else {
			this.tabs.push({ provider: tab });
			this.sortTabs();
			// Activate the first tab added
			if (this.tabs.length === 1) {
				this.activeIdx = 0;
				this.activateTab();
			}
		}
		this.invalidate();
		this.tui.requestRender();
	}

	removeTab(id: string): void {
		const idx = this.tabs.findIndex((t) => t.provider.id === id);
		if (idx < 0) return;
		const wasActive = idx === this.activeIdx;
		if (wasActive) this.deactivateTab();
		this.tabs.splice(idx, 1);
		this.tabCaches.delete(id);
		this.busyTabs.delete(id);
		// Removing a tab before the active one shifts indices left — follow
		// the active tab so the selection doesn't silently jump.
		if (idx < this.activeIdx) this.activeIdx--;
		if (this.activeIdx >= this.tabs.length) {
			this.activeIdx = Math.max(0, this.tabs.length - 1);
		}
		if (wasActive && this.tabs.length > 0) this.activateTab();
		this.invalidate();
		this.tui.requestRender();
	}

	invalidateTab(tabId?: string): void {
		if (tabId == null) {
			// Invalidate everything (e.g. theme change).
			for (const t of this.tabs) t.provider.component.invalidate();
			this.tabCaches.clear();
			this.cachedWidth = undefined;
			this.cachedHeight = undefined;
			this.cachedLines = undefined;
			this.tui.requestRender();
			return;
		}

		// Targeted invalidation: drop ONLY this tab's caches so inactive tabs
		// keep their cached render (the whole point of the per-tab cache).
		const tab = this.tabs.find((t) => t.provider.id === tabId);
		if (!tab) return;
		tab.provider.component.invalidate();
		this.tabCaches.delete(tab.provider.id);

		// Re-render only when the affected tab is the one on screen — a
		// background tab updating its data should not force a repaint.
		if (this.tabs[this.activeIdx]?.provider.id === tabId) {
			this.cachedWidth = undefined;
			this.cachedHeight = undefined;
			this.cachedLines = undefined;
			this.tui.requestRender();
		}
	}

	close(): void {
		this.done();
	}

	/** Request a re-render — exposed for focus toggling from outside */
	requestRender(): void {
		this.tui.requestRender();
	}

	// ── Component interface ───────────────────────────────────────────

	handleInput(data: string): void {
		// Tab: next tab
		if (matchesKey(data, "tab")) {
			if (this.tabs.length > 0) {
				this.switchToTab((this.activeIdx + 1) % this.tabs.length);
			}
			return;
		}

		// Shift+Tab: previous tab
		if (matchesKey(data, "shift+tab")) {
			if (this.tabs.length > 0) {
				this.switchToTab(
					(this.activeIdx - 1 + this.tabs.length) % this.tabs.length,
				);
			}
			return;
		}

		// 1-9: jump to tab by index — unless the active tab is in a
		// text-capture mode (e.g. Bash search), where digits are content.
		// Tabs opt in via an optional capturesText(): boolean method.
		const activeComp = this.activeTab()?.provider.component as
			| { capturesText?: () => boolean }
			| undefined;
		const capturingText = activeComp?.capturesText?.() === true;
		if (!capturingText && data.length === 1 && data >= "1" && data <= "9") {
			const idx = Number.parseInt(data) - 1;
			if (idx < this.tabs.length) {
				this.switchToTab(idx);
				return;
			}
			// Digit with no matching tab: fall through so the active tab
			// can consume it instead of the key being swallowed.
		}

		// F3: unfocus (return to chat, panel stays visible)
		if (matchesKey(data, "f3")) {
			this.onUnfocus();
			return;
		}

		// F2: close panel
		if (matchesKey(data, "f2")) {
			this.done();
			return;
		}

		// Ctrl+C: close panel
		if (matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}

		// Delegate everything else to the active tab's component
		const active = this.activeTab();
		if (active?.provider.component.handleInput) {
			active.provider.component.handleInput(data);
			// Tab likely changed its state — invalidate ONLY this tab
			// (a blanket invalidate would bust every tab's cache per keypress).
			this.invalidateTab(active.provider.id);
		}
	}

	wantsKeyRelease = false;

	render(width: number): string[] {
		const contentH = this.contentHeight();
		if (
			this.cachedLines &&
			this.cachedWidth === width &&
			this.cachedHeight === contentH
		) {
			return this.cachedLines;
		}

		const th = this.theme;
		const innerW = Math.max(1, width - 2); // inside borders
		const lines: string[] = [];

		// Focus distinction: bold borders when panel has focus,
		// dim borders when unfocused. Bold vs non-bold is visible
		// in every terminal regardless of color scheme.
		const B = (s: string) => (this.focused ? th.bold(s) : th.fg("dim", s));

		// Top border
		lines.push(B(`╭${"─".repeat(innerW)}╮`));

		// Header: tab bar (if 2+ tabs) or single-tab header (if 1 tab)
		if (this.tabs.length > 1) {
			lines.push(B("│") + this.renderTabBar(innerW) + B("│"));
			lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));
		} else if (this.tabs.length === 1) {
			const header = ` 1:${this.tabs[0]!.provider.label} `;
			const padded = this.padCenter(header, innerW);
			lines.push(B("│") + th.fg("accent", padded) + B("│"));
			lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));
		} else {
			// No tabs
			lines.push(
				B("│") +
					th.fg("dim", this.padCenter(" No tabs registered ", innerW)) +
					B("│"),
			);
			lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));
		}

		// Content area (height computed from the live terminal above)
		const active = this.activeTab();

		if (active) {
			// ── Busy guard: show loading placeholder while tab is initializing ──
			if (this.busyTabs.has(active.provider.id)) {
				const loading = this.padCenter(" Loading… ", innerW);
				lines.push(B("│") + this.theme.fg("dim", loading) + B("│"));
				let used = 1;
				const message = this.busyTabs.get(active.provider.id);
				if (message) {
					const hint = this.padCenter(` ${message} `, innerW);
					lines.push(B("│") + this.theme.fg("dim", hint) + B("│"));
					used = 2;
				}
				for (let i = used; i < contentH; i++) {
					lines.push(B("│") + " ".repeat(innerW) + B("│"));
				}
			} else {
				// ── Lazy tab rendering (per-tab cache) ────────────
				let tabLines: string[] = [];
				try {
				const comp = active.provider.component as any;
				if (typeof comp.setTheme === "function") {
					comp.setTheme(this.theme);
				}

				// Use cached render if available (avoids re-render on tab switch).
				// Cache key includes the content height so a vertical resize
				// re-renders the tab at the new size.
				const cached = this.tabCaches.get(active.provider.id);
				let clean: string[];
				if (cached && cached.width === innerW && cached.height === contentH) {
					clean = cached.lines;
				} else {
					// Pass the available content height as an optional 2nd arg.
					// Tabs that accept it size their viewport/footer to fit;
					// older tabs ignore it and fall back to their internal height.
					const raw = comp.render(innerW, contentH);
					tabLines = Array.isArray(raw)
						? raw.filter((l: unknown): l is string => typeof l === "string")
						: [];
					clean = tabLines.map((l) => sanitizeLine(l));
					this.tabCaches.set(active.provider.id, {
						width: innerW,
						height: contentH,
						lines: clean,
					});
				}

				// Clamp to viewport
				const visible = clean.slice(0, contentH);

				for (const line of visible) {
					let truncated = truncateToWidth(line, innerW, "");
					// Safety: if truncateToWidth still overflows (e.g. due to
					// width disagreement on ambiguous characters), hard-clamp
					// by stripping ANSI and raw-truncating to innerW.
					let vw = visibleWidth(truncated);
					if (vw > innerW) {
						truncated = truncated.replace(
							/\x1b\[[0-?]*[ -/]*[@-~]/g,
							"",
						);
						while (truncated.length > 0 && visibleWidth(truncated) > innerW) {
							truncated = truncated.slice(0, -1);
						}
						vw = visibleWidth(truncated);
					}
					const padding = " ".repeat(Math.max(0, innerW - vw));
					lines.push(B("│") + truncated + padding + B("│"));
				}

				// Pad remaining space
				const rendered = visible.length;
				for (let i = rendered; i < contentH; i++) {
					lines.push(B("│") + " ".repeat(innerW) + B("│"));
				}
			} catch (err) {
				// Render + sanitize failed — show error and pad box
				// Defensive: guard innerW against NaN/negative (can happen if
				// the component's render throws and width calculation is bad)
				const safeW = Math.max(1, Math.floor(innerW) || 1);
				const errLine = ` ! ${err}`;
				const truncated = truncateToWidth(errLine, safeW);
				const vw = visibleWidth(truncated);
				const padding = " ".repeat(Math.max(0, safeW - vw));
				lines.push(B("│") + th.fg("error", truncated) + padding + B("│"));
				for (let i = 1; i < contentH; i++) {
					lines.push(B("│") + " ".repeat(safeW) + B("│"));
				}
			}
			}
		} else {
			lines.push(
				B("│") +
					th.fg("dim", this.padCenter(" No active tab ", innerW)) +
					B("│"),
			);
		}

		// Footer separator
		lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));

		// Footer hints with padding for ANSI alignment
		const footerHints = this.renderFooter(innerW);
		for (const h of footerHints) {
			const vw = visibleWidth(h);
			const padding = " ".repeat(Math.max(0, innerW - vw));
			lines.push(B("│") + h + padding + B("│"));
		}

		// Bottom border
		lines.push(B(`╰${"─".repeat(innerW)}╯`));

		this.cachedWidth = width;
		this.cachedHeight = contentH;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
		this.tabCaches.clear();
		// Invalidate all tab components so they pick up theme + data changes
		for (const t of this.tabs) {
			t.provider.component.invalidate();
		}
	}

	// ── private helpers ───────────────────────────────────────────────

	private switchToTab(idx: number): void {
		if (this.tabs.length === 0) return;
		if (idx === this.activeIdx) return;
		this.deactivateTab();
		this.activeIdx = idx;
		this.activateTab();
		// Clear panel-level cache (header/tab-bar changes) but keep tab content caches
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	private activateTab(): void {
		const tab = this.tabs[this.activeIdx];
		if (tab) {
			const comp = tab.provider.component as any;
			if (typeof comp.onActivate === "function") comp.onActivate();
		}
	}

	private deactivateTab(): void {
		const tab = this.tabs[this.activeIdx];
		if (tab) {
			const comp = tab.provider.component as any;
			if (typeof comp.onDeactivate === "function") comp.onDeactivate();
		}
	}

	private activeTab(): RegisteredTab | undefined {
		return this.tabs[this.activeIdx];
	}

	private renderTabBar(width: number): string {
		const th = this.theme;
		const segments: { label: string; active: boolean; idx: number }[] =
			this.tabs.map((t, i) => ({
				label: t.provider.label,
				active: i === this.activeIdx,
				idx: i,
			}));

		const separator = ` ${th.fg("border", "│")} `;
		const sepLen = visibleWidth(separator);
		const totalSepLen = (segments.length - 1) * sepLen;

		const available = width - totalSepLen;
		const perTab = Math.floor(available / segments.length);

		const parts: string[] = [];
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i]!;
			const isLast = i === segments.length - 1;
			const alloc = isLast ? available - i * perTab : perTab;
			let label = seg.active
				? th.fg("accent", th.bold(`${i + 1}:${seg.label}`))
				: th.fg("muted", `${i + 1}:${seg.label}`);

			if (visibleWidth(label) > alloc) {
				label = truncateToWidth(label, alloc, "…", false);
			}
			const padLen = Math.max(0, alloc - visibleWidth(label));
			label = label + " ".repeat(padLen);

			parts.push(label);
		}

		return parts.join(separator);
	}

	private renderFooter(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		if (this.tabs.length > 1) {
			lines.push(
				th.fg(
					"dim",
					truncateToWidth(" 1-9 switch │ F2 close │ F3 chat", width, ""),
				),
			);
		} else {
			lines.push(
				th.fg("dim", truncateToWidth(" F2 close │ F3 chat", width, "")),
			);
		}

		return lines;
	}

	private padCenter(s: string, width: number): string {
		const vw = visibleWidth(s);
		if (vw >= width) return truncateToWidth(s, width, "", false);
		const left = Math.floor((width - vw) / 2);
		const right = width - vw - left;
		return " ".repeat(left) + s + " ".repeat(right);
	}
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── State ──────────────────────────────────────────────────────────
	const tabs: RegisteredTab[] = [];
	let activeTabIndex = 0;
	let isOpen = false;
	let hasOpenedThisSession = false;
	let autoOpenEnabled = true;
	let panelComponent: SidepanelComponent | null = null;
	let overlayHandle: any = null;
	let pendingRegistrations: TabProvider[] = [];
	/** Tabs currently flagged busy (e.g. replaying), with an optional status
	 *  message. Buffered here so the state survives until the panel opens,
	 *  then applied to the component. */
	const busyState = new Map<string, string | undefined>();
	/** Latest ctx for widget updates from panel callbacks. */
	const _panelCtx = { current: null as any };

	// ── Widget helpers ────────────────────────────────────────────────

	function setFocusWidget(): void {
		if (!_panelCtx.current?.ui?.setWidget) return;
		_panelCtx.current.ui.setWidget(
			"sidepanel-focus",
			(_tui: any, theme: any) => ({
				render: () => [
					theme.fg("dim", theme.bold("═".repeat(40))),
					theme.fg(
						"dim",
						"  ⬤ Sidepanel active  —  Esc / F3 to return to chat",
					),
				],
				invalidate: () => {},
			}),
		);
	}

	function clearFocusWidget(): void {
		if (!_panelCtx.current?.ui?.setWidget) return;
		_panelCtx.current.ui.setWidget("sidepanel-focus", undefined);
	}

	// ── Helpers ────────────────────────────────────────────────────────

	function openPanel(ctx: {
		ui: {
			custom: <T>(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: any,
					done: (value: T) => void,
				) => Component,
				opts?: any,
			) => Promise<T>;
		};
	}): void {
		if (isOpen) return;

		_panelCtx.current = ctx;

		// Flush pending registrations — only path that mutates tabs when
		// the panel is closed (inline handler skips direct mutation).
		for (const p of pendingRegistrations) {
			const existing = tabs.findIndex((t) => t.provider.id === p.id);
			if (existing >= 0) {
				tabs[existing] = { provider: p };
			} else {
				tabs.push({ provider: p });
			}
		}
		tabs.sort((a, b) => {
			if (a.provider.id === "dash") return -1;
			if (b.provider.id === "dash") return 1;
			return 0;
		});
		pendingRegistrations = [];

		ctx.ui
			.custom<void>(
				(tui, theme, _kb, done) => {
					panelComponent = new SidepanelComponent(
						tui,
						theme,
						tabs,
						activeTabIndex,
						// done callback: panel dismissed — signal the overlay
						() => {
							clearFocusWidget();
							done();
						},
						// onUnfocus: F3 pressed in panel.
						() => {
							clearFocusWidget();
							if (panelComponent) {
								panelComponent.focused = false;
								panelComponent.invalidate();
							}
							tui.requestRender();
							setTimeout(() => overlayHandle?.unfocus?.(), 0);
						},
					);
					// Apply busy flags buffered while the panel was closed, so a
					// tab still replaying shows the loading placeholder right away.
					// Done here (not after ui.custom() returns) because this
					// factory may be invoked asynchronously.
					for (const [id, message] of busyState) {
						panelComponent.setTabBusy(id, true, message);
					}
					return panelComponent;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center" as const,
						width: "35%",
						minWidth: 40,
						maxWidth: 80,
						maxHeight: "90%",
						margin: { right: 1 },
					},
					onHandle: (handle: any) => {
						overlayHandle = handle;
					},
				},
			)
			.then(() => {
				// Preserve the active-tab selection across close → reopen.
				activeTabIndex = panelComponent?.getActiveIndex() ?? activeTabIndex;
				isOpen = false;
				panelComponent = null;
				overlayHandle = null;
			});

		isOpen = true;
		setFocusWidget();
	}

	function maybeAutoOpen(
		ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
	): void {
		if (autoOpenEnabled && !hasOpenedThisSession && !isOpen) {
			hasOpenedThisSession = true;
			openPanel(ctx);
		}
	}

	// ── Commands & Shortcuts ────────────────────────────────────────────

	pi.registerShortcut("f2", {
		description: "Toggle side panel open/close",
		handler: async (ctx: any) => {
			if (isOpen) {
				panelComponent?.close();
			} else {
				openPanel(ctx);
			}
		},
	});

	pi.registerShortcut("f3", {
		description: "Re-focus side panel from chat",
		handler: async (ctx: any) => {
			if (isOpen && overlayHandle && !panelComponent?.focused) {
				_panelCtx.current = ctx;
				overlayHandle.focus?.();
				if (panelComponent) {
					panelComponent.focused = true;
					panelComponent.invalidate();
					panelComponent.requestRender();
				}
				// Re-focus panel, restore focus indicator
				setFocusWidget();
			}
		},
	});

	pi.registerCommand("sidepanel", {
		description: "Toggle the side panel",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args?.trim();
			if (sub === "auto-on") {
				autoOpenEnabled = true;
				ctx.ui.notify("Side panel: auto-open enabled", "info");
				return;
			}
			if (sub === "auto-off") {
				autoOpenEnabled = false;
				ctx.ui.notify("Side panel: auto-open disabled", "info");
				return;
			}

			if (isOpen) {
				panelComponent?.close();
			} else {
				openPanel(ctx);
			}
		},
	});

	// ── Session events ─────────────────────────────────────────────────

	pi.on("session_start", () => {
		hasOpenedThisSession = false;
		tabs.length = 0;
		pendingRegistrations = [];
		busyState.clear();
		activeTabIndex = 0;
		if (panelComponent) {
			panelComponent.close();
			panelComponent = null;
			isOpen = false;
		}
	});

	// ── Auto-open triggers ─────────────────────────────────────────────

	for (const event of ["tool_call", "agent_start", "message_start"] as const) {
		pi.on(event, (_event: any, ctx: any) => {
			maybeAutoOpen(ctx);
		});
	}

	// ── Registration API (via pi.events) ───────────────────────────────

	pi.events.on("sidepanel:register", (tab: TabProvider) => {
		if (panelComponent) {
			// Panel open: let addTab handle dedup + array mutation
			panelComponent.addTab(tab);
		} else {
			// Panel closed: buffer for flush in openPanel()
			const pendingIdx = pendingRegistrations.findIndex((p) => p.id === tab.id);
			if (pendingIdx >= 0) {
				pendingRegistrations[pendingIdx] = tab;
			} else {
				pendingRegistrations.push(tab);
			}
		}
	});

	pi.events.on("sidepanel:unregister", ({ id }: { id: string }) => {
		// Always drop from the pending buffer and the busy buffer.
		const pendingIdx = pendingRegistrations.findIndex((p) => p.id === id);
		if (pendingIdx >= 0) pendingRegistrations.splice(pendingIdx, 1);
		busyState.delete(id);

		if (panelComponent) {
			// Panel open: the component owns the (shared) tabs array and the
			// active-index fixup — single source of truth, no double splice.
			panelComponent.removeTab(id);
		} else {
			// Panel closed: mutate the module-level array directly.
			const idx = tabs.findIndex((t) => t.provider.id === id);
			if (idx >= 0) {
				tabs.splice(idx, 1);
				// Keep the saved selection pointing at the same tab.
				if (idx < activeTabIndex) activeTabIndex--;
			}
			if (activeTabIndex >= tabs.length) {
				activeTabIndex = Math.max(0, tabs.length - 1);
			}
		}
	});

	pi.events.on("sidepanel:invalidate", ({ tabId }: { tabId?: string }) => {
		if (panelComponent) {
			panelComponent.invalidateTab(tabId);
		}
	});

	// Tabs flag themselves busy around slow async work (e.g. session replay)
	// so the framework shows a loading placeholder instead of a frozen view.
	pi.events.on(
		"sidepanel:busy",
		({
			tabId,
			busy,
			message,
		}: {
			tabId?: string;
			busy?: boolean;
			message?: string;
		}) => {
			if (!tabId) return;
			if (busy) {
				busyState.set(tabId, message);
			} else {
				busyState.delete(tabId);
			}
			panelComponent?.setTabBusy(tabId, busy === true, message);
		},
	);

	// Emit ready from session_start so tab plugins can register
	// after both extensions have loaded (avoids load-order issues)
	pi.on("session_start", () => {
		setTimeout(() => {
			pi.events.emit("sidepanel:ready", {});
		}, 0);
	});
}
