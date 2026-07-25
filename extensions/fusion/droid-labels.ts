import { sanitizeScalar } from "./render-safe";

// ── path/label helpers (droid `ht9`, UL0 = 3) ───────────────────────────────
const PATH_SEGMENTS = 3;
export function shortPath(p: string): string {
	const raw = sanitizeScalar(p).replace(/\\/g, "/");
	const home = (process.env.HOME || process.env.USERPROFILE || "").replace(/[\\/]+$/, "");
	const h = home.replace(/\\/g, "/");
	const t = h && (raw === h || raw.startsWith(`${h}/`)) ? `~${raw.slice(h.length)}` : raw;
	const parts = t.split("/").filter(Boolean);
	if (parts.length <= PATH_SEGMENTS) return t;
	return `.../${parts.slice(-PATH_SEGMENTS).join("/")}`;
}

const str = (v: unknown): string | undefined => {
	const value = sanitizeScalar(v);
	return value.length > 0 ? value : undefined;
};

/** Droid display names for Pi's built-in tools (droid `UAT`/`KF1`). */
export const DISPLAY: Record<string, string> = {
	read: "Read",
	bash: "Execute",
	edit: "Edit",
	write: "Create",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
};

/** Header label from tool args (droid `KF1` field mapping, Pi arg names). */
export function headerLabel(tool: string, args: Record<string, unknown>): string {
	switch (tool) {
		case "read":
		case "edit":
		case "write": {
			const p = str(args.path) ?? str(args.file_path);
			return p ? shortPath(p) : "";
		}
		case "bash": {
			const cmd = str(args.command) ?? "";
			return sanitizeScalar(cmd.split("\n")[0]);
		}
		case "grep": {
			const pat = str(args.pattern);
			if (!pat) return "";
			const dir = str(args.path);
			return dir ? `"${pat}" in ${shortPath(dir)}` : `"${pat}"`;
		}
		case "find":
			return str(args.pattern) ?? "";
		case "ls": {
			const p = str(args.path);
			return p ? shortPath(p) : "current directory";
		}
		default:
			return "";
	}
}
