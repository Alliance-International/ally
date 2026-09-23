"""Recognize existing headings without trusting model instructions or output."""

import re


SPEAKER_LINE = re.compile(r"^speaker\s+[^:\r\n]{1,40}:", re.IGNORECASE)


def obvious_heading(line: str, *, transcript: bool = False) -> bool:
    value = line.strip()
    if not value or len(value) > 120 or len(value.split()) > 12:
        return False
    if SPEAKER_LINE.match(value):
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
    if transcript or re.search(r"[.!?,;:]", re.sub(r"^\d{1,3}[.)]\s+", "", value)):
        return False
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
    transcript = sum(bool(SPEAKER_LINE.match(line.strip())) for line in text.splitlines()) >= 2
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
        elif offset in headings or obvious_heading(line, transcript=transcript):
            if start is None:
                start = offset
            has_body = False
        elif start is not None:
            has_body = True
        offset = end
    if start is not None:
        ranges.append((start, offset))
    return ranges
