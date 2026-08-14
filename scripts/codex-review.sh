#!/bin/bash
# LCI-6 — cross-family adversarial review.
#
# Pipes a diff plus its ticket spec to `codex exec` (OpenAI, ChatGPT plan, no API
# key) and parses a VERDICT line back out. The point is model-family diversity:
# the /jarvis pipeline's implementer and logic-reviewer are both Anthropic, so
# they share blind spots. A reviewer trained by a different lab fails differently.
#
# Read-only by construction: --sandbox read-only means the reviewer physically
# cannot edit the tree. Reviewers report; implementers fix. Never the same agent.
#
#   codex-review.sh <base-ref> [head-ref] [--spec <file>]
#
# Exit 0 = PASS, 1 = BLOCK, 2 = harness error (could not get a verdict).

set -uo pipefail

BASE="${1:?usage: codex-review.sh <base-ref> [head-ref] [--spec <file>]}"
HEAD_REF="HEAD"
SPEC_FILE=""

shift
while [ $# -gt 0 ]; do
  case "$1" in
    --spec) SPEC_FILE="${2:-}"; shift 2 ;;
    *)      HEAD_REF="$1"; shift ;;
  esac
done

command -v codex >/dev/null 2>&1 || { echo "codex CLI not found on PATH" >&2; exit 2; }

OUT_DIR="${CODEX_REVIEW_OUT:-${TMPDIR:-/tmp}}"
mkdir -p "$OUT_DIR"
DIFF_FILE="$OUT_DIR/codex-review-diff.patch"
REPORT="$OUT_DIR/codex-review-report.md"

# Exclude tests: the reviewer judges the implementation against the frozen oracle,
# it does not get to argue with the tests. Feeding it the test diff invites
# "this test is wrong" findings, which are out of scope for a reviewer.
git diff "$BASE".."$HEAD_REF" -- . ':(exclude)tests/' > "$DIFF_FILE" 2>/dev/null

if [ ! -s "$DIFF_FILE" ]; then
  echo "no non-test changes between $BASE and $HEAD_REF — nothing to review" >&2
  exit 2
fi

DIFF_LINES=$(wc -l < "$DIFF_FILE" | tr -d ' ')

SPEC_SECTION=""
if [ -n "$SPEC_FILE" ] && [ -f "$SPEC_FILE" ]; then
  SPEC_SECTION="The diff must satisfy this specification. Judge it against the spec,
not against what you would have designed:

<spec>
$(cat "$SPEC_FILE")
</spec>"
fi

PROMPT="You are an adversarial code reviewer. You are READ-ONLY: report defects,
never fix them, never edit a file.

$SPEC_SECTION

Review this diff ($DIFF_LINES lines). It is real code that will run unattended
overnight with authority to modify repositories and open pull requests. A defect
here means an autonomous agent does something its operator forbade, while they
sleep. Review it with that stake in mind.

<diff>
$(cat "$DIFF_FILE")
</diff>

Find what a passing test suite does not prove. Prioritise, in order:
1. Authorization and gating logic that fails OPEN rather than closed.
2. Concurrency: time-of-check/time-of-use, races between processes, caps that
   can be exceeded by the caller's own actions within one pass.
3. Data durability: migrations, non-atomic multi-statement writes, anything that
   can lose or corrupt a user's real database on a partial failure.
4. Silent failure: input a validator accepts but the consumer ignores; work that
   is dropped with no error surfaced anywhere.
5. Type assertions or casts that erase a nullability the runtime still has.

For each finding give: file and approximate line, what is wrong, and a CONCRETE
failure scenario — specific inputs or state leading to a specific wrong outcome.
Distinguish real defects from style preferences. Do not pad the list; a clean
pass is a legitimate and useful outcome. Do not restate what the code does
correctly except in one short closing paragraph.

End your response with exactly one line, nothing after it:
VERDICT: PASS
or
VERDICT: BLOCK"

echo "→ codex reviewing $BASE..$HEAD_REF ($DIFF_LINES lines, tests excluded)" >&2

printf '%s' "$PROMPT" | codex exec \
  --skip-git-repo-check \
  --sandbox read-only \
  ${CODEX_REVIEW_MODEL:+--model "$CODEX_REVIEW_MODEL"} \
  - > "$REPORT" 2>"$OUT_DIR/codex-review-stderr.log"

if [ ! -s "$REPORT" ]; then
  echo "codex produced no output — see $OUT_DIR/codex-review-stderr.log" >&2
  exit 2
fi

# Last VERDICT line wins: the prompt is echoed back in some codex output modes,
# so an early match can be the instruction rather than the answer.
VERDICT=$(grep -oE '^VERDICT: (PASS|BLOCK)' "$REPORT" | tail -1 | awk '{print $2}')

echo "report: $REPORT" >&2

case "$VERDICT" in
  PASS)  echo "VERDICT: PASS";  exit 0 ;;
  BLOCK) echo "VERDICT: BLOCK"; exit 1 ;;
  *)
    echo "no parseable VERDICT line in codex output — treating as harness error" >&2
    echo "(a missing verdict must never be read as a pass)" >&2
    exit 2
    ;;
esac
