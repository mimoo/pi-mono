/**
 * Anthropic Opus 4.5 with image input + weather web search.
 *
 * 1) Describes a hardcoded image file.
 * 2) Searches for New York weather for the next two weeks.
 *
 * Uses ANTHROPIC_API_KEY from environment, with a fallback that reads `.env`
 * from the current directory (and up to two parent directories).
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import type { AgentSession, PromptOptions } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";

const MODEL_PROVIDER = "anthropic";
const MODEL_ID = "claude-opus-4-5";
const IMAGE_PATH = "/Users/david/Downloads/Screenshot 2026-02-17 at 16.28.10.png";
const NATIVE_WEB_SEARCH_UNAVAILABLE = "NATIVE_WEB_SEARCH_UNAVAILABLE";

function parseAnthropicApiKey(envContent: string): string | undefined {
	for (const line of envContent.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

		const match = trimmed.match(/^(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.+)$/);
		if (!match) continue;

		let value = match[1].trim();
		if (value.length === 0) continue;

		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		return value;
	}
	return undefined;
}

function getAnthropicApiKey(): string {
	const keyFromEnv = process.env.ANTHROPIC_API_KEY?.trim();
	if (keyFromEnv) return keyFromEnv;

	const envPaths = [
		resolve(process.cwd(), ".env"),
		resolve(process.cwd(), "..", ".env"),
		resolve(process.cwd(), "..", "..", ".env"),
	];

	for (const envPath of envPaths) {
		if (!existsSync(envPath)) continue;
		const content = readFileSync(envPath, "utf8");
		const parsed = parseAnthropicApiKey(content);
		if (parsed) {
			process.env.ANTHROPIC_API_KEY = parsed;
			return parsed;
		}
	}

	throw new Error(
		"ANTHROPIC_API_KEY was not found. Set it in your environment or in a .env file (ANTHROPIC_API_KEY=...).",
	);
}

function getImageMimeType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			throw new Error(`Unsupported image file extension for ${path}`);
	}
}

function loadImage(imagePath: string): ImageContent {
	if (!existsSync(imagePath)) {
		throw new Error(`Image not found: ${imagePath}`);
	}
	const bytes = readFileSync(imagePath);
	return {
		type: "image",
		data: bytes.toString("base64"),
		mimeType: getImageMimeType(imagePath),
	};
}

function formatDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

interface PromptCaptureResult {
	text: string;
	usedTools: string[];
}

function assertNativeWebSearchOrThrow(result: PromptCaptureResult): void {
	if (result.usedTools.length > 0) {
		throw new Error(
			`Native web search required, but local tools were used: ${result.usedTools.join(", ")}. ` +
				"Disable fallback behavior and retry.",
		);
	}

	if (result.text.includes(NATIVE_WEB_SEARCH_UNAVAILABLE)) {
		throw new Error("Model reported that native web search is unavailable.");
	}

	const lower = result.text.toLowerCase();
	const fallbackIndicators = [
		"don't have native web search",
		"do not have native web search",
		"no native web search",
		"cannot access the web",
		"can't access the web",
		"using command-line tools",
		"using the bash tool",
		"native web search is unavailable",
	];
	if (fallbackIndicators.some((indicator) => lower.includes(indicator))) {
		throw new Error("Model response indicates native web search was unavailable.");
	}

	const urlPattern = /https?:\/\/\S+/i;
	if (!urlPattern.test(result.text)) {
		throw new Error("No source URLs were returned; refusing to accept non-native or unverified weather output.");
	}
}

async function promptAndCapture(
	session: AgentSession,
	text: string,
	options?: PromptOptions,
): Promise<PromptCaptureResult> {
	let output = "";
	const usedTools = new Set<string>();
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			output += event.assistantMessageEvent.delta;
		}
		if (event.type === "tool_execution_start") {
			usedTools.add(event.toolName);
		}
	});
	try {
		await session.prompt(text, options);
		return {
			text: output.trim(),
			usedTools: [...usedTools],
		};
	} finally {
		unsubscribe();
	}
}

const apiKey = getAnthropicApiKey();
const model = getModel(MODEL_PROVIDER, MODEL_ID);
if (!model) {
	throw new Error(`Model not found: ${MODEL_PROVIDER}/${MODEL_ID}`);
}

const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey(MODEL_PROVIDER, apiKey);
const modelRegistry = new ModelRegistry(authStorage);

const sessionOptions: CreateAgentSessionOptions = {
	model,
	authStorage,
	modelRegistry,
	sessionManager: SessionManager.inMemory(),
	tools: [],
	nativeTools: {
		webSearch: {
			userLocation: {
				type: "approximate",
				city: "New York",
				region: "New York",
				country: "US",
				timezone: "America/New_York",
			},
		},
	},
};
const { session } = await createAgentSession(sessionOptions);

try {
	const image = loadImage(IMAGE_PATH);
	const imageResult = await promptAndCapture(
		session,
		"Describe this image. Include the key visual details and any visible text.",
		{ images: [image] },
	);

	console.log("=== Image Description ===");
	console.log(imageResult.text || "(No response text)");
	console.log();

	const start = new Date();
	const end = new Date(start);
	end.setDate(start.getDate() + 13);

	const weatherResult = await promptAndCapture(
		session,
		[
			`Use ONLY native web search to find New York City weather from ${formatDate(start)} to ${formatDate(end)}.`,
			"Use no local tools. Use provider-native web search only.",
			"Return a day-by-day two-week forecast with highs/lows and precipitation chances.",
			"Include source URLs you actually used.",
			`If native web search is unavailable, respond with exactly: ${NATIVE_WEB_SEARCH_UNAVAILABLE}`,
		].join(" "),
	);
	assertNativeWebSearchOrThrow(weatherResult);

	console.log("=== NYC Weather (Next 2 Weeks) ===");
	console.log(weatherResult.text || "(No response text)");
} finally {
	session.dispose();
}
