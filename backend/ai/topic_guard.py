"""Recognize existing headings without trusting model instructions or output."""

import re


def obvious_heading(line: str) -> bool:
    value = line.strip()
    if not value or len(value) > 120 or len(value.split()) > 12:
        return False
    if re.match(r"^#{1,6}\s+\S", value) or re.fullmatch(r"\*\*\S.*\*\*", value):
        return True
    if value.endswith((".", "!", "?", ";", ",", "。", "！", "？")):
        return False
    letters = [char for char in value if char.isalpha()]
    if not letters:
        return False
    if value.endswith(":") or value.isupper():
        return True
    # Capitalization alone must not turn ordinary unpunctuated prose into a
    # heading (common in typed notes and speech transcripts).
    if re.match(r"^(?:I|We|You|He|She|They|It|This|That|These|Those|The|A|An|There|Here|Please)\b", value, re.I):
        return False
    # Short standalone titles, including numbered titles and ALL CAPS labels.
    return (
        len(value) <= 80 and len(value.split()) <= 8 and letters[0].isupper()
    )


def labelled_ranges(text: str, heading_indexes: list[int]) -> list[tuple[int, int]]:
    """UTF-16 ranges covering a heading and its following paragraph group.

    Blank lines between a heading and its body are allowed. A blank line after
    body text starts a new candidate section; the model still checks whether
    it continues the existing topic before proposing any label there.
    """
    headings = set(heading_indexes)
    ranges: list[tuple[int, int]] = []
    offset = 0
    start: int | None = None
    has_body = False
    for line in text.splitlines(keepends=True):
        end = offset + len(line.encode("utf-16-le", errors="surrogatepass")) // 2
        if not line.strip():
            if start is not None and has_body:
                ranges.append((start, offset))
                start = None
                has_body = False
        elif offset in headings or obvious_heading(line):
            if start is None:
                start = offset
            has_body = False
        elif start is not None:
            has_body = True
        offset = end
    if start is not None:
        ranges.append((start, offset))
    return ranges
