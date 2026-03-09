---
id: daily-news
name: Daily News Summary
description: Produce a short news summary for all active chat sessions.
enabled: true
execution_engine: in_process
context_mode: fresh
instance: cc-bridge
workspace: cc-bridge
exec_timeout_ms: 180000
schedule_type: cron
schedule_value: 0 0,12 * * *
target_mode: all_sessions
channels: [telegram, feishu]
template_vars: [input, date_utc, now_iso]
---

# Goal

Create a concise daily news brief for {{date_utc}} using fresh web information.

# Inputs

- `{{input}}`: optional focus, topic, or regional preference
- `{{date_utc}}`: current UTC date
- `{{now_iso}}`: current timestamp

# Output

- Write in Chinese
- Keep it concise and readable
- Cover the most relevant recent stories you can verify at runtime
- Include source links when available
- Start directly with the report content

# Prompt

Create a short daily news summary for {{date_utc}}.

Requirements:
- Use fresh web information gathered at runtime
- Prefer high-credibility sources
- Keep the output concise and useful for chat delivery
- Include source links when practical
- If `{{input}}` is provided, use it as extra guidance

Operator input:
{{input}}
