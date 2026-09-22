"""Official Groq SDK adapter with sanitized provider-neutral results."""

from __future__ import annotations

import json
from typing import Any, Sequence

import groq
import httpx
from groq import AsyncGroq

from .contracts import (
    AIMessage,
    ProviderStructuredResult,
    ProviderTextResult,
    TokenUsage,
)
from .exceptions import (
    AIAuthenticationError,
    AIMalformedResponseError,
    AIRateLimitError,
    AIRefusalError,
    AIRetryableProviderError,
    AITerminalProviderError,
    AITimeoutError,
    AITransportError,
)


MAX_SAFE_RETRY_AFTER_SECONDS = 300
GROQ_STRICT_SCHEMA_ANNOTATIONS = frozenset(
    {
        "default",
        "examples",
        "maxLength",
        "minLength",
        "pattern",
        "title",
    }
)


def _groq_strict_schema(value: Any) -> Any:
    """Keep only constraints supported reliably by Groq strict decoding.

    Local Pydantic validation remains authoritative for string lengths,
    patterns, and other application limits after the provider responds.
    """
    if isinstance(value, dict):
        return {
            key: _groq_strict_schema(item)
            for key, item in value.items()
            if key not in GROQ_STRICT_SCHEMA_ANNOTATIONS
        }
    if isinstance(value, list):
        return [_groq_strict_schema(item) for item in value]
    return value


def _retry_after(error: Exception) -> int | None:
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", {})
    raw = headers.get("retry-after") if headers else None
    try:
        return min(MAX_SAFE_RETRY_AFTER_SECONDS, max(1, int(float(raw))))
    except (TypeError, ValueError):
        return None


class GroqProvider:
    name = "groq"

    def __init__(
        self,
        *,
        api_key: str,
        text_model: str,
        structured_model: str,
        connect_timeout: float,
        read_timeout: float,
        write_timeout: float,
        pool_timeout: float,
        max_retries: int,
        client: Any | None = None,
    ) -> None:
        self.text_model = text_model
        self.structured_model = structured_model
        self._client = client or AsyncGroq(
            api_key=api_key,
            max_retries=max_retries,
            timeout=httpx.Timeout(
                connect=connect_timeout,
                read=read_timeout,
                write=write_timeout,
                pool=pool_timeout,
            ),
        )

    @staticmethod
    def _messages(messages: Sequence[AIMessage]) -> list[dict[str, str]]:
        return [{"role": item.role, "content": item.content} for item in messages]

    @staticmethod
    def _reasoning_options(model: str) -> dict[str, Any]:
        """Keep bounded product tasks from spending their output budget on reasoning.

        GPT-OSS defaults to medium reasoning on Groq. Short tasks such as
        autocomplete can otherwise finish with ``length`` before emitting any
        user-visible content. Reasoning remains enabled at the model's lowest
        supported level and is omitted from the response payload.
        """
        if model.startswith("openai/gpt-oss-"):
            return {"reasoning_effort": "low", "include_reasoning": False}
        return {}

    @staticmethod
    def _map_error(error: Exception) -> Exception:
        if isinstance(error, (groq.AuthenticationError, groq.PermissionDeniedError)):
            return AIAuthenticationError("provider authentication failed")
        if isinstance(error, groq.RateLimitError):
            return AIRateLimitError(_retry_after(error))
        if isinstance(error, groq.APITimeoutError):
            return AITimeoutError("provider timed out")
        if isinstance(error, groq.APIConnectionError):
            return AITransportError("provider connection failed")
        if isinstance(error, groq.InternalServerError):
            return AIRetryableProviderError("provider unavailable")
        if isinstance(error, groq.APIStatusError):
            if getattr(error, "status_code", 0) >= 500:
                return AIRetryableProviderError("provider unavailable")
            return AITerminalProviderError("provider rejected request")
        return AITerminalProviderError("provider request failed")

    @staticmethod
    def _result(completion: Any, model: str) -> ProviderTextResult:
        choices = getattr(completion, "choices", None)
        if not choices:
            raise AIMalformedResponseError("missing choices")
        choice = choices[0]
        message = getattr(choice, "message", None)
        refusal = bool(getattr(message, "refusal", None))
        if refusal:
            raise AIRefusalError("provider refused request")
        content = getattr(message, "content", None)
        if not isinstance(content, str) or not content.strip():
            raise AIMalformedResponseError("empty provider content")
        finish_reason = str(getattr(choice, "finish_reason", "") or "")
        if finish_reason != "stop":
            raise AIMalformedResponseError("provider completion was not complete")
        usage = getattr(completion, "usage", None)
        token_usage = TokenUsage(
            input_tokens=getattr(usage, "prompt_tokens", None),
            output_tokens=getattr(usage, "completion_tokens", None),
        )
        request_id = getattr(completion, "id", None)
        if request_id is not None:
            request_id = str(request_id)[:128]
        return ProviderTextResult(
            content=content.strip(),
            provider="groq",
            model=model,
            finish_reason=finish_reason,
            usage=token_usage,
            request_id=request_id,
        )

    async def generate_text(
        self,
        *,
        messages: Sequence[AIMessage],
        temperature: float,
        max_output_tokens: int,
    ) -> ProviderTextResult:
        try:
            completion = await self._client.chat.completions.create(
                model=self.text_model,
                messages=self._messages(messages),
                temperature=temperature,
                max_completion_tokens=max_output_tokens,
                stream=False,
                **self._reasoning_options(self.text_model),
            )
        except Exception as error:
            mapped = self._map_error(error)
            raise mapped from error
        return self._result(completion, self.text_model)

    async def generate_structured(
        self,
        *,
        messages: Sequence[AIMessage],
        schema_name: str,
        schema: dict[str, Any],
        temperature: float,
        max_output_tokens: int,
    ) -> ProviderStructuredResult:
        try:
            completion = await self._client.chat.completions.create(
                model=self.structured_model,
                messages=self._messages(messages),
                temperature=temperature,
                max_completion_tokens=max_output_tokens,
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema_name,
                        "strict": True,
                        "schema": _groq_strict_schema(schema),
                    },
                },
                stream=False,
                **self._reasoning_options(self.structured_model),
            )
        except Exception as error:
            mapped = self._map_error(error)
            raise mapped from error
        text_result = self._result(completion, self.structured_model)
        try:
            data = json.loads(text_result.content)
        except (json.JSONDecodeError, TypeError) as error:
            raise AIMalformedResponseError("provider returned malformed JSON") from error
        if not isinstance(data, dict):
            raise AIMalformedResponseError("structured response must be an object")
        return ProviderStructuredResult(
            data=data,
            provider=text_result.provider,
            model=text_result.model,
            finish_reason=text_result.finish_reason,
            usage=text_result.usage,
            refusal=text_result.refusal,
            request_id=text_result.request_id,
        )

    async def close(self) -> None:
        close = getattr(self._client, "close", None)
        if close is not None:
            await close()
