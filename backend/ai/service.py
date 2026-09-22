"""Product-level AI tasks, validation, idempotency, and persistence."""

from __future__ import annotations

import asyncio
import hashlib
import html
import json
import logging
import math
import re
import time
import unicodedata
from dataclasses import dataclass
from typing import Any, Callable, TypeVar
from uuid import UUID, uuid4

from pydantic import ValidationError

from config import Settings

from .contracts import AIMessage, AIProvider, ProviderStructuredResult, TokenUsage
from .exceptions import (
    AIError,
    AIGenerationInProgress,
    AIIdempotencyConflict,
    AIInfrastructureError,
    AIInputTooLargeError,
    AIMalformedResponseError,
    AIRefusalError,
    AITimeoutError,
    AITransportError,
    AIUnavailable,
)
from .prompts import (
    AUTOCOMPLETE_SYSTEM,
    CHUNK_SYSTEM,
    MEETING_SYSTEM,
    QUESTION_SYSTEM,
    TOPICS_SYSTEM,
)
from .schemas import (
    MeetingAIOutput,
    MeetingGenerationRequest,
    MeetingGenerationResponse,
    PublicAction,
    TopicSuggestion,
    TopicsAIOutput,
)


logger = logging.getLogger(__name__)
SchemaT = TypeVar("SchemaT")
SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+")


@dataclass
class UsageAccumulator:
    input_tokens: int = 0
    output_tokens: int = 0

    def add(self, usage: TokenUsage) -> None:
        self.input_tokens += max(0, int(usage.input_tokens or 0))
        self.output_tokens += max(0, int(usage.output_tokens or 0))


def canonical_request_hash(request: MeetingGenerationRequest) -> str:
    encoded = json.dumps(
        request.model_dump(mode="json"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def format_summary_html(summary: str) -> str:
    rendered: list[str] = []
    for raw_line in summary.splitlines():
        plain = raw_line.strip()
        if not plain:
            continue
        escaped = html.escape(plain)
        if (plain.endswith(":") and len(plain) < 100) or (
            plain.isupper() and len(plain) > 1
        ):
            rendered.append(f"<h3>{escaped}</h3>")
        else:
            rendered.append(f"<p>{escaped}</p>")
    return "".join(rendered)


def _split_naturally(text: str, chunk_chars: int, max_chunks: int) -> list[str]:
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    pieces: list[str] = []
    for paragraph in paragraphs or [text]:
        if len(paragraph) <= chunk_chars:
            pieces.append(paragraph)
            continue
        sentences = [item.strip() for item in SENTENCE_BOUNDARY.split(paragraph) if item.strip()]
        for sentence in sentences or [paragraph]:
            while len(sentence) > chunk_chars:
                split_at = sentence.rfind(" ", 0, chunk_chars + 1)
                if split_at < chunk_chars // 2:
                    split_at = chunk_chars
                pieces.append(sentence[:split_at].strip())
                sentence = sentence[split_at:].strip()
            if sentence:
                pieces.append(sentence)

    chunks: list[str] = []
    current = ""
    for piece in pieces:
        candidate = f"{current}\n\n{piece}" if current else piece
        if len(candidate) <= chunk_chars:
            current = candidate
        else:
            chunks.append(current)
            current = piece
    if current:
        chunks.append(current)
    if len(chunks) > max_chunks:
        raise AIInputTooLargeError("input exceeds bounded chunk capacity")
    # Splitting may normalize whitespace, but it must retain every source
    # character that carries content.
    original = re.sub(r"\s+", "", text)
    rebuilt = re.sub(r"\s+", "", "".join(chunks))
    if original != rebuilt:
        raise AIInputTooLargeError("input could not be split without loss")
    return chunks


def _find_anchor_index(text: str, anchor: str) -> int | None:
    """Resolve an AI-provided verbatim anchor to an original source index."""
    exact = text.find(anchor)
    if exact >= 0:
        return exact

    case_insensitive = re.search(re.escape(anchor), text, flags=re.IGNORECASE)
    if case_insensitive:
        return case_insensitive.start()

    words = [re.escape(part) for part in re.split(r"\s+", anchor.strip()) if part]
    if not words:
        return None
    whitespace_flexible = re.search(r"\s+".join(words), text, flags=re.IGNORECASE)
    return whitespace_flexible.start() if whitespace_flexible else None


def _word_insertion(text: str, prediction: str) -> str:
    """Convert a predicted whole word into the exact suffix to insert."""
    prediction = prediction.strip()
    if not prediction:
        return ""
    prediction = prediction.splitlines()[0].strip().strip('"`“”')
    # Defensive handling for models that echo the source despite instructions.
    prefix = text.strip()
    if prediction.startswith(prefix + " "):
        prediction = prediction[len(prefix):].lstrip()
    if not prediction:
        return ""
    word = prediction.split()[0]
    # Combining marks are part of words in many supported languages.
    letters = "".join(char for char in word if unicodedata.category(char)[0] != "M")
    if len(word) > 80 or not re.fullmatch(r"[^\W_]+(?:['’\-][^\W_]+)*[,.!?;]?", letters):
        return ""
    start = len(text)
    while start and (unicodedata.category(text[start - 1])[0] in "LMN" or text[start - 1] in "'’-"):
        start -= 1
    last_word = text[start:]
    if last_word and word.casefold().startswith(last_word.casefold()):
        return word[len(last_word):]
    separator = "" if not text or text[-1].isspace() or text[-1] in '(\"“‘/' else " "
    return separator + word


class AIService:
    def __init__(self, settings: Settings, provider: AIProvider, store: Any) -> None:
        self.settings = settings
        self.provider = provider
        self.store = store
        self._semaphore = asyncio.Semaphore(settings.ai_max_concurrent_requests)

    def _check_input(self, text: str) -> None:
        if len(text) > self.settings.ai_max_input_chars:
            raise AIInputTooLargeError("input exceeds character limit")
        estimated_tokens = math.ceil(len(text) / 3)
        if estimated_tokens > self.settings.ai_max_estimated_input_tokens:
            raise AIInputTooLargeError("input exceeds estimated token limit")

    async def _text_call(
        self, messages: list[AIMessage], *, max_tokens: int
    ):
        async with self._semaphore:
            result = await self.provider.generate_text(
                messages=messages,
                temperature=0.2,
                max_output_tokens=min(max_tokens, self.settings.ai_max_output_tokens),
            )
        if result.refusal:
            raise AIRefusalError("provider refused request")
        return result

    async def _structured_call(
        self,
        messages: list[AIMessage],
        *,
        schema_name: str,
        schema_model: Any,
        validator: Callable[[dict[str, Any]], SchemaT],
        max_tokens: int,
    ) -> tuple[SchemaT, ProviderStructuredResult, int]:
        last_error: Exception | None = None
        for attempt in range(2):
            try:
                async with self._semaphore:
                    result = await self.provider.generate_structured(
                        messages=messages,
                        schema_name=schema_name,
                        schema=schema_model.model_json_schema(),
                        temperature=0.1,
                        max_output_tokens=min(
                            max_tokens, self.settings.ai_max_output_tokens
                        ),
                    )
                if result.refusal:
                    raise AIRefusalError("provider refused request")
                return validator(result.data), result, attempt + 1
            except (ValidationError, AIMalformedResponseError, ValueError) as error:
                last_error = error
                if attempt == 0:
                    continue
        raise AIMalformedResponseError("structured provider output failed validation") from last_error

    async def _meeting_output(
        self, request: MeetingGenerationRequest
    ) -> tuple[MeetingAIOutput, ProviderStructuredResult, UsageAccumulator, int]:
        self._check_input(request.source_text)
        chunks = _split_naturally(
            request.source_text,
            self.settings.ai_chunk_chars,
            self.settings.ai_max_chunks,
        )
        usage = UsageAccumulator()
        call_count = 0
        source_for_final = request.source_text
        if len(chunks) > 1:
            summaries: list[str] = []
            for position, chunk in enumerate(chunks, start=1):
                payload = json.dumps(
                    {"chunk_number": position, "chunk_text": chunk},
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                chunk_result = await self._text_call(
                    [
                        AIMessage("system", CHUNK_SYSTEM),
                        AIMessage("user", payload),
                    ],
                    max_tokens=min(1_500, self.settings.ai_max_output_tokens),
                )
                call_count += 1
                usage.add(chunk_result.usage)
                if len(chunk_result.content) > 12_000:
                    raise AIMalformedResponseError("chunk summary exceeds limit")
                summaries.append(chunk_result.content)
            source_for_final = json.dumps(
                {"chunk_summaries": summaries},
                ensure_ascii=False,
                separators=(",", ":"),
            )

        user_payload = json.dumps(
            {
                "source": source_for_final,
                "source_was_chunked": len(chunks) > 1,
                "requested_role": request.role,
                "target_language": request.target_language,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )

        def validate(data: dict[str, Any]) -> MeetingAIOutput:
            output = MeetingAIOutput.model_validate(data)
            if len(output.actions) > self.settings.ai_max_action_items:
                raise ValueError("too many actions")
            normalized_actions = []
            source_folded = request.source_text.casefold()
            for action in output.actions:
                email_address = action.assignee_email
                if email_address and email_address.casefold() not in source_folded:
                    action = action.model_copy(update={"assignee_email": None})
                normalized_actions.append(action)
            return output.model_copy(update={"actions": normalized_actions})

        output, result, attempts = await self._structured_call(
            [AIMessage("system", MEETING_SYSTEM), AIMessage("user", user_payload)],
            schema_name="ally_meeting_result",
            schema_model=MeetingAIOutput,
            validator=validate,
            max_tokens=self.settings.ai_max_output_tokens,
        )
        usage.add(result.usage)
        call_count += attempts
        if call_count > self.settings.ai_max_chunks + 2:
            raise AIInfrastructureError("provider call budget exceeded")
        return output, result, usage, call_count

    @staticmethod
    def _public_response(data: dict[str, Any]) -> MeetingGenerationResponse:
        return MeetingGenerationResponse.model_validate(data)

    async def generate_meeting(
        self,
        *,
        user_id: UUID,
        idempotency_key: UUID,
        request: MeetingGenerationRequest,
    ) -> MeetingGenerationResponse:
        request_hash = canonical_request_hash(request)
        claim_token = uuid4()
        claim = await self.store.claim(
            user_id=user_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            claim_token=claim_token,
        )
        outcome = claim.get("outcome")
        if outcome == "completed":
            return self._public_response(
                await self.store.get_result(
                    user_id=user_id, idempotency_key=idempotency_key
                )
            )
        if outcome == "conflict":
            raise AIIdempotencyConflict("idempotency key request mismatch")
        if outcome == "processing":
            raise AIGenerationInProgress("generation is already processing")
        if outcome in {"failed", "unknown"}:
            raise AIUnavailable("the prior generation did not complete")
        if outcome != "claimed":
            raise AIInfrastructureError("generation claim was invalid")
        if not await self.store.mark_provider_started(
            user_id=user_id,
            idempotency_key=idempotency_key,
            claim_token=claim_token,
        ):
            raise AIInfrastructureError("generation claim expired")

        started = time.monotonic()
        try:
            output, provider_result, usage, call_count = await self._meeting_output(request)
            formatted = format_summary_html(output.summary)
            persisted = await self.store.persist(
                {
                    "p_user_id": str(user_id),
                    "p_idempotency_key": str(idempotency_key),
                    "p_claim_token": str(claim_token),
                    "p_source_type": request.source_type,
                    "p_source_filename": request.source_filename,
                    "p_source_text": request.source_text,
                    "p_summary_html": formatted,
                    "p_summary_text": output.summary,
                    "p_email_subject": output.email_subject,
                    "p_requested_role": request.role,
                    "p_target_language": request.target_language,
                    "p_provider": provider_result.provider,
                    "p_model": provider_result.model,
                    "p_prompt_version": self.settings.ai_prompt_version,
                    "p_finish_reason": provider_result.finish_reason,
                    "p_actions": [
                        action.model_dump(mode="json") for action in output.actions
                    ],
                    "p_input_tokens": usage.input_tokens,
                    "p_output_tokens": usage.output_tokens,
                    "p_provider_call_count": call_count,
                }
            )
        except AIError as error:
            await self.store.fail(
                user_id=user_id,
                idempotency_key=idempotency_key,
                claim_token=claim_token,
                category=error.category,
                uncertain=isinstance(error, (AITimeoutError, AITransportError)),
            )
            raise
        except (ValidationError, ValueError, TypeError) as error:
            await self.store.fail(
                user_id=user_id,
                idempotency_key=idempotency_key,
                claim_token=claim_token,
                category="malformed_provider_response",
                uncertain=False,
            )
            raise AIMalformedResponseError("generated result failed validation") from error

        logger.info(
            "ai_generation operation=meeting_generation provider=%s model=%s prompt_version=%s result=completed latency_ms=%d calls=%d input_tokens=%d output_tokens=%d",
            provider_result.provider,
            provider_result.model,
            self.settings.ai_prompt_version,
            int((time.monotonic() - started) * 1000),
            call_count,
            usage.input_tokens,
            usage.output_tokens,
        )
        return self._public_response(persisted)

    async def autocomplete(self, text: str) -> str:
        self._check_input(text)
        payload = json.dumps({"text": text}, ensure_ascii=False, separators=(",", ":"))
        result = await self._text_call(
            [AIMessage("system", AUTOCOMPLETE_SYSTEM), AIMessage("user", payload)],
            max_tokens=512,
        )
        return _word_insertion(text, result.content)

    async def answer_question(self, *, question: str, context: str) -> str:
        payload = json.dumps(
            {"question": question, "context": context},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        self._check_input(payload)
        result = await self._text_call(
            [AIMessage("system", QUESTION_SYSTEM), AIMessage("user", payload)],
            max_tokens=min(1_500, self.settings.ai_max_output_tokens),
        )
        return result.content[:20_000]

    async def detect_topics(self, text: str) -> list[TopicSuggestion]:
        payload = json.dumps(
            {"source": text, "max_topics": self.settings.ai_max_topics},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        self._check_input(payload)

        def validate(data: dict[str, Any]) -> list[TopicSuggestion]:
            output = TopicsAIOutput.model_validate(data)
            if len(output.topics) > self.settings.ai_max_topics:
                raise ValueError("too many topics")

            candidates: list[TopicSuggestion] = []
            for topic in output.topics:
                index = _find_anchor_index(text, topic.anchor)
                if index is None:
                    raise ValueError("topic anchor does not occur in source")
                # JavaScript/Quill positions count UTF-16 units, not Python
                # code points. Emoji before a topic must not shift its label.
                editor_index = len(text[:index].encode("utf-16-le", errors="surrogatepass")) // 2
                candidates.append(TopicSuggestion(topic=topic.topic, index=editor_index))
            candidates.sort(key=lambda item: (item.index, item.topic.casefold()))

            unique: dict[int, TopicSuggestion] = {}
            for topic in candidates:
                unique.setdefault(topic.index, topic)
            return list(unique.values())

        topics, _result, _attempts = await self._structured_call(
            [AIMessage("system", TOPICS_SYSTEM), AIMessage("user", payload)],
            schema_name="ally_topics",
            schema_model=TopicsAIOutput,
            validator=validate,
            max_tokens=min(2_000, self.settings.ai_max_output_tokens),
        )
        return topics

    async def review_action(self, *, user_id: UUID, action_item_id: UUID, request: Any):
        result = await self.store.review_action(
            user_id=user_id,
            action_item_id=action_item_id,
            decision=request.decision,
            title=request.title,
            assignee=request.assignee,
            assignee_email=request.assignee_email,
            start_date=request.start_date.isoformat() if request.start_date else None,
            deadline=request.deadline.isoformat() if request.deadline else None,
        )
        if result.get("outcome") == "not_found":
            return None
        return result
