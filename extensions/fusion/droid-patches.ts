import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import { ANSI_RESET_BG, DROID, ansiFor, bold, hex } from "./droid-palette";
import {
	genericHeaderComponent,
	genericResultComponent,
	isDroidRenderer,
	renderDroidTool,
	type ToolExecLike,
} from "./droid-cards";
import { fitLine, normalizeWidth, sanitizeStyledLine } from "./render-safe";

type ToolExecProto = {
	render(width: number): string[];
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
let originalToolRender: ((width: number) => string[]) | undefined;
let installedToolRender: ((width: number) => string[]) | undefined;


export function patchToolFallbacks(): void {
	const proto = ToolExecutionComponent.prototype as unknown as ToolExecProto;
	if (installedShell) {
		// A later-loaded extension may replace the prototype after session_start;
		// Fusion owns transcript presentation, so reclaim only our known slots.
		if (proto.getRenderShell !== installedShell) proto.getRenderShell = installedShell;
		if (proto.getCallRenderer !== installedGetCall && installedGetCall)
			proto.getCallRenderer = installedGetCall;
		if (proto.getResultRenderer !== installedGetResult && installedGetResult)
			proto.getResultRenderer = installedGetResult;
		if (proto.createCallFallback !== installedCallFallback && installedCallFallback)
			proto.createCallFallback = installedCallFallback;
		if (proto.createResultFallback !== installedResultFallback && installedResultFallback)
			proto.createResultFallback = installedResultFallback;
		if (proto.render !== installedToolRender && installedToolRender)
			proto.render = installedToolRender;
		return;
	}
	if (
		typeof proto.render !== "function" ||
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
	originalToolRender = proto.render;
	installedToolRender = function (this: ToolExecLike, width: number): string[] {
		return renderDroidTool(this, width);
	};
	proto.render = installedToolRender;
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
	if (proto.render === installedToolRender && originalToolRender) proto.render = originalToolRender;
	originalToolRender = undefined;
	installedToolRender = undefined;
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
