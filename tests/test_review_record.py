"""tools/review_record.py, which holds a pull request marked ready to a
written adversarial review, and the required job check in
.github/workflows/ci.yml, which runs it itself or through scripts/check.sh.

Each way through the verdict is tested: a ready pull request with a real
section passes; one with none, with the template's placeholder or with a
line too short to say anything fails; a draft, a bot's pull request and one
opened before the rule began pass; and a run outside a pull request event
passes, so bash scripts/check.sh on a laptop is unchanged."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import review_record  # noqa: E402

AFTER = "2026-10-23T00:00:00Z"
REAL = ("## Adversarial review\n\nA second session tried to break the parser with an empty body, "
        "a CRLF body and a heading in a code block; the CRLF case failed and is fixed.\n")


def pull(body, **fields):
    return {"body": body, "draft": False, "user": {"type": "User"}, "created_at": AFTER, **fields}


class Verdict(unittest.TestCase):
    def test_a_real_record_passes(self):
        self.assertTrue(review_record.verdict(pull(REAL))[0])

    def test_a_record_written_with_windows_line_ends_passes(self):
        self.assertTrue(review_record.verdict(pull(REAL.replace("\n", "\r\n")))[0])

    def test_no_section_fails(self):
        passes, message = review_record.verdict(pull("Before: x\n\nAfter: y\n"))
        self.assertFalse(passes)
        self.assertIn("## Adversarial review", message)

    def test_an_empty_body_fails(self):
        self.assertFalse(review_record.verdict(pull(None))[0])

    def test_the_placeholder_fails(self):
        body = "## Adversarial review\n\n" + review_record.PLACEHOLDER + " to make it fail, and what came of it.\n"
        self.assertFalse(review_record.verdict(pull(body))[0])

    def test_a_short_line_fails(self):
        self.assertFalse(review_record.verdict(pull("## Adversarial review\n\nLGTM\n"))[0])

    def test_the_section_ends_at_the_next_heading(self):
        body = "## Adversarial review\n\nok\n\n## Notes\n\n" + "x" * 200 + "\n"
        self.assertFalse(review_record.verdict(pull(body))[0])

    def test_a_command_in_a_fence_stays_in_the_section(self):
        body = "## Adversarial review\n\n```\n# run the tests\npython3 -m unittest\n```\nA second session ran the suite against the empty body case and it passed.\n"
        self.assertTrue(review_record.verdict(pull(body))[0])

    def test_a_heading_inside_a_fence_does_not_count(self):
        body = "```\n## Adversarial review\n" + "x" * 80 + "\n```\n"
        self.assertFalse(review_record.verdict(pull(body))[0])

    def test_text_in_an_html_comment_does_not_count(self):
        body = "## Adversarial review\n\n<!-- " + "x" * 80 + " -->\n"
        self.assertFalse(review_record.verdict(pull(body))[0])

    def test_the_heading_may_carry_a_colon_closing_hashes_level_four_or_bold(self):
        for heading in ("## Adversarial review:", "## Adversarial review ##", "#### Adversarial review",
                        "**Adversarial review**"):
            body = heading + "\n\nA second session tried an empty body and a CRLF body; both now pass.\n"
            self.assertTrue(review_record.verdict(pull(body))[0], heading)

    def test_an_empty_first_section_does_not_hide_a_second(self):
        body = "## Adversarial review\n\n## Adversarial review\n\nA second session tried an empty body and a CRLF body; both pass.\n"
        self.assertTrue(review_record.verdict(pull(body))[0])

    def test_a_generated_branch_in_this_repository_passes(self):
        here = {"repo": {"full_name": "o/r"}}
        for ref in ("crowd/setup", "symphony-protocol/sync", "symphony/worker-docs", "drive/sync"):
            self.assertTrue(review_record.verdict(pull("", head={"ref": ref, **here}, base=here))[0], ref)

    def test_a_generated_branch_name_from_a_fork_is_still_asked(self):
        self.assertFalse(review_record.verdict(pull("", head={"ref": "crowd/setup", "repo": {"full_name": "x/r"}},
                                                    base={"repo": {"full_name": "o/r"}}))[0])

    def test_a_draft_passes(self):
        self.assertTrue(review_record.verdict(pull("", draft=True))[0])

    def test_a_bot_passes(self):
        self.assertTrue(review_record.verdict(pull("", user={"type": "Bot"}))[0])

    def test_a_pull_request_opened_before_the_rule_passes(self):
        self.assertTrue(review_record.verdict(pull("", created_at="2026-10-22T02:48:37Z"))[0])

    def test_the_template_carries_the_section_and_its_placeholder(self):
        template = (ROOT / ".github" / "PULL_REQUEST_TEMPLATE.md").read_text(encoding="utf-8")
        self.assertIsNotNone(review_record.review_text(template))
        self.assertFalse(review_record.verdict(pull(template))[0])


class Main(unittest.TestCase):
    def run_with(self, event_name, payload):
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "event.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            return review_record.main({"GITHUB_EVENT_NAME": event_name, "GITHUB_EVENT_PATH": str(path)})

    def test_outside_a_pull_request_it_passes(self):
        self.assertEqual(review_record.main({}), 0)
        self.assertEqual(self.run_with("push", {}), 0)

    def test_a_ready_pull_request_without_a_record_fails(self):
        self.assertEqual(self.run_with("pull_request", {"pull_request": pull("")}), 1)

    def test_a_ready_pull_request_with_a_record_passes(self):
        self.assertEqual(self.run_with("pull_request", {"pull_request": pull(REAL)}), 0)


class Workflow(unittest.TestCase):
    def test_the_required_job_runs_it_on_every_pull_request_event_that_changes_the_body(self):
        text = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        check = text.split("\n  check:\n", 1)[1]
        script = ROOT / "scripts" / "check.sh"
        runs_it = "python3 tools/review_record.py" in check or (
            "bash scripts/check.sh" in check and "python3 tools/review_record.py" in script.read_text(encoding="utf-8"))
        self.assertTrue(runs_it, "the job check runs tools/review_record.py, itself or through scripts/check.sh")
        for kind in ("edited", "ready_for_review", "converted_to_draft"):
            self.assertIn(kind, text.split("pull_request:", 1)[1].split("push:", 1)[0])


if __name__ == "__main__":
    unittest.main()
