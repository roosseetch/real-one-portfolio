"""What the workflow asks the sanitiser for, and what the sanitiser accepts.

These are two files that have to agree and no compiler checks them. The
failure is not subtle -- argparse exits 2 and the job dies -- but it only
happens on a real dispatch, minutes after a draft has already moved to
`processing` and told the author to wait.
"""
import re
from pathlib import Path

import sanitize_media

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "process-media.yml"


def workflow_text() -> str:
    return WORKFLOW.read_text()


def test_the_workflow_calls_the_script_by_the_name_it_has():
    assert "scripts/sanitize_media.py" in workflow_text()
    assert "sanitize-media.py" not in workflow_text(), "the hyphenated name cannot be imported"


def test_every_flag_the_workflow_passes_is_one_the_script_defines():
    call = re.search(
        r"python scripts/sanitize_media\.py(.*?)(?=\n\s*\n|\n {6}- name)",
        workflow_text(),
        re.DOTALL,
    )
    assert call is not None, "could not find the sanitiser invocation in the workflow"

    passed = set(re.findall(r"--[a-z][a-z-]+", call.group(1)))
    assert passed, "the invocation passes no flags at all, which is suspicious in itself"

    parser_source = Path(sanitize_media.__file__).read_text()
    defined = set(re.findall(r'add_argument\("(--[a-z][a-z-]+)"', parser_source))

    assert passed <= defined, f"the workflow passes flags the script does not define: {passed - defined}"


def test_the_widths_the_workflow_requests_are_the_ones_it_checks_back():
    text = workflow_text()
    # One list, read twice: the completeness check parses DERIVATIVE_WIDTHS
    # rather than repeating the numbers, which is what keeps the two honest.
    assert text.count('DERIVATIVE_WIDTHS: "') == 1
    assert 'tr \',\' \' \'' in text or "tr ',' ' '" in text


def test_both_media_kinds_reach_the_sanitiser():
    text = workflow_text()
    # The download filter and the mapping filter must name the same kinds: one
    # without the other is either a file nothing maps or a mapping with no file.
    assert text.count('select(.type == "image" or .type == "video")') == 2
