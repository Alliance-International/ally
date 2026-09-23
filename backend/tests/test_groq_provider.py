import json
from types import SimpleNamespace

import groq
import httpx
import pytest

from ai.contracts import AIMessage
from ai.exceptions import (
    AIAuthenticationError,
    AIInputTooLargeError,
    AIMalformedResponseError,
    AIRateLimitError,
    AIRefusalError,
    AIRetryableProviderError,
    AITimeoutError,
    AITransportError,
)
from ai.groq_provider import GroqProvider, _groq_strict_schema


class FakeCompletions:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.response


class FakeClient:
    def __init__(self, response=None, error=None):
        self.completions = FakeCompletions(response, error)
        self.chat = SimpleNamespace(completions=self.completions)
        self.closed = False

    async def close(self):
        self.closed = True


def completion(content="hello", finish_reason="stop", choices=True, refusal=None):
    values = []
    if choices:
        values = [
            SimpleNamespace(
                message=SimpleNamespace(content=content, refusal=refusal),
                finish_reason=finish_reason,
            )
        ]
    return SimpleNamespace(
        id="request-id",
        choices=values,
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=4),
    )


def provider(client):
    return GroqProvider(
        api_key="secret",
        text_model="openai/gpt-oss-20b",
        structured_model="openai/gpt-oss-20b",
        connect_timeout=1,
        read_timeout=2,
        write_timeout=2,
        pool_timeout=1,
        max_retries=1,
        client=client,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "reason"),
    [
        (completion(content="", finish_reason="length"), "output_truncated"),
        (completion(content=""), "empty_content"),
        (completion(choices=False), "missing_choices"),
        (completion(content="partial", finish_reason="unknown"), "incomplete_completion"),
    ],
)
async def test_incomplete_responses_have_safe_diagnostic_categories(response, reason):
    with pytest.raises(AIMalformedResponseError) as error:
        await provider(FakeClient(response)).generate_structured(
            messages=[AIMessage("user", "private source")],
            schema_name="test", schema={"type": "object"},
            temperature=0.1, max_output_tokens=100,
        )
    assert error.value.reason == reason


@pytest.mark.asyncio
async def test_successful_text_request_has_no_tools_or_browser_controls():
    client = FakeClient(completion())
    result = await provider(client).generate_text(
        messages=[AIMessage("system", "rules"), AIMessage("user", "data")],
        temperature=0.2,
        max_output_tokens=100,
    )
    assert result.content == "hello"
    assert result.provider == "groq"
    call = client.completions.calls[0]
    assert "tools" not in call
    assert "functions" not in call
    assert "compound_custom" not in call
    assert call["model"] == "openai/gpt-oss-20b"
    assert call["reasoning_effort"] == "low"
    assert call["include_reasoning"] is False


@pytest.mark.asyncio
async def test_successful_strict_structured_request():
    client = FakeClient(completion(json.dumps({"value": "ok"})))
    result = await provider(client).generate_structured(
        messages=[AIMessage("system", "rules"), AIMessage("user", "data")],
        schema_name="test",
        schema={
            "title": "GeneratedByPydantic",
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        temperature=0.1,
        max_output_tokens=100,
    )
    assert result.data == {"value": "ok"}
    call = client.completions.calls[0]
    assert call["response_format"]["json_schema"]["strict"] is True
    assert "title" not in call["response_format"]["json_schema"]["schema"]
    assert call["reasoning_effort"] == "low"
    assert call["include_reasoning"] is False


def test_strict_schema_removes_unsupported_annotations_but_keeps_structure():
    schema = {
        "title": "TopicsAIOutput",
        "type": "object",
        "properties": {
            "topics": {
                "title": "Topics",
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "topic": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200,
                            "pattern": "safe-locally",
                        }
                    },
                    "required": ["topic"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["topics"],
        "additionalProperties": False,
    }

    cleaned = _groq_strict_schema(schema)

    assert cleaned == {
        "type": "object",
        "properties": {
            "topics": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"topic": {"type": "string"}},
                    "required": ["topic"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["topics"],
        "additionalProperties": False,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [completion(choices=False), completion(""), completion("partial", "length")],
)
async def test_missing_empty_or_truncated_output_is_rejected(response):
    with pytest.raises(AIMalformedResponseError):
        await provider(FakeClient(response)).generate_text(
            messages=[AIMessage("user", "data")], temperature=0, max_output_tokens=10
        )


@pytest.mark.asyncio
async def test_malformed_structured_json_is_rejected():
    with pytest.raises(AIMalformedResponseError):
        await provider(FakeClient(completion("not-json"))).generate_structured(
            messages=[AIMessage("user", "data")],
            schema_name="test",
            schema={"type": "object"},
            temperature=0,
            max_output_tokens=10,
        )


@pytest.mark.asyncio
async def test_provider_refusal_is_rejected_without_exposing_content():
    with pytest.raises(AIRefusalError):
        await provider(FakeClient(completion("secret response", refusal="refused"))).generate_text(
            messages=[AIMessage("user", "secret source")],
            temperature=0,
            max_output_tokens=10,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            groq.APITimeoutError(request=httpx.Request("POST", "https://api.groq.com")),
            AITimeoutError,
        ),
        (
            groq.APIConnectionError(
                request=httpx.Request("POST", "https://api.groq.com")
            ),
            AITransportError,
        ),
        (
            groq.AuthenticationError(
                "denied",
                response=httpx.Response(
                    401, request=httpx.Request("POST", "https://api.groq.com")
                ),
                body=None,
            ),
            AIAuthenticationError,
        ),
        (
            groq.PermissionDeniedError(
                "denied",
                response=httpx.Response(
                    403, request=httpx.Request("POST", "https://api.groq.com")
                ),
                body=None,
            ),
            AIAuthenticationError,
        ),
        (
            groq.RateLimitError(
                "limited",
                response=httpx.Response(
                    429,
                    headers={"Retry-After": "30"},
                    request=httpx.Request("POST", "https://api.groq.com"),
                ),
                body=None,
            ),
            AIRateLimitError,
        ),
        (
            groq.APIStatusError(
                "provider body must stay private",
                response=httpx.Response(
                    413, request=httpx.Request("POST", "https://api.groq.com")
                ),
                body=None,
            ),
            AIInputTooLargeError,
        ),
        (
            groq.InternalServerError(
                "provider body must stay private",
                response=httpx.Response(
                    500, request=httpx.Request("POST", "https://api.groq.com")
                ),
                body=None,
            ),
            AIRetryableProviderError,
        ),
    ],
)
async def test_sdk_errors_are_sanitized(error, expected):
    with pytest.raises(expected) as raised:
        await provider(FakeClient(error=error)).generate_text(
            messages=[AIMessage("user", "secret source")],
            temperature=0,
            max_output_tokens=10,
        )
    assert "secret source" not in str(raised.value)
    assert "provider body must stay private" not in str(raised.value)


def test_official_client_receives_bounded_retries_and_finite_timeouts(monkeypatch):
    captured = {}

    class ConstructedClient(FakeClient):
        def __init__(self, **kwargs):
            super().__init__(completion())
            captured.update(kwargs)

    monkeypatch.setattr("ai.groq_provider.AsyncGroq", ConstructedClient)
    constructed = GroqProvider(
        api_key="secret",
        text_model="openai/gpt-oss-20b",
        structured_model="openai/gpt-oss-20b",
        connect_timeout=1,
        read_timeout=2,
        write_timeout=3,
        pool_timeout=4,
        max_retries=1,
    )
    assert constructed._client is not None
    assert captured["max_retries"] == 1
    assert captured["timeout"].connect == 1
    assert captured["timeout"].read == 2
    assert captured["timeout"].write == 3
    assert captured["timeout"].pool == 4


@pytest.mark.asyncio
async def test_client_lifecycle_closes_injected_client():
    client = FakeClient(completion())
    await provider(client).close()
    assert client.closed is True
