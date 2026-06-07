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
 *
 * Commands:
 *   /sidepanel         — toggle panel visibility
 *   /sidepanel auto-on  — enable auto-open on first event
 *   /sidepanel auto-off — disable auto-open
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

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

	// keyboard state
	private scrollOffset: number;

	// cached render output
	private cachedWidth?: number;
	private cachedLines?: string[];

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
		this.scrollOffset = 0;
	}

	// ── public API for framework ──────────────────────────────────────

	addTab(tab: TabProvider): void {
		// Deduplicate by id
		const existing = this.tabs.findIndex(
			(t) => t.provider.id === tab.id,
		);
		const wasFirst = this.tabs.length === 0;
		if (existing >= 0) {
			this.tabs[existing] = { provider: tab };
		} else {
			this.tabs.push({ provider: tab });
		}
		if (wasFirst) {
			this.activeIdx = 0;
			this.activateTab();
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
		if (this.activeIdx >= this.tabs.length) {
			this.activeIdx = Math.max(0, this.tabs.length - 1);
		}
		if (wasActive && this.tabs.length > 0) this.activateTab();
		this.invalidate();
		this.tui.requestRender();
	}

	invalidateTab(tabId?: string): void {
		if (tabId == null) {
			// invalidate all
			for (const t of this.tabs) t.provider.component.invalidate();
		} else {
			const tab = this.tabs.find((t) => t.provider.id === tabId);
			tab?.provider.component.invalidate();
		}
		this.invalidate();
		this.tui.requestRender();
	}

	invalidateTabAll(): void {
		this.invalidateTab(undefined);
	}

	close(): void {
		this.done();
	}

	// ── Component interface ───────────────────────────────────────────

	handleInput(data: string): void {
		// Tab / Shift+Tab: switch tabs
		if (matchesKey(data, "tab")) {
			if (this.tabs.length > 0) {
				this.deactivateTab();
				this.activeIdx = (this.activeIdx + 1) % this.tabs.length;
				this.activateTab();
				this.scrollOffset = 0;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "shift+tab")) {
			if (this.tabs.length > 0) {
				this.deactivateTab();
				this.activeIdx =
					(this.activeIdx - 1 + this.tabs.length) % this.tabs.length;
				this.activateTab();
				this.scrollOffset = 0;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// 1-9: jump to tab by index
		if (data.length === 1 && data >= "1" && data <= "9") {
			const idx = Number.parseInt(data) - 1;
			if (idx < this.tabs.length && idx !== this.activeIdx) {
				this.deactivateTab();
				this.activeIdx = idx;
				this.activateTab();
				this.scrollOffset = 0;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// F3: unfocus (return to chat, panel stays visible)
		if (matchesKey(data, "f3")) {
			this.onUnfocus();
			return;
		}

		// F2: toggle (close from panel)
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
			// tab likely changed its state — invalidate and re-render
			this.invalidate();
			this.tui.requestRender();
		}
	}

	wantsKeyRelease = false;

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const innerW = Math.max(1, width - 2); // inside borders
		const lines: string[] = [];

		const B = (s: string) =>
			this.focused ? th.fg("border", s) : th.fg("borderMuted", s);

		// Top border
		lines.push(B(`╭${"─".repeat(innerW)}╮`));

		// Header: tab bar (if 2+ tabs) or single-tab header (if 1 tab)
		if (this.tabs.length > 1) {
			lines.push(B("│") + this.renderTabBar(innerW) + B("│"));
			lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));
		} else if (this.tabs.length === 1) {
			const header = ` ${this.tabs[0]!.provider.label} `;
			const padded = this.padCenter(header, innerW);
			lines.push(B("│") + th.fg("accent", padded) + B("│"));
			lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));
		} else {
			// No tabs
			lines.push(
				B("│") + th.fg("dim", this.padCenter(" No tabs registered ", innerW)) + B("│"),
			);
			lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));
		}

		// Content area
		// Reserve space for header (2-3 lines) + footer (2 lines).
		// The TUI will clip the panel if it exceeds terminal height,
		// so we're generous with the content area.
		const contentH = 40;
		const active = this.activeTab();

		if (active) {
			try {
				// Pass theme to tab components that support it
				const comp = active.provider.component as any;
				if (typeof comp.setTheme === "function") {
					comp.setTheme(this.theme);
				}
				const tabLines = active.provider.component.render(innerW);
				const visible = tabLines.slice(
					this.scrollOffset,
					this.scrollOffset + contentH,
				);
				for (const line of visible) {
					// Pad each line to innerW so ANSI-colored content
					// aligns the right border correctly.
					const truncated = truncateToWidth(line, innerW, "");
					const vw = visibleWidth(truncated);
					const padding = " ".repeat(Math.max(0, innerW - vw));
					lines.push(B("│") + truncated + padding + B("│"));
				}
				// Pad remaining space
				const rendered = visible.length;
				for (let i = rendered; i < contentH; i++) {
					lines.push(B("│") + " ".repeat(innerW) + B("│"));
				}
			} catch (err) {
				const errLine = ` Error: ${err}`;
				const truncated = truncateToWidth(errLine, innerW);
				const vw = visibleWidth(truncated);
				const padding = " ".repeat(Math.max(0, innerW - vw));
				lines.push(
					B("│") + th.fg("error", truncated) + padding + B("│"),
				);
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
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		// Invalidate all tab components so they pick up theme changes + data changes
		for (const t of this.tabs) {
			t.provider.component.invalidate();
		}
	}

	// ── private helpers ───────────────────────────────────────────────

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
		// Build labeled segments
		const segments: { label: string; active: boolean; idx: number }[] =
			this.tabs.map((t, i) => ({
				label: t.provider.label,
				active: i === this.activeIdx,
				idx: i,
			}));

		// Calculate available space
		const separator = ` ${th.fg("border", "│")} `;
		const sepLen = visibleWidth(separator);
		const totalSepLen = (segments.length - 1) * sepLen;

		// Distribute width: last tab gets remainder so bar fills exactly `width`
		const available = width - totalSepLen;
		const perTab = Math.floor(available / segments.length);

		const parts: string[] = [];
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i]!;
			const isLast = i === segments.length - 1;
			const alloc = isLast
				? available - i * perTab
				: perTab;
			let label = seg.active
				? th.fg("accent", th.bold(seg.label))
				: th.fg("muted", seg.label);

			// If too long for allocation, truncate with ellipsis
			if (visibleWidth(label) > alloc) {
				label = truncateToWidth(label, alloc, "…", false);
			}
			// Pad to fill allocation
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
				th.fg("dim", truncateToWidth(" Tab/1-9 switch │ F2 close │ F3 chat", width, "")),
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

		// Flush any pending registrations (deduplicated against tabs)
		for (const p of pendingRegistrations) {
			const existing = tabs.findIndex((t) => t.provider.id === p.id);
			if (existing >= 0) {
				tabs[existing] = { provider: p };
			} else {
				tabs.push({ provider: p });
			}
		}
		pendingRegistrations = [];

		// Fire-and-forget — don't await. The panel stays open until
		// the user dismisses it (Esc). The .then() handles cleanup.
		ctx.ui
			.custom<void>(
				(tui, theme, _kb, done) => {
					panelComponent = new SidepanelComponent(
						tui,
						theme,
						tabs,
						activeTabIndex,
						() => {
							panelComponent = null;
							overlayHandle = null;
							done();
						},
						() => {
							// F3 unfocus: return to chat, panel stays visible
							if (panelComponent) {
								panelComponent.focused = false;
								panelComponent.invalidate();
							}
							overlayHandle?.unfocus?.();
							tui.requestRender();
						},
					);
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
				isOpen = false;
				panelComponent = null;
				overlayHandle = null;
			});

		isOpen = true;
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
		handler: async () => {
			if (isOpen && overlayHandle && !panelComponent?.focused) {
				overlayHandle.focus?.();
				if (panelComponent) {
					panelComponent.focused = true;
					panelComponent.invalidate();
				}
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

			// Toggle
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
		// Clear tabs on session reset
		tabs.length = 0;
		pendingRegistrations = [];
		activeTabIndex = 0;
		if (panelComponent) {
			panelComponent.close();
			panelComponent = null;
			isOpen = false;
		}
	});

	// ── Auto-open triggers ─────────────────────────────────────────────

	for (const event of [
		"tool_call",
		"agent_start",
		"message_start",
	] as const) {
		pi.on(event, (_event: any, ctx: any) => {
			maybeAutoOpen(ctx);
		});
	}

	// ── Registration API (via pi.events) ───────────────────────────────

	pi.events.on("sidepanel:register", (tab: TabProvider) => {
		// Deduplicate
		const existing = tabs.findIndex((t) => t.provider.id === tab.id);
		if (existing >= 0) {
			tabs[existing] = { provider: tab };
		} else {
			tabs.push({ provider: tab });
		}

		// If panel is open, add to live component
		if (panelComponent) {
			panelComponent.addTab(tab);
		} else {
			// Buffer registration until panel opens
			// Avoid duplicates in pending
			const pendingIdx = pendingRegistrations.findIndex(
				(p) => p.id === tab.id,
			);
			if (pendingIdx >= 0) {
				pendingRegistrations[pendingIdx] = tab;
			} else {
				pendingRegistrations.push(tab);
			}
		}
	});

	pi.events.on("sidepanel:unregister", ({ id }: { id: string }) => {
		const idx = tabs.findIndex((t) => t.provider.id === id);
		if (idx >= 0) tabs.splice(idx, 1);
		if (activeTabIndex >= tabs.length) {
			activeTabIndex = Math.max(0, tabs.length - 1);
		}

		// Remove from pending too
		const pendingIdx = pendingRegistrations.findIndex((p) => p.id === id);
		if (pendingIdx >= 0) pendingRegistrations.splice(pendingIdx, 1);

		if (panelComponent) {
			panelComponent.removeTab(id);
		}
	});

	pi.events.on(
		"sidepanel:invalidate",
		({ tabId }: { tabId?: string }) => {
			if (panelComponent) {
				panelComponent.invalidateTab(tabId);
			}
		},
	);

	// Emit ready from session_start so tab plugins can register
	// after both extensions have loaded (avoids load-order issues)
	pi.on("session_start", () => {
		// Slight delay to let framework's own session_start reset complete first.
		// The framework's session_start runs first (alphabetical order),
		// then this ready event fires, then tab plugins' session_start handlers
		// emit sidepanel:register.
		setTimeout(() => {
			pi.events.emit("sidepanel:ready", {});
		}, 0);
	});
}
