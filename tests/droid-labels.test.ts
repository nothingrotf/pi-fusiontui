import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DISPLAY, headerLabel, shortPath } from "../extensions/fusion/droid-labels";

const HOME = process.env.HOME;

// shortPath reads $HOME directly (not os.homedir()), so it is drivable here.
beforeEach(() => {
	process.env.HOME = "/Users/dev";
});

afterEach(() => {
	if (HOME === undefined) delete process.env.HOME;
	else process.env.HOME = HOME;
});

describe("shortPath", () => {
	test("abbreviates the home directory to ~", () => {
		expect(shortPath("/Users/dev")).toBe("~");
		expect(shortPath("/Users/dev/code")).toBe("~/code");
	});

	test("keeps at most the last three segments (droid UL0 = 3)", () => {
		expect(shortPath("/a/b/c")).toBe("/a/b/c");
		expect(shortPath("/a/b/c/d")).toBe(".../b/c/d");
		expect(shortPath("/Users/dev/one/two/three/four")).toBe(".../two/three/four");
	});

	test("does not treat a sibling of home as home", () => {
		expect(shortPath("/Users/developer/x")).toBe("/Users/developer/x");
	});

	test("normalizes windows separators before abbreviating", () => {
		expect(shortPath("C:\\a\\b\\c\\d")).toBe(".../b/c/d");
	});

	test("strips terminal control sequences out of the path", () => {
		expect(shortPath("/a/\x1b[31mb\x1b[0m")).toBe("/a/b");
	});

	test("survives an empty or non-string path", () => {
		expect(shortPath("")).toBe("");
		expect(shortPath(undefined as unknown as string)).toBe("");
	});
});

describe("headerLabel", () => {
	test("uses the abbreviated path for the file tools", () => {
		for (const tool of ["read", "edit", "write"]) {
			expect(headerLabel(tool, { path: "/Users/dev/a/b/c/d.ts" })).toBe(".../b/c/d.ts");
			expect(headerLabel(tool, { file_path: "/Users/dev/x.ts" })).toBe("~/x.ts");
			expect(headerLabel(tool, {})).toBe("");
		}
	});

	test("shows only the first line of a bash command", () => {
		expect(headerLabel("bash", { command: "ls -la\nrm -rf /" })).toBe("ls -la");
		expect(headerLabel("bash", {})).toBe("");
	});

	test("quotes the grep pattern and appends the search directory", () => {
		expect(headerLabel("grep", { pattern: "TODO" })).toBe('"TODO"');
		expect(headerLabel("grep", { pattern: "TODO", path: "/Users/dev/src" }))
			.toBe('"TODO" in ~/src');
		expect(headerLabel("grep", { path: "/Users/dev/src" })).toBe("");
	});

	test("find shows the glob, ls falls back to 'current directory'", () => {
		expect(headerLabel("find", { pattern: "**/*.ts" })).toBe("**/*.ts");
		expect(headerLabel("ls", {})).toBe("current directory");
		expect(headerLabel("ls", { path: "/Users/dev/src" })).toBe("~/src");
	});

	test("an unknown tool has no label", () => {
		expect(headerLabel("mcp__something", { path: "/x" })).toBe("");
	});

	test("never lets tool args inject control sequences or newlines into the row", () => {
		const label = headerLabel("bash", { command: "echo \x1b[2Jhi\rthere" });
		expect(label).not.toContain("\x1b[2J");
		expect(label).not.toContain("\n");
		expect(label).not.toContain("\r");
	});
});

describe("DISPLAY", () => {
	test("maps every built-in Pi tool to its droid display name", () => {
		expect(DISPLAY).toEqual({
			read: "Read",
			bash: "Execute",
			edit: "Edit",
			write: "Create",
			grep: "Grep",
			find: "Glob",
			ls: "LS",
		});
	});
});
