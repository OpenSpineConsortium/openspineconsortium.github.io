# Contributing

The same rules hold for everyone who opens a pull request here, a person or a Claude session, whoever's account it runs on: GitHub enforces them, so nobody's own instructions are needed to keep them.

## What GitHub holds every pull request to

- The default branch takes changes only by pull request, with no forced push and no deletion (the ruleset "Protect the default branch").
- The required check "check" passes (.github/workflows/ci.yml runs `bash scripts/check.sh`): the site's own build checks every page on disk and writes nothing (`tools/build_site.py --check-only`), the tests under tests/ pass, and a pull request marked ready carries its review record (below). Rebuild with `python -X utf8 tools/build_site.py` and commit what it wrote before you push (README.md, Publishing); then run `bash scripts/check.sh`, with the four source repositories beside this one or named as README.md says.
- A pull request marked ready carries a section headed `## Adversarial review` in its body: what a reviewer who wanted the change to fail checked, by reading it or by running it, what they found and what was fixed. It is at least a sentence; "LGTM" does not count. The pull request template has the heading. A draft, a bot's pull request and one opened before 2026-10-22 05:00 UTC are not asked for one. Editing the body re-runs the check; "Re-run" on the old run reads the body as it was, so edit the body instead, or push.
- The organization's ruleset "Require owner approval to merge" asks one approval, given after the last push, of a pull request from anyone but an organization owner.
- A pull request from a fork cannot pass: the check fetches the published texts with the organization's App, whose key GitHub gives no fork. Work on a branch of this repository.

## What everyone is expected to do

- One change, one pull request.
- The review above is adversarial: someone, or a second session, other than the author's first pass, tries to make the change fail before it is marked ready.
