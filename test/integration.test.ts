/**
 * pi-sidepanel integration tests
 *
 * Loads the REAL extension entry point (index.ts) against the FakePi
 * harness and a stubbed pi-tui, then drives it through the same event
 * sequences pi produces. These tests cover the wiring that unit tests
 * of extracted components cannot: registration buffering, the
 * session_start registry wipe + sidepanel:ready handshake, busy-state
 * buffering across panel open, tab switching/removal, and caching.
 *
 * Run: node --test test/integration.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { FakePi, identityTheme, tick } from "./_harness/fake-pi.ts";

register("./_harness/stub-hooks.mjs", import.meta.url);
const extension = (await import("../index.ts")).default;

// ── Drivers ───────────────────────────────────────────────────────────────

/** A fake tab whose component records every interaction. */
function makeTab(id: string, label: string) {
	const calls = {
		renders: 0,
		inputs: [] as string[],
		activations: 0,
		deactivations: 0,
	};
	return {
		calls,
		payload: {
			id,
			label,
			component: {
				render(_width: number): string[] {
					calls.renders++;
					return [`${id} content`];
				},
				handleInput(data: string): void {
					calls.inputs.push(data);
				},
				invalidate(): void {},
				onActivate(): void {
					calls.activations++;
				},
				onDeactivate(): void {
					calls.deactivations++;
				},
			},
		},
	};
}

/** A fake ctx.ui whose custom() captures the overlay component.
 *  `defer` invokes the factory asynchronously — pi is allowed to. */
function makeUi(opts: { defer?: boolean; rows?: number } = {}) {
	const ui: any = {
		component: null,
		widgets: new Map<string, unknown>(),
		custom(factory: any, options?: any) {
			const tui = {
				requestRender() {},
				terminal: { rows: opts.rows ?? 40, columns: 120 },
			};
			let resolveDone!: (v: unknown) => void;
			const done = new Promise((r) => {
				resolveDone = r;
			});
			const run = () => {
				ui.component = factory(tui, identityTheme, {}, (v: unknown) =>
					resolveDone(v),
				);
			};
			if (opts.defer) setTimeout(run, 0);
			else run();
			options?.onHandle?.({ focus() {}, unfocus() {} });
			return done;
		},
		notify(_msg: string, _level?: string) {},
		setWidget(id: string, w: unknown) {
			if (w === undefined) ui.widgets.delete(id);
			else ui.widgets.set(id, w);
		},
	};
	return ui;
}

async function openPanel(pi: FakePi, ui = makeUi()) {
	await pi.shortcuts.get("f2")!.handler({ ui });
	return ui;
}

// ── Registration & ready handshake ────────────────────────────────────────

describe("registration buffering", () => {
	it("registrations buffered while closed appear when the panel opens", async () => {
		const pi = new FakePi();
		extension(pi as any);
		pi.events.emit("sidepanel:register", makeTab("bash", "Bash").payload);

		const ui = await openPanel(pi);
		const lines: string[] = ui.component.render(60);
		assert.ok(
			lines.some((l) => l.includes("1:Bash")),
			"buffered tab should appear in the header",
		);
	});

	it("re-registering the same id replaces, not duplicates", async () => {
		const pi = new FakePi();
		extension(pi as any);
		pi.events.emit("sidepanel:register", makeTab("bash", "Bash").payload);
		pi.events.emit("sidepanel:register", makeTab("bash", "Bash2").payload);

		const ui = await openPanel(pi);
		const lines: string[] = ui.component.render(60);
		assert.ok(lines.some((l) => l.includes("1:Bash2")));
		assert.ok(!lines.some((l) => l.includes("2:")));
	});

	it("dash tab sorts first regardless of registration order", async () => {
		const pi = new FakePi();
		extension(pi as any);
		pi.events.emit("sidepanel:register", makeTab("bash", "Bash").payload);
		pi.events.emit("sidepanel:register", makeTab("dash", "Dash").payload);

		const ui = await openPanel(pi);
		const header = (ui.component.render(60) as string[]).find((l) =>
			l.includes("1:"),
		)!;
		assert.ok(header.includes("1:Dash"), `dash should be tab 1: ${header}`);
		assert.ok(header.includes("2:Bash"));
	});

	it("session_start wipes buffered registrations and emits sidepanel:ready", async () => {
		const pi = new FakePi();
		extension(pi as any);
		pi.events.emit("sidepanel:register", makeTab("bash", "Bash").payload);

		let readyFired = false;
		pi.events.on("sidepanel:ready", () => {
			readyFired = true;
		});
		await pi.fire("session_start");
		await tick();
		assert.equal(readyFired, true, "ready must fire after the wipe");

		// The wipe is real: opening now shows no tabs…
		const ui = await openPanel(pi);
		assert.ok(
			(ui.component.render(60) as string[]).some((l) =>
				l.includes("No tabs registered"),
			),
		);

		// …and a tab that re-registers on ready (the documented recovery
		// protocol) appears.
		pi.events.emit("sidepanel:register", makeTab("bash", "Bash").payload);
		assert.ok(
			(ui.component.render(60) as string[]).some((l) => l.includes("1:Bash")),
		);
	});
});

// ── Busy state ────────────────────────────────────────────────────────────

describe("busy state", () => {
	it("busy flagged while closed shows the placeholder when opened — even when ui.custom defers the factory", async () => {
		const pi = new FakePi();
		extension(pi as any);
		pi.events.emit("sidepanel:register", makeTab("bash", "Bash").payload);
		pi.events.emit("sidepanel:busy", {
			tabId: "bash",
			busy: true,
			message: "replaying session…",
		});

		const ui = makeUi({ defer: true });
		await openPanel(pi, ui);
		assert.equal(ui.component, null, "factory deliberately deferred");
		await tick(2);
		assert.ok(ui.component, "factory should have run");

		const lines: string[] = ui.component.render(60);
		assert.ok(lines.some((l) => l.includes("Loading…")));
		assert.ok(
			lines.some((l) => l.includes("replaying session…")),
			"tab-supplied busy message should render",
		);
	});

	it("clearing busy renders the tab content", async () => {
		const pi = new FakePi();
		extension(pi as any);
		const tab = makeTab("bash", "Bash");
		pi.events.emit("sidepanel:register", tab.payload);
		pi.events.emit("sidepanel:busy", { tabId: "bash", busy: true });

		const ui = await openPanel(pi);
		assert.ok(
			(ui.component.render(60) as string[]).some((l) =>
				l.includes("Loading…"),
			),
		);

		pi.events.emit("sidepanel:busy", { tabId: "bash", busy: false });
		assert.ok(
			(ui.component.render(60) as string[]).some((l) =>
				l.includes("bash content"),
			),
		);
	});
});

// ── Input routing, switching, removal ─────────────────────────────────────

describe("input routing and tab lifecycle", () => {
	function threeTabs(pi: FakePi) {
		const a = makeTab("a", "Aaa");
		const b = makeTab("b", "Bbb");
		const c = makeTab("c", "Ccc");
		pi.events.emit("sidepanel:register", a.payload);
		pi.events.emit("sidepanel:register", b.payload);
		pi.events.emit("sidepanel:register", c.payload);
		return { a, b, c };
	}

	it("digit keys switch tabs and fire activation lifecycle", async () => {
		const pi = new FakePi();
		extension(pi as any);
		const { a, c } = threeTabs(pi);
		const ui = await openPanel(pi);

		ui.component.handleInput("3");
		assert.equal(c.calls.activations, 1);
		assert.equal(a.calls.deactivations, 1);

		ui.component.handleInput("x");
		assert.deepEqual(c.calls.inputs, ["x"]);
		assert.deepEqual(a.calls.inputs, []);
	});

	it("out-of-range digits are delegated to the active tab, not swallowed", async () => {
		const pi = new FakePi();
		extension(pi as any);
		const { a } = threeTabs(pi);
		const ui = await openPanel(pi);

		ui.component.handleInput("9");
		assert.deepEqual(a.calls.inputs, ["9"]);
	});

	it("unregistering a tab before the active one keeps the same tab active", async () => {
		const pi = new FakePi();
		extension(pi as any);
		const { b, c } = threeTabs(pi);
		const ui = await openPanel(pi);

		ui.component.handleInput("3"); // C active
		pi.events.emit("sidepanel:unregister", { id: "a" });

		// No lifecycle churn: the selection followed C.
		assert.equal(b.calls.activations, 0);
		ui.component.handleInput("z");
		assert.ok(c.calls.inputs.includes("z"), "input should still reach C");
	});

	it("unregistering the active tab activates the next one", async () => {
		const pi = new FakePi();
		extension(pi as any);
		const { b } = threeTabs(pi);
		const ui = await openPanel(pi);

		pi.events.emit("sidepanel:unregister", { id: "a" });
		assert.equal(b.calls.activations, 1, "B should become active");
		ui.component.handleInput("z");
		assert.ok(b.calls.inputs.includes("z"));
	});
});

// ── Render caching ────────────────────────────────────────────────────────

describe("per-tab render caching", () => {
	it("switching away and back serves the cached render", async () => {
		const pi = new FakePi();
		extension(pi as any);
		const a = makeTab("a", "Aaa");
		const b = makeTab("b", "Bbb");
		pi.events.emit("sidepanel:register", a.payload);
		pi.events.emit("sidepanel:register", b.payload);
		const ui = await openPanel(pi);

		ui.component.render(60);
		assert.equal(a.calls.renders, 1);

		ui.component.handleInput("\t"); // → B
		ui.component.render(60);
		assert.equal(b.calls.renders, 1);

		ui.component.handleInput("\t"); // → back to A
		ui.component.render(60);
		assert.equal(a.calls.renders, 1, "A must come from cache");
	});

	it("delegated input invalidates ONLY the active tab", async () => {
		const pi = new FakePi();
		extension(pi as any);
		const a = makeTab("a", "Aaa");
		const b = makeTab("b", "Bbb");
		pi.events.emit("sidepanel:register", a.payload);
		pi.events.emit("sidepanel:register", b.payload);
		const ui = await openPanel(pi);

		// Render both once.
		ui.component.render(60);
		ui.component.handleInput("\t");
		ui.component.render(60);
		ui.component.handleInput("\t");
		ui.component.render(60);
		assert.equal(a.calls.renders, 1);
		assert.equal(b.calls.renders, 1);

		// A keypress on A busts A's cache…
		ui.component.handleInput("x");
		ui.component.render(60);
		assert.equal(a.calls.renders, 2);

		// …but B's cache must survive (regression: blanket invalidate).
		ui.component.handleInput("\t");
		ui.component.render(60);
		assert.equal(b.calls.renders, 1, "B must still come from cache");
	});

	it("targeted sidepanel:invalidate of a background tab leaves the active tab cached", async () => {
		const pi = new FakePi();
		extension(pi as any);
		const a = makeTab("a", "Aaa");
		const b = makeTab("b", "Bbb");
		pi.events.emit("sidepanel:register", a.payload);
		pi.events.emit("sidepanel:register", b.payload);
		const ui = await openPanel(pi);
		ui.component.render(60);

		pi.events.emit("sidepanel:invalidate", { tabId: "b" });
		ui.component.render(60);
		assert.equal(a.calls.renders, 1, "active tab A must stay cached");

		ui.component.handleInput("\t");
		ui.component.render(60);
		assert.equal(b.calls.renders, 1, "B renders fresh when shown");
	});
});

// ── Panel geometry ────────────────────────────────────────────────────────

describe("panel geometry", () => {
	it("fills 90% of the terminal minus 6 chrome rows", async () => {
		const pi = new FakePi();
		extension(pi as any);
		pi.events.emit("sidepanel:register", makeTab("a", "Aaa").payload);

		// rows=40 → floor(36) - 6 = 30 content rows + 6 chrome = 36 lines.
		const ui = await openPanel(pi, makeUi({ rows: 40 }));
		assert.equal((ui.component.render(60) as string[]).length, 36);
	});

	it("clamps content to 80 rows on huge terminals", async () => {
		const pi = new FakePi();
		extension(pi as any);
		pi.events.emit("sidepanel:register", makeTab("a", "Aaa").payload);

		const ui = await openPanel(pi, makeUi({ rows: 200 }));
		assert.equal((ui.component.render(60) as string[]).length, 86);
	});

	it("keeps the box shape: borders on every line", async () => {
		const pi = new FakePi();
		extension(pi as any);
		pi.events.emit("sidepanel:register", makeTab("a", "Aaa").payload);

		const ui = await openPanel(pi);
		const lines: string[] = ui.component.render(60);
		assert.ok(lines[0]!.startsWith("╭") && lines[0]!.endsWith("╮"));
		assert.ok(lines.at(-1)!.startsWith("╰") && lines.at(-1)!.endsWith("╯"));
		for (const l of lines.slice(1, -1)) {
			assert.ok(
				l.startsWith("│") || l.startsWith("├"),
				`left border missing: ${JSON.stringify(l)}`,
			);
		}
	});
});

// ── Close / reopen ────────────────────────────────────────────────────────

describe("close and reopen", () => {
	it("ctrl+c closes; reopening preserves the active tab selection", async () => {
		const pi = new FakePi();
		extension(pi as any);
		const a = makeTab("a", "Aaa");
		const b = makeTab("b", "Bbb");
		pi.events.emit("sidepanel:register", a.payload);
		pi.events.emit("sidepanel:register", b.payload);

		const ui = await openPanel(pi);
		ui.component.handleInput("2"); // B active
		ui.component.handleInput("\x03"); // ctrl+c → close
		await tick();

		const ui2 = await openPanel(pi);
		ui2.component.handleInput("z");
		assert.ok(
			b.calls.inputs.includes("z"),
			"B should still be the active tab after reopen",
		);
	});
});
