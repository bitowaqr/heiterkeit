# Heiterkeit

How the German Bundestag lost its sense of humour.

A quantitative study of parliamentary mood across 25 years, 1,690 plenary sessions, and 1,027,516 recorded reactions.

**[View the story →](https://bitowaqr.github.io/heiterkeit/)**

## What this is

German parliamentary stenographers record every audible reaction during plenary sessions — applause, laughter, heckling, amusement. We extracted all of them from the official Plenarprotokolle (WP14–21, 1998–2026) and tracked how the Bundestag's mood changed over time.

Key findings:
- The mood ratio (amusement / confrontation) collapsed around 2013 with the Grand Coalition, then again when the AfD entered in 2017
- Heiterkeit per session barely changed — but Zurufe (heckling) grew 8x, drowning it out
- The AfD accounts for 40–60% of all recorded Lachen since 2018 — mostly directed at other MPs

## Data

- **Source:** Bundestag Open Data (dserver.bundestag.de) and DIP API
- **Coverage:** WP14–21, 1,690 sessions, 1998–2026
- `data/sessions.json` — per-session aggregates (included, 160KB)
- `data/kommentare.jsonl` — raw annotations (128MB, gitignored, reproducible via `download.ts`)

## Reproduce

```bash
bun install
bun download.ts        # extract all annotations (~30min)
bun analyse.ts         # run stats analysis
open index.html        # view the story
```

## Files

| File | Purpose |
|---|---|
| `download.ts` | Data retrieval from Bundestag APIs |
| `analyse.ts` | Statistical analysis (segmented regression, permutation tests) |
| `index.html` | Scrollytelling visualisation |

## Credits

Paul Schneider · [Shoulders](https://shoulde.rs) · paul@shoulde.rs

Built with Claude Code. Data: Deutscher Bundestag.
