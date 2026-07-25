import { afterEach, describe, expect, test } from "bun:test";
import {
	AssistantMessageComponent,
	UserMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	patchAssistantIcon,
	patchUserGutter,
	unpatchAssistantIcon,
	unpatchUserGutter,
} from "../extensions/fusion/droid-patches";

initTheme();

afterEach(() => {
	unpatchAssistantIcon();
	unpatchUserGutter();
});

const stripCtl = (s: string) =>
	s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const assistant = (message: unknown) =>
	new AssistantMessageComponent(message as never, {} as never);

const assistantText = (text: string) =>
	assistant({ role: "assistant", content: [{ type: "text", text }] });

const AGENT_ICON = "⛬";

describe("patchAssistantIcon", () => {
	test("puts the droid icon on the first real text line", () => {
		patchAssistantIcon();
		const lines = assistantText("hello world").render(40).map(stripCtl);
		const iconLines = lines.filter((line) => line.includes(AGENT_ICON));
		expect(iconLines).toHaveLength(1);
		expect(iconLines[0]!.trimStart().startsWith(AGENT_ICON)).toBe(true);
		expect(lines.join("\n")).toContain("hello world");
	});

	test("indents the continuation lines to the same gutter", () => {
		patchAssistantIcon();
		const lines = assistantText("first line\n\nsecond line").render(40).map(stripCtl);
		expect(lines.filter((line) => line.includes(AGENT_ICON))).toHaveLength(1);
		const second = lines.find((line) => line.includes("second line"))!;
		expect(second.startsWith("  ")).toBe(true);
	});

	test("replaces Pi's abort notice with the droid interrupted marker", () => {
		patchAssistantIcon();
		const rendered = assistantText("Operation aborted").render(40).map(stripCtl).join("\n");
		expect(rendered).toContain("⎿");
		expect(rendered).not.toContain("Operation aborted");
	});

	test("gives an error notice its own bullet", () => {
		patchAssistantIcon();
		const rendered = assistantText("Error: something broke").render(60).map(stripCtl).join("\n");
		expect(rendered).toContain("●");
		expect(rendered).toContain("Error: something broke");
	});

	test("every line still fits the requested width", () => {
		patchAssistantIcon();
		const component = assistantText("a fairly long assistant answer that will need wrapping");
		for (const width of [3, 10, 20, 40, 120]) {
			for (const line of component.render(width)) {
				expect(`${width}:${visibleWidth(line) <= width}`).toBe(`${width}:true`);
			}
		}
	});

	// M3: the patch must be restorable, and reinstalling must not stack.
	test("patch is idempotent and unpatch restores the original render", () => {
		const proto = AssistantMessageComponent.prototype as unknown as {
			render: unknown;
		};
		const original = proto.render;
		patchAssistantIcon();
		const installed = proto.render;
		patchAssistantIcon();
		expect(proto.render).toBe(installed);
		unpatchAssistantIcon();
		expect(proto.render).toBe(original);
		unpatchAssistantIcon();
		expect(proto.render).toBe(original);
	});

	test("does not restore over a patch another extension installed later", () => {
		const proto = AssistantMessageComponent.prototype as unknown as { render: unknown };
		patchAssistantIcon();
		const foreign = function () {
			return ["foreign"];
		};
		proto.render = foreign;
		unpatchAssistantIcon();
		expect(proto.render).toBe(foreign);
	});
});

describe("patchUserGutter", () => {
	test("renders a gutter bar and keeps the prompt text", () => {
		patchUserGutter();
		const lines = new UserMessageComponent("hi there" as never, {} as never).render(30);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.map(stripCtl).join("\n")).toContain("hi there");
	});

	test("drops the blank background rows droid does not have", () => {
		patchUserGutter();
		const patched = new UserMessageComponent("hi there" as never, {} as never).render(30);
		unpatchUserGutter();
		const plain = new UserMessageComponent("hi there" as never, {} as never).render(30);
		expect(patched.length).toBeLessThan(plain.length);
	});

	test("keeps the OSC 133 shell-integration markers at the block edges", () => {
		patchUserGutter();
		const lines = new UserMessageComponent("hi there" as never, {} as never).render(30);
		expect(lines[0]!.startsWith("\x1b]133;A\x07")).toBe(true);
		expect(lines[lines.length - 1]!).toContain("\x1b]133;B\x07");
		expect(lines[lines.length - 1]!).toContain("\x1b]133;C\x07");
	});

	test("every line still fits the requested width", () => {
		patchUserGutter();
		const component = new UserMessageComponent(
			"a fairly long user prompt that has to wrap somewhere" as never,
			{} as never,
		);
		for (const width of [3, 10, 20, 40, 120]) {
			for (const line of component.render(width)) {
				expect(`${width}:${visibleWidth(line) <= width}`).toBe(`${width}:true`);
			}
		}
	});

	test("patch is idempotent and unpatch restores the original render", () => {
		const proto = UserMessageComponent.prototype as unknown as { render: unknown };
		const original = proto.render;
		patchUserGutter();
		const installed = proto.render;
		patchUserGutter();
		expect(proto.render).toBe(installed);
		unpatchUserGutter();
		expect(proto.render).toBe(original);
		unpatchUserGutter();
		expect(proto.render).toBe(original);
	});
});
