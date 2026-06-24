import type { GitStatus } from "./git";
import { emptyGitStatus } from "./git";
import type { UsageSnapshot } from "./usage";

/** Everything the footer + editor render from. Mutated in place; render reads it. */
export type FusionState = {
	cwd: string;
	git: GitStatus;
	modelLabel: string;
	effortLabel: string;
	contextLabel: string;
	contextPercent: number | null;
	costLabel: string;
	usage: UsageSnapshot | null;
};

export function createState(cwd: string): FusionState {
	return {
		cwd,
		git: emptyGitStatus(),
		modelLabel: "no-model",
		effortLabel: "",
		contextLabel: "--",
		contextPercent: null,
		costLabel: "$0.000",
		usage: null,
	};
}
