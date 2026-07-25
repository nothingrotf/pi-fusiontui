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
 * definitions (exported from the package root). The component render seam is
 * also guarded so a competing definition cannot restore Pi's colored Box. The
 * assistant icon patches
 * `AssistantMessageComponent.prototype.render` (same module instance as the
 * running app) and is restored on shutdown.
 *
 * The executing tool name animates with Droid's shimmer wave — an exact port
 * of `Cg1`/`yt9` (@480964/@481111): a shared 50 ms ticker, period `hD0 = 20`
 * ticks, wave width `max(3, ⌊len × 0.6⌋)`, cosine falloff × 0.7, lerping the
 * theme's muted base toward rgb(230,230,230), bold. Frames redraw via the render
 * context's `invalidate()`; the ticker is ref-counted and self-stops.
 *
 * This module is the stable import surface for the skin. The implementation is
 * split by concern so each part can be read (and tested) on its own:
 *   - droid-palette.ts  color resolution: theme -> DROID hex -> ANSI per mode
 *   - droid-labels.ts   tool display names and header labels (pure strings)
 *   - droid-shimmer.ts  the 50 ms ticker, the shimmer wave, done-id latching
 *   - droid-cards.ts    the tool card components and the tool overrides
 *   - droid-patches.ts  the monkey-patches over pi-tui component prototypes
 */
export {
	DROID,
	type DroidPalette,
	hex,
	setPaletteThemeProvider,
	syncPalette,
} from "./droid-palette";
export { headerLabel } from "./droid-labels";
export {
	markToolFinished,
	resetDroidSession,
	stopAllShimmers,
	subscribeTicker,
	tickerTick,
} from "./droid-shimmer";
export { installDroidTools } from "./droid-cards";
export {
	patchAssistantIcon,
	patchToolFallbacks,
	patchUserGutter,
	unpatchAssistantIcon,
	unpatchToolFallbacks,
	unpatchUserGutter,
} from "./droid-patches";
