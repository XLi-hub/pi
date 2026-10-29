import { describe, expect, it, vi } from "vitest";
import { McpOAuthProvider, type McpOAuthStateStore, MemoryOAuthStateStore } from "../src/oauth/provider.ts";

function createProvider(store: McpOAuthStateStore): McpOAuthProvider {
	return new McpOAuthProvider({
		serverUrl: "https://mcp.example/mcp",
		redirectUrl: "http://127.0.0.1/callback",
		clientMetadata: {},
		store,
		onRedirect() {},
	});
}

describe("OAuth state-store recovery", () => {
	it("reports a failed save while allowing reads, retries, and invalidation afterward", async () => {
		const memory = new MemoryOAuthStateStore();
		const save = vi.fn((state: Parameters<McpOAuthStateStore["save"]>[0]) => memory.save(state));
		const provider = createProvider({ load: () => memory.load(), save });
		const original = { access_token: "original", token_type: "Bearer" };
		await provider.saveTokens(original);
		const failure = new Error("transient save failure");
		save.mockImplementationOnce(() => {
			throw failure;
		});
		await expect(provider.saveTokens({ access_token: "failed", token_type: "Bearer" })).rejects.toBe(failure);
		expect(await provider.tokens()).toEqual(original);
		const replacement = { access_token: "replacement", token_type: "Bearer" };
		await provider.saveTokens(replacement);
		expect(await provider.tokens()).toEqual(replacement);
		await provider.invalidateCredentials("all");
		expect(await provider.tokens()).toBeUndefined();
		expect(save).toHaveBeenCalledTimes(4);
	});

	it("continues queued writes in order after an asynchronous save rejection", async () => {
		const memory = new MemoryOAuthStateStore();
		const failure = new Error("async save failure");
		const save = vi.fn(async (state: Parameters<McpOAuthStateStore["save"]>[0]) => memory.save(state));
		save.mockRejectedValueOnce(failure);
		const provider = createProvider({ load: () => memory.load(), save });
		const first = provider.saveTokens({ access_token: "failed", token_type: "Bearer" });
		const client = provider.saveClientInformation({ client_id: "saved-client" });
		const verifier = provider.saveCodeVerifier("saved-verifier");
		const results = await Promise.allSettled([first, client, verifier]);
		expect(results).toEqual([
			{ status: "rejected", reason: failure },
			{ status: "fulfilled", value: undefined },
			{ status: "fulfilled", value: undefined },
		]);
		expect(await provider.clientInformation()).toEqual({ client_id: "saved-client" });
		expect(await provider.codeVerifier()).toBe("saved-verifier");
		expect(await provider.tokens()).toBeUndefined();
		expect(save).toHaveBeenCalledTimes(3);
	});

	it("recovers when loading the state for a write fails", async () => {
		const memory = new MemoryOAuthStateStore();
		const failure = new Error("transient load failure");
		const load = vi.fn(async () => memory.load()).mockRejectedValueOnce(failure);
		const provider = createProvider({ load, save: (state) => memory.save(state) });
		await expect(provider.saveCodeVerifier("failed")).rejects.toBe(failure);
		await provider.saveCodeVerifier("retried");
		expect(await provider.codeVerifier()).toBe("retried");
	});
});
