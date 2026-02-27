# Mini-App Definitions

This directory contains mini-app definitions in markdown format. Each `*.md` file is one mini-app.

Mini-app-specific utilities should live in a same-name folder next to the markdown spec:

```text
src/apps/<app-id>.md
src/apps/<app-id>/
```

Example:

```text
src/apps/daily-news.md
src/apps/daily-news/validate_links.ts
```

## Quick Start

To create a new mini-app:

```bash
cp ../gateway/apps/new_app_template.md <your-app-id>.md
```

Then edit the frontmatter and prompt body.

New execution controls in frontmatter:
- `execution_engine`: `claude_container` | `claude_host` | `codex_host`
- `context_mode`: `existing` | `fresh`
- `engine_command` / `engine_args`: optional command/args override for host engines (`{{prompt}}` placeholder supported)

## Documentation

- **Template**: `src/gateway/apps/new_app_template.md`
- **Driver**: `src/gateway/apps/driver.ts`
- **Full docs**: `src/gateway/apps/README.md`
