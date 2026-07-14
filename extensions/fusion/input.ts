export type FocusInputResult = { consume?: boolean; data?: string } | undefined;

/**
 * Remove focus-report CSI sequences from terminal input without dropping
 * surrounding editor bytes (for example `a\x1b[Ib` becomes `ab`). The tiny
 * suffix buffer handles an ESC/ESC[ split across input packets; reset it on
 * session teardown so stale bytes cannot leak into a later session.
 */
export class FocusInputParser {
	private pending = "";

	constructor(private readonly onFocus: (focused: boolean) => void) {}

	reset(): void {
		this.pending = "";
	}

	parse(data: string): FocusInputResult {
		if (!data && !this.pending) return undefined;
		const input = this.pending + data;
		this.pending = "";
		let remaining = "";
		let consumed = false;
		for (let i = 0; i < input.length;) {
			if (input.startsWith("\x1b[I", i)) {
				this.onFocus(true);
				consumed = true;
				i += 3;
				continue;
			}
			if (input.startsWith("\x1b[O", i)) {
				this.onFocus(false);
				consumed = true;
				i += 3;
				continue;
			}
			// Keep only a possible incomplete focus sequence. Other ESC input is
			// editor data and must be preserved unchanged.
			const suffix = input.slice(i);
			if (suffix === "\x1b" || suffix === "\x1b[") {
				this.pending = suffix;
				break;
			}
			remaining += input[i] ?? "";
			i++;
		}
		if (remaining.length > 0) return { data: remaining };
		return consumed ? { consume: true } : undefined;
	}
}
