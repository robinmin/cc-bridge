---
name: mini_app
description: Use this skill when creating, listing, running, scheduling, and unscheduling mini-apps in this repo via `make` targets and `scripts/host_cmd.sh` commands.
---

# Mini App Lifecycle

## Overview

Manage mini-app lifecycle from the repository root using `make` first, with `scripts/host_cmd.sh` as the direct fallback.

## Command Set

Preferred make targets:
- `make app-new APP_ID=<app-id>`
- `make app-list`
- `make app-run APP_ID=<app-id> [APP_INPUT='...'] [APP_CHAT_ID=<id>] [APP_TIMEOUT_MS=<ms>] [APP_CONCURRENCY=<n>]`
- `make app-schedule APP_ID=<app-id> [APP_SCHEDULE_TYPE=once|recurring|cron] [APP_SCHEDULE_VALUE='...'] [APP_INPUT='...'] [APP_INSTANCE=<instance>]`
- `make app-list-tasks [APP_ID=<app-id>]`
- `make app-unschedule TASK_ID=<task-id>`
- `make app-unschedule APP_ID=<app-id>`

Direct host command fallback:
- `./scripts/host_cmd.sh app-new <app-id>`
- `./scripts/host_cmd.sh app-list`
- `./scripts/host_cmd.sh app-run <app-id> [input]`
- `./scripts/host_cmd.sh app-schedule <app-id> [once|recurring|cron] [schedule] [input] [instance]`
- `./scripts/host_cmd.sh app-list-tasks [app-id]`
- `./scripts/host_cmd.sh app-unschedule --task-id <task-id>`
- `./scripts/host_cmd.sh app-unschedule --app-id <app-id>`

## Workflow

1. Create app spec:
   `make app-new APP_ID=<app-id>`
2. Edit `src/apps/<app-id>.md`.
3. Verify discovery:
   `make app-list`
4. Dry run:
   `make app-run APP_ID=<app-id>`
5. Schedule push:
   `make app-schedule APP_ID=<app-id> APP_SCHEDULE_TYPE=recurring APP_SCHEDULE_VALUE='1h'`
6. Inspect tasks:
   `make app-list-tasks APP_ID=<app-id>`
7. Remove schedule if needed:
   `make app-unschedule APP_ID=<app-id>` or by `TASK_ID`.

## Notes

- Mini-app task prompt format is `@miniapp:<app-id> [input]`.
- Scheduled mini-app tasks are persisted in `data/gateway.db`.
- `cron` expressions are UTC and require 5 fields.
