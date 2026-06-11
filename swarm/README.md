# pi-swarm

Hierarchical multi-agent orchestration for pi: one manager agent on one machine, a nestable tree of subagent processes, all trajectories on the local filesystem, and an SSH fleet registry for running work on other machines. See [DESIGN.md](DESIGN.md).

## Run

From this repo (uses pi from sources):

```bash
PI_SWARM_PI_BIN="$PWD/pi-test.sh" ./pi-test.sh -e swarm/index.ts
```

With an installed pi, either pass `-e /path/to/pi/swarm/index.ts` or add it to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/path/to/pi/swarm/index.ts"] }
```

Recommended root model is the Codex backend (`pi --model openai-codex/gpt-5.5-codex`), with auth kept fresh by subrouter's `sr switch`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PI_SWARM_DIR` | `~/.pi/swarm` | Agent metas, event mirrors, remotes.json |
| `PI_SWARM_PI_BIN` | `pi` | Binary used to spawn subagents |
| `PI_SWARM_MAX_DEPTH` | `5` | Agent tree depth cap |

`PI_SWARM_AGENT_ID` and `PI_SWARM_DEPTH` are set automatically on children; do not set them yourself.

## Tools

`agents_spawn`, `agents_send`, `agents_list`, `agents_status`, `agents_tail`, `agents_wait`, `agents_kill`, `swarm_search`, `remotes_list`, `remotes_add`, `ssh_exec`, plus a `/swarm` command that prints the tree. Tool-by-tool rationale is in [DESIGN.md](DESIGN.md).

## Remotes

```
remotes_add {"name": "macmini", "target": "cmux-macmini", "description": "M2 Pro, repos under ~/cmux-runners"}
agents_spawn {"task": "...", "remote": "macmini"}
```

Targets are `~/.ssh/config` aliases or `user@host`; key auth must work non-interactively (`BatchMode=yes`).
