import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FOOTER_MODES, type FooterMode, loadMode, nextMode, saveMode } from "./config";
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

	const refresh = () => requestRender?.();

	pi.registerCommand("fusion", {
		description: "Set the fusiontui footer mode: full, minimal, or adaptive",
		getArgumentCompletions: (prefix) =>
			FOOTER_MODES.filter((m) => m.startsWith(prefix.trim().toLowerCase())).map((m) => ({
				value: m,
				label: m,
			})),
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
		state.effortLabel = ctx.model?.reasoning ? prettyEffort(pi.getThinkingLevel()) : "";
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
				if (!snap.windows.length && snap.error && state.usage?.windows.length) return;
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

		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new FusionEditor(tui, theme, keybindings, ctx.ui.theme, () => ({
				modelLabel: state.modelLabel,
				effortLabel: state.effortLabel,
			})),
		);

		refreshUsage(ctx.model?.provider);

		stopTimers();
		usageTimer = setInterval(() => refreshUsage(activeProvider), USAGE_REFRESH_MS);
		gitTimer = setInterval(() => void refreshGit(ctx), GIT_REFRESH_MS);
	});

	const onInteractive = (_e: unknown, ctx: ExtensionContext) => syncInteractive(ctx);
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
	pi.on("agent_end", onInteractiveAndGit);
	pi.on("tool_execution_end", onInteractiveAndGit);
	pi.on("session_compact", onInteractive);

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimers();
		requestRender = undefined;
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.setFooter(undefined);
			ctx.ui.setEditorComponent(undefined);
		}
	});
}
