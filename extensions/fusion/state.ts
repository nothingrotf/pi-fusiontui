import type { FooterMode } from "./config";
import type { GitStatus } from "./git";
import { emptyGitStatus } from "./git";
import type { UsageSnapshot } from "./usage";

/**
 * What the agent is doing right now (drives the composer border color and
 * the status line under the box, mirroring Droid's mode-colored composer):
 *  - idle     → the composer is yours (accent border)
 *  - working  → the agent is streaming/executing (dim border, steer hints)
 *  - awaiting → the agent asked YOU something (warning border, AskUser-style)
 */
export type AgentActivity = "idle" | "working" | "awaiting";
export type WorkingPhase = "thinking" | "generating" | "invoking";

/** The only render-facing activity view; invalid combinations are not representable. */
export type ActivityView = {
	agent: AgentActivity;
	workingLabel: string;
};

/** Derive a coherent activity/label pair, with pending asks taking precedence. */
export function deriveActivity(
	pendingAskIds: ReadonlySet<string>,
	phase: WorkingPhase | "idle",
): ActivityView {
	if (pendingAskIds.size > 0)
		return { agent: "awaiting", workingLabel: "Waiting for your input..." };
	if (phase === "idle") return { agent: "idle", workingLabel: "" };
	if (phase === "generating") return { agent: "working", workingLabel: "Generating..." };
	if (phase === "invoking") return { agent: "working", workingLabel: "Invoking tools..." };
	return { agent: "working", workingLabel: "Thinking..." };
}

/** Everything the footer + editor render from. Mutated in place; render reads it. */
export type FusionState = {
	mode: FooterMode;
	cwd: string;
	git: GitStatus;
	modelLabel: string;
	effortLabel: string;
	contextLabel: string;
	contextPercent: number | null;
	costLabel: string;
	usage: UsageSnapshot | null;
	activity: ActivityView;
};

export function createState(cwd: string, mode: FooterMode): FusionState {
	return {
		mode,
		cwd,
		git: emptyGitStatus(),
		modelLabel: "no-model",
		effortLabel: "",
		contextLabel: "--",
		contextPercent: null,
		costLabel: "$0.000",
		usage: null,
		activity: { agent: "idle", workingLabel: "" },
	};
}
