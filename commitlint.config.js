/**
 * Conventional Commits linting.
 * Docs: https://www.conventionalcommits.org
 * Run manually: npx commitlint --edit
 */
export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"type-enum": [
			2,
			"always",
			[
				"feat", // a new feature
				"fix", // a bug fix
				"docs", // documentation only
				"style", // formatting, no code change
				"refactor", // code change that neither fixes a bug nor adds a feature
				"perf", // performance improvement
				"test", // adding or fixing tests
				"build", // build system or dependencies
				"ci", // CI configuration
				"chore", // tooling / housekeeping
				"revert", // revert a previous commit
			],
		],
		"scope-enum": [
			2,
			"always",
			["editor", "footer", "usage", "git", "format", "theme", "state", "config", "deps", "release"],
		],
		"scope-empty": [0],
		"subject-case": [2, "never", ["upper-case", "pascal-case", "start-case"]],
		"header-max-length": [2, "always", 100],
	},
};
