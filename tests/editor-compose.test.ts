import { describe, expect, test } from "bun:test";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager as TuiKeybindingsManager,
	TUI,
	TUI_KEYBINDINGS,
	type EditorTheme,
} from "@earendil-works/pi-tui";
import { createFusionEditor, type EditorMeta } from "../extensions/fusion/editor";

/** Minimal fake terminal (same contract as scroll-lock.test.ts). */
function makeTerminal(rows = 24, columns = 80) {
	return {
		columns,
		rows,
		write() {},
		start() {},
		stop() {},
		drainInput: async () => {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		kittyProtocolActive: false,
	};
}

const id = (text: string) => text;
const editorTheme: EditorTheme = {
	borderColor: id,
	selectList: {
		selectedPrefix: id,
		selectedText: id,
		description: id,
		scrollInfo: id,
		noMatch: id,
	},
};

// The skin resolves colors through the live DROID palette (theme.ts fg falls
// back to raw text when a token is unknown), so a structural stand-in works.
const uiTheme = { fg: (_color: string, text: string) => text } as never;

const idleMeta: EditorMeta = {
	modelLabel: "Fable 5",
	effortLabel: "High",
	agent: "idle",
	workingLabel: "",
};

const deps = () => {
	const tui = new TUI(makeTerminal() as never);
	// pi-coding-agent's KeybindingsManager subclass is type-only at the package
	// root; CustomEditor only calls `.matches()`, which the pi-tui base provides.
	const keybindings = new TuiKeybindingsManager(
		TUI_KEYBINDINGS,
	) as unknown as KeybindingsManager;
	return { tui, keybindings };
};

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("composer composition (createFusionEditor)", () => {
	test("without a foreign factory: renders the droid bubble + meta row", () => {
		const { tui, keybindings } = deps();
		const editor = createFusionEditor(tui, editorTheme, keybindings, uiTheme, () => idleMeta);
		const lines = editor.render(60).map(strip);
		expect(lines[1]).toContain("Fable 5 (High)"); // meta prelude row
		expect(lines[2].trimStart().startsWith("╭")).toBe(true);
		expect(lines.at(-1)?.trimStart().startsWith("╰")).toBe(true);
		expect(lines.some((l) => l.includes("│ >"))).toBe(true); // chevron rail
		editor.dispose();
	});

	test("composes a foreign CustomEditor subclass: its handleInput survives under the bubble", () => {
		const { tui, keybindings } = deps();
		const seen: string[] = [];
		class ForeignEditor extends CustomEditor {
			override handleInput(data: string): void {
				seen.push(data); // e.g. rpiv's DOWN-from-empty lane gesture
				super.handleInput(data);
			}
		}
		const editor = createFusionEditor(
			tui,
			editorTheme,
			keybindings,
			uiTheme,
			() => idleMeta,
			() => true,
			(t, th, kb) => new ForeignEditor(t as never, th as EditorTheme, kb as never),
		);
		// Foreign behavior: the subclass sees every keystroke.
		editor.handleInput("\x1b[B"); // DOWN
		editor.handleInput("a");
		expect(seen).toEqual(["\x1b[B", "a"]);
		expect(editor.getText()).toBe("a");
		// Fusion presentation: the SAME instance renders the droid bubble.
		const lines = editor.render(60).map(strip);
		expect(lines[2].trimStart().startsWith("╭")).toBe(true);
		expect(lines.some((l) => l.includes("│ >"))).toBe(true);
		expect(lines.some((l) => l.includes("a"))).toBe(true); // typed text inside the box
		editor.dispose();
	});

	test("broken foreign factory (throws / wrong shape) falls back to a plain CustomEditor", () => {
		const { tui, keybindings } = deps();
		const throwing = createFusionEditor(
			tui,
			editorTheme,
			keybindings,
			uiTheme,
			() => idleMeta,
			() => true,
			() => {
				throw new Error("boom");
			},
		);
		expect(throwing.render(60).map(strip)[2].trimStart().startsWith("╭")).toBe(true);
		throwing.dispose();

		const wrongShape = createFusionEditor(
			tui,
			editorTheme,
			keybindings,
			uiTheme,
			() => idleMeta,
			() => true,
			() => ({ notAnEditor: true }),
		);
		expect(wrongShape.render(60).map(strip)[2].trimStart().startsWith("╭")).toBe(true);
		wrongShape.dispose();
	});

	test("locks foreign padding at 0 so the bubble math holds", () => {
		const { tui, keybindings } = deps();
		const editor = createFusionEditor(tui, editorTheme, keybindings, uiTheme, () => idleMeta);
		editor.setPaddingX(4); // interactive-mode copies the user's editorPaddingX
		const lines = editor.render(40).map(strip);
		// A padded base render would shift the rules/content and break the box fit.
		expect(lines[2].trimStart().startsWith("╭")).toBe(true);
		expect(lines.some((l) => l.includes("│ >"))).toBe(true);
		editor.dispose();
	});
});
