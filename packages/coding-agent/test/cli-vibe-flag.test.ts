import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { shouldEnableVibeAtStartup } from "../src/main";

describe("parseArgs --vibe flag", () => {
	it("parses --vibe as a boolean flag", () => {
		const result = parseArgs(["--vibe"]);
		expect(result.vibe).toBe(true);
	});

	it("does not consume the following resume flag or prompt", () => {
		const result = parseArgs(["--vibe", "--continue", "inspect the resumed session"]);
		expect(result.vibe).toBe(true);
		expect(result.continue).toBe(true);
		expect(result.messages).toEqual(["inspect the resumed session"]);
	});

	it("defaults to undefined when omitted", () => {
		expect(parseArgs([]).vibe).toBeUndefined();
	});
});

describe("startup vibe dispatch", () => {
	it("enters vibe mode for a fresh session when requested", () => {
		expect(shouldEnableVibeAtStartup(true, false)).toBe(true);
	});

	it("does not toggle off vibe mode restored during resume", () => {
		expect(shouldEnableVibeAtStartup(true, true)).toBe(false);
	});

	it("does not enter vibe mode when the flag is absent", () => {
		expect(shouldEnableVibeAtStartup(false, false)).toBe(false);
	});
});
