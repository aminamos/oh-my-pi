import { afterAll, afterEach, beforeEach, describe, expect, mock, test, vi, type Mock } from "bun:test";

// The native WebRTC peer cannot run under `bun test` (offer creation stalls,
// verified with a scratch probe), so live signaling tests stub it at the
// module boundary. Restored in afterAll so files running later in the same
// runner process see the real implementation.
mock.module("@oh-my-pi/pi-natives", () => {
	class FakeLiveWebRtcPeer {
		async createOffer(): Promise<string> {
			return "v=0 fake offer";
		}
		async acceptAnswer(): Promise<void> {}
		async waitForOpen(): Promise<void> {}
		pushAudio(): void {}
		setMuted(): void {}
		async close(): Promise<void> {}
	}
	const deviceCheckGenerateToken = async () => ({ supported: false });
	return { LiveWebRtcPeer: FakeLiveWebRtcPeer, deviceCheckGenerateToken };
});

import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";
import {
	buildLiveSidebandUrl,
	CodexLiveTransport,
	parseLiveCallId,
	resolveLiveSignalingUrl,
} from "../../src/live/transport";
import { asGlobalFetch } from "../helpers/fetch-mock";

const SIGNALING_PATH = "/codex/realtime/calls?intent=quicksilver&architecture=avas";

const LIVE_ENV_KEYS = [
	"PI_CODEX_LIVE_SIGNALING_URL",
	"CODEX_LIVE_SIGNALING_URL",
	"PI_CODEX_BASE_URL",
	"CODEX_BASE_URL",
] as const;

type LiveEnvKey = (typeof LIVE_ENV_KEYS)[number];

const savedLiveEnv = {} as Record<LiveEnvKey, string | undefined>;

beforeEach(() => {
	for (const key of LIVE_ENV_KEYS) {
		savedLiveEnv[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const key of LIVE_ENV_KEYS) {
		const value = savedLiveEnv[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	vi.restoreAllMocks();
});

afterAll(() => {
	mock.restore();
});

describe("resolveLiveSignalingUrl", () => {
	test("falls back to the bundled Codex host when no overrides are set", () => {
		expect(resolveLiveSignalingUrl()).toBe(`${CODEX_BASE_URL}${SIGNALING_PATH}`);
	});

	test("appends the signaling path to a base URL and strips trailing slashes", () => {
		Bun.env.CODEX_BASE_URL = "https://proxy.example///";
		expect(resolveLiveSignalingUrl()).toBe(`https://proxy.example${SIGNALING_PATH}`);
	});

	test("prefers PI_CODEX_BASE_URL over CODEX_BASE_URL", () => {
		Bun.env.CODEX_BASE_URL = "https://codex-base.example";
		Bun.env.PI_CODEX_BASE_URL = "https://pi-base.example/";
		expect(resolveLiveSignalingUrl()).toBe(`https://pi-base.example${SIGNALING_PATH}`);
	});

	test("a full signaling URL override wins over base URLs", () => {
		Bun.env.PI_CODEX_BASE_URL = "https://pi-base.example";
		Bun.env.CODEX_LIVE_SIGNALING_URL = "https://full.example/hook";
		expect(resolveLiveSignalingUrl()).toBe("https://full.example/hook");
	});

	test("prefers PI_CODEX_LIVE_SIGNALING_URL over CODEX_LIVE_SIGNALING_URL", () => {
		Bun.env.CODEX_LIVE_SIGNALING_URL = "https://codex-full.example/hook";
		Bun.env.PI_CODEX_LIVE_SIGNALING_URL = "https://pi-full.example/hook";
		expect(resolveLiveSignalingUrl()).toBe("https://pi-full.example/hook");
	});

	test("trims overrides and ignores blank full URLs", () => {
		Bun.env.PI_CODEX_LIVE_SIGNALING_URL = "   ";
		Bun.env.CODEX_BASE_URL = "https://codex-base.example";
		expect(resolveLiveSignalingUrl()).toBe(`https://codex-base.example${SIGNALING_PATH}`);

		Bun.env.PI_CODEX_LIVE_SIGNALING_URL = "  https://pi-full.example/hook  ";
		expect(resolveLiveSignalingUrl()).toBe("https://pi-full.example/hook");
	});
});

describe("live call IDs and sideband URLs", () => {
	test("extracts the rtc call ID from a signaling Location header", () => {
		expect(parseLiveCallId("https://api.openai.com/v1/live/rtc_abc-123?foo=bar")).toBe("rtc_abc-123");
		expect(parseLiveCallId(null)).toBeUndefined();
		expect(parseLiveCallId("https://example.com/no-call-id")).toBeUndefined();
	});

	test("builds the sideband WebSocket URL for a call ID", () => {
		expect(buildLiveSidebandUrl("rtc_abc123")).toBe("wss://api.openai.com/v1/live/rtc_abc123");
	});
});

const FASTAPI_NOT_FOUND = JSON.stringify({ detail: "Not Found" });

// Structural OAuth stub covering both the current `oauth.access` seam and the
// older `getOAuthAccess` seam, so this file runs unmodified in mirrored trees.
function stubOAuthAccess(): { authStorage: AuthStorage; getOAuthAccess: Mock<() => Promise<{ accessToken: string }>> } {
	const getOAuthAccess = vi.fn(async () => ({ accessToken: "live-test-token" }));
	const authStorage = {
		getOAuthAccess,
		oauth: { access: getOAuthAccess },
		limits: { rotate: vi.fn(async () => false) },
	} as unknown as AuthStorage;
	return { authStorage, getOAuthAccess };
}

async function connectError(transport: CodexLiveTransport): Promise<string> {
	try {
		await transport.connect();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected live connect to reject on a 404 response");
}

describe("live signaling 404", () => {
	test("names a local host and points at the signaling env overrides", async () => {
		Bun.env.PI_CODEX_LIVE_SIGNALING_URL = "http://127.0.0.1:9/hook";
		const { authStorage, getOAuthAccess } = stubOAuthAccess();
		let requestUrl: string | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				requestUrl = String(input);
				return new Response(FASTAPI_NOT_FOUND, { status: 404, statusText: "Not Found" });
			}),
		);
		const transport = new CodexLiveTransport({
			authStorage,
			sessionId: "live-test-session",
			instructions: "test instructions",
			voice: "ash",
			callbacks: {
				onEvent: () => {},
				onOutputLevel: () => {},
			},
		});

		const message = await connectError(transport);

		expect(getOAuthAccess).toHaveBeenCalledWith("openai-codex", "live-test-session", { signal: undefined });
		expect(requestUrl).toBe("http://127.0.0.1:9/hook");
		expect(message).toContain("Codex live signaling failed (404)");
		expect(message).toContain("at host 127.0.0.1:9");
		expect(message).toContain('{"detail":"Not Found"}');
		expect(message).toContain("(local host detected");
		expect(message).toContain("PI_CODEX_LIVE_SIGNALING_URL");
	});

	test("names an upstream host with the retired or gated hint", async () => {
		Bun.env.PI_CODEX_LIVE_SIGNALING_URL = "https://example.invalid/hook";
		const { authStorage, getOAuthAccess } = stubOAuthAccess();
		let requestUrl: string | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				requestUrl = String(input);
				return new Response(FASTAPI_NOT_FOUND, { status: 404, statusText: "Not Found" });
			}),
		);
		const transport = new CodexLiveTransport({
			authStorage,
			sessionId: "live-test-session",
			instructions: "test instructions",
			voice: "ash",
			callbacks: {
				onEvent: () => {},
				onOutputLevel: () => {},
			},
		});

		const message = await connectError(transport);

		expect(getOAuthAccess).toHaveBeenCalledWith("openai-codex", "live-test-session", { signal: undefined });
		expect(requestUrl).toBe("https://example.invalid/hook");
		expect(message).toContain("Codex live signaling failed (404)");
		expect(message).toContain("at host example.invalid");
		expect(message).toContain('{"detail":"Not Found"}');
		expect(message).toContain("(upstream host");
	});
});
