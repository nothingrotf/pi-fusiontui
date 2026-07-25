import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
	const pi = {
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		on: (event: string, handler: unknown) => {
			events.set(event, [...(events.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	activate(pi);
	return { commands, events };
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
