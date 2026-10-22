"""Make the check named "check" required on the default branch, with the App's token.

The owner asked on 2026-10-22 that every contributor to an OpenSpineConsortium
repository be held to the strictest CI the owner's own sessions follow. GitHub
holds a contributor only to what a ruleset requires, and the repository's own
GITHUB_TOKEN cannot administer rulesets, so .github/workflows/required-check.yml
mints the SymphonyBoard App's installation token and runs this with it.

It changes the ruleset "Protect the default branch" alone: where the repository
has it, it adds the required check "check", taken from GitHub Actions, and
keeps every other rule as it is; where it has none, it makes it as
symphony-template's docs/setup/ruleset-main.json does (no deletion, no forced
push, changes by pull request, the check required, nobody bypassing). The rule
that a branch be up to date stays off, as the owner ordered on 2026-10-20.

It requires the check only once "check" has passed on the default branch's
head, so a check that cannot pass here, for a secret the repository does not
receive or a failure nobody has fixed yet, never closes the default branch to
every pull request; it says so and ends without a change, and the next green
run on the default branch applies it. Nothing is written twice.

    GH_TOKEN=<App token> CHECKS_TOKEN=<GITHUB_TOKEN> REPO=owner/name \
        DEFAULT_BRANCH=main python3 tools/required_check.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"
RULESET_NAME = "Protect the default branch"
CHECK = "check"
ACTIONS_APP_ID = 15368


def call(token, method, path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(API + path, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=30) as answer:
        text = answer.read().decode("utf-8")
    return json.loads(text) if text else None


def check_passed_on(token, repo, branch):
    """Whether the newest run of "check" from GitHub Actions on the branch's head passed."""
    head = call(token, "GET", f"/repos/{repo}/commits/{branch}")["sha"]
    runs = call(token, "GET", f"/repos/{repo}/commits/{head}/check-runs?check_name={CHECK}&filter=latest")
    ours = [run for run in runs.get("check_runs", []) if (run.get("app") or {}).get("id") == ACTIONS_APP_ID]
    return head, any(run.get("conclusion") == "success" for run in ours)


def required_check_rule():
    return {
        "type": "required_status_checks",
        "parameters": {
            "strict_required_status_checks_policy": False,
            "do_not_enforce_on_create": False,
            "required_status_checks": [{"context": CHECK, "integration_id": ACTIONS_APP_ID}],
        },
    }


def new_ruleset():
    return {
        "name": RULESET_NAME,
        "target": "branch",
        "enforcement": "active",
        "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
        "rules": [
            {"type": "deletion"},
            {"type": "non_fast_forward"},
            {
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 0,
                    "dismiss_stale_reviews_on_push": False,
                    "require_code_owner_review": False,
                    "require_last_push_approval": False,
                    "required_review_thread_resolution": False,
                    "allowed_merge_methods": ["merge", "squash", "rebase"],
                },
            },
            required_check_rule(),
        ],
        "bypass_actors": [],
    }


def with_check_required(ruleset):
    """The ruleset's body for a PUT with "check" required, or None where it is required already."""
    rules = [dict(rule) for rule in ruleset.get("rules") or []]
    status = [rule for rule in rules if rule.get("type") == "required_status_checks"]
    if not status:
        rules.append(required_check_rule())
    else:
        parameters = dict(status[0].get("parameters") or {})
        checks = list(parameters.get("required_status_checks") or [])
        if any(entry.get("context") == CHECK for entry in checks):
            return None
        checks.append({"context": CHECK, "integration_id": ACTIONS_APP_ID})
        parameters["required_status_checks"] = checks
        parameters.setdefault("strict_required_status_checks_policy", False)
        status[0]["parameters"] = parameters
    keys = ("name", "target", "enforcement", "conditions", "bypass_actors")
    body = {key: ruleset[key] for key in keys if key in ruleset}
    body["rules"] = rules
    return body


def apply(admin_token, repo):
    listed = call(admin_token, "GET", f"/repos/{repo}/rulesets?includes_parents=false&per_page=100") or []
    match = [entry for entry in listed if entry.get("name") == RULESET_NAME]
    if not match:
        made = call(admin_token, "POST", f"/repos/{repo}/rulesets", new_ruleset())
        return f"made the ruleset {RULESET_NAME!r} ({made['id']}) with {CHECK!r} required"
    ruleset = call(admin_token, "GET", f"/repos/{repo}/rulesets/{match[0]['id']}")
    body = with_check_required(ruleset)
    if body is None:
        return f"{CHECK!r} is required already in {RULESET_NAME!r} ({ruleset['id']})"
    call(admin_token, "PUT", f"/repos/{repo}/rulesets/{ruleset['id']}", body)
    return f"added {CHECK!r} to the required checks of {RULESET_NAME!r} ({ruleset['id']})"


def main(environ=None):
    environ = os.environ if environ is None else environ
    repo, branch = environ["REPO"], environ["DEFAULT_BRANCH"]
    try:
        head, passed = check_passed_on(environ["CHECKS_TOKEN"], repo, branch)
        if not passed:
            print(f"::warning::{CHECK!r} has not passed on {branch} at {head[:7]}, so it is not required yet; "
                  "the next green run on the default branch requires it")
            return 0
        print(apply(environ["GH_TOKEN"], repo))
    except urllib.error.HTTPError as error:
        print(f"::error::GitHub answered {error.code} to {error.url}: {error.read().decode('utf-8', 'replace')[:300]}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
