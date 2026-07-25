import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate from "../extensions/fusion/index";
import { FOOTER_MODES } from "../extensions/fusion/config";

type Command = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => { value: string; label: string }[];
	handler: (args: string, ctx: unknown) => Promise<void> | void;
};

/**
 * The extension entrypoint against a fake host. This covers the wiring — which
 * commands and lifecycle events exist — without a TUI. Handlers that persist to
 * ~/.pi are deliberately NOT invoked here; their decision logic lives in
 * commands.ts and is tested there.
 */
function activateFusion() {
	const commands = new Map<string, Command>();
	const events = new Map<string, unknown[]>();
	const tools: { name: string; sourceInfo?: { source: string } }[] = [];
	const pi = {
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		on: (event: string, handler: unknown) => {
			events.set(event, [...(events.get(event) ?? []), handler]);
		},
		getAllTools: () => tools,
		registerTool: (tool: { name: string }) => tools.push(tool),
		getTool: (name: string) => tools.find((tool) => tool.name === name),
	} as unknown as ExtensionAPI;
	activate(pi);
	return { commands, events, tools };
}

describe("extension activation", () => {
	test("registers every fusion command with a description", () => {
		const { commands } = activateFusion();
		expect([...commands.keys()].sort()).toEqual([
			"fusion",
			"fusion-follow",
			"fusion-hold",
			"fusion-redraw",
			"fusion-sound",
		]);
		for (const [name, command] of commands) {
			expect(`${name}:${(command.description ?? "").length > 0}`).toBe(`${name}:true`);
			expect(typeof command.handler).toBe("function");
		}
	});

	test("subscribes to every lifecycle event the footer and skin depend on", () => {
		const { events } = activateFusion();
		for (const event of [
			"session_start",
			"session_shutdown",
			"session_compact",
			"model_select",
			"thinking_level_select",
			"agent_start",
			"agent_end",
			"turn_start",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
		]) {
			expect(`${event}:${events.has(event)}`).toBe(`${event}:true`);
		}
	});

	test("activating twice does not duplicate registrations in one host", () => {
		const first = activateFusion();
		const second = activateFusion();
		expect([...second.commands.keys()]).toEqual([...first.commands.keys()]);
		for (const handlers of second.events.values()) expect(handlers).toHaveLength(1);
	});

	test("/fusion completes the footer modes", () => {
		const { commands } = activateFusion();
		const complete = commands.get("fusion")!.getArgumentCompletions!;
		expect(complete("").map((o) => o.value)).toEqual([...FOOTER_MODES]);
		expect(complete("mi").map((o) => o.value)).toEqual(["minimal"]);
		expect(complete("ZZZ")).toEqual([]);
	});

	test("/fusion-sound completes sounds and subcommands", () => {
		const { commands } = activateFusion();
		const complete = commands.get("fusion-sound")!.getArgumentCompletions!;
		expect(complete("").map((o) => o.value)).toContain("off");
		expect(complete("").map((o) => o.value)).toContain("focus");
		expect(complete("te").map((o) => o.value)).toEqual(["test"]);
	});

	// These three only touch the footer handle / render callback, both of which
	// are undefined before session_start — they must no-op, not throw.
	test("the render commands are safe to run before a session exists", async () => {
		const { commands } = activateFusion();
		for (const name of ["fusion-redraw", "fusion-follow", "fusion-hold"]) {
			await expect(commands.get(name)!.handler("", {})).resolves.toBeUndefined();
		}
	});
});

type Ctx = ReturnType<typeof makeCtx>["ctx"];

/**
 * A fake TUI session context — just enough surface for session_start to install
 * the footer, the composer and the transcript skin, and for session_shutdown to
 * take them all back out again.
 */
function makeCtx(cwd = "/Users/dev/proj") {
	const calls = {
		footers: [] as unknown[],
		editors: [] as unknown[],
		workingVisible: [] as boolean[],
		notifications: [] as string[],
		inputUnsubscribes: 0,
	};
	let editorComponent: unknown;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd,
		model: { id: "claude-opus-4-8", provider: "none", contextWindow: 200_000 },
		isIdle: () => true,
		getContextUsage: () => ({ percent: 10, contextWindow: 200_000 }),
		sessionManager: { getEntries: () => [], getBranch: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, getFgAnsi: () => "", getBgAnsi: () => "" },
			setFooter: (factory: unknown) => calls.footers.push(factory),
			setWorkingVisible: (visible: boolean) => calls.workingVisible.push(visible),
			getEditorComponent: () => editorComponent,
			setEditorComponent: (factory: unknown) => {
				editorComponent = factory;
				calls.editors.push(factory);
			},
			getEditorText: () => "",
			notify: (message: string) => calls.notifications.push(message),
			onTerminalInput: () => () => {
				calls.inputUnsubscribes++;
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, calls, currentEditor: () => editorComponent };
}

const emit = async (
	events: Map<string, unknown[]>,
	name: string,
	ctx: Ctx,
	event: unknown = {},
) => {
	for (const handler of events.get(name) ?? []) {
		await (handler as (e: unknown, c: Ctx) => unknown)(event, ctx);
	}
};

describe("session lifecycle", () => {
	test("session_start installs the footer, the composer and hides Pi's loader", async () => {
		const { events } = activateFusion();
		const { ctx, calls, currentEditor } = makeCtx();
		try {
			await emit(events, "session_start", ctx);
			expect(calls.footers).toHaveLength(1);
			expect(typeof calls.footers[0]).toBe("function");
			expect(typeof currentEditor()).toBe("function");
			expect(calls.workingVisible).toEqual([false]);
		} finally {
			await emit(events, "session_shutdown", ctx);
		}
	});

	// M3: teardown must give every surface back and release the input hook.
	test("session_shutdown removes both surfaces and restores the loader", async () => {
		const { events } = activateFusion();
		const { ctx, calls, currentEditor } = makeCtx();
		await emit(events, "session_start", ctx);
		await emit(events, "session_shutdown", ctx);

		expect(calls.footers[calls.footers.length - 1]).toBeUndefined();
		expect(currentEditor()).toBeUndefined();
		expect(calls.workingVisible).toEqual([false, true]);
		expect(calls.inputUnsubscribes).toBe(1);
	});

	test("a headless or non-tui session installs nothing", async () => {
		const { events } = activateFusion();
		const { ctx, calls } = makeCtx();
		const headless = { ...ctx, hasUI: false } as unknown as Ctx;
		const printMode = { ...ctx, mode: "print" } as unknown as Ctx;
		await emit(events, "session_start", headless);
		await emit(events, "session_start", printMode);
		expect(calls.footers).toHaveLength(0);
		expect(calls.editors).toHaveLength(0);
	});

	// L0-05: a foreign editor installed after us is composed, never evicted, and
	// shutdown must not rip out a slot we no longer own.
	test("shutdown leaves an editor slot that another extension has taken", async () => {
		const { events } = activateFusion();
		const { ctx, currentEditor } = makeCtx();
		await emit(events, "session_start", ctx);
		const foreign = () => ({});
		ctx.ui.setEditorComponent(foreign as never);
		await emit(events, "session_shutdown", ctx);
		expect(currentEditor()).toBe(foreign);
	});

	test("the interactive events keep the footer state in sync", async () => {
		const { events } = activateFusion();
		const { ctx } = makeCtx();
		try {
			await emit(events, "session_start", ctx);
			for (const name of [
				"model_select",
				"thinking_level_select",
				"turn_start",
				"message_start",
				"message_end",
				"agent_start",
				"agent_end",
				"session_compact",
			]) {
				await emit(events, name, ctx, { model: undefined, message: {} });
			}
		} finally {
			await emit(events, "session_shutdown", ctx);
		}
	});

	test("tool events survive an unknown tool payload", async () => {
		const { events } = activateFusion();
		const { ctx } = makeCtx();
		try {
			await emit(events, "session_start", ctx);
			await emit(events, "tool_execution_start", ctx, {
				toolCallId: "t1",
				toolName: "ask_user_question",
			});
			await emit(events, "tool_execution_end", ctx, { toolCallId: "t1" });
			await emit(events, "tool_execution_start", ctx, {});
			await emit(events, "tool_execution_end", ctx, {});
		} finally {
			await emit(events, "session_shutdown", ctx);
		}
	});

	test("a second session_start replaces the surfaces without leaking the first", async () => {
		const { events } = activateFusion();
		const { ctx, calls } = makeCtx();
		try {
			await emit(events, "session_start", ctx);
			await emit(events, "session_start", ctx);
			expect(calls.footers).toHaveLength(2);
		} finally {
			await emit(events, "session_shutdown", ctx);
		}
	});
});

describe("/fusion-sound rejection path", () => {
	// Only the invalid branch is driven here: every accepted value persists to
	// ~/.pi and previews audio. The accepted-value routing is covered purely in
	// tests/commands.test.ts.
	test("an unusable sound value warns and changes nothing", async () => {
		const { commands, events } = activateFusion();
		const { ctx, calls } = makeCtx();
		try {
			await emit(events, "session_start", ctx);
			const handler = commands.get("fusion-sound")!.handler;
			await handler("not-a-sound", ctx);
			await handler("ask sounds/relative.wav", ctx);
			const warnings = calls.notifications.filter((n) => n.includes("invalid sound"));
			expect(warnings).toHaveLength(2);
		} finally {
			await emit(events, "session_shutdown", ctx);
		}
	});
});
