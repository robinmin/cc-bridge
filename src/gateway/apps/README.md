# Mini-App Driver

This directory contains the runtime driver for mini-apps.

## Structure

- `driver.ts` - Mini-app runtime driver (list, load, run apps)
- `driver.test.ts` - Unit tests for the driver
- `new_app_template.md` - Template for creating new mini-apps

## Mini-App Definitions

Mini-app definitions (`.md` files) are stored in `src/apps/`. Each markdown file is one mini-app.
Mini-app-specific scripts should be stored under `src/apps/<app-id>/` to keep operational tooling colocated with the spec.

## CLI Usage

```bash
bun run src/gateway/apps/driver.ts list
bun run src/gateway/apps/driver.ts run <app-id> [input]
bun run src/gateway/apps/driver.ts task-prompt <app-id> [input]
```

## Scheduler Integration

The scheduler uses task prompt tokens:

```text
@miniapp:<app-id> [optional input]
```

When the scheduler sees this token, it loads the mini-app markdown from `src/apps/<app-id>.md` and dispatches execution to all resolved targets.

## Creating a New Mini-App

Copy the template:

```bash
cp src/gateway/apps/new_app_template.md src/apps/<your-app-id>.md
```

Then edit the frontmatter and body as needed.

## Frontmatter Schema

| Field | Required | Description |
|---|---|---|
| `id` | yes | Mini-app identifier (`<id>.md`) |
| `name` | no | Human-readable name |
| `description` | no | Summary for listing/ops |
| `enabled` | no | `true/false`, default `true` |
| `instance` | no | Default instance name fallback |
| `workspace` | no | Default workspace fallback |
| `schedule_type` | no | `once`, `recurring`, or `cron` |
| `schedule_value` | no | interval (`5m`, `1h`) or cron (`0 9 * * 1-5`, UTC) |
| `target_mode` | no | `all_sessions` (default) or `chat_ids` |
| `chat_ids` | no | Required when `target_mode=chat_ids` |
| `channels` | no | Optional filter: `telegram`, `feishu` |
| `template_vars` | no | Document supported `{{var}}` placeholders |

## Template Variables

These variables are injected when a mini-app runs:
- `{{input}}` - optional operator input text
- `{{date_utc}}` - UTC date (`YYYY-MM-DD`)
- `{{now_iso}}` - current ISO timestamp

## Body Design Standard

Mini-app body should follow these sections:
- `Goal`: objective, boundaries, constraints
- `Inputs`: arguments, configuration, and data sources
- `Outputs`: expected format and example
- `Workflow`: step-by-step logic
- `Prompt`: final executable instruction block

This keeps prompts understandable for operators and predictable for runtime behavior.

## Example Authoring Flow

Create app file:
```bash
cp src/gateway/apps/new_app_template.md src/apps/my-daily-report.md
```

Run manually:
```bash
bun run src/gateway/apps/driver.ts run my-daily-report
```

Generate scheduler token:
```bash
bun run src/gateway/apps/driver.ts task-prompt my-daily-report "extra context"
```

Token form:
```text
@miniapp:my-daily-report optional input here
```
