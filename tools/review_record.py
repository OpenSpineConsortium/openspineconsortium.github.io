"""Hold a pull request to its review record, in CI.

The owner's rule for the owner's own sessions is an adversarial review before each
substantive pull request. Written only in the owner's Claude instructions it binds
nobody else, so this check makes it part of the required check "check" for
every contributor who opens a pull request under their own login, a person
or a session alike: a pull request marked ready
for review carries a section headed "## Adversarial review" whose text says
what was checked against the change and what came of it.

What passes without one, and why:
- a draft, since a claim opens its draft before any work is done
  (docs/agents/PROTOCOL.md, Work in the open), and the review comes before
  the pull request is marked ready;
- a pull request opened by a bot account (Dependabot, a GitHub App, a
  workflow's GITHUB_TOKEN, the workers in Actions among them), whose change
  is generated or whose own run is reviewed by the owner before it lands;
- a pull request from one of the branches a workflow or a script writes
  with a person's token where Actions may not open one (GENERATED_HEADS),
  whose body is generated;
- a pull request opened before the rule began (STARTED), so work already in
  review is not stopped half way;
- a run outside a pull request event, such as bash scripts/check.sh on a
  laptop or a push to the default branch.

It reads the event from GITHUB_EVENT_PATH, prints one line on what it found
and exits 1 when the record is missing or still the template's placeholder.
ci.yml runs it on the edited event too, so writing the section into the
body is enough to turn the check green.
"""

import json
import os
import re
import sys
from datetime import datetime

STARTED = "2026-10-22T05:00:00Z"
HEADING = re.compile(r"^(?:#{2,4}\s+|\*\*)\s*adversarial review\s*[:.]?\s*(?:\*\*)?\s*#*\s*$", re.IGNORECASE)
NEXT_HEADING = re.compile(r"^#{1,6}\s")
FENCE = re.compile(r"^\s*(```|~~~)")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
PLACEHOLDER = "What a reviewer who wanted the change to fail checked"
MINIMUM_LETTERS = 40
# Branches whose pull request a workflow or a script writes, body and all,
# and opens with a person's token where GitHub Actions may not open one:
# crowd.py setup, protocol.yml's sync, sync.yml's offer to adopted
# repositories, add-worker.yml and agents.yml, drive-sync.yml.
GENERATED_HEADS = ("crowd/setup", "symphony-protocol/", "symphony/", "drive/sync")


def lines_outside_fences(body):
    """Each line with a flag saying whether it is inside a fenced block."""
    inside = False
    for line in HTML_COMMENT.sub("", body or "").replace("\r\n", "\n").split("\n"):
        if FENCE.match(line):
            inside = not inside
            yield line, True
            continue
        yield line, inside


def review_text(body):
    """The text under every review heading, each up to the next heading, or None."""
    sections, current = [], None
    for line, fenced in lines_outside_fences(body):
        if not fenced and HEADING.match(line.strip()):
            current = []
            sections.append(current)
        elif not fenced and NEXT_HEADING.match(line):
            current = None
        elif current is not None:
            current.append(line)
    if not sections:
        return None
    return "\n".join("\n".join(section) for section in sections).strip()


def generated_head(pull):
    head = pull.get("head") or {}
    ref, repo, base_repo = head.get("ref") or "", head.get("repo") or {}, (pull.get("base") or {}).get("repo") or {}
    same_repository = repo.get("full_name") and repo.get("full_name") == base_repo.get("full_name")
    return bool(same_repository) and any(ref == name or (name.endswith("/") and ref.startswith(name))
                                         for name in GENERATED_HEADS)


def letters_in(text):
    return sum(1 for character in text if character.isalnum())


def opened_before_rule(created_at):
    if not created_at:
        return False
    parsed = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    return parsed < datetime.fromisoformat(STARTED.replace("Z", "+00:00"))


def verdict(pull):
    """(passes, message) for one pull request as the event gives it."""
    if pull.get("draft"):
        return True, "review record: a draft, so not yet asked for"
    if (pull.get("user") or {}).get("type") == "Bot":
        return True, "review record: opened by a bot, so not asked for"
    if generated_head(pull):
        return True, "review record: a branch whose pull request a workflow or a script writes, so not asked for"
    if opened_before_rule(pull.get("created_at")):
        return True, f"review record: opened before {STARTED}, so not asked for"
    text = review_text(pull.get("body"))
    if text is None:
        return False, ("review record: missing; add a section headed '## Adversarial review' to the "
                       "pull request's body saying what was checked against the change and what came of it "
                       "(CONTRIBUTING.md)")
    if PLACEHOLDER in text:
        return False, "review record: still the template's placeholder; replace it with what was checked"
    if letters_in(text) < MINIMUM_LETTERS:
        return False, (f"review record: too short ({letters_in(text)} letters, at least {MINIMUM_LETTERS}); "
                       "say what was checked and what came of it")
    return True, "review record: present"


def main(environ=None):
    environ = os.environ if environ is None else environ
    path = environ.get("GITHUB_EVENT_PATH")
    if environ.get("GITHUB_EVENT_NAME") != "pull_request" or not path:
        print("review record: not a pull request event, nothing to check")
        return 0
    with open(path, encoding="utf-8") as handle:
        pull = json.load(handle).get("pull_request") or {}
    passes, message = verdict(pull)
    print(message)
    return 0 if passes else 1


if __name__ == "__main__":
    sys.exit(main())
