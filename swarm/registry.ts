/**
 * Swarm subagent registry.
 *
 * Each subagent is a `pi --mode rpc` subprocess. The orchestrator talks to it
 * over JSONL on stdin/stdout, mirrors every agent event to
 * `<swarm-dir>/agents/<id>/events.jsonl`, and lets pi itself persist the full
 * trajectory as a normal session file. Children load this same extension, so
 * any subagent can spawn its own subagents and the tree nests arbitrarily
 * deep (bounded by PI_SWARM_MAX_DEPTH).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SELF_ID = process.env.PI_SWARM_AGENT_ID ?? "root";
export const SELF_DEPTH = Number(process.env.PI_SWARM_DEPTH ?? "0");
const MAX_DEPTH = Number(process.env.PI_SWARM_MAX_DEPTH ?? "5");
const EXTENSION_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

export function swarmDir(): string {
	return process.env.PI_SWARM_DIR ?? path.join(os.homedir(), ".pi", "swarm");
}

function agentsDir(): string {
	return path.join(swarmDir(), "agents");
}

export function agentDir(id: string): string {
	return path.join(agentsDir(), id);
}

export type AgentStatus = "starting" | "running" | "idle" | "exited" | "killed" | "error";

export interface AgentMeta {
	id: string;
	parentId: string | null;
	name?: string;
	task: string;
	model?: string;
	cwd: string;
	remote?: string;
	pid?: number;
	status: AgentStatus;
	exitCode?: number | null;
	sessionFile?: string;
	createdAt: string;
	updatedAt: string;
	depth: number;
}

function saveMeta(meta: AgentMeta): void {
	meta.updatedAt = new Date().toISOString();
	fs.mkdirSync(agentDir(meta.id), { recursive: true });
	fs.writeFileSync(path.join(agentDir(meta.id), "meta.json"), JSON.stringify(meta, null, 2));
}

export function loadMeta(id: string): AgentMeta | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(agentDir(id), "meta.json"), "utf8")) as AgentMeta;
	} catch {
		return null;
	}
}

export function listMetas(): AgentMeta[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(agentsDir());
	} catch {
		return [];
	}
	const metas: AgentMeta[] = [];
	for (const entry of entries) {
		const meta = loadMeta(entry);
		if (meta) metas.push(meta);
	}
	return metas.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function processAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Effective status. While an agent's process is alive its owning manager keeps
 * meta.json current, so the stored status is trusted; a dead pid with a
 * non-terminal stored status means the agent (or its manager) crashed.
 */
export function effectiveStatus(meta: AgentMeta): AgentStatus {
	const handle = registry.get(meta.id);
	if (handle) return handle.meta.status;
	if (meta.status === "exited" || meta.status === "killed" || meta.status === "error") return meta.status;
	return processAlive(meta.pid) ? meta.status : "exited";
}

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

export class AgentHandle extends EventEmitter {
	readonly meta: AgentMeta;
	private proc: ChildProcessWithoutNullStreams;
	private pending = new Map<string, PendingRequest>();
	private requestCounter = 0;
	private stdoutBuffer = "";
	private eventsStream: fs.WriteStream;

	constructor(meta: AgentMeta, proc: ChildProcessWithoutNullStreams) {
		super();
		this.meta = meta;
		this.proc = proc;
		this.eventsStream = fs.createWriteStream(path.join(agentDir(meta.id), "events.jsonl"), { flags: "a" });

		proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
		proc.stderr.on("data", (chunk: Buffer) => {
			fs.appendFileSync(path.join(agentDir(meta.id), "stderr.log"), chunk);
		});
		proc.on("exit", (code) => {
			this.meta.status = this.meta.status === "killed" ? "killed" : "exited";
			this.meta.exitCode = code;
			saveMeta(this.meta);
			for (const [, req] of this.pending) {
				clearTimeout(req.timer);
				req.reject(new Error(`agent ${meta.id} exited (code ${code})`));
			}
			this.pending.clear();
			this.eventsStream.end();
			this.emit("settled");
		});
	}

	private onStdout(chunk: Buffer): void {
		this.stdoutBuffer += chunk.toString("utf8");
		let idx = this.stdoutBuffer.indexOf("\n");
		while (idx >= 0) {
			let line = this.stdoutBuffer.slice(0, idx);
			this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim()) this.onLine(line);
			idx = this.stdoutBuffer.indexOf("\n");
		}
	}

	private onLine(line: string): void {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.type === "response") {
			const req = msg.id ? this.pending.get(msg.id) : undefined;
			if (req && msg.id) {
				this.pending.delete(msg.id);
				clearTimeout(req.timer);
				if (msg.success) req.resolve(msg.data);
				else req.reject(new Error(msg.error ?? `command ${msg.command} failed`));
			}
			return;
		}
		// Mirror agent events for offline inspection (agents_tail, swarm_search).
		this.eventsStream.write(`${JSON.stringify({ t: Date.now(), ...msg })}\n`);
		if (msg.type === "agent_start") {
			this.meta.status = "running";
			saveMeta(this.meta);
		} else if (msg.type === "agent_end") {
			this.meta.status = "idle";
			saveMeta(this.meta);
			this.emit("settled");
		}
	}

	request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
		const id = `swarm-${++this.requestCounter}`;
		return new Promise((resolve, reject) => {
			if (!this.proc.stdin.writable) {
				reject(new Error(`agent ${this.meta.id} stdin closed`));
				return;
			}
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`agent ${this.meta.id}: ${String(command.type)} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.proc.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		});
	}

	/** Resolves when the agent has finished its current run (or already idle/exited). */
	waitSettled(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		if (this.meta.status === "idle" || this.meta.status === "exited" || this.meta.status === "killed") {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const done = (ok: boolean) => {
				clearTimeout(timer);
				this.off("settled", onSettled);
				signal?.removeEventListener("abort", onAbort);
				resolve(ok);
			};
			const onSettled = () => done(true);
			const onAbort = () => done(false);
			const timer = setTimeout(() => done(false), timeoutMs);
			this.on("settled", onSettled);
			signal?.addEventListener("abort", onAbort);
		});
	}

	kill(): void {
		this.meta.status = "killed";
		saveMeta(this.meta);
		this.proc.kill("SIGTERM");
		const hardKill = setTimeout(() => {
			if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
		}, 3000);
		hardKill.unref();
	}
}

/** Live handles owned by this orchestrator process. */
export const registry = new Map<string, AgentHandle>();

// Reap children when this manager exits, so idle subagent processes don't
// linger and later crash with EPIPE on their closed stdout pipe. The exit
// hook does not fire on an unhandled SIGTERM, so install one that routes
// through process.exit().
process.on("exit", () => {
	for (const handle of registry.values()) {
		if (handle.meta.status !== "exited") handle.kill();
	}
});
process.on("SIGTERM", () => process.exit(143));

// Swarm children also watch for parent death (covers SIGKILLed managers,
// where no cleanup on the parent side can run): when the manager is gone,
// ppid is reparented and the child exits itself.
if (SELF_ID !== "root") {
	const parentWatch = setInterval(() => {
		if (process.ppid === 1 || !processAlive(process.ppid)) process.exit(0);
	}, 5000);
	parentWatch.unref();
}

function nextChildId(): string {
	const existing = new Set(listMetas().map((m) => m.id));
	let n = 1;
	while (existing.has(SELF_ID === "root" ? `${n}` : `${SELF_ID}.${n}`)) n++;
	return SELF_ID === "root" ? `${n}` : `${SELF_ID}.${n}`;
}

export interface SpawnOptions {
	task: string;
	name?: string;
	model?: string;
	cwd?: string;
	remote?: string;
	env?: Record<string, string>;
}

export async function spawnAgent(opts: SpawnOptions): Promise<AgentHandle> {
	if (SELF_DEPTH + 1 > MAX_DEPTH) {
		throw new Error(`max agent tree depth ${MAX_DEPTH} reached (set PI_SWARM_MAX_DEPTH to raise)`);
	}
	const id = nextChildId();
	const cwd = opts.cwd ?? process.cwd();
	const meta: AgentMeta = {
		id,
		parentId: SELF_ID === "root" ? null : SELF_ID,
		name: opts.name,
		task: opts.task,
		model: opts.model,
		cwd,
		remote: opts.remote,
		status: "starting",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		depth: SELF_DEPTH + 1,
	};
	saveMeta(meta);

	const piBin = process.env.PI_SWARM_PI_BIN ?? "pi";
	const args = ["--mode", "rpc", "-e", EXTENSION_ENTRY];
	if (opts.model) args.push("--model", opts.model);
	if (opts.name) args.push("--name", opts.name);

	const proc = spawn(piBin, args, {
		cwd,
		env: {
			...process.env,
			...opts.env,
			PI_SWARM_AGENT_ID: id,
			PI_SWARM_DEPTH: String(SELF_DEPTH + 1),
			PI_SWARM_DIR: swarmDir(),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	meta.pid = proc.pid;
	saveMeta(meta);

	const handle = new AgentHandle(meta, proc);
	registry.set(id, handle);

	// Capture the pi session file path so trajectories are linkable from meta.
	try {
		const state = await handle.request({ type: "get_state" }, 60_000);
		meta.sessionFile = state?.sessionFile;
		saveMeta(meta);
	} catch {
		// Non-fatal: agent may still be booting; sessionFile stays unknown.
	}

	let task = opts.task;
	if (opts.remote) {
		task = `You are assigned the SSH remote "${opts.remote}". Run all build/test/exec work on it via the ssh_exec tool (remote: "${opts.remote}") unless a step is explicitly local.\n\n${task}`;
	}
	await handle.request({ type: "prompt", message: task });
	meta.status = "running";
	saveMeta(meta);
	return handle;
}

export function killSubtree(id: string): string[] {
	const killed: string[] = [];
	for (const meta of listMetas()) {
		if (meta.id !== id && !meta.id.startsWith(`${id}.`)) continue;
		const handle = registry.get(meta.id);
		if (handle) {
			handle.kill();
			killed.push(meta.id);
		} else if (processAlive(meta.pid) && meta.pid) {
			process.kill(meta.pid, "SIGTERM");
			meta.status = "killed";
			saveMeta(meta);
			killed.push(meta.id);
		}
	}
	return killed;
}

const MAX_TOOL_TEXT = 8_000;

export function truncate(text: string, max = MAX_TOOL_TEXT): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/** Compact one mirrored event for agents_tail / swarm_search output. */
export function renderEvent(event: any): string | null {
	switch (event.type) {
		case "message_end": {
			const msg = event.message;
			if (!msg) return null;
			const text = Array.isArray(msg.content)
				? msg.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join(" ")
				: typeof msg.content === "string"
					? msg.content
					: "";
			if (!text.trim()) return null;
			return `[${msg.role}] ${text.trim().slice(0, 400)}`;
		}
		case "tool_execution_start":
			return `[tool] ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 300)}`;
		case "agent_start":
			return "[run started]";
		case "agent_end":
			return "[run finished]";
		default:
			return null;
	}
}

export function readEvents(id: string, limit?: number): any[] {
	const file = path.join(agentDir(id), "events.jsonl");
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const lines = raw.split("\n").filter((l) => l.trim());
	const slice = limit ? lines.slice(-limit) : lines;
	const events: any[] = [];
	for (const line of slice) {
		try {
			events.push(JSON.parse(line));
		} catch {
			// skip torn writes
		}
	}
	return events;
}

/** Last assistant text from the mirrored event log (works without a live handle). */
export function lastAssistantTextFromEvents(id: string): string | null {
	const events = readEvents(id);
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const text = Array.isArray(event.message.content)
			? event.message.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n")
			: "";
		if (text.trim()) return text;
	}
	return null;
}
