/**
 * pi-sidepanel sanitize — ANSI / control-character sanitizer
 *
 * Strips dangerous terminal control sequences that could break the panel's
 * box shape, while preserving SGR codes (colors, bold, dim, etc.).
 *
 * Pure function, zero dependencies — safe to test in isolation.
 */

/**
 * Strip all ANSI escape sequences EXCEPT SGR (Select Graphic Rendition)
 * codes (`\x1b[...m`). Also collapse embedded newlines and carriage
 * returns that would break the vertical/horizontal alignment of the
 * panel borders.
 */
export function sanitizeLine(line: string): string {
	// 1. Collapse newlines and carriage returns — these would break
	//    the box vertically (newline) or horizontally (CR overwrites
	//    the left border).
	line = line.replace(/\r\n?|\n/g, "");

	// 2. Strip CSI sequences that do NOT end with 'm' (SGR).
	//    This removes cursor movement (A-D,G,H,f), clearing (J,K),
	//    scrolling (S,T), save/restore cursor (s,u), private modes
	//    (?…h, ?…l), key encodings (~), and other terminal control.
	//    Pattern: ESC [ [param...] <final byte that is not 'm'>
	line = line.replace(/\x1b\[[?=]?[\d;]*[A-Za-ln-z~]/g, "");

	// 3. RIS — reset to initial state (would clear the entire terminal)
	line = line.replace(/\x1bc/g, "");

	// 4. OSC sequences — operating system commands (set title, etc.)
	//    Format: ESC ] ... (BEL | ST)
	line = line.replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "");

	// 5. Character set selection — ESC ( X or ESC ) X
	//    These change how characters are rendered.
	line = line.replace(/\x1b[()*+][A-Za-z0-9]/g, "");

	// 6. Shift-in / shift-out (SI/SO) — character set shifts
	line = line.replace(/[\x0e\x0f]/g, "");

	// 7. Backspace / delete — could cause text overlap.
	//    Each backspace deletes the character to its left (destructive
	//    backspace emulation). Loop to handle chains like "ab\x08\x08c".
	//    Guard: max iterations = line length (prevents infinite loop on
	//    a leading backspace with no preceding character).
	for (let i = 0; i < line.length && line.includes("\x08"); i++) {
		const prev = line;
		line = line.replace(/.\x08/g, "");
		// If nothing changed, strip remaining isolated backspaces
		if (line === prev) {
			line = line.replace(/\x08/g, "");
			break;
		}
	}

	return line;
}
