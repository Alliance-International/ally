"""Sanitized internal AI error categories."""

from __future__ import annotations


class AIError(Exception):
    category = "ai_error"
    retry_after_seconds: int | None = None


class AIUnavailable(AIError):
    category = "configuration_unavailable"


class AIAuthenticationError(AIError):
    category = "provider_authentication"


class AIRateLimitError(AIError):
    category = "provider_rate_limit"

    def __init__(self, retry_after_seconds: int | None = None) -> None:
        super().__init__(self.category)
        self.retry_after_seconds = retry_after_seconds


class AITimeoutError(AIError):
    category = "provider_timeout"


class AITransportError(AIError):
    category = "provider_transport"


class AIRetryableProviderError(AIError):
    category = "provider_retryable"


class AITerminalProviderError(AIError):
    category = "provider_terminal"


class AIRefusalError(AIError):
    category = "provider_refusal"


class AIMalformedResponseError(AIError):
    category = "malformed_provider_response"

    def __init__(self, message: str, *, reason: str = "invalid_response") -> None:
        super().__init__(message)
        # Only server-owned categories may reach logs or repair instructions.
        allowed = {
            "missing_choices", "empty_content", "output_truncated",
            "incomplete_completion", "invalid_json", "invalid_object",
            "unknown_topic_block", "too_many_topics", "invalid_response",
        }
        self.reason = reason if reason in allowed else "invalid_response"


class AIInputTooLargeError(AIError):
    category = "input_too_large"


class AIIdempotencyConflict(AIError):
    category = "idempotency_conflict"


class AIGenerationInProgress(AIError):
    category = "generation_in_progress"


class AIInfrastructureError(AIError):
    category = "generation_infrastructure"
