import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	FOOTER_MODES,
	type FooterMode,
	type FusionConfig,
	loadConfig,
	loadMode,
	nextMode,
	saveConfig,
	saveMode,
} from "./config";
import {
	BUILTIN_SOUNDS,
	FOCUS_META,
	FocusTracker,
	SOUND_FOCUS_MODES,
	SOUND_META,
	type SoundFocusMode,
	type SoundValue,
	playSound,
	previewSound,
} from "./sound";
import { FusionEditor } from "./editor";
import {
	buildContextLabel,
	contextPercent,
	getUsageTotals,
	prettyEffort,
	prettyModel,
} from "./format";
import {
	installDroidTools,
	markToolFinished,
	patchAssistantIcon,
	patchToolFallbacks,
	patchUserGutter,
	setPaletteThemeProvider,
	stopAllShimmers,
	unpatchAssistantIcon,
	unpatchToolFallbacks,
	unpatchUserGutter,
} from "./droid";
import { installFooter } from "./footer";
import { readGitStatus } from "./git";
import { createState } from "./state";
import { fetchUsageForProvider } from "./usage";

const USAGE_REFRESH_MS = 5 * 60_000;
const GIT_REFRESH_MS = 30_000;

/**
 * Ask-style tools → the agent is awaiting YOUR input (Droid's second sound
 * trigger, docs/ui/12-sound-notifications-spec.md §2). Matches
 * `ask_user_question`, `ask_user`, `askuser`, anything with `question`.
 */
const isAskTool = (name: string): boolean =>
	/(^|_)ask(_|user|$)|question/i.test(name);

export default function (pi: ExtensionAPI) {
	const state = createState(process.cwd(), loadMode());
	let droidToolsInstalled = false;
	let fusionEditor: FusionEditor | undefined;
	let requestRender: ((force?: boolean) => void) | undefined;
	// Scroll-safe viewport resync (repaints the visible screen only, no \x1b[3J).
	let resyncFn: (() => void) | undefined;
	// True when pi-tui's frame is taller than the viewport — i.e. rows have
	// scrolled into terminal scrollback, where a viewport resync can't reach them.
	let frameOverflowsFn: (() => boolean) | undefined;
	let usageTimer: ReturnType<typeof setInterval> | undefined;
	let gitTimer: ReturnType<typeof setInterval> | undefined;
	let healTimer: ReturnType<typeof setInterval> | undefined;
	let activeProvider: string | undefined;

	// ── Sound notifications ──────────────────────────────────────────────
	// Note on subagents: Droid silences subagent sounds via getDepth(); Pi
	// subagents run headless (ctx.hasUI === false), so the tui guards below
	// give us the same behavior for free.
	let sound: Pick<
		FusionConfig,
		"completionSound" | "awaitingInputSound" | "soundFocusMode"
	> = loadConfig();
	const focus = new FocusTracker();
	let unsubscribeInput: (() => void) | undefined;

	/** Enable/disable terminal focus reporting based on the current focus policy. */
	const syncFocusReporting = () => {
		if (sound.soundFocusMode === "always") focus.disable();
		else focus.enable();
	};

	const refresh = () => requestRender?.();
	// ── Mid-stream self-heal ─────────────────────────────────────────
	// pi-tui's differ can desync from the physical screen during over-viewport
	// repaints (implicit scrolls), leaving stale rows — e.g. a frozen copy of
	// the live status row between transcript components. The agent_end resync
	// heals too late: by then the stale rows have scrolled into terminal
	// scrollback, where an in-place repaint can never reach them. While the
	// agent runs, resync the visible viewport on a slow cadence so desyncs are
	// repaired BEFORE they leave the screen. The resync is scrollback-safe
	// (footer.ts: home + per-row EL(2) rewrite, no ED(2)/ED(3)) and bounded by
	// the viewport height, so the 2 s cadence costs a few KB per beat.
	const HEAL_MS = 2_000;
	const startHealing = () => {
		if (healTimer) return;
		healTimer = setInterval(() => resyncFn?.(), HEAL_MS);
	};
	const stopHealing = () => {
		if (healTimer) clearInterval(healTimer);
		healTimer = undefined;
	};
	// Full clear + reprint of pi-tui's whole virtual buffer. pi-tui's differ can
	// bake stale rows into terminal scrollback when a repaint grows the frame
	// past the viewport (duplicated lines, torn borders); this is pi's own
	// recovery path — use it after UI-shape changes.
	const refreshFull = () => requestRender?.(true);
	// The scrub reprints the ENTIRE session synchronously — on long transcripts
	// that freezes input for hundreds of ms (typed keys "stop and come back").
	// Never scrub while the user is composing; defer to the next safe moment.
	let scrubPending = false;
	const scrub = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (ctx.ui.getEditorText().length > 0) {
			scrubPending = true;
			return;
		}
		scrubPending = false;
		refreshFull();
	};

	pi.registerCommand("fusion-sound", {
		description:
			"Configure sounds: completion (off|bell|fx-ok01|fx-ack01|/path.wav), 'ask <sound>' for the awaiting-input sound, 'focus <mode>', or 'test'",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim().toLowerCase();
			const opts = [
				...["off", "bell", ...BUILTIN_SOUNDS].map((v) => ({ value: v, label: v })),
				{ value: "ask", label: "ask <sound> — awaiting-input sound (AskUser)" },
				{ value: "focus", label: "focus <always|focused|unfocused>" },
				{ value: "test", label: "test — preview the current sound" },
			];
			return opts.filter((o) => o.value.startsWith(p));
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const [head, ...rest] = raw.split(/\s+/);
			const arg = (head ?? "").toLowerCase();

			// `/fusion-sound test` → preview current sound now.
			if (arg === "test") {
				void previewSound(sound.completionSound);
				ctx.ui.notify(`fusiontui: playing ${sound.completionSound}`, "info");
				return;
			}

			// `/fusion-sound ask <value>` → set the awaiting-input sound (Droid's
			// second trigger: AskUser questions / permission prompts).
			if (arg === "ask") {
				let value = rest.join(" ").trim() as SoundValue;
				if (!value) {
					const choices = ["off", "bell", ...BUILTIN_SOUNDS].map((v) => {
						const meta = SOUND_META[v];
						const marker = v === sound.awaitingInputSound ? " (current)" : "";
						return `${v} — ${meta?.description ?? v}${marker}`;
					});
					const pick = await ctx.ui.select("Select awaiting-input sound", choices);
					if (!pick) return;
					value = pick.split(" ")[0] as SoundValue;
				}
				sound = { ...sound, awaitingInputSound: value };
				saveConfig({ awaitingInputSound: value });
				if (value !== "off") void previewSound(value);
				ctx.ui.notify(`fusiontui: awaiting-input sound = ${value}`, "info");
				return;
			}

			// `/fusion-sound focus <mode>` → set focus policy.
			if (arg === "focus") {
				let mode = (rest[0] ?? "").toLowerCase() as SoundFocusMode;
				if (!(SOUND_FOCUS_MODES as readonly string[]).includes(mode)) {
					const pick = await ctx.ui.select(
						"Sound focus mode",
						SOUND_FOCUS_MODES.map((m) => `${m} — ${FOCUS_META[m].description}`),
					);
					if (!pick) return;
					mode = pick.split(" ")[0] as SoundFocusMode;
				}
				sound = { ...sound, soundFocusMode: mode };
				saveConfig({ soundFocusMode: mode });
				syncFocusReporting();
				ctx.ui.notify(`fusiontui: sound focus mode = ${mode}`, "info");
				return;
			}

			// `/fusion-sound <value>` → set completion sound (bare arg).
			if (raw.length > 0) {
				const value = raw as SoundValue;
				sound = { ...sound, completionSound: value };
				saveConfig({ completionSound: value });
				if (value !== "off") void previewSound(value);
				ctx.ui.notify(`fusiontui: completion sound = ${value}`, "info");
				return;
			}

			// No args → interactive picker.
			const choices = ["off", "bell", ...BUILTIN_SOUNDS].map((v) => {
				const meta = SOUND_META[v];
				const marker = v === sound.completionSound ? " (current)" : "";
				return `${v} — ${meta?.description ?? v}${marker}`;
			});
			const pick = await ctx.ui.select("Select completion sound", choices);
			if (!pick) return;
			const value = pick.split(" ")[0] as SoundValue;
			sound = { ...sound, completionSound: value };
			saveConfig({ completionSound: value });
			if (value !== "off") void previewSound(value);
			ctx.ui.notify(`fusiontui: completion sound = ${value}`, "info");
		},
	});

	pi.registerCommand("fusion-redraw", {
		description:
			"Force a full repaint (cleans stale/duplicated lines baked into scrollback)",
		handler: async (_args, _ctx) => {
			refreshFull();
		},
	});

	pi.registerCommand("fusion", {
		description: "Set the fusiontui footer mode: full, minimal, or adaptive",
		getArgumentCompletions: (prefix) =>
			FOOTER_MODES.filter((m) => m.startsWith(prefix.trim().toLowerCase())).map(
				(m) => ({
					value: m,
					label: m,
				}),
			),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const mode: FooterMode = (FOOTER_MODES as readonly string[]).includes(arg)
				? (arg as FooterMode)
				: nextMode(state.mode);
			state.mode = mode;
			saveMode(mode);
			refresh();
			ctx.ui.notify(`fusiontui footer mode: ${mode}`, "info");
		},
	});

	/** Cheap, synchronous state derived from ctx (model, effort, context, cost). */
	const syncInteractive = (ctx: ExtensionContext) => {
		state.cwd = ctx.cwd;
		state.modelLabel = prettyModel(ctx.model?.id);
		state.effortLabel = ctx.model?.reasoning
			? prettyEffort(pi.getThinkingLevel())
			: "";
		state.contextLabel = buildContextLabel(ctx);
		state.contextPercent = contextPercent(ctx);
		state.costLabel = `$${getUsageTotals(ctx).cost.toFixed(3)}`;
		refresh();
	};

	const refreshGit = async (ctx: ExtensionContext) => {
		state.git = await readGitStatus(ctx.cwd);
		refresh();
	};

	// ── Working indicator (Droid's ‹⠋ Thinking…› ‹context: 12%› analog) ─────
	// Rendered by FusionEditor above the composer instead of Pi's loader row:
	// the loader can scroll into terminal scrollback mid-stream and persist
	// (`⠋ Thinking…` lines between turns) — Droid never commits status lines.
	let workingLabel = "Thinking...";
	const awaitingToolIds = new Set<string>();
	const updateWorking = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		// Droid shows no ctx% in the live status (the footer already carries it).
		state.workingLabel = workingLabel;
		refresh();
	};

	const refreshUsage = (provider: string | undefined) => {
		const task = fetchUsageForProvider(provider);
		if (!task) {
			state.usage = null;
			refresh();
			return;
		}
		activeProvider = provider;
		task
			.then((snap) => {
				if (activeProvider !== provider) return;
				// Keep prior data on a transient error.
				if (!snap.windows.length && snap.error && state.usage?.windows.length)
					return;
				state.usage = snap;
				refresh();
			})
			.catch(() => {});
	};

	const stopTimers = () => {
		if (usageTimer) clearInterval(usageTimer);
		if (gitTimer) clearInterval(gitTimer);
		usageTimer = undefined;
		gitTimer = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		syncInteractive(ctx);
		void refreshGit(ctx);

		// Feed the droid skin the ACTIVE pi theme so its palette follows whatever
		// theme is selected (getter stays live across runtime theme switches).
		setPaletteThemeProvider(() => ctx.ui.theme);

		patchAssistantIcon();
		patchUserGutter();
		patchToolFallbacks();

		// Droid transcript skin: same-name overrides of the built-in tools
		// (render-only; execution delegates to the genuine built-ins). Registered
		// post-load — registering during load trips Pi's cross-extension tool
		// conflict check when another extension owns a name (pi-diff, pi-fff, …).
		if (!droidToolsInstalled) {
			droidToolsInstalled = true;
			const ownedByOthers = new Set(
				pi
					.getAllTools()
					.filter((t) => t.sourceInfo && t.sourceInfo.source !== "builtin")
					.map((t) => t.name),
			);
			const skipped = installDroidTools(pi, ctx.cwd, ownedByOthers);
			if (skipped.length > 0)
				ctx.ui.notify(
					`fusiontui: droid cards skipped for ${skipped.join(", ")} (owned by another extension)`,
					"warning",
				);
		}

		installFooter(ctx, () => state, {
			setRequestRender: (fn) => {
				requestRender = fn;
			},
			setResync: (fn) => {
				resyncFn = fn;
			},
			setFrameOverflows: (fn) => {
				frameOverflowsFn = fn;
			},
			onBranchChange: () => void refreshGit(ctx),
		});

		// Suppress Pi's loader row — the live status renders above the composer.
		ctx.ui.setWorkingVisible(false);

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// interactive-mode never disposes replaced custom editors — keep the
			// instance so shutdown can release its ticker subscription.
			fusionEditor?.dispose();
			fusionEditor = new FusionEditor(tui, theme, keybindings, ctx.ui.theme, () => ({
				modelLabel: state.modelLabel,
				effortLabel: state.effortLabel,
				agent: state.agent,
				workingLabel: state.workingLabel,
			}));
			return fusionEditor;
		});

		refreshUsage(ctx.model?.provider);

		// Focus tracking for focus-sensitive sound modes.
		sound = loadConfig();
		syncFocusReporting();
		unsubscribeInput = ctx.ui.onTerminalInput?.((data) => {
			focus.handleInput(data);
			// Swallow bare focus-report sequences so they never leak into the editor.
			if (data === "\x1b[I" || data === "\x1b[O") return { consume: true };
			return undefined;
		});

		stopTimers();
		usageTimer = setInterval(
			() => refreshUsage(activeProvider),
			USAGE_REFRESH_MS,
		);
		gitTimer = setInterval(() => void refreshGit(ctx), GIT_REFRESH_MS);
	});

	const onInteractive = (_e: unknown, ctx: ExtensionContext) =>
		syncInteractive(ctx);
	const onInteractiveAndGit = (_e: unknown, ctx: ExtensionContext) => {
		syncInteractive(ctx);
		void refreshGit(ctx);
	};

	pi.on("model_select", (event, ctx) => {
		syncInteractive(ctx);
		refreshUsage(event.model?.provider ?? ctx.model?.provider);
		scrub(ctx);
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		syncInteractive(ctx);
		scrub(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		state.agent = "working";
		awaitingToolIds.clear();
		workingLabel = "Thinking...";
		syncInteractive(ctx);
		updateWorking(ctx);
		if (ctx.hasUI && ctx.mode === "tui") startHealing();
		// A scrub was deferred while the user was composing — the editor just
		// emptied (message sent), and the stall is masked by "Thinking…".
		if (scrubPending && ctx.hasUI && ctx.mode === "tui") {
			scrubPending = false;
			refreshFull();
		}
	});
	pi.on("turn_start", (_event, ctx) => {
		workingLabel = "Thinking...";
		updateWorking(ctx);
	});
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		workingLabel = "Generating..."; // droid `status.generating`, verbatim
		updateWorking(ctx);
	});
	pi.on("message_end", onInteractive);
	pi.on("agent_end", (_event, ctx) => {
		state.agent = "idle";
		state.workingLabel = "";
		awaitingToolIds.clear();
		stopHealing();
		// Aborted tools never fire tool_execution_end — latch their headers solid.
		stopAllShimmers();
		syncInteractive(ctx);
		void refreshGit(ctx);
		// The agent finished its run → control returns to you. Ding + heal the
		// display. Which heal depends on whether this run scrolled past the
		// viewport:
		//  - Frame FITS the viewport → nothing reached scrollback, so the cheap
		//    in-place viewport resync (scrollback-safe: no ED(2)/ED(3)) is enough.
		//  - Frame OUTGREW the viewport → the differ's implicit over-viewport
		//    scrolls can bake duplicated rows into terminal scrollback (seen on
		//    Ghostty/iTerm2), which an in-place resync can never repair. Do the
		//    deep clean (full clear + reprint, /fusion-redraw's path) so the
		//    completed transcript reads clean when you scroll up. It's wrapped in
		//    synchronized output (DEC 2026) so modern terminals show no flash, and
		//    scrub() defers it if you're already composing the next message.
		if (ctx.hasUI && ctx.mode === "tui") {
			if (frameOverflowsFn?.()) scrub(ctx);
			else resyncFn?.();
			void playSound(sound.completionSound, sound.soundFocusMode, {
				isFocused: focus.isFocused,
			});
		}
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (isAskTool(event.toolName)) {
			// Droid's awaiting-input trigger: an AskUser-style question opened.
			awaitingToolIds.add(event.toolCallId);
			state.agent = "awaiting";
			workingLabel = "Waiting for your input...";
			if (ctx.hasUI && ctx.mode === "tui") {
				void playSound(sound.awaitingInputSound, sound.soundFocusMode, {
					isFocused: focus.isFocused,
				});
			}
		} else {
			// Droid `ie0` isInvokingTools branch, verbatim (" Invoking tools... ") —
			// droid never puts the tool name in the live status row.
			workingLabel = "Invoking tools...";
		}
		updateWorking(ctx);
		refresh();
	});
	pi.on("tool_execution_end", (event, ctx) => {
		markToolFinished(event.toolCallId);
		if (awaitingToolIds.delete(event.toolCallId) && awaitingToolIds.size === 0)
			state.agent = "working";
		workingLabel = "Thinking...";
		updateWorking(ctx);
		onInteractiveAndGit(event, ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		syncInteractive(ctx);
		scrub(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimers();
		stopHealing();
		requestRender = undefined;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		focus.disable();
		stopAllShimmers();
		fusionEditor?.dispose();
		fusionEditor = undefined;
		unpatchAssistantIcon();
		unpatchUserGutter();
		unpatchToolFallbacks();
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setFooter(undefined);
			ctx.ui.setEditorComponent(undefined);
		}
	});
}
