import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeScalar } from "./render-safe";

/** Aggregated token/cost usage for the current session branch. */
export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

/** 1234 -> "1.2k", 1_500_000 -> "1.5M". Non-finite/negative -> "--" (L2-04). */
export function formatCount(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "--";
	if (value < 1000) return Math.round(value).toString();
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

/** "claude-opus-4-8" -> "Opus 4.8", "grok-composer-2.5-fast" -> "Composer 2.5 Fast" */
export function prettyModel(id: string | undefined): string {
	const safeId = sanitizeScalar(id);
	if (!safeId) return "no-model";
	const base = safeId.split("/").pop() ?? safeId;
	const stripped = base.replace(/^(claude|grok|gpt|gemini|openai)-/i, "");
	const words = stripped.split("-").filter(Boolean);
	const merged: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		// Merge bare number groups into dotted versions: "4","8" -> "4.8"
		if (/^\d+$/.test(w) && merged.length && /\d$/.test(merged[merged.length - 1])) {
			merged[merged.length - 1] = `${merged[merged.length - 1]}.${w}`;
		} else {
			merged.push(w);
		}
	}
	return merged
		.map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
		.join(" ");
}

/** "high" -> "High", "xhigh" -> "XHigh", "max" -> "Max", "off" -> "" */
export function prettyEffort(level: string | undefined): string {
	const safeLevel = sanitizeScalar(level).toLowerCase();
	if (!safeLevel || safeLevel === "off") return "";
	if (safeLevel === "xhigh") return "XHigh";
	if (safeLevel === "max") return "Max";
	return safeLevel.charAt(0).toUpperCase() + safeLevel.slice(1);
}

/** Sum tokens + cost over every assistant message in the active branch. */
export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const finite = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = (entry.message as AssistantMessage).usage;
		totals.input += finite(usage?.input);
		totals.output += finite(usage?.output);
		totals.cacheRead += finite(usage?.cacheRead);
		totals.cacheWrite += finite(usage?.cacheWrite);
		totals.cost += finite(usage?.cost?.total);
	}
	return totals;
}

/** "42%/200k" describing context-window pressure. */
export function buildContextLabel(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const window = ctx.model?.contextWindow ?? usage?.contextWindow;
	if (!usage || typeof window !== "number" || !Number.isFinite(window) || window <= 0) return "--";
	// L2-04: non-finite percent must never surface as "NaN%".
	const percent =
		usage.percent === null || !Number.isFinite(usage.percent)
			? "?"
			: `${Math.max(0, Math.min(999, Math.round(usage.percent)))}%`;
	return `${percent}/${formatCount(window)}`;
}

/** Context fill 0-100, or null when unknown/invalid (L2-04). */
export function contextPercent(ctx: ExtensionContext): number | null {
	const usage = ctx.getContextUsage();
	const percent = usage?.percent ?? null;
	return percent !== null && Number.isFinite(percent) ? percent : null;
}

/**
 * Abbreviated directory for the footer (L2-01): home is replaced with "~"
 * only at a segment boundary (never for siblings like /home/alice2), and the
 * last two path segments are preserved for context. Width truncation stays
 * in the layout layer (`justify`).
 */
export function formatCwd(cwd: string): string {
	if (typeof cwd !== "string" || cwd.length === 0) return "--";
	const home = (process.env.HOME || process.env.USERPROFILE || "").replace(/[\\/]+$/, "");
	let p = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const h = home.replace(/\\/g, "/");
	if (h && (p === h || p.startsWith(`${h}/`))) p = `~${p.slice(h.length)}`;
	const parts = p.split("/").filter(Boolean);
	if (parts.length === 0) return p || "/";
	const rooted = parts[0] === "~";
	// Short paths render fully; deeper ones keep the last two segments.
	if (parts.length <= (rooted ? 3 : 2)) return rooted ? parts.join("/") : `/${parts.join("/")}`;
	const tail = parts.slice(-2).join("/");
	return rooted ? `~/…/${tail}` : `…/${tail}`;
}

/** Future date -> "2h13m" / "4d6h" / "now". Invalid dates -> "now" (L2-04). */
export function formatResetIn(date: Date): string {
	const timestamp = date instanceof Date ? date.getTime() : Number.NaN;
	const ms = timestamp - Date.now();
	if (!Number.isFinite(ms) || ms <= 0) return "now";
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	const rmins = mins % 60;
	if (hours < 24) return rmins > 0 ? `${hours}h${rmins}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const rhours = hours % 24;
	return rhours > 0 ? `${days}d${rhours}h` : `${days}d`;
}
