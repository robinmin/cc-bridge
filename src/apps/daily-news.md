---
id: daily-news
name: Daily News Summary
description: Summarize today's important international headlines for all active chat sessions.
enabled: true
instance: cc-bridge
workspace: cc-bridge
exec_timeout_ms: 300000
schedule_type: recurring
schedule_value: 8h
target_mode: all_sessions
channels: [telegram, feishu]
template_vars: [input, date_utc, now_iso]
---

# Goal

Generate a concise daily global news brief for {{date_utc}} that highlights the most important developments and why they matter.

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
- Prioritize same-day developments and clearly time-sensitive updates

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

1. Collect the most significant same-day global developments.
2. Deduplicate aggressively: if multiple outlets cover the same event, merge into one story.
3. Filter for high impact and broad relevance.
4. Group selected items by category.
5. Summarize each item with context and significance.
6. Produce final concise brief and append `Watch Next`.

## Prompt

Create today's news summary for {{date_utc}}.

Output in Chinese.

Cover categories in this order: US, China, East Asia, World, Tech, Sports, Business.

Strict output start rule:
- Begin immediately with the report title and sections.
- Do not output any meta preface, explanation of method, or separators before the title.

Prioritize story discovery from https://www.newsnow.com/us/, then validate or supplement with other high-credibility sources when needed.

Prefer the trusted source list in this file when selecting and cross-checking stories. If conflicts exist, prioritize wire services and official sources.

Deduplication rule (strict):
- Never output duplicate stories about the same event.
- If the same event appears across multiple sources, keep one canonical story item and merge key details into 1-2 sentences.
- Prefer the clearest headline and most reliable facts from wire/official sources.

For proper nouns and technical terms, keep original names/abbreviations when helpful.

For each story item, append one source line using markdown hyperlink format exactly:
- `来源：[<媒体简称>](<原始新闻URL>)`
- The hyperlink text must be the source/briefing name.
- The URL must point to the original news article page.

Operator input:
{{input}}
