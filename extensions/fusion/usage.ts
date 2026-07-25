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
export const normalizePercent = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) ? clamp(v) : 0;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** `resets_at` is optional and provider-shaped; anything unusable yields no countdown. */
function resetsIn(value: unknown, toDate: (raw: never) => Date): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const date = toDate(value as never);
	return Number.isFinite(date.getTime()) ? formatResetIn(date) : undefined;
}

/**
 * Anthropic `/api/oauth/usage` -> footer windows. Total: an absent, malformed
 * or hostile payload yields fewer windows, never a throw (L2-04).
 */
export function parseClaudeWindows(data: unknown): UsageWindow[] {
	const root = record(data);
	const windows: UsageWindow[] = [];
	const add = (label: string, key: string) => {
		const window = record(root[key]);
		if (window.utilization === undefined) return;
		windows.push({
			label,
			usedPercent: normalizePercent(window.utilization),
			resetsIn: resetsIn(window.resets_at, (raw) => new Date(raw)),
		});
	};
	add("5h", "five_hour");
	add("wk", "seven_day");
	return windows;
}

/**
 * ChatGPT `wham/usage` -> footer windows. `reset_at` is unix SECONDS here,
 * unlike Anthropic's ISO string.
 */
export function parseCodexWindows(data: unknown): UsageWindow[] {
	const limits = record(record(data).rate_limit);
	const windows: UsageWindow[] = [];
	const add = (label: string, key: string) => {
		if (!limits[key]) return;
		const window = record(limits[key]);
		windows.push({
			label,
			usedPercent: normalizePercent(window.used_percent),
			resetsIn: resetsIn(
				window.reset_at,
				(raw) => new Date(typeof raw === "number" ? raw * 1000 : Number.NaN),
			),
		});
	};
	add("5h", "primary_window");
	add("wk", "secondary_window");
	return windows;
}

/**
 * Run an async operation with a signal that is also cancelled by a deadline.
 * The timeout wraps response body consumption as well as headers (L2-02).
 */
export async function withTimeout<T>(
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
		return { provider, windows: parseClaudeWindows(data), fetchedAt: Date.now() };
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
		return { provider, windows: parseCodexWindows(data), fetchedAt: Date.now() };
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
