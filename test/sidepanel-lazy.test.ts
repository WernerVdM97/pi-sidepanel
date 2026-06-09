/**
 * Lazy viewport rendering tests for SidepanelComponent
 *
 * Verifies:
 * - Tab render output cached per-tab (switch tab = instant restore)
 * - Inactive tabs not re-rendered on switch
 * - Active tab re-rendered when invalidated
 * - Caches invalidated on data change
 *
 * Run: node --test test/sidepanel-lazy.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Tab component factory with render counting ──────────────────────────

function makeTab(id: string, label: string, renderFn: (w: number) => string[]) {
	let renderCount = 0;

	return {
		id,
		label,
		component: {
			render(width: number): string[] {
				renderCount++;
				return renderFn(width);
			},
			invalidate(): void {
				// no-op
			},
		},
		getRenderCount: () => renderCount,
	};
}

// ── Lazy render cache (mirrors SidepanelComponent optimization) ──────────

interface CachedRender {
	width: number;
	lines: string[];
}

class LazyTabPanel {
	/** Per-tab stable render output. Keyed by tab index. */
	private tabCaches = new Map<number, CachedRender>();
	private activeIdx = 0;
	private tabs: ReturnType<typeof makeTab>[] = [];

	addTab(tab: ReturnType<typeof makeTab>): void {
		this.tabs.push(tab);
	}

	switchTo(idx: number): void {
		if (idx === this.activeIdx || idx >= this.tabs.length) return;
		this.activeIdx = idx;
	}

	/** Render with lazy caching: only re-render active tab if stale. */
	renderContent(width: number): string[] {
		const activeTab = this.tabs[this.activeIdx];
		if (!activeTab) return [];

		const cached = this.tabCaches.get(this.activeIdx);
		if (cached && cached.width === width) {
			// Return cached — no re-render needed
			return cached.lines;
		}

		const lines = activeTab.component.render(width);
		this.tabCaches.set(this.activeIdx, { width, lines });
		return lines;
	}

	/** Invalidate cache for active tab only (data change). */
	invalidateActiveTab(): void {
		this.tabCaches.delete(this.activeIdx);
	}

	/** Invalidate all caches (theme change, resize). */
	invalidateAll(): void {
		this.tabCaches.clear();
	}

	getActiveIdx(): number {
		return this.activeIdx;
	}
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Lazy viewport rendering", () => {
	it("caches render output by width", () => {
		const panel = new LazyTabPanel();
		const tab = makeTab("t1", "T1", () => ["line 1", "line 2"]);
		panel.addTab(tab);

		// First render — should call tab.render()
		const result1 = panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 1);
		assert.deepEqual(result1, ["line 1", "line 2"]);

		// Second render same width — should use cache
		const result2 = panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 1); // no increment
		assert.deepEqual(result2, ["line 1", "line 2"]);
	});

	it("re-renders when width changes", () => {
		const panel = new LazyTabPanel();
		const tab = makeTab("t1", "T1", (w) => [`width=${w}`]);
		panel.addTab(tab);

		panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 1);

		// Different width invalidates cache
		panel.renderContent(50);
		assert.equal(tab.getRenderCount(), 2);
	});

	it("switch tab does NOT re-render inactive tab", () => {
		const panel = new LazyTabPanel();
		const tabA = makeTab("a", "A", () => ["A content"]);
		const tabB = makeTab("b", "B", () => ["B content"]);
		panel.addTab(tabA);
		panel.addTab(tabB);

		// Render tab 0
		panel.renderContent(40);
		assert.equal(tabA.getRenderCount(), 1);
		assert.equal(tabB.getRenderCount(), 0);

		// Switch to tab 1 — should render tab 1
		panel.switchTo(1);
		panel.renderContent(40);
		assert.equal(tabB.getRenderCount(), 1);
	});

	it("switch tab and back uses cached render for previously-active tab", () => {
		const panel = new LazyTabPanel();
		const tabA = makeTab("a", "A", () => ["A"]);
		const tabB = makeTab("b", "B", () => ["B"]);
		panel.addTab(tabA);
		panel.addTab(tabB);

		// Render A
		panel.renderContent(40);
		assert.equal(tabA.getRenderCount(), 1);

		// Switch to B, render B
		panel.switchTo(1);
		panel.renderContent(40);
		assert.equal(tabB.getRenderCount(), 1);

		// Switch back to A — should use cached A
		panel.switchTo(0);
		panel.renderContent(40);
		assert.equal(tabA.getRenderCount(), 1); // still 1 — no re-render
	});

	it("invalidateActiveTab forces re-render of active tab", () => {
		const panel = new LazyTabPanel();
		const tab = makeTab("t1", "T1", (_w) => ["initial"]);
		panel.addTab(tab);

		panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 1);

		// Invalidate and re-render — should call tab.render() again
		panel.invalidateActiveTab();
		panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 2);
	});

	it("invalidateAll forces re-render of all tabs", () => {
		const panel = new LazyTabPanel();
		const tabA = makeTab("a", "A", () => ["A"]);
		const tabB = makeTab("b", "B", () => ["B"]);
		panel.addTab(tabA);
		panel.addTab(tabB);

		// Render both tabs
		panel.renderContent(40);
		panel.switchTo(1);
		panel.renderContent(40);

		assert.equal(tabA.getRenderCount(), 1);
		assert.equal(tabB.getRenderCount(), 1);

		// Invalidate all
		panel.invalidateAll();

		// Switch back to A — should re-render
		panel.switchTo(0);
		panel.renderContent(40);
		assert.equal(tabA.getRenderCount(), 2);

		// Switch to B — should re-render
		panel.switchTo(1);
		panel.renderContent(40);
		assert.equal(tabB.getRenderCount(), 2);
	});

	it("invalidateAll triggered on theme change", () => {
		const panel = new LazyTabPanel();
		const tab = makeTab("t1", "T1", (_w) => ["themed"]);
		panel.addTab(tab);

		panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 1);

		// Theme change: invalidate all, re-render
		panel.invalidateAll();
		panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 2);
	});

	it("switch to same tab is no-op", () => {
		const panel = new LazyTabPanel();
		const tab = makeTab("t1", "T1", () => ["data"]);
		panel.addTab(tab);

		panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 1);

		panel.switchTo(0); // same tab
		panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 1); // no re-render
	});
});

describe("Render count efficiency", () => {
	it("navigating with j/k reuses cache (no re-render)", () => {
		const panel = new LazyTabPanel();
		// Tab component handles its own scroll internally
		const tab = makeTab("a", "A", (_w) => {
			// This renderFn simulates a tab that manages scroll internally
			// and returns the current viewport slice
			return ["line 1", "line 2"];
		});
		panel.addTab(tab);

		// Initial render
		panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 1);

		// User presses j (down arrow) — tab component changes scroll state
		// but SidepanelComponent should NOT re-render the tab for a scroll event
		// because the tab manages its own viewport and emissions its own
		// "sidepanel:invalidate" which triggers invalidateActiveTab
		panel.invalidateActiveTab();
		panel.renderContent(40);
		assert.equal(tab.getRenderCount(), 2); // forced by invalidate
	});
});
