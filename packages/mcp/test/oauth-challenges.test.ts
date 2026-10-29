import { describe, expect, it } from "vitest";
import { parseWwwAuthenticate } from "../src/oauth/discovery.ts";
import { McpOAuthAuthorizationRequiredError } from "../src/oauth/errors.ts";
import { adaptOAuthProvider } from "../src/oauth/flow.ts";
import { McpOAuthProvider } from "../src/oauth/provider.ts";

describe("WWW-Authenticate challenges", () => {
	it.each([
		'Basic realm="gateway", Bearer resource_metadata="https://mcp.example/metadata", scope="tools:read"',
		'Bearer resource_metadata="https://mcp.example/metadata", scope="tools:read", Basic realm="gateway"',
		'Negotiate abc==, bEaReR resource_metadata="https://mcp.example/metadata", scope="tools:read"',
	])("finds a Bearer challenge in %s", (header) => {
		const challenge = parseWwwAuthenticate(header);
		expect(challenge.resourceMetadataUrl?.href).toBe("https://mcp.example/metadata");
		expect(challenge.scope).toBe("tools:read");
	});

	it("handles multiple header fields combined by Headers", () => {
		const headers = new Headers();
		headers.append("WWW-Authenticate", 'Basic realm="gateway"');
		headers.append("WWW-Authenticate", 'Bearer scope="tools:read"');
		expect(parseWwwAuthenticate(headers.get("www-authenticate")).scope).toBe("tools:read");
	});

	it("keeps fields within the first supported challenge", () => {
		const challenge = parseWwwAuthenticate(
			'Bearer realm="mcp", Basic realm="gateway", scope="basic-only", error="insufficient_scope"',
		);
		expect(challenge.scope).toBeUndefined();
		expect(challenge.error).toBeUndefined();
		expect(parseWwwAuthenticate('DPoP scope="first", Bearer scope="second"').scope).toBe("first");
	});

	it("does not treat commas or parameter-looking text inside quoted values as challenges or fields", () => {
		const challenge = parseWwwAuthenticate(
			'Basic realm="gateway, Bearer scope=wrong", Bearer error_description="Denied, scope=wrong", scope="right"',
		);
		expect(challenge.scope).toBe("right");
		expect(challenge.errorDescription).toBe("Denied, scope=wrong");
		expect(parseWwwAuthenticate('Bearer realm="scope=wrong"').scope).toBeUndefined();
	});

	it("decodes quoted pairs and accepts token values and whitespace around equals", () => {
		const challenge = parseWwwAuthenticate(
			String.raw`Bearer ERROR = insufficient_scope, scope = "read", error_description="say \"hello\", then retry"`,
		);
		expect(challenge.error).toBe("insufficient_scope");
		expect(challenge.scope).toBe("read");
		expect(challenge.errorDescription).toBe('say "hello", then retry');
	});

	it("ignores absent, unsupported, empty, and invalid metadata values", () => {
		expect(parseWwwAuthenticate(null)).toEqual({});
		expect(parseWwwAuthenticate(" ")).toEqual({});
		expect(parseWwwAuthenticate('Basic realm="gateway"')).toEqual({});
		expect(parseWwwAuthenticate('Bearer scope="", resource_metadata="not a URL"').scope).toBeUndefined();
		expect(parseWwwAuthenticate('Bearer resource_metadata="not a URL"').resourceMetadataUrl).toBeUndefined();
	});

	it("starts step-up authorization instead of refreshing when Bearer follows Basic", async () => {
		let authorization: URL | undefined;
		const provider = new McpOAuthProvider({
			serverUrl: "https://mcp.example/mcp",
			redirectUrl: "http://127.0.0.1/callback",
			clientId: "client",
			clientMetadata: {},
			onRedirect: (url) => {
				authorization = url;
			},
		});
		await provider.saveDiscoveryState({
			authorizationServerUrl: "https://auth.example",
			authorizationServerMetadata: {
				issuer: "https://auth.example",
				authorization_endpoint: "https://auth.example/authorize",
				token_endpoint: "https://auth.example/token",
				response_types_supported: ["code"],
			},
		});
		await provider.saveTokens({
			access_token: "dummy",
			refresh_token: "dummy-refresh",
			token_type: "Bearer",
			scope: "tools:read",
		});
		await expect(
			adaptOAuthProvider(provider).onUnauthorized?.({
				response: new Response(null, {
					status: 403,
					headers: {
						"WWW-Authenticate": 'Basic realm="gateway", Bearer error="insufficient_scope", scope="tools:write"',
					},
				}),
				serverUrl: new URL("https://mcp.example/mcp"),
				token: "dummy",
				fetch: async () => {
					throw new Error("Step-up must not make a refresh request");
				},
			}),
		).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		expect(authorization?.searchParams.get("scope")).toBe("tools:read tools:write");
	});
});
