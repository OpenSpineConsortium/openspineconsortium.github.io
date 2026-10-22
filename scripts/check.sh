#!/usr/bin/env bash
# The required check "check" (.github/workflows/ci.yml runs this script), and the same run on a
# laptop: the site's own build checks the pages on disk and writes nothing
# (tools/build_site.py --check-only), the tests under tests/ run, and on a pull request event one
# marked ready is held to its review record (tools/review_record.py, CONTRIBUTING.md).
#
# The build renders the Beethoven and Symphony texts it checks the pages against from the
# repositories beside this one, or from where BEETHOVEN_REPO, BEETHOVEN_VSCODE_REPO, SYMPHONY_REPO
# and SYMPHONY_START_REPO point (README.md); CI fetches only those published texts and each
# extension's version, and it needs pandoc.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
run() { echo "== $*"; "$@" || { echo "FAIL: $*"; fail=1; }; }
run python3 -X utf8 tools/build_site.py --check-only --quiet
run python3 -m unittest discover -s tests -p 'test_*.py'
run python3 tools/review_record.py
if [ "$fail" = 0 ]; then echo "check: passed"; else echo "check: FAILED"; fi
exit "$fail"
