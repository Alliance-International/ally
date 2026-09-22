import asyncio
from dataclasses import replace
from types import SimpleNamespace
from uuid import UUID

import pytest

from ai.contracts import ProviderStructuredResult, ProviderTextResult, TokenUsage
from ai.exceptions import (
    AIGenerationInProgress,
    AIIdempotencyConflict,
    AIInputTooLargeError,
    AIMalformedResponseError,
)
from ai.schemas import MeetingGenerationRequest
from ai.service import AIService
from conftest import configured_settings


USER_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
KEY = UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")


VALID_OUTPUT = {
    "summary": "SUMMARY:\n<script>alert(1)</script>",
    "email_subject": "Project update",
    "actions": [
        {
            "title": "Send plan",
            "assignee": "Alice",
            "assignee_email": "invented@example.com",
            "start_date": "2026-09-21",
            "deadline": "2026-09-22",
            "evidence": "Alice will send the plan",
        }
    ],
}


class FakeProvider:
    name = "groq"
    text_model = "openai/gpt-oss-20b"
    structured_model = "openai/gpt-oss-20b"

    def __init__(self, structured=None, text="chunk summary"):
        self.structured = list(structured or [VALID_OUTPUT])
        self.text = text
        self.text_calls = []
        self.structured_calls = []

    async def generate_text(self, **kwargs):
        self.text_calls.append(kwargs)
        return ProviderTextResult(
            self.text,
            "groq",
            self.text_model,
            "stop",
            TokenUsage(10, 5),
        )

    async def generate_structured(self, **kwargs):
        self.structured_calls.append(kwargs)
        value = self.structured.pop(0)
        if isinstance(value, Exception):
            raise value
        return ProviderStructuredResult(
            value,
            "groq",
            self.structured_model,
            "stop",
            TokenUsage(20, 10),
        )

    async def close(self):
        return None


class FakeStore:
    def __init__(self, outcome="claimed"):
        self.outcome = outcome
        self.persisted = []
        self.failed = []
        self.claims = 0

    async def claim(self, **kwargs):
        self.claims += 1
        return {"outcome": self.outcome}

    async def mark_provider_started(self, **kwargs):
        return True

    async def fail(self, **kwargs):
        self.failed.append(kwargs)

    async def persist(self, payload):
        self.persisted.append(payload)
        actions = [
            {
                "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                **payload["p_actions"][0],
                "review_status": "pending",
                "reviewed_at": None,
            }
        ]
        return {
            "meeting_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "formatted_result": payload["p_summary_html"],
            "plain_text_summary": payload["p_summary_text"],
            "email_subject": payload["p_email_subject"],
            "ai_provider": payload["p_provider"],
            "ai_model": payload["p_model"],
            "prompt_version": payload["p_prompt_version"],
            "finish_reason": payload["p_finish_reason"],
            "actions": actions,
        }

    async def get_result(self, **kwargs):
        return {
            "meeting_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "formatted_result": "<p>Saved</p>",
            "plain_text_summary": "Saved",
            "email_subject": "Saved result",
            "ai_provider": "groq",
            "ai_model": "openai/gpt-oss-20b",
            "prompt_version": "phase2e-v1",
            "finish_reason": "stop",
            "actions": [],
        }


def settings(**overrides):
    values = {
        "ai_enabled": True,
        "ai_provider": "groq",
        "groq_api_key": "test",
        "ai_text_model": "openai/gpt-oss-20b",
        "ai_structured_model": "openai/gpt-oss-20b",
        "ai_chunk_chars": 100,
        "ai_max_chunks": 5,
        "ai_max_input_chars": 500,
        "ai_max_estimated_input_tokens": 500,
    }
    values.update(overrides)
    return replace(configured_settings(), **values)


@pytest.mark.asyncio
async def test_meeting_generation_separates_prompts_validates_email_and_escapes_html():
    provider = FakeProvider()
    store = FakeStore()
    service = AIService(settings(), provider, store)
    response = await service.generate_meeting(
        user_id=USER_ID,
        idempotency_key=KEY,
        request=MeetingGenerationRequest(
            source_text="Alice will send the plan.",
            role="Engineer",
            target_language="French",
        ),
    )
    assert response.actions[0].assignee_email is None
    assert "<script>" not in response.formatted_result
    assert "&lt;script&gt;" in response.formatted_result
    messages = provider.structured_calls[0]["messages"]
    assert messages[0].role == "system"
    assert "Alice will send" not in messages[0].content
    assert messages[1].role == "user"
    assert "Alice will send" in messages[1].content
    assert '"requested_role":"Engineer"' in messages[1].content
    assert '"target_language":"French"' in messages[1].content
    assert "test-only-secret" not in "".join(item.content for item in messages)
    assert store.persisted[0]["p_provider"] == "groq"
    assert store.persisted[0]["p_prompt_version"] == "phase2e-v1"


@pytest.mark.asyncio
async def test_email_present_in_source_is_retained():
    provider = FakeProvider()
    service = AIService(settings(), provider, FakeStore())
    result = await service.generate_meeting(
        user_id=USER_ID,
        idempotency_key=KEY,
        request=MeetingGenerationRequest(
            source_text="Contact invented@example.com about the plan."
        ),
    )
    assert result.actions[0].assignee_email == "invented@example.com"


@pytest.mark.asyncio
async def test_malformed_output_gets_only_one_repair_attempt_and_is_not_saved():
    provider = FakeProvider(structured=[{"extra": "bad"}, {"still": "bad"}])
    store = FakeStore()
    with pytest.raises(AIMalformedResponseError):
        await AIService(settings(), provider, store).generate_meeting(
            user_id=USER_ID,
            idempotency_key=KEY,
            request=MeetingGenerationRequest(source_text="Valid source"),
        )
    assert len(provider.structured_calls) == 2
    assert store.persisted == []
    assert store.failed[0]["category"] == "malformed_provider_response"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid_output",
    [
        {**VALID_OUTPUT, "email_subject": "bad\r\nBcc: victim@example.com"},
        {**VALID_OUTPUT, "actions": [{**VALID_OUTPUT["actions"][0], "deadline": "not-a-date"}]},
        {
            **VALID_OUTPUT,
            "actions": [
                {
                    **VALID_OUTPUT["actions"][0],
                    "start_date": "2026-09-23",
                    "deadline": "2026-09-22",
                }
            ],
        },
        {**VALID_OUTPUT, "actions": [{**VALID_OUTPUT["actions"][0], "unexpected": True}]},
    ],
)
async def test_invalid_structured_fields_are_never_persisted(invalid_output):
    provider = FakeProvider(structured=[invalid_output, invalid_output])
    store = FakeStore()
    with pytest.raises(AIMalformedResponseError):
        await AIService(settings(), provider, store).generate_meeting(
            user_id=USER_ID,
            idempotency_key=KEY,
            request=MeetingGenerationRequest(source_text="Valid source"),
        )
    assert store.persisted == []
    assert len(provider.structured_calls) == 2


@pytest.mark.asyncio
async def test_long_input_is_chunked_sequentially_and_bounded():
    provider = FakeProvider()
    store = FakeStore()
    source = "First paragraph. " * 8 + "\n\n" + "Second paragraph. " * 8
    await AIService(settings(), provider, store).generate_meeting(
        user_id=USER_ID,
        idempotency_key=KEY,
        request=MeetingGenerationRequest(source_text=source),
    )
    assert 1 < len(provider.text_calls) <= 5
    assert len(provider.structured_calls) == 1
    assert store.persisted[0]["p_provider_call_count"] == len(provider.text_calls) + 1
    chunk_data = "".join(call["messages"][1].content for call in provider.text_calls)
    assert "First paragraph" in chunk_data
    assert "Second paragraph" in chunk_data


@pytest.mark.asyncio
async def test_normal_input_uses_one_structured_call_and_no_chunk_calls():
    provider = FakeProvider()
    await AIService(settings(), provider, FakeStore()).generate_meeting(
        user_id=USER_ID,
        idempotency_key=KEY,
        request=MeetingGenerationRequest(source_text="A short source."),
    )
    assert provider.text_calls == []
    assert len(provider.structured_calls) == 1


@pytest.mark.asyncio
async def test_overflow_is_rejected_without_provider_call():
    provider = FakeProvider()
    with pytest.raises(AIInputTooLargeError):
        await AIService(settings(ai_max_input_chars=20), provider, FakeStore()).generate_meeting(
            user_id=USER_ID,
            idempotency_key=KEY,
            request=MeetingGenerationRequest(source_text="x" * 21),
        )
    assert provider.text_calls == []
    assert provider.structured_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("outcome", "expected"),
    [("conflict", AIIdempotencyConflict), ("processing", AIGenerationInProgress)],
)
async def test_claim_conflict_or_active_processing_never_calls_provider(outcome, expected):
    provider = FakeProvider()
    with pytest.raises(expected):
        await AIService(settings(), provider, FakeStore(outcome)).generate_meeting(
            user_id=USER_ID,
            idempotency_key=KEY,
            request=MeetingGenerationRequest(source_text="source"),
        )
    assert provider.structured_calls == []


@pytest.mark.asyncio
async def test_completed_replay_reconstructs_result_without_provider_call():
    provider = FakeProvider()
    result = await AIService(settings(), provider, FakeStore("completed")).generate_meeting(
        user_id=USER_ID,
        idempotency_key=KEY,
        request=MeetingGenerationRequest(source_text="source"),
    )
    assert result.plain_text_summary == "Saved"
    assert provider.structured_calls == []


@pytest.mark.asyncio
async def test_topic_indexes_are_sorted_and_deduplicated_deterministically():
    provider = FakeProvider(
        structured=[
            {
                "topics": [
                    {"topic": "Zulu", "anchor": "def"},
                    {"topic": "Alpha", "anchor": "DEF"},
                    {"topic": "Start", "anchor": "abc"},
                ]
            }
        ]
    )
    topics = await AIService(settings(), provider, FakeStore()).detect_topics("abcdef")
    assert [(item.topic, item.index) for item in topics] == [("Start", 0), ("Alpha", 3)]


@pytest.mark.asyncio
async def test_unmatched_topic_anchors_are_rejected_after_one_repair():
    invalid = {"topics": [{"topic": "Outside", "anchor": "not in source"}]}
    provider = FakeProvider(structured=[invalid, invalid])
    with pytest.raises(AIMalformedResponseError):
        await AIService(settings(), provider, FakeStore()).detect_topics("short")
    assert len(provider.structured_calls) == 2


@pytest.mark.asyncio
async def test_topic_anchor_mapping_preserves_original_whitespace_index():
    provider = FakeProvider(
        structured=[
            {"topics": [{"topic": "Second", "anchor": "SECOND topic starts"}]}
        ]
    )
    source = "First topic.\n\nSecond   topic starts here."
    topics = await AIService(settings(), provider, FakeStore()).detect_topics(source)
    assert [(item.topic, item.index) for item in topics] == [
        ("Second", source.index("Second"))
    ]


@pytest.mark.asyncio
async def test_action_count_cap_prevents_partial_save():
    provider = FakeProvider(structured=[VALID_OUTPUT, VALID_OUTPUT])
    store = FakeStore()
    with pytest.raises(AIMalformedResponseError):
        await AIService(settings(ai_max_action_items=0), provider, store).generate_meeting(
            user_id=USER_ID,
            idempotency_key=KEY,
            request=MeetingGenerationRequest(source_text="source"),
        )
    assert store.persisted == []


@pytest.mark.asyncio
async def test_question_budget_counts_question_and_serialized_context():
    provider = FakeProvider()
    service = AIService(
        settings(ai_max_input_chars=25, ai_max_estimated_input_tokens=500),
        provider,
        FakeStore(),
    )
    with pytest.raises(AIInputTooLargeError):
        await service.answer_question(question="why", context="x" * 20)
    assert provider.text_calls == []


@pytest.mark.asyncio
async def test_autocomplete_has_reasoning_headroom_and_returns_only_one_word():
    provider = FakeProvider(text="continue naturally\nignore this second line")
    result = await AIService(settings(), provider, FakeStore()).autocomplete(
        "This sentence should"
    )
    assert result == " continue"
    assert provider.text_calls[0]["max_output_tokens"] == 512
    messages = provider.text_calls[0]["messages"]
    assert "This sentence should" not in messages[0].content
    assert "This sentence should" in messages[1].content


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("prefix", "prediction", "insertion"),
    [
        ("I am going to the ", "market", "market"),
        ("I am going to the", "market", " market"),
        ("I am going to the mar", "market", "ket"),
        ("I am going to the mar", "MARKET", "KET"),
        ("What is the next step in the ", "process", "process"),
        ("I am going to the ", "I am going to the market to buy food.", "market"),
        ("We agreed to ", '"review"', "review"),
        ("Nous allons au ", "marché", "marché"),
        ("We will visit the ", "cafe\u0301", "cafe\u0301"),
        ("यह एक ", "किताब", "किताब"),
        ("I am going to the mar", "", ""),
        ("I am going to the mar", "mar", ""),
        ("I am going to the ", "<script>alert(1)</script>", ""),
    ],
)
async def test_autocomplete_returns_exact_insertion(prefix, prediction, insertion):
    provider = FakeProvider(text=prediction)
    result = await AIService(settings(), provider, FakeStore()).autocomplete(prefix)
    assert result == insertion


@pytest.mark.asyncio
async def test_autocomplete_sends_previous_paragraphs_and_trailing_whitespace():
    import json

    source = "We buy vegetables at the market.\nToday I am going to the "
    provider = FakeProvider(text="market")
    await AIService(settings(), provider, FakeStore()).autocomplete(source)
    messages = provider.text_calls[0]["messages"]
    assert json.loads(messages[1].content) == {"text": source}
    assert "Do not answer questions" in messages[0].content


@pytest.mark.asyncio
async def test_topic_multiline_anchors_no_longer_fail_validation():
    source = "\n  Budget\nApproved spending for October.\n\nHiring\nRecruit two engineers.\n"
    provider = FakeProvider(structured=[{"topics": [
        {"topic": "Budget", "anchor": "Budget\nApproved spending for October."},
        {"topic": "Hiring", "anchor": "Hiring\nRecruit two engineers."},
    ]}])
    result = await AIService(settings(), provider, FakeStore()).detect_topics(source)
    assert [(topic.topic, topic.index) for topic in result] == [
        ("Budget", source.index("Budget")), ("Hiring", source.index("Hiring")),
    ]
    assert len(provider.structured_calls) == 1


@pytest.mark.asyncio
async def test_topic_offsets_preserve_crlf_leading_spaces_and_javascript_unicode_units():
    source = "\r\n  🚀 Launch approved.\r\n\r\nHiring\r\nRecruit two engineers.\r\n"
    provider = FakeProvider(structured=[{"topics": [
        {"topic": "Hiring", "anchor": "Hiring\nRecruit two engineers."},
    ]}])
    result = await AIService(settings(), provider, FakeStore()).detect_topics(source)
    assert result[0].index == len(source[:source.index("Hiring")].encode("utf-16-le")) // 2


@pytest.mark.asyncio
async def test_topic_titles_still_reject_html_and_newlines():
    for title in ["<b>Budget</b>", "Budget\nInjected", "   "]:
        output = {"topics": [{"topic": title, "anchor": "Budget"}]}
        provider = FakeProvider(structured=[output, output])
        with pytest.raises(AIMalformedResponseError):
            await AIService(settings(), provider, FakeStore()).detect_topics("Budget")


@pytest.mark.asyncio
async def test_question_uses_separate_untrusted_payload_and_plain_text_result():
    provider = FakeProvider(text="The answer is in the source.")
    result = await AIService(settings(), provider, FakeStore()).answer_question(
        question="What is the answer?", context="The source says forty-two."
    )
    assert result == "The answer is in the source."
    messages = provider.text_calls[0]["messages"]
    assert "forty-two" not in messages[0].content
    assert "What is the answer?" not in messages[0].content
    assert "forty-two" in messages[1].content
    assert "What is the answer?" in messages[1].content
