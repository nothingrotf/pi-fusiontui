import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 2_000;

export type GitStatus = {
	branch?: string;
	dirty: boolean;
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	added: number;
	deleted: number;
	renamed: number;
	copied: number;
	untracked: number;
	conflicted: number;
};

export function emptyGitStatus(): GitStatus {
	return {
		branch: undefined,
		dirty: false,
		ahead: 0,
		behind: 0,
		staged: 0,
		modified: 0,
		added: 0,
		deleted: 0,
		renamed: 0,
		copied: 0,
		untracked: 0,
		conflicted: 0,
	};
}

export function parsePorcelain(stdout: string): GitStatus {
	const status = emptyGitStatus();
	for (const line of stdout.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("# branch.head ")) {
			const b = line.slice("# branch.head ".length).trim();
			status.branch = b && b !== "(detached)" ? b : undefined;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const m = line.match(/\+(\d+)\s+-(\d+)/);
			if (m) {
				status.ahead = Number(m[1] ?? 0);
				status.behind = Number(m[2] ?? 0);
			}
			continue;
		}
		if (line.startsWith("#")) continue;
		status.dirty = true;
		if (line.startsWith("? ")) {
			status.untracked += 1;
			continue;
		}
		if (line.startsWith("u ")) {
			status.conflicted += 1;
			continue;
		}
		if (!(line.startsWith("1 ") || line.startsWith("2 "))) continue;
		const xy = line.split(" ")[1] ?? "..";
		const x = xy[0] ?? ".";
		const y = xy[1] ?? ".";
		if (x !== "." && x !== " ") status.staged += 1;
		const codes = `${x}${y}`;
		// Count each path once per category, even when both index and worktree
		// carry the same status (for example `MM`).
		if (codes.includes("M") || codes.includes("T")) status.modified += 1;
		if (codes.includes("A")) status.added += 1;
		if (codes.includes("D")) status.deleted += 1;
		if (codes.includes("R")) status.renamed += 1;
		if (codes.includes("C")) status.copied += 1;
	}
	return status;
}

export async function readGitStatus(cwd: string): Promise<GitStatus> {
	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain=2", "--branch"], {
			cwd,
			timeout: TIMEOUT_MS,
		});
		return parsePorcelain(typeof stdout === "string" ? stdout : String(stdout));
	} catch {
		return emptyGitStatus();
	}
}
