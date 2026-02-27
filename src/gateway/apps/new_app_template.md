---
id: new-app
name: New Mini-App
description: Short summary of what this mini-app does and why it exists.
enabled: false
execution_engine: claude_container
context_mode: fresh
instance: cc-bridge
workspace: cc-bridge
engine_command:
engine_args: []
exec_timeout_ms: 300000
schedule_type: recurring
schedule_value: 1h
target_mode: all_sessions
channels: [telegram, feishu]
template_vars: [input, date_utc, now_iso]
---

# Goal

Define the task objective in one paragraph:
- what success means
- scope boundaries
- constraints

## Inputs

List all required and optional inputs.

### Arguments
- `{{input}}`: operator-provided text (optional)

### Configuration
- `execution_engine`: `claude_container` | `claude_host` | `codex_host`
- `context_mode`: `existing` | `fresh`
- `instance`: default runtime instance from frontmatter
- `workspace`: default workspace from frontmatter
- `engine_command`: optional command override per engine
- `engine_args`: optional args array. Use `{{prompt}}`, `{{workspace}}`, `{{chat_id}}` placeholders.

### Data Sources
- Local files:
  - example: `data/reports/*.json`
- Web sources:
  - list allowed websites/APIs if web lookup is required

## Outputs

Define output format and quality bar.

### Format
- language and tone
- structure (headings, bullets, table, JSON, etc)
- required fields

### Example Output
```text
Summary Date: {{date_utc}}
Key Points:
1) ...
2) ...
Action Items:
- ...
```

## Workflow

Describe step-by-step execution logic.
1. Collect and validate required inputs.
2. Gather data from declared local/web sources.
3. Analyze and synthesize results.
4. Format final output using the required structure.
5. Run a final self-check against scope/constraints before returning.

## Prompt

Use this section as the executable instruction body.

Current UTC date: {{date_utc}}
Current timestamp: {{now_iso}}
Operator input: {{input}}
