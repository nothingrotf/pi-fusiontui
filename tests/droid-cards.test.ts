import { afterEach, describe, expect, test } from "bun:test";
import {
	ToolExecutionComponent,
	initTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installDroidTools } from "../extensions/fusion/droid-cards";
import {
	patchToolFallbacks,
	unpatchToolFallbacks,
} from "../extensions/fusion/droid-patches";
import { resetDroidSession } from "../extensions/fusion/droid-shimmer";

// Pi's own fallback rendering reads the global theme, which normally only
// exists inside a running app. Constructing a ToolExecutionComponent touches it
// before any of our patches run, so initialize it once for the whole file.
initTheme();

afterEach(() => {
	unpatchToolFallbacks();
	resetDroidSession();
});

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function fakePi() {
	const registered: { name: string; renderShell?: string }[] = [];
	const pi = {
		registerTool: (tool: { name: string; renderShell?: string }) => registered.push(tool),
	} as unknown as ExtensionAPI;
	return { pi, registered };
}

/** Build a real ToolExecutionComponent under the droid patches. */
function card(
	tool: string,
	args: Record<string, unknown>,
	result?: { content: { type: string; text?: string }[]; details?: unknown; isError: boolean },
) {
	const component = new ToolExecutionComponent(
		tool,
		`${tool}-call`,
		args,
		{},
		undefined,
		{ requestRender() {} } as never,
		process.cwd(),
	);
	if (result) component.updateResult(result);
	return component;
}

const text = (content: string, isError = false) => ({
	content: [{ type: "text", text: content }],
	isError,
});

describe("installDroidTools", () => {
	test("re-registers every built-in tool with a self-rendered shell", () => {
		const { pi, registered } = fakePi();
		const skipped = installDroidTools(pi, "/tmp", new Set());
		expect(skipped).toEqual([]);
		expect(registered.map((t) => t.name).sort()).toEqual([
			"bash",
			"edit",
			"find",
			"grep",
			"ls",
			"read",
			"write",
		]);
		for (const tool of registered) expect(tool.renderShell).toBe("self");
	});

	// Registering a name another extension owns trips Pi's conflict check.
	test("skips tools already owned by another extension and reports them", () => {
		const { pi, registered } = fakePi();
		const skipped = installDroidTools(pi, "/tmp", new Set(["edit", "bash"]));
		expect(skipped.sort()).toEqual(["bash", "edit"]);
		expect(registered.map((t) => t.name)).not.toContain("edit");
		expect(registered.map((t) => t.name)).not.toContain("bash");
	});

	test("skipping everything registers nothing", () => {
		const { pi, registered } = fakePi();
		const all = ["read", "bash", "edit", "write", "grep", "find", "ls"];
		expect(installDroidTools(pi, "/tmp", new Set(all)).sort()).toEqual([...all].sort());
		expect(registered).toEqual([]);
	});
});

describe("droid tool cards", () => {
	test("bypasses Pi's colored Box shell for every tool", () => {
		patchToolFallbacks();
		for (const tool of ["read", "bash", "grep", "mcp__server__thing"]) {
			const component = card(tool, { path: "/tmp/a.ts", command: "ls", pattern: "x" });
			expect(
				(component as unknown as { getRenderShell(): string }).getRenderShell(),
			).toBe("self");
			const rendered = component.render(80).join("\n");
			expect(rendered).not.toContain("╭");
			expect(rendered).not.toContain("\x1b[48;");
		}
	});

	test("renders the droid display name and its header label", () => {
		patchToolFallbacks();
		const rendered = stripAnsi(card("bash", { command: "ls -la" }).render(80).join("\n"));
		expect(rendered).toContain("Execute");
		expect(rendered).toContain("ls -la");
	});

	test("summarizes a successful read as a line count", () => {
		patchToolFallbacks();
		const rendered = stripAnsi(
			card("read", { path: "/tmp/a.ts" }, text("a\nb\nc")).render(80).join("\n"),
		);
		expect(rendered).toContain("Read");
		expect(rendered).toMatch(/3 lines/);
	});

	test("marks an errored result as an error", () => {
		patchToolFallbacks();
		const rendered = stripAnsi(
			card("bash", { command: "false" }, text("boom", true)).render(80).join("\n"),
		);
		expect(rendered.toLowerCase()).toContain("error");
	});

	test("colorizes a diff and keeps both sides of the change", () => {
		patchToolFallbacks();
		const rendered = card(
			"edit",
			{ path: "/tmp/a.ts", old_string: "old", new_string: "new" },
			{ ...text(""), details: { diff: "@@ -1 +1 @@\n-old\n+new" } },
		)
			.render(80)
			.join("\n");
		expect(stripAnsi(rendered)).toContain("-old");
		expect(stripAnsi(rendered)).toContain("+new");
		expect(rendered).toContain("\x1b["); // the diff is colored, not plain
	});

	// M2: a card must fit whatever width it is handed, at any terminal size.
	test("every rendered line fits the requested width", () => {
		patchToolFallbacks();
		const component = card(
			"bash",
			{ command: "a-very-long-command --with --plenty --of --flags --to --overflow" },
			text("out\n".repeat(20)),
		);
		for (const width of [1, 2, 5, 10, 20, 40, 80, 200]) {
			for (const line of component.render(width)) {
				expect(`${width}:${visibleWidth(line) <= width}`).toBe(`${width}:true`);
			}
		}
	});

	// L4-07: a huge tool output must not expand the transcript without bound.
	test("bounds a huge output and says how much was hidden", () => {
		patchToolFallbacks();
		const component = card("bash", { command: "yes" }, text("line\n".repeat(500)));
		(component as unknown as { expanded: boolean }).expanded = true;
		const lines = component.render(80);
		expect(lines.length).toBeLessThan(120);
		expect(stripAnsi(lines.join("\n"))).toContain("more lines");
	});

	// L4-02: tool text must never inject physical rows or cursor moves.
	test("sanitizes control sequences out of tool output", () => {
		patchToolFallbacks();
		const rendered = card(
			"bash",
			{ command: "evil" },
			text("before\x1b[2J\x1b[10Aafter"),
		)
			.render(80)
			.join("");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toContain("\x1b[10A");
	});

	test("a still-running call renders a header with no result section", () => {
		patchToolFallbacks();
		const lines = card("read", { path: "/tmp/a.ts" }).render(80);
		expect(stripAnsi(lines.join("\n"))).toContain("Read");
		expect(stripAnsi(lines.join("\n"))).not.toContain("↳");
	});

	test("unknown MCP tools get a generic card rather than Pi's fallback box", () => {
		patchToolFallbacks();
		const rendered = stripAnsi(
			card("mcp__linear__create_issue", { title: "x" }, text("done")).render(80).join("\n"),
		);
		expect(rendered).not.toContain("╭");
		expect(rendered.trim().length).toBeGreaterThan(0);
	});
});

describe("patchToolFallbacks", () => {
	test("unpatching restores Pi's own shell decision", () => {
		patchToolFallbacks();
		const patched = card("read", { path: "/tmp/a.ts" });
		expect((patched as unknown as { getRenderShell(): string }).getRenderShell()).toBe("self");
		unpatchToolFallbacks();
		const restored = card("read", { path: "/tmp/a.ts" });
		expect((restored as unknown as { getRenderShell(): string }).getRenderShell()).not.toBe(
			"self",
		);
	});

	test("patching twice and unpatching twice are both safe", () => {
		expect(() => {
			patchToolFallbacks();
			patchToolFallbacks();
			unpatchToolFallbacks();
			unpatchToolFallbacks();
		}).not.toThrow();
	});
});
