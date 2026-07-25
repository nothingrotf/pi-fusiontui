import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";

// ── palette ──────────────────────────────────────────────────────────────────
// Droid factory-dark (verbatim hex, traced) — kept as the FALLBACK when the
// active pi theme can't be resolved.
const FACTORY_DARK = {
	primary: "#d75f00",
	toolName: "#d7875f",
	toolParam: "#b2b2b2",
	muted: "#767676",
	error: "#d75f5f",
	diffAdded: "#5fff5f",
	diffRemoved: "#ff5f5f",
	diffHeader: "#5fafd7",
	diffUnchanged: "#767676",
	userSymbol: "#d75f00",
	userBg: "#262626",
	// fusion-only editor border tints (droid uses a constant border)
	borderIdle: "#d75f00",
	borderWorking: "#767676",
	borderAwaiting: "#ffaf00",
} as const;

export type DroidPalette = { -readonly [K in keyof typeof FACTORY_DARK]: string };

/**
 * Live palette — resolved from the ACTIVE pi theme so the skin follows
 * whatever theme is selected (e.g. evangelion-dark), refreshed with a ~1 s
 * TTL from `hex()` (called on every paint). Token mapping (fg unless noted):
 *
 *   primary/userSymbol → accent        toolName → toolTitle
 *   toolParam → toolOutput             muted → muted · error → error
 *   diffAdded/Removed → toolDiff*      diffUnchanged → toolDiffContext
 *   diffHeader → mdCode                userBg → userMessageBg (bg token)
 *   borderIdle → accent  borderWorking → borderMuted  borderAwaiting → warning
 */
export const DROID: DroidPalette = { ...FACTORY_DARK };

// The extension supplies a getter for the current Theme instance (always live,
// so runtime theme switches are picked up). Undefined → keep factory-dark.
let themeProvider: (() => Theme | undefined) | undefined;
export function setPaletteThemeProvider(fn: (() => Theme | undefined) | undefined): void {
	themeProvider = fn;
	syncPalette(true);
}

/** ansi256 palette index → "#rrggbb" (mirrors pi's ansi256ToHex). */
function ansi256ToHex(index: number): string {
	const basic = [
		"#000000", "#800000", "#008000", "#808000", "#000080", "#800080",
		"#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00",
		"#0000ff", "#ff00ff", "#00ffff", "#ffffff",
	];
	if (index < 16) return basic[index];
	if (index < 232) {
		const c = index - 16;
		const r = Math.floor(c / 36);
		const g = Math.floor((c % 36) / 6);
		const b = c % 6;
		const h = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${h(r)}${h(g)}${h(b)}`;
	}
	const gray = 8 + (index - 232) * 10;
	const gh = gray.toString(16).padStart(2, "0");
	return `#${gh}${gh}${gh}`;
}

/** Extract "#rrggbb" from a pi SGR fg/bg escape, or undefined for default (39/49). */
function hexFromAnsi(ansi: string): string | undefined {
	const tc = ansi.match(/\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
	if (tc) {
		const h = (s: string) => Math.max(0, Math.min(255, parseInt(s, 10))).toString(16).padStart(2, "0");
		return `#${h(tc[1])}${h(tc[2])}${h(tc[3])}`;
	}
	const idx = ansi.match(/\[(?:38|48);5;(\d+)m/);
	if (idx) return ansi256ToHex(parseInt(idx[1], 10));
	return undefined; // \x1b[39m / \x1b[49m → terminal default, no hex
}

let lastPaletteSync = 0;
const PALETTE_TTL_MS = 1000;

/** Re-resolve DROID from the active theme (memoized; safe to call per frame). */
export function syncPalette(force = false): void {
	const now = Date.now();
	if (!force && now - lastPaletteSync < PALETTE_TTL_MS) return;
	lastPaletteSync = now;
	const theme = themeProvider?.();
	if (!theme) {
		Object.assign(DROID, FACTORY_DARK);
		return;
	}
	const fgHex = (token: ThemeColor, fallback: string): string => {
		try {
			return hexFromAnsi(theme.getFgAnsi(token)) ?? fallback;
		} catch {
			return fallback;
		}
	};
	let userBg: string = FACTORY_DARK.userBg;
	try {
		userBg = hexFromAnsi(theme.getBgAnsi("userMessageBg")) ?? FACTORY_DARK.userBg;
	} catch {}
	DROID.primary = fgHex("accent", FACTORY_DARK.primary);
	DROID.toolName = fgHex("toolTitle", FACTORY_DARK.toolName);
	DROID.toolParam = fgHex("toolOutput", FACTORY_DARK.toolParam);
	DROID.muted = fgHex("muted", FACTORY_DARK.muted);
	DROID.error = fgHex("error", FACTORY_DARK.error);
	DROID.diffAdded = fgHex("toolDiffAdded", FACTORY_DARK.diffAdded);
	DROID.diffRemoved = fgHex("toolDiffRemoved", FACTORY_DARK.diffRemoved);
	DROID.diffHeader = fgHex("mdCode", FACTORY_DARK.diffHeader);
	DROID.diffUnchanged = fgHex("toolDiffContext", FACTORY_DARK.diffUnchanged);
	DROID.userSymbol = fgHex("accent", FACTORY_DARK.userSymbol);
	DROID.userBg = userBg;
	DROID.borderIdle = fgHex("accent", FACTORY_DARK.borderIdle);
	DROID.borderWorking = fgHex("borderMuted", FACTORY_DARK.borderWorking);
	DROID.borderAwaiting = fgHex("warning", FACTORY_DARK.borderAwaiting);
}

export const ANSI_RESET_FG = "\x1b[39m";
export const ANSI_RESET_BG = "\x1b[49m";
type ColorMode = "truecolor" | "256color" | "16color" | "plain";

function rgbFromHex(color: string): [number, number, number] | undefined {
	if (!/^#[0-9a-f]{6}$/i.test(color)) return undefined;
	return [
		parseInt(color.slice(1, 3), 16),
		parseInt(color.slice(3, 5), 16),
		parseInt(color.slice(5, 7), 16),
	];
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

const ansi256Cache = new Map<string, number>();
const ansi16Cache = new Map<string, number>();

function nearestAnsi256(color: string): number {
	const cached = ansi256Cache.get(color);
	if (cached !== undefined) return cached;
	const rgb = rgbFromHex(color) ?? [255, 255, 255];
	let best = 15;
	let distance = Infinity;
	for (let i = 0; i < 256; i++) {
		const candidate = rgbFromHex(ansi256ToHex(i)) ?? [0, 0, 0];
		const current = colorDistance(rgb, candidate);
		if (current < distance) {
			distance = current;
			best = i;
		}
	}
	ansi256Cache.set(color, best);
	return best;
}

function nearestAnsi16(color: string): number {
	const cached = ansi16Cache.get(color);
	if (cached !== undefined) return cached;
	const rgb = rgbFromHex(color) ?? [255, 255, 255];
	let best = 7;
	let distance = Infinity;
	for (let i = 0; i < 16; i++) {
		const candidate = rgbFromHex(ansi256ToHex(i)) ?? [0, 0, 0];
		const current = colorDistance(rgb, candidate);
		if (current < distance) {
			distance = current;
			best = i;
		}
	}
	ansi16Cache.set(color, best);
	return best;
}

function colorMode(): ColorMode {
	try {
		if (process.env.NO_COLOR || process.env.TERM === "dumb") return "plain";
		const capabilities = getCapabilities();
		if (capabilities.trueColor) return "truecolor";
		const themeMode = themeProvider?.()?.getColorMode?.();
		if (themeMode === "256color") return "256color";
		if (/16color|ansi/i.test(process.env.TERM ?? "")) return "16color";
		return "256color";
	} catch {
		return "plain";
	}
}

export function ansiFor(color: string, background: boolean): string {
	const mode = colorMode();
	const rgb = rgbFromHex(color);
	if (!rgb || mode === "plain") return "";
	if (mode === "truecolor")
		return `\x1b[${background ? 48 : 38};2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
	if (mode === "256color") return `\x1b[${background ? 48 : 38};5;${nearestAnsi256(color)}m`;
	const index = nearestAnsi16(color);
	const base = background ? 40 : 30;
	const code = index < 8 ? base + index : base + 60 + (index - 8);
	return `\x1b[${code}m`;
}

/** Capability-aware foreground from "#rrggbb" (L4-09). */
export function hex(color: string, text: string): string {
	syncPalette();
	const ansi = ansiFor(color, false);
	return ansi ? `${ansi}${text}${ANSI_RESET_FG}` : text;
}
export const bold = (text: string): string => `\x1b[1m${text}\x1b[22m`;
