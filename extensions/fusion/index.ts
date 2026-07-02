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
import { installFooter } from "./footer";
import { readGitStatus } from "./git";
import { createState } from "./state";
import { fetchUsageForProvider } from "./usage";

const USAGE_REFRESH_MS = 5 * 60_000;
const GIT_REFRESH_MS = 30_000;

export default function (pi: ExtensionAPI) {
	const state = createState(process.cwd(), loadMode());
	let requestRender: (() => void) | undefined;
	let usageTimer: ReturnType<typeof setInterval> | undefined;
	let gitTimer: ReturnType<typeof setInterval> | undefined;
	let activeProvider: string | undefined;

	// ── Sound notifications ──────────────────────────────────────────────
	let sound: Pick<FusionConfig, "completionSound" | "soundFocusMode"> = loadConfig();
	const focus = new FocusTracker();
	let unsubscribeInput: (() => void) | undefined;

	/** Enable/disable terminal focus reporting based on the current focus policy. */
	const syncFocusReporting = () => {
		if (sound.soundFocusMode === "always") focus.disable();
		else focus.enable();
	};

	const refresh = () => requestRender?.();

	pi.registerCommand("fusion-sound", {
		description:
			"Configure the completion sound: off | bell | fx-ok01 | fx-ack01 | /path.wav, 'focus <mode>', or 'test'",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim().toLowerCase();
			const opts = [
				...["off", "bell", ...BUILTIN_SOUNDS].map((v) => ({ value: v, label: v })),
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

		installFooter(ctx, () => state, {
			setRequestRender: (fn) => {
				requestRender = fn;
			},
			onBranchChange: () => void refreshGit(ctx),
		});

		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new FusionEditor(tui, theme, keybindings, ctx.ui.theme, () => ({
					modelLabel: state.modelLabel,
					effortLabel: state.effortLabel,
				})),
		);

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
	});
	pi.on("thinking_level_select", onInteractive);
	pi.on("agent_start", onInteractive);
	pi.on("message_end", onInteractive);
	pi.on("agent_end", (_event, ctx) => {
		syncInteractive(ctx);
		void refreshGit(ctx);
		// The agent finished its turn → control returns to you. Ding.
		if (ctx.hasUI && ctx.mode === "tui") {
			void playSound(sound.completionSound, sound.soundFocusMode, {
				isFocused: focus.isFocused,
			});
		}
	});
	pi.on("tool_execution_end", onInteractiveAndGit);
	pi.on("session_compact", onInteractive);

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimers();
		requestRender = undefined;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		focus.disable();
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.setFooter(undefined);
			ctx.ui.setEditorComponent(undefined);
		}
	});
}
