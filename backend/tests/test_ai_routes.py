from uuid import UUID

import pytest

from fastapi.testclient import TestClient

from ai.factory import get_ai_service, get_ai_store
from ai.schemas import MeetingGenerationResponse
from auth import AuthenticatedUser, get_current_user
from main import app
from rate_limit import AI_RATE_LIMIT, AUTOCOMPLETE_RATE_LIMIT


USER = AuthenticatedUser(
    id=UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    email="user@example.com",
    role="authenticated",
    session_id=None,
)
KEY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
client = TestClient(app)


class FakeService:
    def __init__(self):
        self.requests = []

    async def generate_meeting(self, **kwargs):
        self.requests.append(kwargs)
        return MeetingGenerationResponse.model_validate(
            {
                "meeting_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "formatted_result": "<p>Safe</p>",
                "plain_text_summary": "Safe",
                "email_subject": "Safe subject",
                "ai_provider": "groq",
                "ai_model": "openai/gpt-oss-20b",
                "prompt_version": "phase2e-v1",
                "finish_reason": "stop",
                "actions": [],
            }
        )

    async def autocomplete(self, text):
        self.requests.append(text)
        return "completion"

    async def answer_question(self, **kwargs):
        return "answer"

    async def detect_topics(self, text):
        self.requests.append(text)
        return []


class FakeStore:
    async def review_action(self, **kwargs):
        return {
            "outcome": "reviewed",
            "action": {
                "id": str(kwargs["action_item_id"]),
                "title": kwargs["title"],
                "assignee": kwargs["assignee"] or "Unassigned",
                "assignee_email": kwargs["assignee_email"],
                "start_date": kwargs["start_date"],
                "deadline": kwargs["deadline"],
                "evidence": None,
                "source": "ai_generated",
                "status": "not_started",
                "review_status": kwargs["decision"],
            },
        }


def install(service=None, store=None):
    service = service or FakeService()
    store = store or FakeStore()
    app.dependency_overrides[get_current_user] = lambda: USER
    app.dependency_overrides[get_ai_service] = lambda: service
    app.dependency_overrides[get_ai_store] = lambda: store
    app.dependency_overrides[AI_RATE_LIMIT] = lambda: None
    app.dependency_overrides[AUTOCOMPLETE_RATE_LIMIT] = lambda: None
    return service


def uninstall():
    for dependency in (
        get_current_user,
        get_ai_service,
        get_ai_store,
        AI_RATE_LIMIT,
        AUTOCOMPLETE_RATE_LIMIT,
    ):
        app.dependency_overrides.pop(dependency, None)


def test_meeting_route_requires_idempotency_and_rejects_browser_controls():
    install()
    try:
        assert (
            client.post("/generate-result/", json={"source_text": "source"}).status_code
            == 400
        )
        response = client.post(
            "/generate-result/",
            headers={"Idempotency-Key": KEY},
            json={"source_text": "source", "provider": "attacker"},
        )
        assert response.status_code == 422
        response = client.post(
            "/generate-result/",
            headers={"Idempotency-Key": KEY},
            json={"source_text": "source", "tools": [], "temperature": 0},
        )
        assert response.status_code == 422
    finally:
        uninstall()


def test_typed_ai_routes_accept_only_task_fields():
    install()
    try:
        assert client.post("/ai/autocomplete", json={"text": "continue this"}).status_code == 200
        assert (
            client.post(
                "/ai/question", json={"question": "Why?", "context": "Because."}
            ).status_code
            == 200
        )
        assert client.post("/ai/topics", json={"text": "Topic text"}).status_code == 200
        assert (
            client.post(
                "/ai/question",
                json={"question": "Why?", "context": "Because.", "is_json": True},
            ).status_code
            == 422
        )
        assert client.post("/ai-helper", json={}).status_code == 410
    finally:
        uninstall()


@pytest.mark.parametrize("endpoint", ["/ai/autocomplete", "/ai/topics"])
def test_editor_routes_preserve_exact_text_and_reject_blank_input(endpoint):
    service = install()
    try:
        text = "\r\n  🚀 Planning\r\nI am going to the "
        assert client.post(endpoint, json={"text": text}).status_code == 200
        assert service.requests == [text]
        assert client.post(endpoint, json={"text": " \n\t"}).status_code == 422
    finally:
        uninstall()


def test_autocomplete_accepts_short_prefix_and_bounded_document_context():
    install()
    try:
        assert client.post("/ai/autocomplete", json={"text": "I "}).status_code == 200
        assert client.post("/ai/autocomplete", json={"text": "x" * 4000}).status_code == 200
        assert client.post("/ai/autocomplete", json={"text": "x" * 4001}).status_code == 422
    finally:
        uninstall()


def test_topics_route_maps_numbered_multiline_sections_end_to_end():
    from ai.service import AIService
    from test_ai_service import FakeProvider, settings

    provider = FakeProvider(structured=[{"topics": [
        {"topic": "Hiring", "block_id": 1},
    ]}])
    install(AIService(settings(), provider, None))
    try:
        source = "\n  🚀 Budget approved.\n\nHiring\nRecruit two engineers.\n"
        response = client.post("/ai/topics", json={"text": source})
        assert response.status_code == 200
        assert response.json() == {"topics": [{
            "topic": "Hiring",
            "index": len(source[:source.index("Hiring")].encode("utf-16-le")) // 2,
        }]}
        assert len(provider.structured_calls) == 1
    finally:
        uninstall()


def test_control_characters_and_unsupported_languages_are_rejected():
    install()
    try:
        assert (
            client.post("/ai/autocomplete", json={"text": "hello\x00world"}).status_code
            == 422
        )
        assert (
            client.post(
                "/generate-result/",
                headers={"Idempotency-Key": KEY},
                json={"source_text": "source", "target_language": "Klingon"},
            ).status_code
            == 422
        )
    finally:
        uninstall()


def test_ai_disabled_fails_closed_without_touching_a_provider():
    app.dependency_overrides[get_current_user] = lambda: USER
    app.dependency_overrides[AI_RATE_LIMIT] = lambda: None
    original = app.state.ai_service
    app.state.ai_service = None
    try:
        response = client.post(
            "/generate-result/",
            headers={"Idempotency-Key": KEY},
            json={"source_text": "source"},
        )
        assert response.status_code == 503
        assert response.json() == {"detail": "AI service is unavailable."}
    finally:
        app.state.ai_service = original
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(AI_RATE_LIMIT, None)


def test_generation_response_provenance_comes_from_service():
    service = install()
    try:
        response = client.post(
            "/generate-result/",
            headers={"Idempotency-Key": KEY},
            json={"source_text": "source", "source_type": "text"},
        )
        assert response.status_code == 200
        assert response.json()["ai_provider"] == "groq"
        assert service.requests[0]["user_id"] == USER.id
    finally:
        uninstall()


def test_review_route_uses_verified_owner_and_strict_fields():
    install()
    action_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    try:
        response = client.post(
            f"/action-items/{action_id}/review",
            json={
                "decision": "confirmed",
                "title": "Ship",
                "assignee": "Alice",
                "assignee_email": "alice@example.com",
                "start_date": "2026-09-21",
                "deadline": "2026-09-22",
            },
        )
        assert response.status_code == 200
        assert response.json()["review_status"] == "confirmed"
        response = client.post(
            f"/action-items/{action_id}/review",
            json={
                "decision": "confirmed",
                "title": "Ship",
                "assignee": "Alice",
                "assignee_email": "bad",
                "start_date": None,
                "deadline": None,
                "user_id": "attacker",
            },
        )
        assert response.status_code == 422
    finally:
        uninstall()
