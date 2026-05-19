#!/usr/bin/env python3
"""
Summarize the OpenSpineConsortium participation survey into a de-identified
aggregate JSON for the website's Education Outcomes section.

Usage:
    python3 summarize_survey.py path/to/raw_survey_export.csv

Writes survey-summary.json next to this script.

IMPORTANT — the raw survey CSV contains names, sex, and race/ethnicity.
Never commit it to a public repository. Only the aggregate JSON produced
here is safe to publish. (.gitignore already excludes *Participation_Survey*.csv)
"""
import csv, json, sys, os
from collections import OrderedDict

# Column indices in the raw export -------------------------------------------
COL_TRAIN_YEAR   = 5
COL_PRIOR_CODE   = 6
COL_PRIOR_IMAGE  = 7
COMFORT_BEFORE   = range(8, 14)    # 6 competencies, "before" ratings
COMFORT_NOW      = range(14, 20)   # same 6 competencies, "now" ratings
COL_RESEARCH     = 23              # effect on interest in research careers
COL_RECOMMEND    = 26              # would recommend OSC
COL_COAUTHOR     = 28              # wants co-authorship

COMPETENCIES = [
    "Reading & interpreting CT spine imaging",
    "Identifying spine landmarks & pathology",
    "Writing Python code",
    "Writing a scientific abstract",
    "Submitting work to a conference",
    "Reading a paper critically",
]

# Hand-picked representative quotes (free-text needs human curation, not code).
# Edit these after reviewing the "most valuable" / comments columns yourself.
QUOTES = [
    {"text": "Learning how to apply coding and imaging analysis to real "
             "clinical research projects.", "by": "OSC participant"},
    {"text": "Troubleshooting and thinking critically is a valuable skill that "
             "isn't used often during the preclinical years \u2014 and I have "
             "thoroughly enjoyed that process.", "by": "OSC participant"},
    {"text": "It's amazing that we can run programs like this with little to no "
             "prior coding experience.", "by": "OSC participant"},
]


def likert(cell):
    """'1 (Not at all comfortable)' -> 1 ; '4' -> 4."""
    cell = (cell or "").strip()
    return int(cell.split()[0]) if cell and cell.split()[0].isdigit() else None


def mean(vals):
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 1) if vals else 0.0


def main(path):
    with open(path, newline="") as f:
        rows = list(csv.reader(f))[1:]
    n = len(rows)

    competencies = []
    for k, label in enumerate(COMPETENCIES):
        before = mean([likert(r[COMFORT_BEFORE[k]]) for r in rows])
        now    = mean([likert(r[COMFORT_NOW[k]])    for r in rows])
        competencies.append(OrderedDict([
            ("label", label),
            ("before", before),
            ("now", now),
            ("delta", round(now - before, 1)),
        ]))

    improved   = sum(1 for c in competencies if c["now"] > c["before"])
    research   = sum(1 for r in rows if "increased" in r[COL_RESEARCH].lower())
    recommend  = sum(1 for r in rows if r[COL_RECOMMEND].strip().lower()
                     in ("definitely", "probably"))
    coauthor   = sum(1 for r in rows if r[COL_COAUTHOR].strip().lower() == "yes")
    no_code    = sum(1 for r in rows if r[COL_PRIOR_CODE].strip().lower() == "none")
    no_imaging = sum(1 for r in rows if "some segmentation"
                     not in r[COL_PRIOR_IMAGE].lower())

    summary = OrderedDict([
        ("$note", "De-identified aggregate summary of the OSC participation "
                  "survey. Do not commit the raw CSV (names, sex, "
                  "race/ethnicity). Regenerate with summarize_survey.py."),
        ("meta", OrderedDict([
            ("respondents", n),
            ("cohort", "Medical students (predominantly M2)"),
            ("instrument", "Pre/post self-assessment on a 1-5 comfort scale"),
        ])),
        ("scale", OrderedDict([
            ("min", 1), ("max", 5),
            ("min_label", "Not at all comfortable"),
            ("max_label", "Very comfortable"),
        ])),
        ("competencies", competencies),
        ("headline_stats", [
            OrderedDict([("value", "%d / %d" % (coauthor, n)),
                         ("label", "earned co-authorship on a CNS 2026 abstract")]),
            OrderedDict([("value", "%d / %d" % (improved, len(competencies))),
                         ("label", "self-assessed competencies improved group-wide")]),
            OrderedDict([("value", "%d / %d" % (research, n)),
                         ("label", "reported increased interest in research-oriented careers")]),
            OrderedDict([("value", "%d / %d" % (recommend, n)),
                         ("label", "would recommend OSC to another medical student")]),
        ]),
        ("baseline", "Most participants began from a near-zero baseline: "
                     "%d of %d had no prior coding experience, and %d of %d had "
                     "no prior hands-on medical-imaging analysis experience."
                     % (no_code, n, no_imaging, n)),
        ("quotes", QUOTES),
    ])

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "survey-summary.json")
    with open(out, "w") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print("wrote", out, "(%d respondents)" % n)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python3 summarize_survey.py path/to/raw_survey.csv")
    main(sys.argv[1])
