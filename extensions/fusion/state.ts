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
	agent: AgentActivity;
	/** Live status label (`Thinking… · ctx 3%`) shown above the composer. */
	workingLabel: string;
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
		agent: "idle",
		workingLabel: "",
	};
}
