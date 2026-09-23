"""Strict AI request, provider-output, and public-response schemas."""

from __future__ import annotations

import re
from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from email_validator import EmailNotValidError, validate_email
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
HTML_PATTERN = re.compile(r"<\s*/?\s*[a-zA-Z][^>]*>")
SUPPORTED_LANGUAGES = {
    "english": "English",
    "french": "French",
    "spanish": "Spanish",
    "german": "German",
    "japanese": "Japanese",
    "swahili": "Swahili",
}


def normalize_text(value: str, *, allow_newlines: bool = True) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    if CONTROL_PATTERN.search(value):
        raise ValueError("control characters are not allowed")
    if not allow_newlines and "\n" in value:
        raise ValueError("line breaks are not allowed")
    return value.strip()


def validate_editor_text(value: str) -> str:
    # Whitespace is significant: it identifies word boundaries for completion
    # and source offsets for topic labels (including CRLF and leading blanks).
    if CONTROL_PATTERN.search(value):
        raise ValueError("control characters are not allowed")
    if not value.strip():
        raise ValueError("text is required")
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class MeetingGenerationRequest(StrictModel):
    source_text: str = Field(min_length=1, max_length=500_000)
    source_type: Literal[
        "text", "document", "audio", "video", "microphone", "system_audio"
    ] = "text"
    source_filename: str | None = Field(default=None, max_length=255)
    role: str | None = Field(default=None, max_length=100)
    target_language: str | None = Field(default=None, max_length=30)

    @field_validator("source_text")
    @classmethod
    def validate_source(cls, value: str) -> str:
        value = normalize_text(value)
        if not value:
            raise ValueError("source text is required")
        return value

    @field_validator("source_filename", "role")
    @classmethod
    def validate_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = normalize_text(value, allow_newlines=False)
        return value or None

    @field_validator("target_language")
    @classmethod
    def validate_language(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = normalize_text(value, allow_newlines=False)
        if not value or value.casefold() == "no translation":
            return None
        normalized = SUPPORTED_LANGUAGES.get(value.casefold())
        if not normalized:
            raise ValueError("unsupported target language")
        return normalized


class AutocompleteRequest(StrictModel):
    text: str = Field(min_length=1, max_length=4_000)

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return validate_editor_text(value)


class QuestionRequest(StrictModel):
    question: str = Field(min_length=1, max_length=2_000)
    context: str = Field(min_length=1, max_length=150_000)

    @field_validator("question", "context")
    @classmethod
    def validate_text(cls, value: str) -> str:
        value = normalize_text(value)
        if not value:
            raise ValueError("text is required")
        return value


class TopicsRequest(StrictModel):
    text: str = Field(min_length=1, max_length=150_000)
    heading_indexes: list[Annotated[int, Field(ge=0, strict=True)]] = Field(
        default_factory=list, max_length=2000
    )

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return validate_editor_text(value)

    @model_validator(mode="after")
    def validate_heading_indexes(self):
        # Positions describe existing rich-text lines, never new instructions.
        starts = set()
        offset = 0
        for line in self.text.splitlines(keepends=True):
            if line.strip():
                starts.add(offset)
            offset += len(line.encode("utf-16-le", errors="surrogatepass")) // 2
        if any(index not in starts for index in self.heading_indexes):
            raise ValueError("heading indexes must identify nonempty source line starts")
        self.heading_indexes = sorted(set(self.heading_indexes))
        return self


class ReviewActionRequest(StrictModel):
    decision: Literal["confirmed", "rejected"]
    title: str = Field(min_length=1, max_length=500)
    assignee: str | None = Field(default=None, max_length=200)
    assignee_email: str | None = Field(default=None, max_length=320)
    start_date: date | None = None
    deadline: date | None = None

    @field_validator("title", "assignee")
    @classmethod
    def validate_plain_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = normalize_text(value, allow_newlines=False)
        if HTML_PATTERN.search(value):
            raise ValueError("HTML is not allowed")
        return value or None

    @field_validator("assignee_email")
    @classmethod
    def validate_email_address(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        value = normalize_text(value, allow_newlines=False)
        try:
            return validate_email(value, check_deliverability=False).normalized
        except EmailNotValidError as exc:
            raise ValueError("invalid email address") from exc

    @model_validator(mode="after")
    def validate_dates(self):
        if self.start_date and self.deadline and self.deadline < self.start_date:
            raise ValueError("deadline cannot precede start date")
        return self


class ActionSuggestion(StrictModel):
    title: str = Field(min_length=1, max_length=500)
    assignee: str | None = Field(max_length=200)
    assignee_email: str | None = Field(max_length=320)
    start_date: str | None = Field(max_length=10)
    deadline: str | None = Field(max_length=10)
    evidence: str | None = Field(max_length=500)

    @field_validator("title", "assignee", "evidence")
    @classmethod
    def validate_plain_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = normalize_text(value, allow_newlines=False)
        if HTML_PATTERN.search(value):
            raise ValueError("HTML is not allowed")
        return value or None

    @field_validator("assignee_email")
    @classmethod
    def validate_email_address(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        value = normalize_text(value, allow_newlines=False)
        try:
            return validate_email(value, check_deliverability=False).normalized
        except EmailNotValidError as exc:
            raise ValueError("invalid email address") from exc

    @field_validator("start_date", "deadline")
    @classmethod
    def validate_date(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        value = normalize_text(value, allow_newlines=False)
        try:
            return date.fromisoformat(value).isoformat()
        except ValueError as exc:
            raise ValueError("invalid ISO date") from exc

    @model_validator(mode="after")
    def validate_date_order(self):
        if self.start_date and self.deadline and self.deadline < self.start_date:
            raise ValueError("deadline cannot precede start date")
        return self


class MeetingAIOutput(StrictModel):
    summary: str = Field(min_length=1, max_length=250_000)
    email_subject: str = Field(min_length=1, max_length=200)
    actions: list[ActionSuggestion]

    @field_validator("summary")
    @classmethod
    def validate_summary(cls, value: str) -> str:
        value = normalize_text(value)
        if not value:
            raise ValueError("summary is required")
        return value

    @field_validator("email_subject")
    @classmethod
    def validate_subject(cls, value: str) -> str:
        value = normalize_text(value, allow_newlines=False).strip(' "')
        if not value:
            raise ValueError("email subject is required")
        return value


class TopicBlockSuggestion(StrictModel):
    topic: str = Field(min_length=1, max_length=200)
    block_id: int = Field(ge=0, strict=True)

    @field_validator("topic")
    @classmethod
    def validate_plain_text(cls, value: str) -> str:
        value = normalize_text(value, allow_newlines=False)
        if HTML_PATTERN.search(value):
            raise ValueError("HTML is not allowed")
        if not value:
            raise ValueError("topic is required")
        return value

class TopicsAIOutput(StrictModel):
    topics: list[TopicBlockSuggestion]


class TopicSuggestion(StrictModel):
    topic: str = Field(min_length=1, max_length=200)
    index: int = Field(ge=0)

    @field_validator("topic")
    @classmethod
    def validate_topic(cls, value: str) -> str:
        value = normalize_text(value, allow_newlines=False)
        if HTML_PATTERN.search(value):
            raise ValueError("HTML is not allowed")
        return value


class PublicAction(StrictModel):
    id: UUID
    title: str
    assignee: str | None
    assignee_email: str | None
    start_date: date | None
    deadline: date | None
    evidence: str | None
    review_status: Literal["pending", "confirmed", "rejected"]
    reviewed_at: str | None = None


class MeetingGenerationResponse(StrictModel):
    meeting_id: UUID
    formatted_result: str
    plain_text_summary: str
    email_subject: str
    ai_provider: str
    ai_model: str
    prompt_version: str
    finish_reason: str
    actions: list[PublicAction]


class TextResponse(StrictModel):
    text: str


class TopicsResponse(StrictModel):
    topics: list[TopicSuggestion]
