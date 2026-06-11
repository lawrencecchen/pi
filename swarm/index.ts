/**
 * pi-swarm: hierarchical multi-agent orchestration for pi.
 *
 * Load with `pi -e swarm/index.ts` or via the "extensions" array in
 * ~/.pi/agent/settings.json. Subagents are spawned with this extension
 * preloaded, so every node in the tree has the same tools and the tree can
 * nest. See swarm/DESIGN.md for the architecture.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	SELF_DEPTH,
	SELF_ID,
	effectiveStatus,
	killSubtree,
	lastAssistantTextFromEvents,
	listMetas,
	loadMeta,
	readEvents,
	registry,
	renderEvent,
	spawnAgent,
	swarmDir,
	truncate,
} from "./registry.ts";
import { loadRemotes, saveRemotes, sshExec } from "./remotes.ts";

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: {} };
}

function requireMeta(agentId: string) {
	const meta = loadMeta(agentId);
	if (!meta) throw new Error(`unknown agent "${agentId}" (see agents_list)`);
	return meta;
}

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------------
	// Orchestration tools
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "agents_spawn",
		label: "Spawn subagent",
		description:
			"Spawn a subagent (a fresh pi process) to work on a task asynchronously. Returns immediately with the agent id; use agents_wait or agents_status to follow progress. Subagents have these same swarm tools and can spawn their own subagents. Give the task prompt full context: the subagent shares no conversation history with you.",
		promptGuidelines: [
			"Decompose large work into subagents instead of doing everything serially yourself.",
			"Write subagent tasks as complete briefs: goal, constraints, repo paths, and what the final report must contain.",
			"Assign a remote when the work should run on another machine.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Complete task brief for the subagent" }),
			name: Type.Optional(Type.String({ description: "Short human-readable label" })),
			model: Type.Optional(
				Type.String({
					description:
						'Model as "provider/model-id" (e.g. "openai-codex/gpt-5.5-codex" or "anthropic/claude-fable-5"). Omit to inherit the default.',
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
			remote: Type.Optional(Type.String({ description: "Name of an SSH remote the subagent should work on (see remotes_list)" })),
		}),
		async execute(_toolCallId, params) {
			const handle = await spawnAgent(params);
			return text(
				`Spawned agent ${handle.meta.id}${params.name ? ` (${params.name})` : ""}` +
					`${params.model ? ` on ${params.model}` : ""}${params.remote ? ` targeting remote ${params.remote}` : ""}.\n` +
					`Session: ${handle.meta.sessionFile ?? "(pending)"}\n` +
					`It is now working. Use agents_wait {"agent_ids":["${handle.meta.id}"]} to collect its result, or keep working and check agents_status later.`,
			);
		},
	});

	pi.registerTool({
		name: "agents_send",
		label: "Message subagent",
		description:
			"Send a message to a running subagent. mode=steer interrupts after its current tool batch; mode=follow_up queues until it finishes; mode=prompt starts a new turn on an idle agent.",
		parameters: Type.Object({
			agent_id: Type.String(),
			message: Type.String(),
			mode: StringEnum(["prompt", "steer", "follow_up"] as const),
		}),
		async execute(_toolCallId, params) {
			requireMeta(params.agent_id);
			const handle = registry.get(params.agent_id);
			if (!handle) throw new Error(`agent ${params.agent_id} is not controlled by this process (it may have exited or belong to another manager)`);
			await handle.request(
				params.mode === "prompt"
					? { type: "prompt", message: params.message, streamingBehavior: "steer" }
					: { type: params.mode, message: params.message },
			);
			return text(`Delivered to ${params.agent_id} (${params.mode}).`);
		},
	});

	pi.registerTool({
		name: "agents_list",
		label: "List agents",
		description:
			"List the agent tree: every spawned agent with id, name, status (starting/running/idle/exited/killed), model, remote, and task summary. Ids encode the hierarchy (1, 1.2, 1.2.3). You can inspect any agent, but you can only send to agents you spawned.",
		parameters: Type.Object({}),
		async execute() {
			const metas = listMetas();
			if (metas.length === 0) return text("No agents spawned yet.");
			const lines = metas.map((m) => {
				const indent = "  ".repeat(Math.max(0, m.depth - 1));
				const status = effectiveStatus(m);
				const bits = [
					`${indent}${m.id}`,
					m.name ? `(${m.name})` : "",
					`[${status}]`,
					m.model ?? "",
					m.remote ? `@${m.remote}` : "",
					`— ${m.task.replace(/\s+/g, " ").slice(0, 100)}`,
				].filter(Boolean);
				return bits.join(" ");
			});
			return text(`You are agent "${SELF_ID}" (depth ${SELF_DEPTH}). Swarm dir: ${swarmDir()}\n${lines.join("\n")}`);
		},
	});

	pi.registerTool({
		name: "agents_status",
		label: "Agent status",
		description:
			"Detailed status of one agent: live state (streaming, queued messages, message count), task, session file path, recent activity. Works for any agent in the tree, including ones you did not spawn.",
		parameters: Type.Object({
			agent_id: Type.String(),
		}),
		async execute(_toolCallId, params) {
			const meta = requireMeta(params.agent_id);
			const handle = registry.get(params.agent_id);
			let live = "";
			if (handle) {
				try {
					const state = await handle.request({ type: "get_state" }, 10_000);
					live = `streaming=${state.isStreaming} queued=${state.pendingMessageCount} messages=${state.messageCount} model=${state.model?.id ?? "?"}`;
				} catch (err) {
					live = `live state unavailable: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
			const recent = readEvents(params.agent_id, 50)
				.map(renderEvent)
				.filter((line): line is string => line !== null)
				.slice(-8);
			return text(
				[
					`agent ${meta.id}${meta.name ? ` (${meta.name})` : ""}`,
					`status: ${effectiveStatus(meta)}  depth: ${meta.depth}  pid: ${meta.pid ?? "?"}  exit: ${meta.exitCode ?? "-"}`,
					`model: ${meta.model ?? "(default)"}  remote: ${meta.remote ?? "-"}  cwd: ${meta.cwd}`,
					live ? `live: ${live}` : "live: not controlled by this process",
					`session: ${meta.sessionFile ?? "?"}`,
					`task: ${meta.task.slice(0, 500)}`,
					recent.length ? `recent:\n${recent.map((l) => `  ${l}`).join("\n")}` : "recent: (no events yet)",
				].join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "agents_tail",
		label: "Agent trajectory tail",
		description:
			"Read the recent trajectory of an agent: assistant/user messages and tool calls, oldest first. Use it to audit what a subagent actually did, beyond its self-reported result.",
		parameters: Type.Object({
			agent_id: Type.String(),
			count: Type.Optional(Type.Number({ description: "Max rendered entries (default 30)" })),
		}),
		async execute(_toolCallId, params) {
			requireMeta(params.agent_id);
			const rendered = readEvents(params.agent_id)
				.map(renderEvent)
				.filter((line): line is string => line !== null);
			const slice = rendered.slice(-(params.count ?? 30));
			if (slice.length === 0) return text("No trajectory events yet.");
			return text(truncate(slice.join("\n")));
		},
	});

	pi.registerTool({
		name: "agents_wait",
		label: "Wait for agents",
		description:
			"Block until the given agents finish their current run (or timeout), then return each agent's final message. Prefer this over polling agents_status in a loop.",
		parameters: Type.Object({
			agent_ids: Type.Array(Type.String()),
			timeout_seconds: Type.Optional(Type.Number({ description: "Default 600" })),
		}),
		async execute(_toolCallId, params, signal) {
			const timeoutMs = (params.timeout_seconds ?? 600) * 1000;
			const results = await Promise.all(
				params.agent_ids.map(async (id) => {
					const meta = requireMeta(id);
					const handle = registry.get(id);
					if (!handle) {
						const status = effectiveStatus(meta);
						const last = lastAssistantTextFromEvents(id);
						return `=== ${id} [${status}] ===\n${last ?? "(no final message recorded)"}`;
					}
					const settled = await handle.waitSettled(timeoutMs, signal);
					if (!settled) return `=== ${id} [still running after ${params.timeout_seconds ?? 600}s] ===`;
					let last: string | null = null;
					try {
						const data = await handle.request({ type: "get_last_assistant_text" }, 15_000);
						last = typeof data === "string" ? data : (data?.text ?? null);
					} catch {
						last = lastAssistantTextFromEvents(id);
					}
					return `=== ${id} [${effectiveStatus(meta)}] ===\n${last ?? "(no final message)"}`;
				}),
			);
			return text(truncate(results.join("\n\n"), 24_000));
		},
	});

	pi.registerTool({
		name: "agents_kill",
		label: "Kill agent",
		description: "Terminate an agent. With subtree=true, also terminates everything it spawned.",
		parameters: Type.Object({
			agent_id: Type.String(),
			subtree: Type.Optional(Type.Boolean({ description: "Also kill descendants (default true)" })),
		}),
		async execute(_toolCallId, params) {
			requireMeta(params.agent_id);
			if (params.subtree === false) {
				const handle = registry.get(params.agent_id);
				if (!handle) throw new Error(`agent ${params.agent_id} is not controlled by this process`);
				handle.kill();
				return text(`Killed ${params.agent_id}.`);
			}
			const killed = killSubtree(params.agent_id);
			return text(killed.length ? `Killed: ${killed.join(", ")}` : "Nothing to kill (already exited).");
		},
	});

	pi.registerTool({
		name: "swarm_search",
		label: "Search trajectories",
		description:
			"Case-insensitive substring search across all agent trajectories. Answers questions like: which agent touched file X, who already investigated Y. Returns agent id + matching entry per hit.",
		parameters: Type.Object({
			query: Type.String(),
			agent_id: Type.Optional(Type.String({ description: "Restrict to one agent's subtree" })),
			max_results: Type.Optional(Type.Number({ description: "Default 20" })),
		}),
		async execute(_toolCallId, params) {
			const needle = params.query.toLowerCase();
			const max = params.max_results ?? 20;
			const hits: string[] = [];
			for (const meta of listMetas()) {
				if (params.agent_id && meta.id !== params.agent_id && !meta.id.startsWith(`${params.agent_id}.`)) continue;
				for (const event of readEvents(meta.id)) {
					const rendered = renderEvent(event);
					if (!rendered || !rendered.toLowerCase().includes(needle)) continue;
					hits.push(`${meta.id}: ${rendered.slice(0, 300)}`);
					if (hits.length >= max) break;
				}
				if (hits.length >= max) break;
			}
			return text(hits.length ? truncate(hits.join("\n")) : `No matches for "${params.query}".`);
		},
	});

	// ------------------------------------------------------------------
	// SSH remotes
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "remotes_list",
		label: "List SSH remotes",
		description: "List the registered SSH remotes (name, target, description). Use these names with ssh_exec and agents_spawn.remote.",
		parameters: Type.Object({}),
		async execute() {
			const remotes = loadRemotes();
			const names = Object.keys(remotes);
			if (names.length === 0) return text(`No remotes registered. Add one with remotes_add, stored in ${swarmDir()}/remotes.json.`);
			return text(
				names
					.map((name) => `${name}: ${remotes[name].target}${remotes[name].description ? ` — ${remotes[name].description}` : ""}`)
					.join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "remotes_add",
		label: "Add SSH remote",
		description: "Register an SSH remote in the shared fleet registry. Target is an ~/.ssh/config alias or user@host; key auth must already work non-interactively.",
		parameters: Type.Object({
			name: Type.String(),
			target: Type.String(),
			description: Type.Optional(Type.String({ description: "What this machine is for: OS, hardware, repos, roles" })),
		}),
		async execute(_toolCallId, params) {
			const remotes = loadRemotes();
			remotes[params.name] = { target: params.target, description: params.description };
			saveRemotes(remotes);
			return text(`Registered remote "${params.name}" -> ${params.target}.`);
		},
	});

	pi.registerTool({
		name: "ssh_exec",
		label: "SSH exec",
		description:
			"Run a shell command on a registered SSH remote and return combined output. Non-interactive (BatchMode); long jobs should be nohup'd or run in tmux on the remote.",
		parameters: Type.Object({
			remote: Type.String({ description: "Remote name from remotes_list" }),
			command: Type.String(),
			timeout_seconds: Type.Optional(Type.Number({ description: "Default 120" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const remotes = loadRemotes();
			const remote = remotes[params.remote];
			if (!remote) throw new Error(`unknown remote "${params.remote}" (see remotes_list)`);
			let streamed = "";
			const result = await sshExec(remote.target, params.command, {
				timeoutMs: (params.timeout_seconds ?? 120) * 1000,
				signal,
				onData: (chunk) => {
					streamed += chunk;
					onUpdate?.({ content: [{ type: "text", text: truncate(streamed, 2000) }], details: {} });
				},
			});
			const body = truncate(result.output) || "(no output)";
			if (result.exitCode !== 0) {
				throw new Error(`exit ${result.exitCode} on ${params.remote}:\n${body}`);
			}
			return text(body);
		},
	});

	// ------------------------------------------------------------------
	// Human-facing command
	// ------------------------------------------------------------------

	pi.registerCommand("swarm", {
		description: "Show the swarm agent tree",
		handler: async (_args, ctx) => {
			const metas = listMetas();
			const lines = metas.map((m) => `${"  ".repeat(Math.max(0, m.depth - 1))}${m.id} [${effectiveStatus(m)}] ${m.name ?? m.task.slice(0, 60)}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "no agents", "info");
		},
	});
}
