import { visibleWidth } from "@earendil-works/pi-tui";
import { hex } from "./droid-palette";

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
				for (const l of Array.from(this.listeners)) l();
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
export function shimmerText(text: string, baseColor: string, tick: number): string {
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

export function finishShimmer(toolCallId: string): void {
	doneIds.add(toolCallId);
	shimmerSubs.get(toolCallId)?.();
	shimmerSubs.delete(toolCallId);
}

/** Has this tool call already been latched as finished? */
export function isToolFinished(toolCallId: string): boolean {
	return doneIds.has(toolCallId);
}

/**
 * Attach ONE repaint loop to an animating tool call.
 *
 * Both card renderers (`headerComponent` and `genericHeaderComponent`) re-run
 * on every invalidate, so subscribing inline would churn the listener set from
 * inside its own callback — the OOM loop. This is a no-op when the call is
 * already finished or already subscribed, and it self-unsubscribes as soon as
 * the call latches done.
 *
 * `repaint` fires at 10 fps, not the ticker's 20: every render walks Pi's whole
 * session buffer, so 20 fps x N tools is real lag on long transcripts. The wave
 * phase derives from the tick counter, so the sweep still takes exactly 1 s.
 */
export function ensureShimmerRepaint(toolCallId: string, repaint: () => void): void {
	if (doneIds.has(toolCallId) || shimmerSubs.has(toolCallId)) return;
	const unsub = ticker.subscribe(() => {
		if (doneIds.has(toolCallId)) {
			finishShimmer(toolCallId);
			repaint(); // draw the final solid frame
			return;
		}
		if (ticker.tick % 2 === 0) repaint();
	});
	shimmerSubs.set(toolCallId, unsub);
}

/** Stop every active shimmer (agent turn ended / aborted / shutdown). */
export function stopAllShimmers(): void {
	for (const [id, unsub] of shimmerSubs) {
		unsub();
		doneIds.add(id);
	}
	shimmerSubs.clear();
}
