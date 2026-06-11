/**
 * SSH remotes registry.
 *
 * Remotes live in `<swarm-dir>/remotes.json` so every agent in the tree sees
 * the same fleet. A remote is a name plus an ssh target (alias from
 * ~/.ssh/config or user@host), with an optional description the model can use
 * to pick the right machine.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { swarmDir } from "./registry.ts";

export interface Remote {
	/** ssh target: an ~/.ssh/config alias or user@host */
	target: string;
	/** what this machine is for, OS, hardware, repo locations, etc. */
	description?: string;
	tags?: string[];
}

function remotesFile(): string {
	return path.join(swarmDir(), "remotes.json");
}

export function loadRemotes(): Record<string, Remote> {
	try {
		return JSON.parse(fs.readFileSync(remotesFile(), "utf8")) as Record<string, Remote>;
	} catch {
		return {};
	}
}

export function saveRemotes(remotes: Record<string, Remote>): void {
	fs.mkdirSync(swarmDir(), { recursive: true });
	fs.writeFileSync(remotesFile(), JSON.stringify(remotes, null, 2));
}

export interface SshExecResult {
	exitCode: number | null;
	output: string;
}

export function sshExec(
	target: string,
	command: string,
	options: { timeoutMs?: number; signal?: AbortSignal; onData?: (text: string) => void } = {},
): Promise<SshExecResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn(
			"ssh",
			["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", target, command],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		const collect = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			output += text;
			options.onData?.(text);
		};
		proc.stdout.on("data", collect);
		proc.stderr.on("data", collect);

		let timer: NodeJS.Timeout | undefined;
		if (options.timeoutMs) {
			timer = setTimeout(() => {
				proc.kill("SIGKILL");
				reject(new Error(`ssh ${target}: timed out after ${options.timeoutMs}ms\n${output.slice(-2000)}`));
			}, options.timeoutMs);
		}
		const onAbort = () => proc.kill("SIGKILL");
		options.signal?.addEventListener("abort", onAbort);

		proc.on("error", (err) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		proc.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode: code, output });
		});
	});
}
