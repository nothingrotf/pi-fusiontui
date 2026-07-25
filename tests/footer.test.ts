import { describe, expect, test } from "bun:test";
import { TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { installFooter } from "../extensions/fusion/footer";
import { createState, type FusionState } from "../extensions/fusion/state";

type FooterComponent = {
	dispose: () => void;
	invalidate: () => void;
	render: (width: number) => string[];
};
type FooterFactory = (tui: TUI, theme: unknown, footerData: unknown) => FooterComponent;

function makeTerminal() {
	const writes: string[] = [];
	return {
		terminal: {
			columns: 80,
			rows: 10,
			write(data: string) {
				writes.push(data);
			},
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
		},
		writes,
	};
}

const theme = { fg: (_c: string, text: string) => text } as unknown as Theme;

/**
 * Drives the real `installFooter` through a fake host: capture the factory Pi
 * would call, then invoke it with a real TUI so the scroll lock, the hooks and
 * the component contract are all exercised.
 */
function mount(state: FusionState = createState("/Users/dev/proj", "full")) {
	const { terminal, writes } = makeTerminal();
	const tui = new TUI(terminal);
	let factory: FooterFactory | undefined;
	const statuses = new Map<string, string>();
	const branchListeners: (() => void)[] = [];
	let branchUnsubs = 0;

	const ctx = {
		ui: {
			setFooter: (fn: FooterFactory) => {
				factory = fn;
			},
		},
	} as unknown as ExtensionContext;

	const hooks = {
		requestRender: undefined as ((force?: boolean) => void) | undefined,
		resync: undefined as (() => void) | undefined,
		owners: [] as symbol[],
		branchChanges: 0,
	};

	const handle = installFooter(
		ctx,
		() => state,
		{
			setRequestRender: (fn, owner) => {
				hooks.requestRender = fn;
				hooks.owners.push(owner);
			},
			setResync: (fn, owner) => {
				hooks.resync = fn;
				hooks.owners.push(owner);
			},
			onBranchChange: () => {
				hooks.branchChanges++;
			},
		},
	);

	const footerData = {
		getExtensionStatuses: () => statuses,
		onBranchChange: (fn: () => void) => {
			branchListeners.push(fn);
			return () => {
				branchUnsubs++;
			};
		},
	};

	const component = factory!(tui, theme, footerData);
	return {
		handle,
		component,
		hooks,
		statuses,
		state,
		writes,
		tui,
		fireBranchChange: () => branchListeners.forEach((fn) => fn()),
		branchUnsubs: () => branchUnsubs,
	};
}

describe("installFooter", () => {
	test("installs a footer factory and hands the hooks its own owner token", () => {
		const { handle, hooks } = mount();
		expect(handle.isOwned()).toBe(true);
		expect(typeof hooks.requestRender).toBe("function");
		expect(typeof hooks.resync).toBe("function");
		expect(hooks.owners.every((owner) => owner === handle.token)).toBe(true);
	});

	test("render delegates to the pure row layer, honouring mode and statuses", () => {
		const { component, state, statuses } = mount();
		expect(component.render(80)).toHaveLength(2);
		statuses.set("codex-goal", "goal: shipping");
		expect(component.render(80).join("")).toContain("goal: shipping");
		state.mode = "minimal";
		expect(component.render(80)).toHaveLength(1);
	});

	test("a branch change notifies the extension and repaints", () => {
		const { hooks, fireBranchChange } = mount();
		fireBranchChange();
		expect(hooks.branchChanges).toBe(1);
	});

	// M3: teardown must release everything this install owns, and only that.
	test("dispose drops ownership, clears the hooks and unsubscribes", () => {
		const { handle, component, hooks, branchUnsubs } = mount();
		component.dispose();
		expect(handle.isOwned()).toBe(false);
		expect(hooks.requestRender).toBeUndefined();
		expect(hooks.resync).toBeUndefined();
		expect(branchUnsubs()).toBe(1);
	});

	test("the handle keeps answering after dispose instead of throwing", () => {
		const { handle, component } = mount();
		component.dispose();
		expect(handle.isPaused()).toBe(false);
		expect(() => {
			handle.pause();
			handle.resume();
			handle.setActive(true);
			handle.handleInput("x");
		}).not.toThrow();
	});

	test("scroll-lock input routes through the handle", () => {
		const { handle, component } = mount();
		expect(handle.isPaused()).toBe(false);
		handle.handleInput("\x1b[5~"); // PageUp
		expect(handle.isPaused()).toBe(true);
		handle.resume();
		expect(handle.isPaused()).toBe(false);
		component.dispose();
	});
});

describe("footer resync hook", () => {
	const flush = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

	test("reprints the visible frame in place, never clearing scrollback", async () => {
		const { hooks, writes, tui, component } = mount();
		tui.addChild({ render: () => ["row 1", "row 2", "row 3"], invalidate() {} });
		tui.requestRender(true);
		await flush();
		writes.length = 0;

		hooks.resync!();
		const out = writes.join("");
		expect(out).toContain("\x1b[H"); // home
		expect(out).toContain("\x1b[2K"); // per-row erase
		expect(out).toContain("\x1b[0J"); // clear below the content
		// The two sequences that push a cleared screen into scrollback.
		expect(out).not.toContain("\x1b[2J");
		expect(out).not.toContain("\x1b[3J");
		component.dispose();
	});

	test("does nothing while the transcript is paused for reading", async () => {
		const { handle, hooks, writes, tui, component } = mount();
		tui.addChild({ render: () => ["row 1"], invalidate() {} });
		tui.requestRender(true);
		await flush();
		handle.handleInput("\x1b[5~"); // PageUp
		writes.length = 0;

		hooks.resync!();
		await flush();
		expect(writes.join("")).toBe("");
		component.dispose();
	});
});
