import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Footer layout modes, in cycle order. */
export const FOOTER_MODES = ["full", "minimal", "adaptive"] as const;
export type FooterMode = (typeof FOOTER_MODES)[number];

const CONFIG_PATH = join(homedir(), ".pi", "fusiontui.json");

function isFooterMode(value: unknown): value is FooterMode {
	return typeof value === "string" && (FOOTER_MODES as readonly string[]).includes(value);
}

/** Persisted mode, defaulting to "full" when missing or unreadable. */
export function loadMode(): FooterMode {
	try {
		const mode = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))?.mode;
		if (isFooterMode(mode)) return mode;
	} catch {}
	return "full";
}

export function saveMode(mode: FooterMode): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify({ mode }, null, 2)}\n`);
	} catch {}
}

/** Mode after `current`, wrapping around the cycle. */
export function nextMode(current: FooterMode): FooterMode {
	return FOOTER_MODES[(FOOTER_MODES.indexOf(current) + 1) % FOOTER_MODES.length];
}
