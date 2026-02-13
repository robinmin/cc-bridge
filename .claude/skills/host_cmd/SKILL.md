---
name: host_cmd
description: Use this skill when you need to trigger cc-bridge slash commands from the host via scripts/host_cmd.sh (AgentBot automation), and understand chat-only host operations like /menu and /host.
---

# Host Command Bridge

This skill teaches how to invoke AgentBot slash commands from the host using `scripts/host_cmd.sh`. Use it to automate `/agents`, `/commands`, `/skills`, `/schedulers`, `/scheduler_add`, `/scheduler_del`, `/clear`, and workspace commands (`/ws_list`, `/ws_current`, `/ws_switch`, `/ws_add`, `/ws_del`) without going through chat.

It also documents the new chat commands:
- `/menu` (MenuBot): print combined command menu (MenuBot + HostBot + AgentBot)
- `/host <cmd>` (HostBot): run a host shell command with blacklist validation, timeout, and output truncation

## Quick Use

Run the corresponding host command (no leading slash):

```bash
scripts/host_cmd.sh agents
scripts/host_cmd.sh commands
scripts/host_cmd.sh skills
scripts/host_cmd.sh schedulers
scripts/host_cmd.sh scheduler_add cc-bridge recurring 1h "Daily summary"
scripts/host_cmd.sh scheduler_del <task_id>
scripts/host_cmd.sh clear
scripts/host_cmd.sh ws_list
scripts/host_cmd.sh ws_current
scripts/host_cmd.sh ws_switch my-project
scripts/host_cmd.sh ws_add my-project
scripts/host_cmd.sh ws_del my-project
```

Chat-only commands (not mapped by `scripts/host_cmd.sh`):

```text
/menu
/host <command>
```

## Command Mapping

Each host command maps to the AgentBot slash command:

- `agents` → `/agents`
- `commands` → `/commands`
- `skills` → `/skills`
- `schedulers` → `/schedulers`
- `scheduler_add <instance> <once|recurring> <schedule> <prompt>` → `/scheduler_add ...`
- `scheduler_del <task_id>` → `/scheduler_del ...`
- `clear` → `/clear`
- `ws_list` → `/ws_list`
- `ws_current` → `/ws_current`
- `ws_switch <name>` → `/ws_switch <name>`
- `ws_add <name>` → `/ws_add <name>`
- `ws_del <name>` → `/ws_del <name>`

## New Slash Commands

- `/menu`
  - Owner: `MenuBot`
  - Returns a full merged command list for all bots.

- `/host <cmd>`
  - Owner: `HostBot`
  - Runs `<cmd>` via a subprocess on host OS.
  - Applies blacklist-based blocking (exact match or command prefix).
  - Returns stdout/stderr + exit code.
  - Truncates long output and reports truncation.
  - Times out after 10 seconds.

Alias tip for `/host`:

```text
/host bash -ic 'gst'
```

This forces interactive bash alias expansion. Using raw command (`/host git status`) is more reliable.

## Notes

- Output is printed to stdout by `scripts/host_cmd.ts`.
- Use the host commands exactly; do not add a leading slash.
- If a command returns "not handled", verify the command name and arguments.
- `scripts/host_cmd.ts` currently routes through `AgentBot` only, so `/menu` and `/host <cmd>` are intentionally chat-only.
