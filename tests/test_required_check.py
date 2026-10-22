"""tools/required_check.py, which makes "check" required on the default branch.

The ruleset it writes is tested without GitHub: a repository with no ruleset
gets the template's, one with a ruleset and no required checks gets the check
added and every other rule kept, one that already requires other checks keeps
them and gains "check", and one that requires "check" already is left alone.
The up-to-date rule stays off and nobody is added to the bypass list."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import required_check  # noqa: E402

PROTECT = {
    "id": 7, "name": "Protect the default branch", "target": "branch", "enforcement": "active",
    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
    "rules": [{"type": "deletion"}, {"type": "non_fast_forward"}],
    "bypass_actors": [], "source_type": "Repository", "_links": {},
}


def contexts(body):
    rule = [r for r in body["rules"] if r["type"] == "required_status_checks"][0]
    return [entry["context"] for entry in rule["parameters"]["required_status_checks"]]


class Ruleset(unittest.TestCase):
    def test_a_new_ruleset_requires_check_from_actions_with_nobody_bypassing(self):
        body = required_check.new_ruleset()
        self.assertEqual(contexts(body), ["check"])
        self.assertEqual(body["bypass_actors"], [])
        rule = body["rules"][-1]["parameters"]
        self.assertFalse(rule["strict_required_status_checks_policy"])
        self.assertEqual(rule["required_status_checks"][0]["integration_id"], 15368)
        self.assertIn("pull_request", [r["type"] for r in body["rules"]])

    def test_a_ruleset_without_checks_gains_check_and_keeps_its_rules(self):
        body = required_check.with_check_required(PROTECT)
        self.assertEqual(contexts(body), ["check"])
        self.assertEqual([r["type"] for r in body["rules"]][:2], ["deletion", "non_fast_forward"])
        self.assertNotIn("id", body)
        self.assertNotIn("source_type", body)

    def test_other_required_checks_are_kept(self):
        ruleset = dict(PROTECT, rules=PROTECT["rules"] + [{"type": "required_status_checks", "parameters": {
            "strict_required_status_checks_policy": False,
            "required_status_checks": [{"context": "gate"}]}}])
        self.assertEqual(contexts(required_check.with_check_required(ruleset)), ["gate", "check"])

    def test_a_ruleset_that_requires_check_already_is_left_alone(self):
        ruleset = dict(PROTECT, rules=PROTECT["rules"] + [{"type": "required_status_checks", "parameters": {
            "required_status_checks": [{"context": "check"}]}}])
        self.assertIsNone(required_check.with_check_required(ruleset))

    def test_the_original_is_not_changed(self):
        before = repr(PROTECT)
        required_check.with_check_required(PROTECT)
        self.assertEqual(repr(PROTECT), before)


if __name__ == "__main__":
    unittest.main()
