import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Aggregated token/cost usage for the current session branch. */
export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

/** 1234 -> "1.2k", 1_500_000 -> "1.5M" */
export function formatCount(value: number): string {
	if (value < 1000) return value.toString();
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

/** "claude-opus-4-8" -> "Opus 4.8", "grok-composer-2.5-fast" -> "Composer 2.5 Fast" */
export function prettyModel(id: string | undefined): string {
	if (!id) return "no-model";
	const base = id.split("/").pop() ?? id;
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

/** "high" -> "High", "xhigh" -> "XHigh", "off" -> "" */
export function prettyEffort(level: string | undefined): string {
	if (!level || level === "off") return "";
	if (level === "xhigh") return "XHigh";
	return level.charAt(0).toUpperCase() + level.slice(1);
}

/** Sum tokens + cost over every assistant message in the active branch. */
export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = (entry.message as AssistantMessage).usage;
		totals.input += usage?.input ?? 0;
		totals.output += usage?.output ?? 0;
		totals.cacheRead += usage?.cacheRead ?? 0;
		totals.cacheWrite += usage?.cacheWrite ?? 0;
		totals.cost += usage?.cost?.total ?? 0;
	}
	return totals;
}

/** "42%/200k" describing context-window pressure. */
export function buildContextLabel(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const window = ctx.model?.contextWindow ?? usage?.contextWindow;
	if (!usage || !window || window <= 0) return "--";
	const percent =
		usage.percent === null ? "?" : `${Math.max(0, Math.min(999, Math.round(usage.percent)))}%`;
	return `${percent}/${formatCount(window)}`;
}

/** Context fill 0-100, or null when unknown. */
export function contextPercent(ctx: ExtensionContext): number | null {
	const usage = ctx.getContextUsage();
	return usage?.percent ?? null;
}

/** Last path segment of a directory, with "~" applied. */
export function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	let p = cwd;
	if (home && p.startsWith(home)) p = `~${p.slice(home.length)}`;
	const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

/** Future date -> "2h13m" / "4d6h" / "now". */
export function formatResetIn(date: Date): string {
	const ms = date.getTime() - Date.now();
	if (ms <= 0) return "now";
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	const rmins = mins % 60;
	if (hours < 24) return rmins > 0 ? `${hours}h${rmins}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const rhours = hours % 24;
	return rhours > 0 ? `${days}d${rhours}h` : `${days}d`;
}
