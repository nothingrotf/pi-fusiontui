import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { DROID, bold, hex } from "./droid-palette";
import { DISPLAY, headerLabel, shortPath } from "./droid-labels";
import {
	ensureShimmerRepaint,
	finishShimmer,
	isToolFinished,
	shimmerText,
	tickerTick,
} from "./droid-shimmer";
import {
	boundedLines,
	fitLine,
	normalizeWidth,
	sanitizeLines,
	sanitizeScalar,
	sanitizeStyledLine,
	sanitizeText,
} from "./render-safe";

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
	const finished = isToolFinished(id) || !ctx.isPartial;
	if (finished) finishShimmer(id);
	// The first ctx.invalidate stays valid: it targets the same
	// ToolExecutionComponent for the whole call.
	if (!finished) ensureShimmerRepaint(id, () => ctx.invalidate());
	return lineComponent(() => {
		const display = DISPLAY[tool] ?? tool;
		// renderCall re-runs (fresh ctx) whenever the result lands, so the
		// captured `finished` stays current; the latch covers the in-between ticks.
		const name = finished || isToolFinished(id)
			? bold(hex(DROID.toolName, display))
			: bold(shimmerText(display, DROID.muted, tickerTick()));
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

export function isDroidRenderer(fn: unknown): boolean {
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
	const builtin = DISPLAY[safeName.toLowerCase()];
	if (builtin) return builtin;
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

export type ToolExecLike = {
	toolName: string;
	toolCallId: string;
	args: unknown;
	result?: {
		content: { type: string; text?: string }[];
		isError?: boolean;
		details?: unknown;
	};
	expanded: boolean;
	isPartial: boolean;
	hideComponent?: boolean;
	imageComponents?: Component[];
	imageSpacers?: Component[];
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
export function genericHeaderComponent(comp: ToolExecLike): Component {
	const builtin = DISPLAY[comp.toolName.toLowerCase()];
	if (builtin) {
		return headerComponent(
			comp.toolName.toLowerCase(),
			(comp.args ?? {}) as Record<string, unknown>,
			comp,
		);
	}
	const id = comp.toolCallId;
	// A stored result means the call is over — restored transcripts never fire
	// tool_execution_end, so without this every historical card would subscribe
	// and repaint the whole session at 10 fps until the next agent_end.
	if (comp.result !== undefined) finishShimmer(id);
	if (comp.result === undefined)
		ensureShimmerRepaint(id, () => {
			comp.invalidate();
			comp.ui.requestRender();
		});
	return lineComponent(() => {
		const display = genericDisplayName(comp.toolName);
		const done = isToolFinished(id) || comp.result !== undefined;
		const name = done
			? bold(hex(DROID.toolName, display))
			: bold(shimmerText(display, DROID.muted, tickerTick()));
		const label = genericLabel(comp.args);
		return [
			label ? `${INDENT}${name} ${hex(DROID.toolParam, label)}` : `${INDENT}${name}`,
		];
	});
}

/** Droid result for an arbitrary tool: `↳ summary`, full output when expanded. */
export function genericResultComponent(comp: ToolExecLike): Component {
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
		const summary = DISPLAY[comp.toolName.toLowerCase()]
			? summaryFor(comp.toolName.toLowerCase(), result as ResultLike, isError)
			: isError
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

/**
 * Render at the component boundary, not only through tool-definition hooks.
 * Pi's fallback shell is a colored Box and can win when another extension owns
 * the same tool or patches the renderer after Fusion. Bypassing that shell is
 * what makes the Droid surface an invariant for Edit and every other tool.
 */
export function renderDroidTool(comp: ToolExecLike, width: number): string[] {
	if (comp.hideComponent) return [];
	const lines = [""];
	const header = genericHeaderComponent(comp);
	lines.push(...header.render(width));
	if (comp.result) {
		const result = DISPLAY[comp.toolName.toLowerCase()]
			? resultComponent(
					comp.toolName.toLowerCase(),
					comp.result,
					comp.expanded,
					comp.result.isError === true,
				)
			: genericResultComponent(comp);
		lines.push(...result.render(width));
	}
	for (let i = 0; i < (comp.imageComponents?.length ?? 0); i++) {
		const spacer = comp.imageSpacers?.[i];
		if (spacer) lines.push(...spacer.render(width));
		const image = comp.imageComponents?.[i];
		if (image) lines.push(...image.render(width));
	}
	return lines;
}
