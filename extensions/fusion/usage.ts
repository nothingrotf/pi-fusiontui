import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatResetIn } from "./format";

/** A single rate-limit window (e.g. the rolling 5h window or the weekly window). */
export type UsageWindow = {
	label: string;
	/** 0-100 used. */
	usedPercent: number;
	/** Human reset countdown, e.g. "2h13m". */
	resetsIn?: string;
};

export type UsageSnapshot = {
	provider: string;
	windows: UsageWindow[];
	error?: string;
	fetchedAt: number;
};

const clamp = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0);
/** Accept either a 0-1 fraction or a 0-100 percent. */
const normalizePercent = (v: number) => clamp(v <= 1 && v >= 0 ? v * 100 : v);

function loadAuth(): Record<string, any> {
	const p = join(homedir(), ".pi", "agent", "auth.json");
	try {
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
	} catch {}
	return {};
}

function getClaudeToken(): string | undefined {
	const auth = loadAuth();
	if (auth.anthropic?.access) return auth.anthropic.access;
	// macOS Claude Code keychain fallback.
	try {
		const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		if (raw) return JSON.parse(raw)?.claudeAiOauth?.accessToken;
	} catch {}
	return undefined;
}

function getCodexCreds(): { token: string; accountId?: string } | undefined {
	const auth = loadAuth();
	if (auth["openai-codex"]?.access) {
		return { token: auth["openai-codex"].access, accountId: auth["openai-codex"]?.accountId };
	}
	return undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 5000): Promise<Response> {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), ms);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(t);
	}
}

async function fetchClaudeUsage(): Promise<UsageSnapshot> {
	const token = getClaudeToken();
	if (!token) return { provider: "Claude", windows: [], error: "no-auth", fetchedAt: Date.now() };
	try {
		const res = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
			headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
		});
		if (!res.ok) return { provider: "Claude", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
		const data = (await res.json()) as any;
		const windows: UsageWindow[] = [];
		if (data.five_hour?.utilization !== undefined) {
			windows.push({
				label: "5h",
				usedPercent: normalizePercent(data.five_hour.utilization),
				resetsIn: data.five_hour.resets_at ? formatResetIn(new Date(data.five_hour.resets_at)) : undefined,
			});
		}
		if (data.seven_day?.utilization !== undefined) {
			windows.push({
				label: "wk",
				usedPercent: normalizePercent(data.seven_day.utilization),
				resetsIn: data.seven_day.resets_at ? formatResetIn(new Date(data.seven_day.resets_at)) : undefined,
			});
		}
		return { provider: "Claude", windows, fetchedAt: Date.now() };
	} catch (e) {
		return { provider: "Claude", windows: [], error: String(e), fetchedAt: Date.now() };
	}
}

async function fetchCodexUsage(): Promise<UsageSnapshot> {
	const creds = getCodexCreds();
	if (!creds) return { provider: "Codex", windows: [], error: "no-auth", fetchedAt: Date.now() };
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${creds.token}`,
			"User-Agent": "pi-agent",
			Accept: "application/json",
		};
		if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;
		const res = await fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", { headers });
		if (!res.ok) return { provider: "Codex", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
		const data = (await res.json()) as any;
		const windows: UsageWindow[] = [];
		const pw = data.rate_limit?.primary_window;
		if (pw) {
			windows.push({
				label: "5h",
				usedPercent: clamp(pw.used_percent ?? 0),
				resetsIn: pw.reset_at ? formatResetIn(new Date(pw.reset_at * 1000)) : undefined,
			});
		}
		const sw = data.rate_limit?.secondary_window;
		if (sw) {
			windows.push({
				label: "wk",
				usedPercent: clamp(sw.used_percent ?? 0),
				resetsIn: sw.reset_at ? formatResetIn(new Date(sw.reset_at * 1000)) : undefined,
			});
		}
		return { provider: "Codex", windows, fetchedAt: Date.now() };
	} catch (e) {
		return { provider: "Codex", windows: [], error: String(e), fetchedAt: Date.now() };
	}
}

/** Map a Pi model provider id to its usage fetcher. */
export function fetchUsageForProvider(modelProvider: string | undefined): Promise<UsageSnapshot> | null {
	switch (modelProvider) {
		case "anthropic":
			return fetchClaudeUsage();
		case "openai-codex":
			return fetchCodexUsage();
		default:
			return null;
	}
}
