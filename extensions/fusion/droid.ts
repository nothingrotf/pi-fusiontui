/**
 * Droid transcript skin — a 1:1 replica of Droid's main-chat tool-call
 * rendering and assistant icon, traced from the droid 0.158.0 bundle
 * (droid-missions-reverse-engineered/work/droid.pretty.js):
 *
 *   - Tool row (`InR`/`KgT` @595541/@480990): 3-space indent, tool display
 *     name **bold** in `uT.toolName`, params after one space in `uT.toolParam`,
 *     result line `↳ …` in `uT.text.muted` with ` (error)` suffix in `uT.error`.
 *   - Display names + header labels (`UAT`/`KF1` @479599): Read/Execute/Edit/
 *     Create/Grep/Glob/LS; paths ~-abbreviated and capped at the last 3
 *     segments (`ht9`, UL0=3).
 *   - Result summaries: verbatim `toolDisplay.*` i18n strings
 *     ("{{count}} lines read", "Success ({{count}} lines output)", …).
 *   - Assistant icon (`XkH` @589774): `⛬` (U+26EC) bold in `uT.primary`
 *     (accent) in a 2-col gutter before assistant markdown.
 *   - Colors: resolved from the ACTIVE pi theme (see the DROID palette /
 *     `syncPalette`), so the skin follows your theme (e.g. evangelion-dark);
 *     it falls back to the traced factory-dark hex (@236145) when a theme
 *     token can't be resolved.
 *
 * Mechanism: Pi lets extension tools override built-ins by name — same-name
 * `registerTool` with `renderShell: "self"` + `renderCall`/`renderResult`
 * replaces the card visuals while `execute` delegates to the real built-in
 * definitions (exported from the package root). The assistant icon patches
 * `AssistantMessageComponent.prototype.render` (same module instance as the
 * running app) and is restored on shutdown.
 *
 * The executing tool name animates with Droid's shimmer wave — an exact port
 * of `Cg1`/`yt9` (@480964/@481111): a shared 50 ms ticker, period `hD0 = 20`
 * ticks, wave width `max(3, ⌊len × 0.6⌋)`, cosine falloff × 0.7, lerping the
 * theme's muted base toward rgb(230,230,230), bold. Frames redraw via the render
 * context's `invalidate()`; the ticker is ref-counted and self-stops.
 */
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ThemeColor,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getCapabilities,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	boundedLines,
	fitLine,
	normalizeWidth,
	sanitizeLines,
	sanitizeScalar,
	sanitizeStyledLine,
	sanitizeText,
} from "./render-safe";

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
	borderIdle: "#878787",
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
 *   borderIdle → border  borderWorking → borderMuted  borderAwaiting → warning
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
	DROID.borderIdle = fgHex("border", FACTORY_DARK.borderIdle);
	DROID.borderWorking = fgHex("borderMuted", FACTORY_DARK.borderWorking);
	DROID.borderAwaiting = fgHex("warning", FACTORY_DARK.borderAwaiting);
}

const ANSI_RESET_FG = "\x1b[39m";
const ANSI_RESET_BG = "\x1b[49m";
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

function ansiFor(color: string, background: boolean): string {
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
const bold = (text: string): string => `\x1b[1m${text}\x1b[22m`;

// ── path/label helpers (droid `ht9`, UL0 = 3) ───────────────────────────────
const PATH_SEGMENTS = 3;
function shortPath(p: string): string {
	const raw = sanitizeScalar(p).replace(/\\/g, "/");
	const home = (process.env.HOME || process.env.USERPROFILE || "").replace(/[\\/]+$/, "");
	const h = home.replace(/\\/g, "/");
	const t = h && (raw === h || raw.startsWith(`${h}/`)) ? `~${raw.slice(h.length)}` : raw;
	const parts = t.split("/").filter(Boolean);
	if (parts.length <= PATH_SEGMENTS) return t;
	return `.../${parts.slice(-PATH_SEGMENTS).join("/")}`;
}

const str = (v: unknown): string | undefined => {
	const value = sanitizeScalar(v);
	return value.length > 0 ? value : undefined;
};

/** Droid display names for Pi's built-in tools (droid `UAT`/`KF1`). */
const DISPLAY: Record<string, string> = {
	read: "Read",
	bash: "Execute",
	edit: "Edit",
	write: "Create",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
};

/** Header label from tool args (droid `KF1` field mapping, Pi arg names). */
function headerLabel(tool: string, args: Record<string, unknown>): string {
	switch (tool) {
		case "read":
		case "edit":
		case "write": {
			const p = str(args.path) ?? str(args.file_path);
			return p ? shortPath(p) : "";
		}
		case "bash": {
			const cmd = str(args.command) ?? "";
			return sanitizeScalar(cmd.split("\n")[0]);
		}
		case "grep": {
			const pat = str(args.pattern);
			if (!pat) return "";
			const dir = str(args.path);
			return dir ? `"${pat}" in ${shortPath(dir)}` : `"${pat}"`;
		}
		case "find":
			return str(args.pattern) ?? "";
		case "ls": {
			const p = str(args.path);
			return p ? shortPath(p) : "current directory";
		}
		default:
			return "";
	}
}

// ── shimmer latching ────────────────────────────────────────────────────────
// Error state comes straight from Pi's ToolRenderContext.isError (and the
// stored result's isError on the fallback path) — no side-channel needed.
export function markToolFinished(toolCallId: string): void {
	finishShimmer(toolCallId);
}

// ── shimmer (exact port of droid `Cg1` + `yt9`) ──────────────────────────
/** Droid `yt9`: shared 50 ms tick source, ref-counted, self-stopping. */
const ticker = {
	tick: 0,
	listeners: new Set<() => void>(),
	interval: undefined as ReturnType<typeof setInterval> | undefined,
	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		if (!this.interval)
			this.interval = setInterval(() => {
				this.tick++;
				// Snapshot: a listener may (un)subscribe during its callback —
				// iterating the live Set would visit listeners added mid-tick
				// (infinite loop → OOM).
				for (const l of [...this.listeners]) l();
			}, 50);
		return () => {
			this.listeners.delete(fn);
			if (this.listeners.size === 0 && this.interval) {
				clearInterval(this.interval);
				this.interval = undefined;
			}
		};
	},
};

/** Droid `hD0` — sweep period in ticks (20 × 50 ms = 1 s). */
const SHIMMER_PERIOD = 20;
/** Droid `Cg1` bright target `B = [230, 230, 230]`. */
const SHIMMER_BRIGHT: [number, number, number] = [230, 230, 230];

/** Droid `_g1`: "#rrggbb" → [r, g, b]. */
function rgbOf(color: string): [number, number, number] {
	const h = color.replace("#", "");
	return [
		parseInt(h.slice(0, 2), 16),
		parseInt(h.slice(2, 4), 16),
		parseInt(h.slice(4, 6), 16),
	];
}

/** Droid `fg1`/`ug1`: lerp base→bright by U, back to hex. */
function lerpHex(
	base: [number, number, number],
	bright: [number, number, number],
	u: number,
): string {
	const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
	const r = c(base[0] + (bright[0] - base[0]) * u);
	const g = c(base[1] + (bright[1] - base[1]) * u);
	const b = c(base[2] + (bright[2] - base[2]) * u);
	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Droid `Cg1` frame math: per-char colors for the moving cosine highlight. */
function shimmerText(text: string, baseColor: string, tick: number): string {
	const base = rgbOf(baseColor);
	const clusters = typeof Intl.Segmenter === "function"
		? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment)
		: Array.from(text);
	const widths = clusters.map((cluster) => Math.max(1, visibleWidth(cluster)));
	const totalWidth = widths.reduce((sum, width) => sum + width, 0);
	const waveWidth = Math.max(3, Math.floor(totalWidth * 0.6));
	const span = totalWidth + waveWidth;
	const phase = (tick % SHIMMER_PERIOD) / SHIMMER_PERIOD;
	const center = phase * span - waveWidth / 2;
	let offset = 0;
	let out = "";
	for (let i = 0; i < clusters.length; i++) {
		const cluster = clusters[i] ?? "";
		const clusterWidth = widths[i] ?? 1;
		const q = Math.abs(offset + clusterWidth / 2 - center);
		const u = q < waveWidth / 2
			? Math.cos((q / (waveWidth / 2)) * (Math.PI / 2)) * 0.7
			: 0;
		out += hex(lerpHex(base, SHIMMER_BRIGHT, u), cluster);
		offset += clusterWidth;
	}
	return out;
}

/** Shared tick source for other fusion surfaces (composer spinner). */
export function subscribeTicker(fn: () => void): () => void {
	return ticker.subscribe(fn);
}
export function tickerTick(): number {
	return ticker.tick;
}

/** Tool calls whose header is still animating (id → unsubscribe). */
const shimmerSubs = new Map<string, () => void>();
/**
 * Finished latches are session-local and bounded. A plain Set retained every
 * historical tool ID forever in long sessions (L4-06).
 */
class BoundedDoneIds {
	private readonly values = new Map<string, number>();
	constructor(private readonly max = 2048, private readonly ttlMs = 10 * 60_000) {}
	private prune(): void {
		const cutoff = Date.now() - this.ttlMs;
		for (const [id, timestamp] of this.values) {
			if (timestamp < cutoff) this.values.delete(id);
			else break;
		}
		while (this.values.size > this.max) {
			const first = this.values.keys().next().value as string | undefined;
			if (first === undefined) break;
			this.values.delete(first);
		}
	}
	add(id: string): void {
		this.values.delete(id);
		this.values.set(id, Date.now());
		this.prune();
	}
	has(id: string): boolean {
		this.prune();
		return this.values.has(id);
	}
	clear(): void {
		this.values.clear();
	}
}
const doneIds = new BoundedDoneIds();
export function resetDroidSession(): void {
	for (const unsubscribe of shimmerSubs.values()) unsubscribe();
	shimmerSubs.clear();
	doneIds.clear();
}

function finishShimmer(toolCallId: string): void {
	doneIds.add(toolCallId);
	shimmerSubs.get(toolCallId)?.();
	shimmerSubs.delete(toolCallId);
}

/** Stop every active shimmer (agent turn ended / aborted / shutdown). */
export function stopAllShimmers(): void {
	for (const [id, unsub] of shimmerSubs) {
		unsub();
		doneIds.add(id);
	}
	shimmerSubs.clear();
}

// ── shared line-based Component ──────────────────────────────────────────────
/** Card indent: droid `marginLeft: 3` on the tool row. */
const INDENT = "   ";
/** Result indent: card margin + `marginLeft: 1` on the result column. */
const R_INDENT = "    ";

function lineComponent(build: (width: number) => string[]): Component {
	return {
		render(width: number): string[] {
			const w = normalizeWidth(width);
			if (w === 0) return [""];
			const physical = build(w).flatMap((line) => line.replace(/\r\n?/g, "\n").split("\n"));
			return physical.map((line) => {
				const safe = sanitizeStyledLine(line);
				// At narrow widths, fixed card gutters would hide all semantic text.
				const compact = w <= 8 ? safe.replace(/^ +/, "") : safe;
				return fitLine(compact, w, "…");
			});
		},
		invalidate() {},
	};
}

/**
 * `   Read .../gateway/middleware.ts` — the droid header row. While the call
 * is pending/executing the name shimmers (droid `KgT` isPending branch:
 * bold wave over `uT.text.muted`); once finished it latches to bold solid
 * `uT.toolName`.
 */
function headerComponent(
	tool: string,
	args: Record<string, unknown>,
	ctx: { toolCallId: string; invalidate: () => void; isPartial: boolean },
): Component {
	const id = ctx.toolCallId;
	// A finalized result (isPartial=false) means the call is over — this covers
	// restored/resumed transcripts, where tool_execution_end never fires for
	// historical calls (doneIds alone would shimmer them forever).
	const finished = doneIds.has(id) || !ctx.isPartial;
	if (finished) finishShimmer(id);
	// ONE ticker subscription per tool call, kept for its whole lifetime.
	// renderCall re-runs on every invalidate — re-subscribing here would churn
	// the listener set from inside its own callback (the OOM loop). The first
	// ctx.invalidate stays valid: it targets the same ToolExecutionComponent.
	if (!finished && !shimmerSubs.has(id)) {
		const unsub = ticker.subscribe(() => {
			if (doneIds.has(id)) {
				finishShimmer(id);
				ctx.invalidate(); // draw the final solid frame
				return;
			}
			// Repaint at 10 fps — every render walks Pi's whole session buffer,
			// so 20 fps × N tools is real lag on long transcripts. The wave phase
			// derives from the tick counter, so the sweep still takes exactly 1 s.
			if (ticker.tick % 2 === 0) ctx.invalidate();
		});
		shimmerSubs.set(id, unsub);
	}
	return lineComponent(() => {
		const display = DISPLAY[tool] ?? tool;
		// renderCall re-runs (fresh ctx) whenever the result lands, so the
		// captured `finished` stays current; doneIds covers the in-between ticks.
		const name = finished || doneIds.has(id)
			? bold(hex(DROID.toolName, display))
			: bold(shimmerText(display, DROID.muted, ticker.tick));
		const label = headerLabel(tool, args);
		return [
			label ? `${INDENT}${name} ${hex(DROID.toolParam, label)}` : `${INDENT}${name}`,
		];
	});
}

// ── result rendering ─────────────────────────────────────────────────────────
type ResultLike = { content?: { type: string; text?: string }[]; details?: unknown };

function resultText(result: ResultLike): string {
	const content = Array.isArray(result.content) ? result.content : [];
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.flatMap((c) => sanitizeLines(c.text))
		.join("\n");
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.replace(/\n+$/, "").split("\n").length;
}

const plural = (n: number): string => (n === 1 ? "" : "s");

/** Verbatim droid `toolDisplay.*` result summaries. */
function summaryFor(tool: string, result: ResultLike, isError: boolean): string {
	const text = resultText(result);
	const n = lineCount(text);
	if (isError) {
		// Droid execute failures: "Command failed (exit code: {{code}})" / "Command failed".
		if (tool === "bash") {
			const m = text.match(/exit(?:ed)? ?(?:with )?code:? (\d+)/i);
			return m ? `Command failed (exit code: ${m[1]})` : "Command failed";
		}
		const first = text.split("\n")[0] ?? "";
		return first || "failed";
	}
	switch (tool) {
		case "read":
			return (result.content ?? []).some((c) => c.type === "image")
				? "Read image file successfully."
				: `Read ${n} line${plural(n)}.`;
		case "bash": {
			const m = text.match(/exit(?:ed)? ?(?:with )?code:? (\d+)/i);
			if (m && m[1] !== "0") return `Exit code ${m[1]} (${n} lines output)`;
			return `Success (${n} lines output)`;
		}
		case "edit":
			return "Succeeded. File edited.";
		case "write":
			return "Succeeded. File created.";
		case "grep":
			return `Found ${n} matches.`;
		case "find":
			return `Found ${n} files.`;
		case "ls":
			return `Listed ${n} items.`;
		default:
			return `Read ${n} line${plural(n)}.`;
	}
}

/** Droid diff colors over a display diff (edit tool `details.diff`). */
function colorizeDiffLine(line: string): string {
	const safe = sanitizeText(line);
	if (safe.startsWith("+")) return hex(DROID.diffAdded, safe);
	if (safe.startsWith("-")) return hex(DROID.diffRemoved, safe);
	if (safe.startsWith("@@")) return hex(DROID.diffHeader, safe);
	return hex(DROID.diffUnchanged, safe);
}

const COLLAPSED_DIFF_LINES = 10;
const COLLAPSED_OUTPUT_LINES = 5;
const MAX_CARD_LINES = 50;

function resultComponent(
	tool: string,
	result: ResultLike,
	expanded: boolean,
	isError: boolean,
): Component {
	return lineComponent(() => {
		const lines: string[] = [];
		const summary = summaryFor(tool, result, isError);
		const arrow = `${R_INDENT}${hex(DROID.muted, `↳ ${summary}`)}`;
		lines.push(isError ? `${arrow} ${hex(DROID.error, "(error)")}` : arrow);

		// Edit: droid renders the diff inline in the card.
		if (tool === "edit" && !isError) {
			const details = result.details as { diff?: unknown } | undefined;
			const rawDiff = details?.diff;
			const diff = typeof rawDiff === "string" ? rawDiff : "";
			if (diff) {
				const all = diff.replace(/\n+$/, "").split("\n");
				const shown = expanded ? all : all.slice(0, COLLAPSED_DIFF_LINES);
				for (const l of shown) lines.push(`${R_INDENT}${colorizeDiffLine(l)}`);
				const hidden = all.length - shown.length;
				if (hidden > 0)
					lines.push(
						`${R_INDENT}${hex(DROID.muted, `... ${hidden} more lines, press Ctrl+O to expand`)}`,
					);
			}
		}

		// Execute: droid shows the output tail with a `↳ showing last N/M lines` note.
		if (tool === "bash") {
			const all = resultText(result).replace(/\n+$/, "").split("\n").filter(
				(l, i, a) => !(a.length === 1 && l === ""),
			);
			if (all.length > 0 && all[0] !== "") {
				const shown = expanded ? all : all.slice(-COLLAPSED_OUTPUT_LINES);
				if (!expanded && all.length > shown.length)
					lines.push(
						`${R_INDENT}${hex(DROID.muted, `↳ showing last ${shown.length}/${all.length} lines`)}`,
					);
				for (const l of shown)
					lines.push(`${R_INDENT}${hex(isError ? DROID.error : DROID.muted, l)}`);
			}
		}

		return boundedLines(
			lines,
			MAX_CARD_LINES,
			(hidden) => `${R_INDENT}${hex(DROID.muted, `... ${hidden} more lines, press Ctrl+O to expand`)}`,
		);
	});
}

// ── tool overrides ───────────────────────────────────────────────────────────
type AnyToolDef = ToolDefinition<any, any, any>;

/** Marker so the global impersonation patch keeps OUR renderers active. */
const DROID_RENDERER = Symbol.for("fusiontui.droidRenderer");

function markDroid<T>(fn: T): T {
	(fn as unknown as Record<symbol, boolean>)[DROID_RENDERER] = true;
	return fn;
}

function isDroidRenderer(fn: unknown): boolean {
	return (
		typeof fn === "function" &&
		(fn as unknown as Record<symbol, boolean>)[DROID_RENDERER] === true
	);
}

function skinned(base: AnyToolDef, tool: string): AnyToolDef {
	return {
		...base,
		renderShell: "self",
		renderCall: markDroid(
			(
				args: unknown,
				_theme: unknown,
				ctx: { toolCallId: string; invalidate: () => void; isPartial: boolean },
			) => headerComponent(tool, (args ?? {}) as Record<string, unknown>, ctx),
		),
		renderResult: markDroid(
			(
				result: unknown,
				options: { expanded: boolean },
				_theme: unknown,
				ctx: { isError: boolean },
			) => resultComponent(tool, result as ResultLike, options.expanded, ctx.isError),
		),
	};
}

/**
 * Register droid-skinned overrides of Pi's built-in tools. Execution delegates
 * to the genuine built-in definitions; only the card visuals change.
 *
 * Must be called AFTER load (e.g. session_start): Pi's resource loader treats
 * same-name tools across extensions as a load-time conflict, so names already
 * owned by another extension (pi-diff's edit/write, pi-fff's grep/find, …)
 * are skipped — that extension keeps its rendering. Returns the skipped names.
 */
export function installDroidTools(
	pi: ExtensionAPI,
	cwd: string,
	ownedByOthers: ReadonlySet<string>,
): string[] {
	const bases: [string, AnyToolDef][] = [
		["read", createReadToolDefinition(cwd) as AnyToolDef],
		["bash", createBashToolDefinition(cwd) as AnyToolDef],
		["edit", createEditToolDefinition(cwd) as AnyToolDef],
		["write", createWriteToolDefinition(cwd) as AnyToolDef],
		["grep", createGrepToolDefinition(cwd) as AnyToolDef],
		["find", createFindToolDefinition(cwd) as AnyToolDef],
		["ls", createLsToolDefinition(cwd) as AnyToolDef],
	];
	const skipped: string[] = [];
	for (const [tool, base] of bases) {
		if (ownedByOthers.has(tool)) {
			skipped.push(tool);
			continue;
		}
		pi.registerTool(skinned(base, tool));
	}
	return skipped;
}

// ── generic droid cards for ALL other tools (MCP/extension tools) ──────────
// Tools we can't re-register (owned by other extensions / MCP servers) render
// through ToolExecutionComponent's fallback path: bold name inside a colored
// Box. Patch the prototype so every tool gets the deliberate global Droid card;
// custom renderers are intentionally normalized rather than allowed to diverge.

/** Droid `UAT`: `server___tool` → `SERVER: tool`; otherwise the raw name. */
function genericDisplayName(name: string): string {
	const safeName = sanitizeScalar(name);
	if (safeName.includes("___")) {
		const [server, ...rest] = safeName.split("___");
		const tool = rest.join("___");
		if (server && tool) return `${server.toUpperCase()}: ${tool}`;
	}
	return safeName || "Tool";
}

/** Pick a droid-style header label out of arbitrary tool args. */
function genericLabel(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const rec = args as Record<string, unknown>;
	for (const key of [
		"path",
		"file_path",
		"filePath",
		"command",
		"pattern",
		"query",
		"url",
		"name",
		"action",
		"description",
		"prompt",
	]) {
		const v = rec[key];
		if (typeof v === "string" && v.length > 0) {
			const first = sanitizeScalar(v.split("\n")[0]);
			return key.toLowerCase().includes("path") ? shortPath(first) : first;
		}
	}
	try {
		const json = JSON.stringify(rec);
		return json && json !== "{}" ? sanitizeScalar(json) : "";
	} catch {
		return "";
	}
}

type ToolExecLike = {
	toolName: string;
	toolCallId: string;
	args: unknown;
	result?: {
		content: { type: string; text?: string }[];
		isError?: boolean;
		details?: unknown;
	};
	expanded: boolean;
	isPartial?: boolean;
	ui: { requestRender(): void };
	invalidate(): void;
};

/** Subagent details shape streamed by agent tools (pi-subagents). */
type AgentDetailsLike = {
	status?: string;
	activity?: string;
	modelName?: string;
	toolUses?: number;
	tokens?: string;
	turnCount?: number;
	durationMs?: number;
	agentId?: string;
};

const isAgentDetails = (d: unknown): d is AgentDetailsLike =>
	typeof d === "object" &&
	d !== null &&
	("toolUses" in d || "activity" in d || "agentId" in d);

const formatDuration = (ms: number): string => {
	const s = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${s % 60 > 0 ? `${s % 60}s` : ""}`;
};

/** Droid Task-style summary (`toolDisplay.task`): running → activity + stats; done → "Task completed". */
function agentSummary(d: AgentDetailsLike, isPartial: boolean): string {
	const stats: string[] = [];
	const modelName = sanitizeScalar(d.modelName);
	const tokens = sanitizeScalar(d.tokens);
	const status = sanitizeScalar(d.status);
	const activity = sanitizeScalar(d.activity);
	const agentId = sanitizeScalar(d.agentId);
	if (modelName) stats.push(modelName);
	if (typeof d.toolUses === "number" && Number.isFinite(d.toolUses) && d.toolUses > 0)
		stats.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
	if (tokens) stats.push(tokens);
	if (status === "background")
		return `Running in background${agentId ? ` (ID: ${agentId})` : ""}`;
	if (isPartial || status === "running") {
		const head = activity || "Running task";
		return stats.length ? `${head} · ${stats.join(" · ")}` : head;
	}
	if (typeof d.durationMs === "number")
		stats.push(formatDuration(d.durationMs));
	const head = status === "failed" ? "Task failed" : "Task completed";
	return stats.length ? `${head} · ${stats.join(" · ")}` : head;
}

/** Droid header for an arbitrary tool (shimmer while running, solid when done). */
function genericHeaderComponent(comp: ToolExecLike): Component {
	const id = comp.toolCallId;
	// A stored result means the call is over — restored transcripts never fire
	// tool_execution_end, so without this every historical card would subscribe
	// and repaint the whole session at 10 fps until the next agent_end.
	if (comp.result !== undefined) finishShimmer(id);
	if (!doneIds.has(id) && comp.result === undefined && !shimmerSubs.has(id)) {
		const unsub = ticker.subscribe(() => {
			if (doneIds.has(id)) {
				finishShimmer(id);
				comp.invalidate();
				comp.ui.requestRender();
				return;
			}
			if (ticker.tick % 2 === 0) {
				comp.invalidate();
				comp.ui.requestRender();
			}
		});
		shimmerSubs.set(id, unsub);
	}
	return lineComponent(() => {
		const display = genericDisplayName(comp.toolName);
		const done = doneIds.has(id) || comp.result !== undefined;
		const name = done
			? bold(hex(DROID.toolName, display))
			: bold(shimmerText(display, DROID.muted, ticker.tick));
		const label = genericLabel(comp.args);
		return [
			label ? `${INDENT}${name} ${hex(DROID.toolParam, label)}` : `${INDENT}${name}`,
		];
	});
}

/** Droid result for an arbitrary tool: `↳ summary`, full output when expanded. */
function genericResultComponent(comp: ToolExecLike): Component {
	return lineComponent(() => {
		const result = comp.result;
		if (!result) return [];
		// Droid renders TodoWrite as a single subtle line (toolDisplay.todoWrite).
		if (/todo/i.test(comp.toolName))
			return [`${R_INDENT}${hex(DROID.muted, "↳ Todos updated")}`];
		// Agent/Task tools stream rich details — droid's task display shows the
		// live activity + stats and a "Task completed" summary (toolDisplay.task).
		if (isAgentDetails(result.details)) {
			const summary = agentSummary(result.details, comp.isPartial === true);
			const lines = [`${R_INDENT}${hex(DROID.muted, `↳ ${summary}`)}`];
			if (comp.expanded) {
				const text = resultText(result as ResultLike).replace(/\n+$/, "");
				for (const l of text ? text.split("\n") : [])
					lines.push(`${R_INDENT}${hex(DROID.muted, l)}`);
			}
			return boundedLines(
				lines,
				MAX_CARD_LINES,
				(hidden) => `${R_INDENT}${hex(DROID.muted, `... ${hidden} more lines, press Ctrl+O to expand`)}`,
			);
		}
		const isError = result.isError ?? false;
		const text = resultText(result as ResultLike).replace(/\n+$/, "");
		const all = text ? text.split("\n") : [];
		const first = all[0] ?? "";
		const summary = isError
			? first || "failed"
			: all.length > 1
				? `${all.length} lines`
				: first || "Done";
		const lines: string[] = [];
		const arrow = `${R_INDENT}${hex(DROID.muted, `↳ ${summary}`)}`;
		lines.push(isError ? `${arrow} ${hex(DROID.error, "(error)")}` : arrow);
		// Edit-style tools carrying a display diff get droid diff colors.
		const details = (comp.result as { details?: { diff?: unknown } } | undefined)
			?.details;
		const diff = typeof details?.diff === "string" ? details.diff : undefined;
		if (diff && !isError) {
			const dl = sanitizeLines(diff).filter((line, index, all) => !(all.length === 1 && !line));
			const shown = comp.expanded ? dl : dl.slice(0, COLLAPSED_DIFF_LINES);
			for (const l of shown) lines.push(`${R_INDENT}${colorizeDiffLine(l)}`);
			const hidden = dl.length - shown.length;
			if (hidden > 0)
				lines.push(
					`${R_INDENT}${hex(DROID.muted, `... ${hidden} more lines, press Ctrl+O to expand`)}`,
				);
		} else if (comp.expanded) {
			for (const l of all)
				lines.push(`${R_INDENT}${hex(isError ? DROID.error : DROID.muted, l)}`);
		}
		return boundedLines(
			lines,
			MAX_CARD_LINES,
			(hidden) => `${R_INDENT}${hex(DROID.muted, `... ${hidden} more lines, press Ctrl+O to expand`)}`,
		);
	});
}

type ToolExecProto = {
	getRenderShell(): string;
	getCallRenderer(): unknown;
	getResultRenderer(): unknown;
	createCallFallback(): Component;
	createResultFallback(): Component | undefined;
};

let originalShell: (() => string) | undefined;
let originalGetCall: (() => unknown) | undefined;
let originalGetResult: (() => unknown) | undefined;
let originalCallFallback: (() => Component) | undefined;
let originalResultFallback: (() => Component | undefined) | undefined;
let installedShell: (() => string) | undefined;
let installedGetCall: (() => unknown) | undefined;
let installedGetResult: (() => unknown) | undefined;
let installedCallFallback: (() => Component) | undefined;
let installedResultFallback: (() => Component | undefined) | undefined;

export function patchToolFallbacks(): void {
	if (installedShell) return;
	const proto = ToolExecutionComponent.prototype as unknown as ToolExecProto;
	if (
		typeof proto.getRenderShell !== "function" ||
		typeof proto.getCallRenderer !== "function" ||
		typeof proto.getResultRenderer !== "function" ||
		typeof proto.createCallFallback !== "function" ||
		typeof proto.createResultFallback !== "function"
	) return;
	// Impersonation: EVERY tool renders as a droid card. Renderers that are not
	// ours (todo, Agent, pi-diff, MCP…) are deliberately suppressed so the droid
	// fallbacks take over — execution remains owned by the original tool.
	originalGetCall = proto.getCallRenderer;
	const origGetCall = originalGetCall;
	installedGetCall = function (this: ToolExecProto): unknown {
		const r = origGetCall.call(this);
		return isDroidRenderer(r) ? r : undefined;
	};
	proto.getCallRenderer = installedGetCall;
	originalGetResult = proto.getResultRenderer;
	const origGetResult = originalGetResult;
	installedGetResult = function (this: ToolExecProto): unknown {
		const r = origGetResult.call(this);
		return isDroidRenderer(r) ? r : undefined;
	};
	proto.getResultRenderer = installedGetResult;
	originalShell = proto.getRenderShell;
	// Everything renders in the plain "self" container (no colored Box).
	installedShell = function (this: ToolExecProto): string {
		return "self";
	};
	proto.getRenderShell = installedShell;
	originalCallFallback = proto.createCallFallback;
	installedCallFallback = function (this: unknown): Component {
		return genericHeaderComponent(this as ToolExecLike);
	};
	proto.createCallFallback = installedCallFallback;
	originalResultFallback = proto.createResultFallback;
	installedResultFallback = function (this: unknown): Component | undefined {
		return genericResultComponent(this as ToolExecLike);
	};
	proto.createResultFallback = installedResultFallback;
}

export function unpatchToolFallbacks(): void {
	if (!installedShell) return;
	const proto = ToolExecutionComponent.prototype as unknown as ToolExecProto;
	// Restore only slots still owned by Fusion; preserve later patches from other
	// extensions (L4-05).
	if (proto.getRenderShell === installedShell && originalShell) proto.getRenderShell = originalShell;
	if (proto.getCallRenderer === installedGetCall && originalGetCall) proto.getCallRenderer = originalGetCall as never;
	if (proto.getResultRenderer === installedGetResult && originalGetResult) proto.getResultRenderer = originalGetResult as never;
	if (proto.createCallFallback === installedCallFallback && originalCallFallback) proto.createCallFallback = originalCallFallback;
	if (proto.createResultFallback === installedResultFallback && originalResultFallback) proto.createResultFallback = originalResultFallback;
	originalShell = undefined;
	originalGetCall = undefined;
	originalGetResult = undefined;
	originalCallFallback = undefined;
	originalResultFallback = undefined;
	installedShell = undefined;
	installedGetCall = undefined;
	installedGetResult = undefined;
	installedCallFallback = undefined;
	installedResultFallback = undefined;
}

// ── assistant icon (droid `XkH`: `⛬` bold uT.primary, 2-col gutter) ─────────
const AGENT_ICON = "\u26EC"; // ⛬
/** Droid `ayH` @426958 — the interrupted marker, verbatim (U+23BF). */
const INTERRUPTED = "\u23BF Interrupted";
const NOTICE_ICON = "\u25CF"; // ● — droid system/error notice bullet (XkH)

let originalRender:
	| ((this: AssistantMessageComponent, width: number) => string[])
	| undefined;
let installedAssistantRender:
	| ((this: AssistantMessageComponent, width: number) => string[])
	| undefined;

export function patchAssistantIcon(): void {
	if (originalRender) return;
	const proto = AssistantMessageComponent.prototype as unknown as {
		render(width: number): string[];
	};
	if (typeof proto.render !== "function") return;
	originalRender = proto.render;
	const orig = originalRender;
	// Droid gutter: icon column (1) + marginRight 1.5 (Yoga → 2) puts content at
	// column 3. Pi's assistant markdown already carries paddingX 1, so the icon
	// plus ONE space lands the text at column 3 exactly (⛬ · pad · text).
	//
	// The icon marks the assistant's MESSAGE TEXT only (droid `XkH` renders ⛬
	// before assistant markdown). Thinking content — Pi's hidden-thinking label
	// ("Thinking..."/custom) and visible thinking blocks — renders fully italic
	// (`theme.italic(...)`), which droid shows dim with NO icon. Skip any line
	// that OPENS in italic so ⛬ lands on the first real text line instead.
	// OSC sequences (hyperlinks, OSC 133 shell-integration zone markers) are
	// invisible — strip them before testing. Pi prepends `\x1b]133;B\x07\x1b]133;C\x07`
	// to the LAST line of a streaming message; while only the thinking label has
	// arrived, that label IS the last line, so the markers sit between the line
	// start and the italic SGR. The old prefix-ordered regex missed that layout
	// and dropped the ⛬ icon onto the thinking line ("tempering…" bug).
	const OSC_SEQ = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
	const opensItalic = (line: string): boolean =>
		/^(?:\s|\x1b\[[0-9;]*m)*\x1b\[3m/.test(line.replace(OSC_SEQ, ""));
	installedAssistantRender = function (width: number): string[] {
		const w = normalizeWidth(width);
		const inner = orig.call(this as unknown as AssistantMessageComponent, Math.max(1, w - 2));
		let iconPlaced = false;
		return inner.map((line) => {
			const plain = stripCtl(line).trim();
			// Droid abort marker: `⎿ Interrupted` in uT.text.muted (droid `ayH`),
			// replacing Pi's error-colored "Operation aborted".
			if (plain === "Operation aborted" || /^Aborted after \d+ retry/.test(plain)) {
				return fitLine(sanitizeStyledLine(` ${hex(DROID.muted, INTERRUPTED)}`), w, "");
			}
			// Droid error notices carry a `●` bullet in uT.error (XkH role=error).
			if (plain.startsWith("Error: ")) {
				return fitLine(sanitizeStyledLine(`${hex(DROID.error, NOTICE_ICON)} ${hex(DROID.error, plain)}`), w, "");
			}
			if (!iconPlaced && plain.length > 0 && !opensItalic(line)) {
				iconPlaced = true;
				// Keep any leading OSC markers (OSC 133 zones) at the line start so
				// terminal shell integration still sees them first.
				const osc = line.match(/^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*/)?.[0] ?? "";
				return fitLine(sanitizeStyledLine(`${osc}${bold(hex(DROID.primary, AGENT_ICON))} ${line.slice(osc.length)}`), w, "");
			}
			return fitLine(sanitizeStyledLine(line.length > 0 ? `  ${line}` : line), w, "");
		});
	};
	proto.render = installedAssistantRender;
}

export function unpatchAssistantIcon(): void {
	if (!originalRender || !installedAssistantRender) return;
	const proto = AssistantMessageComponent.prototype as unknown as {
		render(width: number): string[];
	};
	if (proto.render === installedAssistantRender) proto.render = originalRender;
	originalRender = undefined;
	installedAssistantRender = undefined;
}

// ── user message gutter (droid `XkH` user branch, traced @589840) ──────────
// Droid renders user prompts as a 1-column `uT.text.userSymbol` (#d75f00)
// gutter bar + a `uT.text.userBg` (#262626) block with paddingLeft 2.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function bg(color: string, text: string): string {
	const ansi = ansiFor(color, true);
	return ansi ? `${ansi}${text}${ANSI_RESET_BG}` : text;
}

const stripCtl = (s: string): string =>
	s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

let originalUserRender:
	| ((this: UserMessageComponent, width: number) => string[])
	| undefined;
let installedUserRender:
	| ((this: UserMessageComponent, width: number) => string[])
	| undefined;

export function patchUserGutter(): void {
	if (originalUserRender) return;
	const proto = UserMessageComponent.prototype as unknown as {
		render(width: number): string[];
	};
	if (typeof proto.render !== "function") return;
	originalUserRender = proto.render;
	installedUserRender = function (width: number): string[] {
		const w = normalizeWidth(width);
		const self = this as unknown as {
			contentBox?: { setBgFn?: (fn: (c: string) => string) => void };
			__droidBg?: boolean;
		};
		// Repaint Pi's user block with droid's userBg once per component.
		if (!self.__droidBg && self.contentBox?.setBgFn) {
			self.contentBox.setBgFn((c) => bg(DROID.userBg, c));
			self.__droidBg = true;
		}
		// Raw box lines (skip the subclass render — it only adds OSC 133 marks).
		const raw: string[] = (
			Container.prototype.render as (this: unknown, w: number) => string[]
		).call(this, Math.max(1, w - 2));
		// Droid has no vertical padding on the user block — drop blank bg rows.
		while (raw.length && stripCtl(raw[0]).trim() === "") raw.shift();
		while (raw.length && stripCtl(raw[raw.length - 1]).trim() === "") raw.pop();
		const bar = bg(DROID.userSymbol, " ");
		const pad = bg(DROID.userBg, " ");
		const out = raw.map((l) => sanitizeStyledLine(`${bar}${pad}${l}`));
		if (out.length > 0) {
			out[0] = OSC133_ZONE_START + out[0];
			out[out.length - 1] =
				OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
		}
		return out.map((line) => fitLine(line, w, ""));
	};
	proto.render = installedUserRender;
}

export function unpatchUserGutter(): void {
	if (!originalUserRender || !installedUserRender) return;
	const proto = UserMessageComponent.prototype as unknown as {
		render(width: number): string[];
	};
	if (proto.render === installedUserRender) proto.render = originalUserRender;
	originalUserRender = undefined;
	installedUserRender = undefined;
}
