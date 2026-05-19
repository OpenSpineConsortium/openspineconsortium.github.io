# meded/

Data for the website's **Education Outcomes** section.

## Files

- **`survey-summary.json`** — de-identified aggregate summary of the OSC
  participation survey. This is what the website reads and the only survey
  artifact safe to publish.
- **`summarize_survey.py`** — regenerates `survey-summary.json` from a raw survey
  export.

## ⚠️ Do not commit the raw survey CSV

The raw export contains **names, sex assigned at birth, and race/ethnicity**.
It must never be committed to a public repository. `.gitignore` already excludes
`*Participation_Survey*.csv`, `meded/*.csv`, and `*_raw.csv` — keep it that way.

`survey-summary.json` contains only group-level counts and means (no individual
rows, no demographics, no free-text that could identify a respondent).

## Regenerating the summary

When you collect more responses, re-export the survey and run:

```bash
cd meded
python3 summarize_survey.py path/to/raw_survey_export.csv
```

This rewrites `survey-summary.json`. Commit only that file.

## Editing what's shown

- **Numbers** (competency means, headline stats, baseline) are computed — change
  them by re-running the script, not by hand.
- **Quotes** are hand-picked. Free-text responses need human curation, so the
  three quotes live in the `QUOTES` list near the top of `summarize_survey.py`.
  Edit them there, then re-run the script.
- Column indices at the top of the script must match your survey's column
  order; update them if the form changes.
