"""Authenticated, task-specific AI and review routes."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException

from auth import AuthenticatedUser, get_current_user
from rate_limit import AI_RATE_LIMIT, AUTOCOMPLETE_RATE_LIMIT

from .exceptions import (
    AIAuthenticationError,
    AIError,
    AIGenerationInProgress,
    AIIdempotencyConflict,
    AIInfrastructureError,
    AIInputTooLargeError,
    AIMalformedResponseError,
    AIRateLimitError,
    AIRefusalError,
    AIRetryableProviderError,
    AITerminalProviderError,
    AITimeoutError,
    AITransportError,
    AIUnavailable,
)
from .factory import get_ai_service, get_ai_store
from .schemas import (
    AutocompleteRequest,
    MeetingGenerationRequest,
    MeetingGenerationResponse,
    PublicAction,
    QuestionRequest,
    ReviewActionRequest,
    TextResponse,
    TopicsRequest,
    TopicsResponse,
)
from .service import AIService
from .store import SupabaseAIStore


router = APIRouter()
Authenticated = Annotated[AuthenticatedUser, Depends(get_current_user)]
AIWorkflow = Annotated[AIService, Depends(get_ai_service)]
AIStore = Annotated[SupabaseAIStore, Depends(get_ai_store)]


def _public_ai_error(error: AIError) -> HTTPException:
    if isinstance(error, AIInputTooLargeError):
        return HTTPException(status_code=413, detail="The submitted text is too large.")
    if isinstance(error, (AIIdempotencyConflict, AIGenerationInProgress)):
        detail = (
            "This Idempotency-Key was already used for different input."
            if isinstance(error, AIIdempotencyConflict)
            else "This generation request is still processing."
        )
        return HTTPException(status_code=409, detail=detail)
    if isinstance(error, AIRateLimitError):
        headers = (
            {"Retry-After": str(error.retry_after_seconds)}
            if error.retry_after_seconds
            else None
        )
        return HTTPException(
            status_code=503,
            detail="AI service is temporarily unavailable.",
            headers=headers,
        )
    if isinstance(error, AITimeoutError):
        return HTTPException(status_code=504, detail="AI processing timed out.")
    if isinstance(
        error,
        (
            AIUnavailable,
            AIAuthenticationError,
            AITransportError,
            AIRetryableProviderError,
            AIInfrastructureError,
        ),
    ):
        return HTTPException(status_code=503, detail="AI service is temporarily unavailable.")
    if isinstance(
        error, (AIMalformedResponseError, AIRefusalError, AITerminalProviderError)
    ):
        return HTTPException(status_code=502, detail="AI processing could not be completed.")
    return HTTPException(status_code=502, detail="AI processing could not be completed.")


@router.post(
    "/generate-result/",
    response_model=MeetingGenerationResponse,
    summary="Generate and persist a reviewed meeting result",
)
async def generate_result(
    request: MeetingGenerationRequest,
    current_user: Authenticated,
    service: AIWorkflow,
    _rate_limit: Annotated[None, Depends(AI_RATE_LIMIT)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
):
    del _rate_limit
    try:
        parsed_key = UUID(idempotency_key or "")
    except (TypeError, ValueError, AttributeError) as error:
        raise HTTPException(
            status_code=400, detail="A valid Idempotency-Key UUID is required."
        ) from error
    try:
        return await service.generate_meeting(
            user_id=current_user.id,
            idempotency_key=parsed_key,
            request=request,
        )
    except AIError as error:
        raise _public_ai_error(error) from error


@router.post(
    "/ai/autocomplete", response_model=TextResponse, summary="Autocomplete text"
)
async def autocomplete(
    request: AutocompleteRequest,
    current_user: Authenticated,
    service: AIWorkflow,
    _rate_limit: Annotated[None, Depends(AUTOCOMPLETE_RATE_LIMIT)],
):
    del current_user, _rate_limit
    try:
        return TextResponse(text=await service.autocomplete(request.text))
    except AIError as error:
        raise _public_ai_error(error) from error


@router.post("/ai/question", response_model=TextResponse, summary="Ask about a document")
async def answer_question(
    request: QuestionRequest,
    current_user: Authenticated,
    service: AIWorkflow,
    _rate_limit: Annotated[None, Depends(AI_RATE_LIMIT)],
):
    del current_user, _rate_limit
    try:
        return TextResponse(
            text=await service.answer_question(
                question=request.question, context=request.context
            )
        )
    except AIError as error:
        raise _public_ai_error(error) from error


@router.post("/ai/topics", response_model=TopicsResponse, summary="Detect document topics")
async def detect_topics(
    request: TopicsRequest,
    current_user: Authenticated,
    service: AIWorkflow,
    _rate_limit: Annotated[None, Depends(AI_RATE_LIMIT)],
):
    del current_user, _rate_limit
    try:
        return TopicsResponse(topics=await service.detect_topics(
            request.text, heading_indexes=request.heading_indexes
        ))
    except AIError as error:
        raise _public_ai_error(error) from error


@router.post("/ai-helper", summary="Removed generic AI route")
async def removed_ai_helper(current_user: Authenticated):
    del current_user
    raise HTTPException(status_code=410, detail="This generic AI route was removed.")


@router.post(
    "/action-items/{action_item_id}/review",
    response_model=PublicAction,
    summary="Confirm or reject an AI-proposed action",
)
async def review_action(
    action_item_id: UUID,
    request: ReviewActionRequest,
    current_user: Authenticated,
    store: AIStore,
):
    try:
        result = await store.review_action(
            user_id=current_user.id,
            action_item_id=action_item_id,
            decision=request.decision,
            title=request.title,
            assignee=request.assignee,
            assignee_email=request.assignee_email,
            start_date=request.start_date.isoformat() if request.start_date else None,
            deadline=request.deadline.isoformat() if request.deadline else None,
        )
    except AIError as error:
        raise _public_ai_error(error) from error
    if result.get("outcome") == "not_found":
        raise HTTPException(status_code=404, detail="Action item not found.")
    if result.get("outcome") != "reviewed":
        raise HTTPException(status_code=503, detail="Action review is temporarily unavailable.")
    action = result.get("action") or {}
    return PublicAction(
        id=action.get("id"),
        title=action.get("title"),
        assignee=action.get("assignee"),
        assignee_email=action.get("assignee_email"),
        start_date=action.get("start_date"),
        deadline=action.get("deadline"),
        evidence=action.get("evidence"),
        review_status=action.get("review_status"),
        reviewed_at=action.get("reviewed_at"),
    )
