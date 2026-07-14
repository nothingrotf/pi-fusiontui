import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { formatResetIn } from "./format";

const execFileAsync = promisify(execFile);
const REQUEST_TIMEOUT_MS = 5_000;
const KEYCHAIN_TIMEOUT_MS = 1_500;

type AuthRecord = Record<string, unknown>;

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
/** Both provider payloads expose utilization as a 0-100 percentage. */
const normalizePercent = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) ? clamp(v) : 0;

/**
 * Run an async operation with a signal that is also cancelled by a deadline.
 * The timeout wraps response body consumption as well as headers (L2-02).
 */
async function withTimeout<T>(
	parent: AbortSignal | undefined,
	ms: number,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const relay = () => controller.abort(parent?.reason);
	if (parent) {
		if (parent.aborted) relay();
		else parent.addEventListener("abort", relay, { once: true });
	}
	const timer = setTimeout(() => controller.abort(new Error("operation timed out")), ms);
	try {
		return await work(controller.signal);
	} finally {
		clearTimeout(timer);
		parent?.removeEventListener("abort", relay);
	}
}

async function loadAuth(signal?: AbortSignal): Promise<AuthRecord> {
	try {
		const p = join(homedir(), ".pi", "agent", "auth.json");
		const raw = await readFile(p, { encoding: "utf8", signal });
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as AuthRecord) : {};
	} catch (error) {
		if (signal?.aborted) throw error;
		return {};
	}
}

function nestedString(value: unknown, ...keys: string[]): string | undefined {
	let current = value;
	for (const key of keys) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" && current.length > 0 ? current : undefined;
}

async function getClaudeToken(signal?: AbortSignal): Promise<string | undefined> {
	const auth = await loadAuth(signal);
	const direct = nestedString(auth.anthropic, "access");
	if (direct) return direct;

	// macOS Claude Code keychain fallback. This is asynchronous and bounded so
	// the initial TUI render/input loop is never blocked (L2-03).
	try {
		const raw = await withTimeout(signal, KEYCHAIN_TIMEOUT_MS, async (keychainSignal) => {
			const result = await execFileAsync(
				"security",
				["find-generic-password", "-s", "Claude Code-credentials", "-w"],
				{
					encoding: "utf8",
					maxBuffer: 64 * 1024,
					signal: keychainSignal,
				},
			);
			return String(result.stdout).trim();
		});
		if (!raw) return undefined;
		const parsed: unknown = JSON.parse(raw);
		return nestedString(parsed, "claudeAiOauth", "accessToken");
	} catch (error) {
		if (signal?.aborted) throw error;
		return undefined;
	}
}

async function getCodexCreds(
	signal?: AbortSignal,
): Promise<{ token: string; accountId?: string } | undefined> {
	const auth = await loadAuth(signal);
	const record = auth["openai-codex"];
	const token = nestedString(record, "access");
	if (!token) return undefined;
	return { token, accountId: nestedString(record, "accountId") };
}

type JsonResponse = { response: Response; data?: unknown };

async function fetchJson(
	url: string,
	init: RequestInit,
	parentSignal?: AbortSignal,
): Promise<JsonResponse> {
	return withTimeout(parentSignal, REQUEST_TIMEOUT_MS, async (signal) => {
		const response = await fetch(url, { ...init, signal });
		if (!response.ok) return { response };
		// Keep this inside the timeout: headers can arrive while the body stalls.
		const data: unknown = await response.json();
		return { response, data };
	});
}

async function fetchClaudeUsage(signal?: AbortSignal): Promise<UsageSnapshot> {
	const provider = "Claude";
	try {
		const token = await getClaudeToken(signal);
		if (!token) return { provider, windows: [], error: "no-auth", fetchedAt: Date.now() };
		const { response: res, data } = await fetchJson(
			"https://api.anthropic.com/api/oauth/usage",
			{ headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } },
			signal,
		);
		if (!res.ok) return { provider, windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
		const record = data && typeof data === "object" ? (data as Record<string, any>) : {};
		const windows: UsageWindow[] = [];
		if (record.five_hour?.utilization !== undefined) {
			windows.push({
				label: "5h",
				usedPercent: normalizePercent(record.five_hour.utilization),
				resetsIn: record.five_hour.resets_at ? formatResetIn(new Date(record.five_hour.resets_at)) : undefined,
			});
		}
		if (record.seven_day?.utilization !== undefined) {
			windows.push({
				label: "wk",
				usedPercent: normalizePercent(record.seven_day.utilization),
				resetsIn: record.seven_day.resets_at ? formatResetIn(new Date(record.seven_day.resets_at)) : undefined,
			});
		}
		return { provider, windows, fetchedAt: Date.now() };
	} catch (error) {
		if (signal?.aborted) throw error;
		return { provider, windows: [], error: String(error), fetchedAt: Date.now() };
	}
}

async function fetchCodexUsage(signal?: AbortSignal): Promise<UsageSnapshot> {
	const provider = "Codex";
	try {
		const creds = await getCodexCreds(signal);
		if (!creds) return { provider, windows: [], error: "no-auth", fetchedAt: Date.now() };
		const headers: Record<string, string> = {
			Authorization: `Bearer ${creds.token}`,
			"User-Agent": "pi-agent",
			Accept: "application/json",
		};
		if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;
		const { response: res, data } = await fetchJson(
			"https://chatgpt.com/backend-api/wham/usage",
			{ headers },
			signal,
		);
		if (!res.ok) return { provider, windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
		const record = data && typeof data === "object" ? (data as Record<string, any>) : {};
		const windows: UsageWindow[] = [];
		const pw = record.rate_limit?.primary_window;
		if (pw) {
			windows.push({
				label: "5h",
				usedPercent: normalizePercent(pw.used_percent),
				resetsIn: pw.reset_at ? formatResetIn(new Date(pw.reset_at * 1000)) : undefined,
			});
		}
		const sw = record.rate_limit?.secondary_window;
		if (sw) {
			windows.push({
				label: "wk",
				usedPercent: normalizePercent(sw.used_percent),
				resetsIn: sw.reset_at ? formatResetIn(new Date(sw.reset_at * 1000)) : undefined,
			});
		}
		return { provider, windows, fetchedAt: Date.now() };
	} catch (error) {
		if (signal?.aborted) throw error;
		return { provider, windows: [], error: String(error), fetchedAt: Date.now() };
	}
}

/** Map a Pi model provider id to its usage fetcher. */
export function fetchUsageForProvider(
	modelProvider: string | undefined,
	signal?: AbortSignal,
): Promise<UsageSnapshot> | null {
	switch (modelProvider) {
		case "anthropic":
			return fetchClaudeUsage(signal);
		case "openai-codex":
			return fetchCodexUsage(signal);
		default:
			return null;
	}
}
