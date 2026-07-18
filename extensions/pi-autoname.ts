import { complete, getApiProvider } from "@earendil-works/pi-ai/compat";
import type { Model, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_PROMPT = `You are a session title generator.

Given the user's message(s), write a short, concise, descriptive title for the conversation.
- Use the same language as the message.
- Output ONLY the title text.
- Do not add quotes, explanations, or punctuation.
- Maximum 50 characters.`;

type ThinkingMode = "default" | "low" | "off";

interface AutonameConfig {
	enabled: boolean;
	prompt: string;
	model: string | null; // "provider/modelId" or null to use current conversation model
	maxLength: number;
	thinking: ThinkingMode;
}

const DEFAULT_CONFIG: AutonameConfig = {
	enabled: true,
	prompt: DEFAULT_PROMPT,
	model: null,
	maxLength: 50,
	thinking: "default",
};

type GenStatus = "idle" | "generating" | "success" | "error";

interface LastGeneration {
	status: GenStatus;
	timestamp: number;
	modelUsed: string;
	request: { systemPrompt: string; userText: string };
	response?: string;
	stopReason?: string;
	rawContent?: string;
	title?: string;
	error?: string;
}

function getConfigPath(): string {
	return join(getAgentDir(), "pi-autoname.json");
}

async function loadConfig(): Promise<AutonameConfig> {
	try {
		const raw = await readFile(getConfigPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<AutonameConfig>;
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

async function saveConfig(config: AutonameConfig): Promise<void> {
	await mkdir(getAgentDir(), { recursive: true });
	await writeFile(getConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

function resolveModel(ctx: ExtensionContext, spec: string | null): Model<any> | undefined {
	if (!spec) return ctx.model;
	const parts = spec.split("/");
	if (parts.length === 2) return ctx.modelRegistry.find(parts[0], parts[1]);
	return ctx.modelRegistry.getAvailable().find((m) => m.id === spec);
}

function sanitizeTitle(raw: string, maxLength: number): string {
	let t = raw
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (t.length > maxLength) t = t.slice(0, maxLength).trimEnd();
	return t;
}

function isUserMessageEntry(entry: { type: string; message?: { role?: string } }): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}

function extractUserText(entry: { message?: { content?: Array<{ type: string; text?: string }> } }): string | undefined {
	const text = entry.message?.content
		?.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join(" ")
		.trim();
	return text || undefined;
}

function isDebugDump(text: string): boolean {
	return (
		text.includes("Autoname Debug") ||
		text.includes("Raw content array:") ||
		text.includes("Generated title:")
	);
}

function getFirstAndLatestUserText(ctx: ExtensionContext): { first: string; latest: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	let first: string | undefined;
	const userTexts: string[] = [];
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = extractUserText(entry);
		if (!text) continue;
		if (first === undefined) first = text;
		userTexts.push(text);
	}
	if (!first) return undefined;

	// Skip pasted /autoname-debug dumps when picking the latest message
	let latest: string | undefined;
	for (let i = userTexts.length - 1; i >= 0; i--) {
		if (!isDebugDump(userTexts[i])) {
			latest = userTexts[i];
			break;
		}
	}
	return { first, latest: latest ?? userTexts[userTexts.length - 1]! };
}

function getNamingText(ctx: ExtensionContext): string | undefined {
	const pair = getFirstAndLatestUserText(ctx);
	if (!pair) return undefined;
	if (pair.first === pair.latest) return pair.first;
	return `First user message:\n${pair.first}\n\nLatest user message:\n${pair.latest}`;
}

const THINKING_LEVEL_ORDER: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function resolveThinkingLevel(model: Model<any>, target: Exclude<ThinkingMode, "default">): ModelThinkingLevel | undefined {
	const map = model.thinkingLevelMap;
	if (!map) return undefined;

	if (target === "off") {
		if (map.off !== undefined && map.off !== null) return "off";
		for (const level of THINKING_LEVEL_ORDER) {
			const mapped = map[level];
			if (mapped !== undefined && mapped !== null) return level;
		}
		return undefined;
	}

	// target === "low": prefer low, otherwise the smallest supported level that is at least low
	if (map.low !== undefined && map.low !== null) return "low";
	let fallback: ModelThinkingLevel | undefined;
	for (const level of THINKING_LEVEL_ORDER) {
		const mapped = map[level];
		if (mapped !== undefined && mapped !== null) {
			if (!fallback) fallback = level;
			if (level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max") return level;
		}
	}
	return fallback;
}

function buildThinkingOptions(model: Model<any>, thinking: ThinkingMode): Record<string, unknown> | undefined {
	if (thinking === "default") return undefined;

	const api = model.api;
	const provider = model.provider;

	// OpenCode and DeepSeek OpenAI-compatible APIs use { thinking: { type: "enabled/disabled" } }
	if (
		(api === "openai-completions" || api.endsWith("-openai-completions")) &&
		(provider === "opencode" || provider === "deepseek" || provider.startsWith("kimi"))
	) {
		return {
			onPayload: (payload: unknown) => {
				if (!payload || typeof payload !== "object") return payload;
				const p = payload as Record<string, unknown>;
				p.thinking = { type: thinking === "off" ? "disabled" : "enabled" };
				return p;
			},
		};
	}

	if (api === "anthropic-messages") {
		if (thinking === "off") return { thinkingEnabled: false };
		return { thinkingEnabled: true, thinkingBudgetTokens: 1024 };
	}

	if (api === "openai-codex-responses") {
		if (thinking === "off") return { reasoningEffort: "none" };
		return { reasoningEffort: "low" };
	}

	if (api === "openai-responses" || api === "openai-completions" || api.endsWith("-openai-responses")) {
		const level = resolveThinkingLevel(model, thinking);
		if (!level) return undefined;
		return { reasoningEffort: level };
	}

	return undefined;
}

function normalizeApi(model: Model<any>): Model<any> {
	if (getApiProvider(model.api)) return model;
	if (model.api.endsWith("-openai-completions")) return { ...model, api: "openai-completions" };
	if (model.api.endsWith("-openai-responses")) return { ...model, api: "openai-responses" };
	return model;
}

export default function (pi: ExtensionAPI) {
	let config: AutonameConfig = { ...DEFAULT_CONFIG };
	let lastGen: LastGeneration | undefined;
	let generating = false;

	async function generateTitle(userText: string, ctx: ExtensionContext): Promise<void> {
		const model = resolveModel(ctx, config.model);
		if (!model) {
			lastGen = {
				status: "error",
				timestamp: Date.now(),
				modelUsed: config.model ?? "current",
				request: { systemPrompt: config.prompt, userText },
				error: "No model available",
			};
			return;
		}

		const modelName = `${model.provider}/${model.id}`;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			lastGen = {
				status: "error",
				timestamp: Date.now(),
				modelUsed: modelName,
				request: { systemPrompt: config.prompt, userText },
				error: auth.ok ? "No API key configured" : auth.error,
			};
			return;
		}

		const request = { systemPrompt: config.prompt, userText: userText.slice(0, 4000) };
		lastGen = {
			status: "generating",
			timestamp: Date.now(),
			modelUsed: modelName,
			request,
		};

		try {
			const thinkingOptions = buildThinkingOptions(model, config.thinking);
			const response = await complete(
				normalizeApi(model),
				{
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: `${config.prompt}\n\nUser message(s):\n${request.userText}`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, ...thinkingOptions },
			);

			const raw = response.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join(" ")
				.trim();

			const title = sanitizeTitle(raw, config.maxLength);
			if (title) {
				pi.setSessionName(title);
				lastGen = {
					status: "success",
					timestamp: Date.now(),
					modelUsed: modelName,
					request,
					response: raw,
					stopReason: response.stopReason,
					rawContent: JSON.stringify(response.content),
					title,
				};
				ctx.ui.notify(`Session auto-named: ${title}`, "info");
			} else {
				lastGen = {
					status: "error",
					timestamp: Date.now(),
					modelUsed: modelName,
					request,
					response: raw,
					stopReason: response.stopReason,
					rawContent: JSON.stringify(response.content),
					error:
						response.stopReason === "error" && response.errorMessage
							? response.errorMessage
							: "Model returned an empty title",
				};
			}
		} catch (err) {
			lastGen = {
				status: "error",
				timestamp: Date.now(),
				modelUsed: modelName,
				request,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	pi.on("session_start", async () => {
		generating = false;
		config = await loadConfig();
	});

	pi.on("input", (event, ctx) => {
		if (!config.enabled || generating) return;
		if (event.source !== "interactive") return;
		if (pi.getSessionName()) return;

		const hasUser = ctx.sessionManager.getBranch().some(isUserMessageEntry);
		if (hasUser) return;

		const text = event.text.trim();
		if (!text) return;

		generating = true;
		generateTitle(text, ctx).finally(() => {
			generating = false;
		});
	});

	pi.registerCommand("autoname-now", {
		description: "Manually generate a session title from the latest user message",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("autoname-now requires TUI mode", "error");
				return;
			}

			const text = getNamingText(ctx);
			if (!text) {
				ctx.ui.notify("No user message to generate a title from", "error");
				return;
			}
			if (generating) {
				ctx.ui.notify("Already generating a title", "warning");
				return;
			}

			generating = true;
			ctx.ui.notify("Generating title...", "info");
			await generateTitle(text, ctx);
			generating = false;
			if (lastGen?.status === "error") {
				ctx.ui.notify(`Title generation failed: ${lastGen.error}`, "error");
			}
		},
	});

	pi.registerCommand("autoname-config", {
		description: "Configure pi-autoname (prompt, model, enable)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("autoname-config requires TUI mode", "error");
				return;
			}

			let done = false;
			while (!done) {
				const choice = await ctx.ui.select("Autoname config:", [
					`Toggle enabled (${config.enabled ? "on" : "off"})`,
					"Edit prompt",
					`Select model (${config.model ?? "current"})`,
					`Set thinking mode (${config.thinking})`,
					`Set max length (${config.maxLength})`,
					"Reset to defaults",
					"Close",
				]);

				switch (choice) {
					case `Toggle enabled (${config.enabled ? "on" : "off"})`: {
						config.enabled = !config.enabled;
						await saveConfig(config);
						ctx.ui.notify(`Autoname ${config.enabled ? "enabled" : "disabled"}`, "info");
						break;
					}
					case "Edit prompt": {
						const next = await ctx.ui.editor("Edit autoname prompt:", config.prompt);
						if (next !== undefined) {
							config.prompt = next;
							await saveConfig(config);
							ctx.ui.notify("Prompt updated", "info");
						}
						break;
					}
					case `Select model (${config.model ?? "current"})`: {
						const models = ctx.modelRegistry.getAvailable();
						const options = ["(use current conversation model)", ...models.map((m) => `${m.provider}/${m.id}`)];
						const picked = await ctx.ui.select("Select autoname model:", options);
						if (picked !== undefined) {
							config.model = picked === "(use current conversation model)" ? null : picked;
							await saveConfig(config);
							ctx.ui.notify(`Autoname model set to ${config.model ?? "current"}`, "info");
						}
						break;
					}
					case `Set thinking mode (${config.thinking})`: {
						const picked = await ctx.ui.select("Select thinking mode:", ["default", "low", "off"]);
						if (picked !== undefined) {
							config.thinking = picked as ThinkingMode;
							await saveConfig(config);
							ctx.ui.notify(`Thinking mode set to ${config.thinking}`, "info");
						}
						break;
					}
					case `Set max length (${config.maxLength})`: {
						const next = await ctx.ui.input("Max title length:", config.maxLength.toString());
						const n = next ? parseInt(next, 10) : NaN;
						if (!isNaN(n) && n > 0) {
							config.maxLength = n;
							await saveConfig(config);
							ctx.ui.notify(`Max length set to ${n}`, "info");
						}
						break;
					}
					case "Reset to defaults": {
						config = { ...DEFAULT_CONFIG };
						await saveConfig(config);
						ctx.ui.notify("Autoname config reset", "info");
						break;
					}
					case "Close":
					default:
						done = true;
				}
			}
		},
	});

	pi.registerCommand("autoname-debug", {
		description: "Show pi-autoname debug info",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("autoname-debug requires TUI mode", "error");
				return;
			}
			const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
			pi.appendEntry("autoname-debug", {
				config,
				lastGen,
				generating,
				currentModel,
			});
		},
	});

	pi.registerEntryRenderer("autoname-debug", (entry, _options, theme) => {
		const data = entry.data as {
			config: AutonameConfig;
			lastGen?: LastGeneration;
			generating: boolean;
			currentModel: string;
		};
		const lines: string[] = [];

		lines.push(theme.fg("accent", theme.bold("Autoname Debug")));
		lines.push(`Enabled: ${data.config.enabled ? "on" : "off"}`);
		lines.push(`Model: ${data.config.model ?? "(current conversation model)"}`);
		lines.push(`Current model: ${data.currentModel}`);
		lines.push(`Thinking mode: ${data.config.thinking}`);
		lines.push(`Max length: ${data.config.maxLength}`);
		lines.push(theme.fg("accent", "Prompt:"));
		lines.push(data.config.prompt);
		lines.push("");
		lines.push(`Status: ${data.generating ? "generating" : data.lastGen?.status ?? "idle"}`);

		if (data.lastGen) {
			lines.push(`Last run: ${new Date(data.lastGen.timestamp).toISOString()}`);
			lines.push(`Model used: ${data.lastGen.modelUsed}`);
			if (data.lastGen.stopReason) {
				lines.push(`Stop reason: ${data.lastGen.stopReason}`);
			}
			lines.push(theme.fg("accent", "Request system prompt:"));
			lines.push(data.lastGen.request.systemPrompt);
			lines.push(theme.fg("accent", "Request user text:"));
			lines.push(data.lastGen.request.userText);
			if (data.lastGen.response !== undefined) {
				lines.push(theme.fg("accent", "Extracted text:"));
				lines.push(data.lastGen.response);
			}
			if (data.lastGen.rawContent) {
				lines.push(theme.fg("accent", "Raw content array:"));
				lines.push(data.lastGen.rawContent);
			}
			if (data.lastGen.title) {
				lines.push(theme.fg("success", `Generated title: ${data.lastGen.title}`));
			}
			if (data.lastGen.error) {
				lines.push(theme.fg("error", `Error: ${data.lastGen.error}`));
			}
		}

		return new Text(lines.join("\n"), 1, 1);
	});
}
