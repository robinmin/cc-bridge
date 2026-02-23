---
id: daily-news
name: Daily News Summary
description: Summarize today's important international headlines for all active chat sessions.
enabled: true
instance: cc-bridge
workspace: cc-bridge
exec_timeout_ms: 300000
schedule_type: cron
schedule_value: 0 0,12 * * *
target_mode: all_sessions
channels: [telegram, feishu]
template_vars: [input, date_utc, now_iso]
---

# Goal

Generate a concise daily global news brief for {{date_utc}} by fetching real news published within the last 48 hours from trusted sources. Do not generate or infer news from model memory.

## Inputs

### Arguments
- `{{input}}`: optional focus or constraints from operator (e.g. "focus on AI regulation")

### Configuration
- `instance`: `cc-bridge`
- `workspace`: `cc-bridge`
- `channels`: `telegram`, `feishu`

### Data Sources
- Prioritize https://www.newsnow.com/us/ as the primary aggregator source
- Use major international, high-credibility news outlets and official sources as verification and supplements
- Prefer these reputation sources when selecting or verifying stories:
  - Wire: Reuters, AP, AFP, Bloomberg
  - US: WSJ, NYT, Washington Post, Politico
  - World: BBC, Financial Times, The Economist, Al Jazeera
  - China / East Asia: Caixin, Nikkei Asia, South China Morning Post, The Straits Times
  - Tech: The Information, Ars Technica, MIT Technology Review
  - Business: Bloomberg, FT, WSJ, CNBC
  - Sports: ESPN, The Athletic, and official league sites
- Strict recency window: only include stories with publish/update timestamps within the last 48 hours (relative to runtime `now_iso`)
- If a source page does not clearly show a publish/update time, do not use it
- Never use LLM prior knowledge as a substitute for fresh retrieval

### Operational Tooling
- Use local verifier script for source link checks before finalizing:
  - `bun run src/apps/daily-news/validate_links.ts --from-file <report.md>`
  - or `bun run src/apps/daily-news/validate_links.ts <url1> <url2> ...`

## Outputs

### Format
- Total length: about 250-380 words
- Start directly with the news content. Do not add any lead-in sentence, preface, or divider (for example, do not output lines like "Based on my search results..." or `---` before content).
- Group stories by category:
  - US
  - China
  - East Asia
  - World
  - Tech
  - Sports
  - Business
- Include 7-12 stories
- Per story provide:
  - short title
  - 1-2 concise sentences with key information (cover-page style, like NewsNow)
  - end with one source line in this exact style: `来源：[<媒体简称>](<原始新闻URL>)`
  - `来源` must be the original article link (not a search page or aggregator list page)
- Do not include any item outside the 48-hour window
- URL requirements:
  - must be reachable (no 404/410 and no obvious error page)
  - must resolve to the intended story page
  - if URL is dead or mismatched, replace it before output
- End with a `Watch Next` section containing 3 developing topics
- Primary language: Chinese
- Keep original names, organizations, product names, and technical abbreviations in original form when accuracy/readability benefits (e.g., OpenAI, SEC, GDP, NVIDIA, ETF)

### Example Output
```text
Daily News Summary (2026-02-20)

World
1) [Title]
Context: ...
Why it matters: ...
来源：[Reuters](https://www.reuters.com/...)

Watch Next
- ...
- ...
- ...
```

## Workflow

1. Fetch candidate stories from the listed sources and verify each item has a visible publish/update timestamp.
2. Keep only stories within the strict last-48-hours window relative to `now_iso`.
3. Deduplicate aggressively: if multiple outlets cover the same event, merge into one story.
4. Filter for high impact and broad relevance.
5. Group selected items by category.
6. Write each item in 1-2 precise, concise sentences.
7. Mandatory verification gate before final output:
   - Content check: each item is factual, precise, concise, and aligned to its source
   - Link check: each `来源` URL is valid/reachable and points to the correct article page (not 404/error/mismatch)
8. Produce final concise brief and append `Watch Next`.

## Prompt

Create today's news summary for {{date_utc}}.

Output in Chinese.

Cover categories in this order: US, China, East Asia, World, Tech, Sports, Business.

Strict output start rule:
- Begin immediately with the report title and sections.
- Do not output any meta preface, explanation of method, or separators before the title.
- Do not output completion/status text such as "Daily news summary completed..." or "The brief includes ...".

Prioritize story discovery from https://www.newsnow.com/us/, then validate or supplement with other high-credibility sources when needed.

Prefer the trusted source list in this file when selecting and cross-checking stories. If conflicts exist, prioritize wire services and official sources.

Hard retrieval rule (mandatory):
- You must fetch real news from web sources at runtime.
- Do not generate news from model memory, background knowledge, or inferred trends.
- Only include stories with timestamps within the last 48 hours from `now_iso`.
- If you cannot retrieve enough valid stories in-window, output fewer items rather than fabricating.

Deduplication rule (strict):
- Never output duplicate stories about the same event.
- If the same event appears across multiple sources, keep one canonical story item and merge key details into 1-2 sentences.
- Prefer the clearest headline and most reliable facts from wire/official sources.

For proper nouns and technical terms, keep original names/abbreviations when helpful.

For each story item, append one source line using markdown hyperlink format exactly:
- `来源：[<媒体简称>](<原始新闻URL>)`
- The hyperlink text must be the source/briefing name.
- The URL must point to the original news article page.

Mandatory final verification before you return the answer:
- Verify each item is precise and concise (remove vague or speculative wording).
- Verify every source URL is valid/reachable and maps to the corresponding story page.
- Replace or remove any item with broken/mismatched links.

Operator input:
{{input}}
