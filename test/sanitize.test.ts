import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeLine } from "../sanitize.ts";

// ── Pure text passthrough ─────────────────────────────────────────────────

describe("sanitizeLine — plain text", () => {
	it("passes normal text through unchanged", () => {
		assert.equal(sanitizeLine("hello world"), "hello world");
	});

	it("handles empty string", () => {
		assert.equal(sanitizeLine(""), "");
	});

	it("preserves spaces and punctuation", () => {
		assert.equal(sanitizeLine("  file.txt — [W]  "), "  file.txt — [W]  ");
	});
});

// ── Newline / carriage return stripping ───────────────────────────────────

describe("sanitizeLine — newlines and CR", () => {
	it("strips LF newlines", () => {
		assert.equal(sanitizeLine("line1\nline2"), "line1line2");
	});

	it("strips CR+LF newlines", () => {
		assert.equal(sanitizeLine("line1\r\nline2"), "line1line2");
	});

	it("strips standalone CR", () => {
		assert.equal(sanitizeLine("line1\rline2"), "line1line2");
	});

	it("strips multiple newlines", () => {
		assert.equal(sanitizeLine("a\n\nb\nc"), "abc");
	});

	it("strips newline at end", () => {
		assert.equal(sanitizeLine("text\n"), "text");
	});

	it("strips newline at start", () => {
		assert.equal(sanitizeLine("\ntext"), "text");
	});
});

// ── ANSI cursor movement stripping ────────────────────────────────────────

describe("sanitizeLine — cursor movement", () => {
	const sgr = "\x1b[31m";

	it("strips cursor up (A)", () => {
		assert.equal(
			sanitizeLine(`${sgr}hello\x1b[2Aworld${sgr}`),
			`${sgr}helloworld${sgr}`,
		);
	});

	it("strips cursor down (B)", () => {
		assert.equal(sanitizeLine("a\x1b[1Bb"), "ab");
	});

	it("strips cursor forward (C)", () => {
		assert.equal(sanitizeLine("a\x1b[5Cb"), "ab");
	});

	it("strips cursor back (D)", () => {
		assert.equal(sanitizeLine("a\x1b[3Db"), "ab");
	});

	it("strips cursor next line (E)", () => {
		assert.equal(sanitizeLine("a\x1b[1Eb"), "ab");
	});

	it("strips cursor previous line (F)", () => {
		assert.equal(sanitizeLine("a\x1b[1Fb"), "ab");
	});

	it("strips cursor horizontal absolute (G)", () => {
		assert.equal(sanitizeLine("a\x1b[10Gb"), "ab");
	});

	it("strips cursor position (H)", () => {
		assert.equal(sanitizeLine("a\x1b[5;10Hb"), "ab");
	});

	it("strips cursor position (f)", () => {
		assert.equal(sanitizeLine("a\x1b[5;10fb"), "ab");
	});
});

// ── ANSI clearing / scrolling stripping ───────────────────────────────────

describe("sanitizeLine — clearing and scrolling", () => {
	it("strips clear display (J)", () => {
		assert.equal(sanitizeLine("a\x1b[2Jb"), "ab");
	});

	it("strips clear line (K)", () => {
		assert.equal(sanitizeLine("a\x1b[Kb"), "ab");
	});

	it("strips scroll up (S)", () => {
		assert.equal(sanitizeLine("a\x1b[2Sb"), "ab");
	});

	it("strips scroll down (T)", () => {
		assert.equal(sanitizeLine("a\x1b[2Tb"), "ab");
	});

	it("strips save cursor (s)", () => {
		assert.equal(sanitizeLine("a\x1b[sb"), "ab");
	});

	it("strips restore cursor (u)", () => {
		assert.equal(sanitizeLine("a\x1b[ub"), "ab");
	});
});

// ── Private mode / reset stripping ────────────────────────────────────────

describe("sanitizeLine — modes and reset", () => {
	it("strips private mode set (?…h)", () => {
		assert.equal(sanitizeLine("a\x1b[?25hb"), "ab");
	});

	it("strips private mode reset (?…l)", () => {
		assert.equal(sanitizeLine("a\x1b[?25lb"), "ab");
	});

	it("strips keypad mode (=…h)", () => {
		assert.equal(sanitizeLine("a\x1b[=0hb"), "ab");
	});

	it("strips RIS (ESC c)", () => {
		assert.equal(sanitizeLine("a\x1bcb"), "ab");
	});

	it("strips key encoding (~)", () => {
		assert.equal(sanitizeLine("a\x1b[3~b"), "ab");
	});
});

// ── OSC / character set stripping ─────────────────────────────────────────

describe("sanitizeLine — OSC and charsets", () => {
	it("strips OSC set-title (BEL terminated)", () => {
		assert.equal(sanitizeLine("a\x1b]0;hacked\x07b"), "ab");
	});

	it("strips OSC set-title (ST terminated)", () => {
		assert.equal(sanitizeLine("a\x1b]0;hacked\x1b\\b"), "ab");
	});

	it("strips character set selection ESC ( A", () => {
		assert.equal(sanitizeLine("a\x1b(Ab"), "ab");
	});

	it("strips character set selection ESC ) 0", () => {
		assert.equal(sanitizeLine("a\x1b)0b"), "ab");
	});

	it("strips shift-in / shift-out", () => {
		assert.equal(sanitizeLine("a\x0eb\x0fc"), "abc");
	});
});

// ── SGR preservation ──────────────────────────────────────────────────────

describe("sanitizeLine — preserves SGR codes", () => {
	it("preserves basic color (31m)", () => {
		assert.equal(sanitizeLine("\x1b[31mred\x1b[0m"), "\x1b[31mred\x1b[0m");
	});

	it("preserves 256-color (38;5;Nm)", () => {
		assert.equal(
			sanitizeLine("\x1b[38;5;196mred\x1b[0m"),
			"\x1b[38;5;196mred\x1b[0m",
		);
	});

	it("preserves truecolor (38;2;R;G;Bm)", () => {
		assert.equal(
			sanitizeLine("\x1b[38;2;255;0;0mred\x1b[0m"),
			"\x1b[38;2;255;0;0mred\x1b[0m",
		);
	});

	it("preserves bold (1m)", () => {
		assert.equal(sanitizeLine("\x1b[1mbold\x1b[0m"), "\x1b[1mbold\x1b[0m");
	});

	it("preserves dim (2m)", () => {
		assert.equal(sanitizeLine("\x1b[2mdim\x1b[0m"), "\x1b[2mdim\x1b[0m");
	});

	it("preserves combined SGR (1;31m)", () => {
		assert.equal(
			sanitizeLine("\x1b[1;31mbold red\x1b[0m"),
			"\x1b[1;31mbold red\x1b[0m",
		);
	});

	it("preserves background color (41m)", () => {
		assert.equal(
			sanitizeLine("\x1b[41mbg red\x1b[0m"),
			"\x1b[41mbg red\x1b[0m",
		);
	});
});

// ── Backspace handling ────────────────────────────────────────────────────

describe("sanitizeLine — backspace", () => {
	it("strips character + backspace pair", () => {
		// "a\x08b" means: type 'a', backspace over it, type 'b'
		// We strip the 'a' + backspace, leaving 'b'
		assert.equal(sanitizeLine("a\x08b"), "b");
	});

	it("strips multiple backspace pairs", () => {
		assert.equal(sanitizeLine("ab\x08\x08c"), "c");
	});

	it("strips leading backspace (would overwrite left border)", () => {
		// A leading backspace would move the cursor left of the
		// border character — it must be stripped.
		assert.equal(sanitizeLine("\x08hello"), "hello");
	});
});

// ── Newline injection attacks (tab component tries to break box) ─────────

describe("sanitizeLine — newline injection attacks", () => {
	it("strips \\n trying to write over right border", () => {
		// Tab renders a line that inserts a newline + fake border
		const attack = "legit content\n│ injected border overwrite";
		const clean = sanitizeLine(attack);
		assert.equal(clean.includes("\n"), false);
		assert.equal(
			clean.includes("injected border overwrite"),
			true,
			"content after newline should be concatenated, not on new line",
		);
	});

	it("strips \\r used to overwrite left border", () => {
		// Tab renders a line with CR to jump back and overwrite the │ border
		const attack = "data\rX";
		const clean = sanitizeLine(attack);
		assert.equal(clean, "dataX");
	});

	it("strips \\n\\n multi-newline trying to shift entire panel down", () => {
		// Multiple newlines would push all subsequent lines down
		const attack = "a\n\n\nb";
		assert.equal(sanitizeLine(attack), "ab");
	});

	it("strips newlines embedded inside ANSI-colored text", () => {
		const attack = "\x1b[31maaa\nbbb\x1b[0m\n\x1b[32mccc\x1b[0m";
		const clean = sanitizeLine(attack);
		assert.equal(clean.includes("\n"), false);
		assert.ok(clean.startsWith("\x1b[31m"));
	});

	it("strips ANSI cursor-move that would reposition to (1,1)", () => {
		// \x1b[H moves cursor to home (1,1) — would overwrite top-left
		const attack = "data\x1b[HO";
		assert.equal(sanitizeLine(attack), "dataO");
	});

	it("strips ANSI clear-screen injected mid-line", () => {
		// \x1b[2J clears entire screen
		const attack = "safe\x1b[2Jpoisoned";
		assert.equal(sanitizeLine(attack), "safepoisoned");
	});
});

// ── Combined / edge cases ─────────────────────────────────────────────────

describe("sanitizeLine — combined attacks", () => {
	it("strips mixed dangerous sequences while keeping SGR", () => {
		const input = "\x1b[31mhello\x1b[2A\x1b[Kw0rld\x1b[0m\x1bc";
		const expected = "\x1b[31mhellow0rld\x1b[0m";
		assert.equal(sanitizeLine(input), expected);
	});

	it("handles newline + ANSI combination", () => {
		const input = "a\n\x1b[31m\x1b[2Jb\x1b[0m\nc";
		const expected = "a\x1b[31mb\x1b[0mc";
		assert.equal(sanitizeLine(input), expected);
	});

	it("preserves complex SGR with embedded attacks", () => {
		const input = "\x1b[1;31;44mBOLD RED BG\x1b[H\x1b[2J\x1b[0m";
		const expected = "\x1b[1;31;44mBOLD RED BG\x1b[0m";
		assert.equal(sanitizeLine(input), expected);
	});

	it("returns empty string for all-control input", () => {
		assert.equal(sanitizeLine("\x1b[2J\x1bc\x1b[H\n\r\n"), "");
	});

	it("is idempotent", () => {
		const input = "a\x1b[31m\x1b[2Ab\x1b[0m";
		const once = sanitizeLine(input);
		const twice = sanitizeLine(once);
		assert.equal(twice, once);
	});
});

// ── Box shape integrity (verified on clean output) ────────────────────────

describe("Box shape post-sanitization", () => {
	/**
	 * After sanitizeLine(), the output must contain zero:
	 *   - newlines (\n, \r, \r\n)
	 *   - dangerous CSI sequences (cursor, clear, scroll, modes)
	 */
	function hasNewlines(s: string): boolean {
		return /[\r\n]/.test(s);
	}

	function hasDangerousCSI(s: string): boolean {
		// CSI ending in anything except 'm'
		return /\x1b\[[?=]?[\d;]*[A-Za-ln-z~]/.test(s);
	}

	function hasRIS(s: string): boolean {
		return /\x1bc/.test(s);
	}

	function hasOSC(s: string): boolean {
		return /\x1b\].*?(?:\x07|\x1b\\)/.test(s);
	}

	it("output has no newlines after sanitization", () => {
		const dirty = "line1\nline2\rline3\r\nline4";
		const clean = sanitizeLine(dirty);
		assert.equal(hasNewlines(clean), false);
	});

	it("output has no dangerous CSI after sanitization", () => {
		const dirty = "text\x1b[2Aup\x1b[Jclear\x1b[?25lhide";
		const clean = sanitizeLine(dirty);
		assert.equal(hasDangerousCSI(clean), false);
	});

	it("output has no RIS after sanitization", () => {
		assert.equal(hasRIS(sanitizeLine("a\x1bcb")), false);
	});

	it("output has no OSC after sanitization", () => {
		assert.equal(hasOSC(sanitizeLine("a\x1b]0;x\x07b")), false);
	});

	it("SGR codes survive through the box-shape checks", () => {
		const clean = sanitizeLine("\x1b[1;31merror\x1b[0m");
		// Must still contain the SGR codes
		assert.ok(clean.includes("\x1b[1;31m"));
		assert.ok(clean.includes("\x1b[0m"));
		// Must be free of dangerous sequences
		assert.equal(hasDangerousCSI(clean), false);
		assert.equal(hasNewlines(clean), false);
	});
});
