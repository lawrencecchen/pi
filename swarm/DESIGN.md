# pi-swarm design

A hierarchical multi-agent orchestrator built on pi. One root manager agent runs on a single machine, decomposes work into subagents, and those subagents can spawn their own subagents. The tree can nest arbitrarily deep (default cap: 5 levels). Every trajectory is a plain file on the orchestrator host. The fleet of other machines is reached over SSH.

## Why pi

pi already has the four primitives this needs, so the whole orchestrator is a pure-addition extension with zero upstream edits (clean rebases on `upstream/main`):

- **RPC mode** (`pi --mode rpc`): headless JSONL control over stdin/stdout with `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_last_assistant_text`. Each subagent is one such subprocess.
- **Sessions**: append-only JSONL under `~/.pi/agent/sessions/`, with `parentSession` links, forking, and compaction entries. Trajectories are filesystem-native by default.
- **Extensions**: `pi.registerTool()` from a plain `.ts` file. Subagents are spawned with `-e swarm/index.ts`, so every node in the tree has the same orchestration tools. That single decision is what makes the tree recursive.
- **Provider layer**: `openai-codex-responses` speaks the ChatGPT Codex backend natively, models support per-model `baseUrl` and `headers`, and auth lives in `~/.pi/agent/auth.json`, which subrouter already syncs (`sr switch` writes the `openai-codex` key there).

## Topology

```
orchestrator host (one machine)
└─ root pi (TUI or RPC), model: openai-codex via subrouter
   ├─ agent 1 (pi --mode rpc subprocess)        claude or codex
   │  ├─ agent 1.1                              may target ssh remote "cmux-macmini"
   │  └─ agent 1.2
   └─ agent 2 ...
```

The main loop and all child processes run on one computer. Remote machines are execution targets, not agent hosts: an agent assigned a remote does its shell work there through `ssh_exec` while its model loop, session file, and event mirror stay local. This keeps every trajectory in one place and keeps provider credentials off the fleet.

## State layout

```
~/.pi/swarm/                      (override: PI_SWARM_DIR)
  remotes.json                    shared SSH fleet registry
  agents/<id>/                    ids encode the tree: 1, 1.2, 1.2.3
    meta.json                     task, parent, model, remote, pid, status, sessionFile
    events.jsonl                  mirrored agent events (messages, tool calls)
    stderr.log
~/.pi/agent/sessions/             pi's own full-fidelity trajectories
```

`events.jsonl` is the cheap queryable mirror (status, tail, search). `meta.sessionFile` points at the authoritative pi session for full replay, forking, or `pi --resume`.

## Tool surface

The manager-side tools, all registered by `swarm/index.ts` on every node:

| Tool | Purpose |
|---|---|
| `agents_spawn` | Start a subagent: task brief, optional name, `provider/model`, cwd, SSH remote. Async, returns the agent id immediately. |
| `agents_send` | Talk to a child: `steer` (interrupt after current tool batch), `follow_up` (queue), `prompt` (new turn). |
| `agents_list` | The whole tree with status per node: starting / running / idle / exited / killed. |
| `agents_status` | Deep view of one agent: live streaming state, queued messages, message count, session path, last 8 trajectory entries. |
| `agents_tail` | Recent trajectory (messages + tool calls) of any agent, for auditing what it actually did vs what it claims. |
| `agents_wait` | Block on N agents until they settle (or timeout), return each one's final message. The primary join primitive; no polling loops. |
| `agents_kill` | Terminate an agent, by default with its whole subtree. |
| `swarm_search` | Substring search across all trajectories: which agent touched file X, who already tried Y. |
| `remotes_list` / `remotes_add` | Shared SSH fleet registry (name, target, description the model uses to pick machines). |
| `ssh_exec` | Run a command on a named remote, streamed, with timeout. |

Design choices worth noting:

- **Spawn is non-blocking, wait is explicit.** A manager fans out k children, keeps working, then `agents_wait`s on the set. Settling is event-driven (the child's `agent_end` event), not poll-based.
- **Status is readable by anyone, control is owner-only.** Any agent can inspect any trajectory (meta + events are just files), but `steer`/`prompt` require the live process handle, which only the parent that spawned the child holds. This avoids two managers steering one worker.
- **Self-reports are not trusted.** `agents_tail` and `swarm_search` exist specifically so a manager verifies a child's work from its actual tool calls, not its summary.
- **Tool outputs are truncated** (8k chars default, 24k for joined waits) so a manager polling a large tree does not blow its own context.

## Providers and subrouter

The root manager runs on the Codex backend (`openai-codex` provider). Subagents choose per spawn: `anthropic/...` or `openai-codex/...` or anything else pi supports.

Routing through subrouter gives sticky account assignment and rate-limit-aware selection across all Codex and Claude subscription accounts:

- **Auth**: `sr switch` already writes Codex OAuth credentials into `~/.pi/agent/auth.json` (provider key `openai-codex`) and refreshes them every 10 minutes. Nothing to build.
- **Proxy routing (optional, for multi-account)**: define a custom model in `~/.pi/agent/models.json` with `baseUrl: "http://127.0.0.1:31415/backend-api"` (subrouter's Codex path; it normalizes `/responses` for the selected account). Claude subagents route by passing `ANTHROPIC_BASE_URL=http://127.0.0.1:31415` plus an OAuth token in the spawn env.
- **Session stickiness**: subrouter pins conversations to accounts via Codex session headers it already sniffs; each subagent is its own pi session, so each child gets its own sticky account with full prompt-cache reuse.

On compaction: pi does client-side compaction (summarize + `CompactionEntry` in the session). The `openai-codex-responses` provider already supports `previous_response_id` against the Codex backend; moving the root manager to server-side Codex compaction is a follow-up that lives entirely in `packages/ai` (tracked under future work).

## Remote execution phases

1. **v1 (this commit)**: `ssh_exec` tool plus a spawn-time remote assignment that instructs the agent to run its work on that remote. Simple, debuggable, credentials stay home.
2. **v2**: SSH-backed `BashOperations`. pi's bash tool takes an injectable `exec` implementation, so a remote-assigned agent's built-in `bash` tool transparently runs on its remote (cd/env handled per call). No model-visible difference from local work.
3. **v3**: remote agent hosts: `ssh host pi --mode rpc` with the same JSONL protocol flowing over the SSH pipe, for fleets where the work is too chatty for round-trips. Trajectory mirroring stays local because the orchestrator still owns stdout.

## Failure model

- Child crash: `exit` handler rejects pending requests, marks `exited`, wakes waiters. The manager sees it in `agents_wait` output.
- Manager exit: a `process.on("exit")` hook reaps the manager's live children so idle subagent processes don't linger. On a hard kill (SIGKILL) children can survive untracked; their metas show a live pid and `agents_kill` still works by pid. Trajectories and final messages always remain readable from `events.jsonl`; re-adoption (control without respawn) is future work.
- Runaway trees: depth cap (`PI_SWARM_MAX_DEPTH`, default 5) and subtree kill. A token/cost budget per subtree is future work.

## Future work

- Server-side Codex compaction for the root manager (`previous_response_id` chaining in `openai-codex-responses`).
- SSH-backed `BashOperations` (v2 above) and orphan re-adoption after orchestrator restart.
- Budgets: per-subtree token/cost ceilings enforced at spawn and in `agents_status`.
- A read-only web dashboard over `~/.pi/swarm` (the data is already all files).
- Structured final reports: spawn-time output schema, enforced via a terminating structured-output tool in the child.
