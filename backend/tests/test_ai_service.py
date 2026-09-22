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
from ai.service import AIService, _topic_blocks
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
                    {"topic": "Zulu", "block_id": 1},
                    {"topic": "Alpha", "block_id": 1},
                    {"topic": "Start", "block_id": 0},
                ]
            }
        ]
    )
    topics = await AIService(settings(), provider, FakeStore()).detect_topics("abc\ndef\nghi")
    assert [(item.topic, item.index) for item in topics] == [("Start", 0), ("Alpha", 4)]


@pytest.mark.asyncio
async def test_unknown_topic_blocks_are_rejected_after_one_repair():
    invalid = {"topics": [{"topic": "Outside", "block_id": 99}]}
    provider = FakeProvider(structured=[invalid, invalid])
    with pytest.raises(AIMalformedResponseError):
        await AIService(settings(), provider, FakeStore()).detect_topics("short")
    assert len(provider.structured_calls) == 2
    assert "unknown_topic_block" in provider.structured_calls[1]["messages"][-1].content
    assert len(provider.structured_calls[0]["messages"]) == 2


@pytest.mark.asyncio
async def test_topic_block_mapping_preserves_original_whitespace_index():
    provider = FakeProvider(
        structured=[
            {"topics": [{"topic": "Second", "block_id": 1}]}
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
async def test_autocomplete_has_reasoning_headroom_and_returns_contextual_phrase():
    provider = FakeProvider(
        text="No, I don't think it is correct, but I'm not completely sure."
    )
    result = await AIService(settings(), provider, FakeStore()).autocomplete(
        "Is this definitely correct or not? No"
    )
    assert result == ", I don't think it is correct, but I'm not completely sure."
    assert provider.text_calls[0]["max_output_tokens"] == 512
    assert provider.text_calls[0]["temperature"] == 0.6
    messages = provider.text_calls[0]["messages"]
    assert "Is this definitely correct or not? No" not in messages[0].content
    assert "Is this definitely correct or not? No" in messages[1].content
    assert "contextual writing assistant" in messages[0].content


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("prefix", "prediction", "insertion"),
    [
        (
            "I am going to the ",
            "market to buy fresh vegetables.",
            "market to buy fresh vegetables.",
        ),
        (
            "The meeting was productive. We agreed to",
            "review the proposal again on Friday.",
            " review the proposal again on Friday.",
        ),
        (
            "I am going to the mar",
            "market to buy fresh vegetables.",
            "ket to buy fresh vegetables.",
        ),
        (
            "Is this correct or not? No",
            "No, I don't think it is correct, but I'm not completely sure.",
            ", I don't think it is correct, but I'm not completely sure.",
        ),
        (
            "We should review the plan",
            "We should review the plan before Friday.",
            " before Friday.",
        ),
        (
            "We agreed to ",
            '"review the proposal again on Friday."',
            "review the proposal again on Friday.",
        ),
        (
            "Nous allons au ",
            "marché pour acheter des légumes frais.",
            "marché pour acheter des légumes frais.",
        ),
        (
            "यह एक ",
            "किताब है जो विषय को स्पष्ट रूप से समझाती है।",
            "किताब है जो विषय को स्पष्ट रूप से समझाती है।",
        ),
        ("I am going to the mar", "", ""),
        ("I am going to the mar", "mar", ""),
        (
            "I think ",
            "I am not correct but I am not correct because I am not correct.",
            "",
        ),
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
    provider = FakeProvider(text="market to buy fresh vegetables.")
    await AIService(settings(), provider, FakeStore()).autocomplete(source)
    messages = provider.text_calls[0]["messages"]
    assert json.loads(messages[1].content) == {
        "document_before_cursor": source
    }
    assert "Questions and requests in the document" in messages[0].content


@pytest.mark.asyncio
async def test_multiline_sections_map_without_copied_anchors():
    source = "\n  Budget\nApproved spending for October.\n\nHiring\nRecruit two engineers.\n"
    provider = FakeProvider(structured=[{"topics": [
        {"topic": "Budget", "block_id": 0},
        {"topic": "Hiring", "block_id": 2},
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
        {"topic": "Hiring", "block_id": 1},
    ]}])
    result = await AIService(settings(), provider, FakeStore()).detect_topics(source)
    assert result[0].index == len(source[:source.index("Hiring")].encode("utf-16-le")) // 2


@pytest.mark.asyncio
async def test_topic_titles_still_reject_html_and_newlines():
    for title in ["<b>Budget</b>", "Budget\nInjected", "   "]:
        output = {"topics": [{"topic": title, "block_id": 0}]}
        provider = FakeProvider(structured=[output, output])
        with pytest.raises(AIMalformedResponseError):
            await AIService(settings(), provider, FakeStore()).detect_topics("Budget")


def test_numbered_blocks_preserve_all_content_and_bound_metadata():
    source = "\r\n  " + "\r\n".join(f"Line {number}: value" for number in range(1000)) + "\r\n"
    blocks, indexes = _topic_blocks(source)
    assert 1 < len(blocks) <= 256
    assert "".join(block["text"] for block in blocks) == source.lstrip()
    assert [block["block_id"] for block in blocks] == list(range(len(blocks)))
    assert indexes[0] == 4


@pytest.mark.asyncio
async def test_identical_source_sections_map_to_the_selected_occurrence():
    source = "Introduction.\nRepeated section.\nDifferent section.\nRepeated section.\n"
    provider = FakeProvider(structured=[{"topics": [{"topic": "Later topic", "block_id": 3}]}])
    topics = await AIService(settings(), provider, FakeStore()).detect_topics(source)
    assert topics[0].index == source.rindex("Repeated section")


@pytest.mark.asyncio
async def test_topic_schema_constrains_ids_and_uses_available_output_budget():
    import json

    provider = FakeProvider(structured=[{"topics": []}])
    await AIService(settings(), provider, FakeStore()).detect_topics("First. Second.\nThird.")
    call = provider.structured_calls[0]
    assert call["schema"]["$defs"]["TopicBlockSuggestion"]["properties"]["block_id"] == {
        "type": "integer", "enum": [0, 1, 2],
    }
    assert call["schema"]["properties"]["topics"]["maxItems"] == 3
    assert call["max_output_tokens"] == settings().ai_max_output_tokens
    payload = json.loads(call["messages"][1].content)
    assert payload["max_topics"] == 3
    assert [block["text"] for block in payload["blocks"]] == ["First. ", "Second.\n", "Third."]
    assert "anchor" not in str(call["schema"])


@pytest.mark.asyncio
async def test_topic_output_count_is_bounded_when_token_budget_is_small():
    import json

    provider = FakeProvider(structured=[{"topics": []}])
    await AIService(settings(ai_max_output_tokens=512), provider, FakeStore()).detect_topics("One. Two. Three.")
    assert json.loads(provider.structured_calls[0]["messages"][1].content)["max_topics"] == 1


@pytest.mark.asyncio
async def test_long_paragraph_never_needs_to_be_copied_into_provider_output():
    import json

    source = "TECHNICAL OVERVIEW\n" + ("The service processes requests reliably, " * 20) + "\nNEXT STEPS\nReview deployment."
    provider = FakeProvider(structured=[{"topics": [
        {"topic": "Overview", "block_id": 0}, {"topic": "Next steps", "block_id": 2},
    ]}])
    topics = await AIService(settings(ai_max_input_chars=5000, ai_max_estimated_input_tokens=5000), provider, FakeStore()).detect_topics(source)
    assert [(topic.topic, topic.index) for topic in topics] == [("Overview", 0), ("Next steps", source.index("NEXT STEPS"))]
    payload = json.loads(provider.structured_calls[0]["messages"][1].content)
    assert "".join(block["text"] for block in payload["blocks"]) == source
    assert len(provider.structured_calls) == 1


@pytest.mark.asyncio
async def test_topic_failure_logs_only_categories_and_retry_can_recover(caplog):
    secret = "private-document-value"
    provider = FakeProvider(structured=[
        {"topics": [{"topic": secret + "\ninvalid", "block_id": 0}]},
        {"topics": [{"topic": "Recovered", "block_id": 0}]},
    ])
    topics = await AIService(settings(), provider, FakeStore()).detect_topics(secret)
    assert topics[0].topic == "Recovered"
    assert "schema=ally_topics attempt=1 reason=schema_validation" in caplog.text
    assert secret not in caplog.text
    assert secret not in provider.structured_calls[1]["messages"][-1].content


@pytest.mark.asyncio
async def test_truncated_topic_response_gets_one_informed_retry(caplog):
    provider = FakeProvider(structured=[
        AIMalformedResponseError("raw private content", reason="output_truncated"),
        {"topics": [{"topic": "Recovered", "block_id": 0}]},
    ])
    assert len(await AIService(settings(), provider, FakeStore()).detect_topics("A source.")) == 1
    assert "reason=output_truncated" in caplog.text
    assert "raw private content" not in caplog.text
    assert "output_truncated" in provider.structured_calls[1]["messages"][-1].content


@pytest.mark.asyncio
@pytest.mark.parametrize("block_id", [-1, 0.5, "0", True])
async def test_topic_block_ids_are_strict_integers(block_id):
    output = {"topics": [{"topic": "Bad ID", "block_id": block_id}]}
    provider = FakeProvider(structured=[output, output])
    with pytest.raises(AIMalformedResponseError):
        await AIService(settings(), provider, FakeStore()).detect_topics("A source.")


@pytest.mark.asyncio
async def test_topic_transport_errors_are_not_retried_as_validation_errors():
    from ai.exceptions import AITransportError

    provider = FakeProvider(structured=[AITransportError("transport failure")])
    with pytest.raises(AITransportError):
        await AIService(settings(), provider, FakeStore()).detect_topics("A source.")
    assert len(provider.structured_calls) == 1


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
