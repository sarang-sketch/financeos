"""The internal tool client, and the deadline ordering it exists to preserve.

Task 29.5, Requirements 12.7, 12.9, 12.11, 14.8.

Every case answers through ``httpx.MockTransport``, so the suite opens no socket and
needs no running TypeScript process. What is asserted is the client's contract: the
13-second deadline against the 10-second server bound, the two credentials on every
request, no Tenant identifier anywhere in the payload, and the boundary between a
``ToolResult`` variant and the two facts that are not one.

The coroutines are driven by :func:`driven` rather than by an async pytest plugin.
``pyproject.toml`` declares pytest, Hypothesis, ruff and mypy and nothing else, so a
test that needed ``pytest-asyncio`` or ``anyio``'s plugin would add a fifth tool — or
worse, depend on one that is present only transitively through httpx.
"""

import asyncio
import functools
from collections.abc import Callable, Coroutine
from typing import Any, Final

import httpx
import pytest

from financeos.agents.tool_client import (
    CLIENT_DEADLINE_SECONDS,
    FORWARDED_USER_SESSION_HEADER,
    SERVER_TOOL_TIMEOUT_SECONDS,
    SERVICE_CREDENTIAL_HEADER,
    InternalToolClient,
    ToolClientConfigurationError,
    ToolEndpointRejectedError,
    ToolTransportError,
    assert_deadline_ordering,
    parse_tool_response,
)
from financeos.wire.fields import WireModel
from financeos.wire.tool_transport import (
    IncompleteEvidenceWire,
    PostReconciliationAdjustmentInputWire,
    PostReconciliationAdjustmentOutputWire,
    SchemaViolationWire,
    ToolFailureWire,
    ToolSuccessWire,
    UnauthorizedWriteWire,
)

BASE_URL: Final[str] = "https://financeos.internal"
SERVICE_CREDENTIAL: Final[str] = "service-credential-of-the-agent-runtime-0001"
USER_TOKEN: Final[str] = "forwarded-user-access-token"  # noqa: S105
TENANT: Final[str] = "11111111-1111-4111-8111-111111111111"
CHAIN: Final[str] = "33333333-3333-4333-8333-333333333333"
SET_ID: Final[str] = "44444444-4444-4444-8444-444444444444"

Handler = Callable[[httpx.Request], httpx.Response]


def driven[**P](test: Callable[P, Coroutine[Any, Any, None]]) -> Callable[P, None]:
    """Run an ``async def`` test on a fresh event loop, so no async plugin is needed."""

    @functools.wraps(test)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> None:
        asyncio.run(test(*args, **kwargs))

    return wrapper


class FigureInputWire(WireModel):
    """A read-only tool's arguments. Carries no money and, deliberately, no Tenant."""

    as_of: str


def _evidence() -> dict[str, object]:
    return {
        "evidence_chain_id": CHAIN,
        "figure_paise": "99999999999999",
        "sources": [{"type": "payment", "id": "pay_FIXTURE0001"}],
        "source_count": 1,
        "steps": [
            {
                "index": 1,
                "operation": "sum",
                "operands": [
                    {
                        "kind": "source",
                        "ref": {"type": "payment", "id": "pay_FIXTURE0001"},
                        "field": "amount_paise",
                    }
                ],
                "result_paise": "99999999999999",
                "note": None,
            }
        ],
        "as_of": "2026-01-01T00:00:00.000Z",
        "produced_by": "post_reconciliation_adjustment",
    }


def _success_body() -> dict[str, object]:
    return {
        "ok": True,
        "value": {
            "set_id": SET_ID,
            "total_debit_paise": "84260000",
            "total_credit_paise": "84260000",
            "total_debit_evidence_chain_id": CHAIN,
            "total_debit_evidence_as_of": "2026-01-01T00:00:00.000Z",
            "total_credit_evidence_chain_id": CHAIN,
            "total_credit_evidence_as_of": "2026-01-01T00:00:00.000Z",
        },
        "evidence": _evidence(),
    }


def _answering(status_code: int, body: object) -> Handler:
    return lambda _request: httpx.Response(status_code, json=body)


def _client(handler: Handler) -> InternalToolClient:
    return InternalToolClient(
        base_url=BASE_URL,
        service_credential=SERVICE_CREDENTIAL,
        transport=httpx.MockTransport(handler),
    )


def _arguments() -> FigureInputWire:
    return FigureInputWire(as_of="2026-01-01")


# ---------------------------------------------------------------------------
# The deadline ordering
# ---------------------------------------------------------------------------


def test_client_deadline_is_longer_than_the_server_tool_timeout() -> None:
    """13 s against 10 s, so an overrun surfaces as tool_failure and not as transport."""
    assert SERVER_TOOL_TIMEOUT_SECONDS == 10.0
    assert CLIENT_DEADLINE_SECONDS == 13.0
    assert CLIENT_DEADLINE_SECONDS > SERVER_TOOL_TIMEOUT_SECONDS
    assert_deadline_ordering()


@pytest.mark.parametrize("client_seconds", [9.0, 10.0])
def test_a_deadline_at_or_below_the_server_bound_is_refused(client_seconds: float) -> None:
    """Equality is refused too: an unspecified race between the two timers is the bug."""
    with pytest.raises(ToolClientConfigurationError, match="must exceed"):
        assert_deadline_ordering(client_seconds, SERVER_TOOL_TIMEOUT_SECONDS)


def test_the_configured_deadline_reaches_the_transport() -> None:
    """The deadline is not a constructor argument, so a caller cannot shorten it."""
    client = _client(_answering(200, _success_body()))
    timeout = client._client.timeout  # noqa: SLF001
    assert timeout.read == CLIENT_DEADLINE_SECONDS
    assert timeout.connect == CLIENT_DEADLINE_SECONDS


def test_the_repr_names_the_endpoint_and_never_the_credential() -> None:
    rendered = repr(_client(_answering(200, _success_body())))
    assert BASE_URL in rendered
    assert SERVICE_CREDENTIAL not in rendered


# ---------------------------------------------------------------------------
# What every request carries, and what it must not
# ---------------------------------------------------------------------------


@driven
async def test_both_credentials_are_sent_and_no_tenant_identifier_is() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_success_body())

    async with _client(handler) as client:
        await client.invoke(
            tool_name="post_reconciliation_adjustment",
            arguments=PostReconciliationAdjustmentInputWire.model_validate(
                {
                    "entry_date": "2026-01-01",
                    "entries": [
                        {"account_code": "cash", "side": "debit", "amount_paise": "84260000"},
                        {
                            "account_code": "revenue",
                            "side": "credit",
                            "amount_paise": "84260000",
                        },
                    ],
                    "source_refs": [{"type": "settlement", "id": "setl_FIXTURE0001"}],
                }
            ),
            out_model=PostReconciliationAdjustmentOutputWire,
            user_access_token=USER_TOKEN,
        )

    request = seen[0]
    assert request.method == "POST"
    assert request.url.path == "/internal/tools/post_reconciliation_adjustment"
    # The service credential establishes the runtime; the forwarded session is the
    # only source of the Tenant scope. Two headers, two jobs.
    assert request.headers[SERVICE_CREDENTIAL_HEADER] == SERVICE_CREDENTIAL
    assert request.headers[FORWARDED_USER_SESSION_HEADER] == f"Bearer {USER_TOKEN}"
    # No user session on `Authorization`: the endpoint refuses a request carrying one.
    assert "authorization" not in request.headers
    body = request.content.decode()
    assert "tenant_id" not in body
    assert TENANT not in body
    # Money crosses as decimal strings, never as JSON numbers.
    assert '"amount_paise":"84260000"' in body.replace(" ", "")


def test_a_tenant_id_cannot_be_added_to_the_arguments() -> None:
    """``extra="forbid"`` is what makes the client incapable of scoping a request."""
    with pytest.raises(ValueError, match="tenant_id"):
        FigureInputWire(as_of="2026-01-01", tenant_id=TENANT)  # type: ignore[call-arg]


@driven
async def test_a_malformed_tool_name_never_becomes_a_request() -> None:
    attempts: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        return httpx.Response(200, json=_success_body())

    async with _client(handler) as client:
        with pytest.raises(ToolClientConfigurationError, match="Financial_Tool name"):
            await client.invoke(
                tool_name="Get Trial Balance; DROP TABLE ledger_entries",
                arguments=_arguments(),
                out_model=PostReconciliationAdjustmentOutputWire,
                user_access_token=USER_TOKEN,
            )

    assert attempts == []


# ---------------------------------------------------------------------------
# The five ToolResult variants come back as values
# ---------------------------------------------------------------------------


@driven
async def test_a_success_envelope_parses_with_money_as_int_in_memory() -> None:
    async with _client(_answering(200, _success_body())) as client:
        result = await client.invoke(
            tool_name="post_reconciliation_adjustment",
            arguments=_arguments(),
            out_model=PostReconciliationAdjustmentOutputWire,
            user_access_token=USER_TOKEN,
        )

    assert isinstance(result, ToolSuccessWire)
    # str on the wire, int in memory, converted only at the boundary.
    assert result.value.total_debit_paise == "84260000"
    assert result.value.total_debit() == 84_260_000
    assert result.evidence.figure() == 99_999_999_999_999


@driven
async def test_a_tool_overrun_arrives_as_tool_failure_with_cause_timeout() -> None:
    """The whole reason the client waits 13 s: this is a value, not an exception."""
    body = {
        "ok": False,
        "kind": "tool_failure",
        "tool": "get_trial_balance",
        "cause": "timeout",
    }

    async with _client(_answering(503, body)) as client:
        result = await client.invoke(
            tool_name="get_trial_balance",
            arguments=_arguments(),
            out_model=PostReconciliationAdjustmentOutputWire,
            user_access_token=USER_TOKEN,
        )

    assert isinstance(result, ToolFailureWire)
    assert (result.tool, result.cause) == ("get_trial_balance", "timeout")


@driven
async def test_an_unknown_tool_name_arrives_as_a_schema_violation_not_a_404() -> None:
    body = {
        "ok": False,
        "kind": "schema_violation",
        "violations": [{"argument": "tool_name", "reason": "no Financial_Tool of that name"}],
    }

    async with _client(_answering(400, body)) as client:
        result = await client.invoke(
            tool_name="get_trial_balances",
            arguments=_arguments(),
            out_model=PostReconciliationAdjustmentOutputWire,
            user_access_token=USER_TOKEN,
        )

    assert isinstance(result, SchemaViolationWire)
    assert result.violations[0].argument == "tool_name"


@driven
async def test_a_body_tenant_id_rejection_names_the_path_it_was_found_at() -> None:
    body = {
        "ok": False,
        "kind": "schema_violation",
        "violations": [
            {"argument": "entries[0].tenant_id", "reason": "the Tenant comes from the session"}
        ],
    }

    async with _client(_answering(400, body)) as client:
        result = await client.invoke(
            tool_name="post_reconciliation_adjustment",
            arguments=_arguments(),
            out_model=PostReconciliationAdjustmentOutputWire,
            user_access_token=USER_TOKEN,
        )

    assert isinstance(result, SchemaViolationWire)
    assert result.violations[0].argument == "entries[0].tenant_id"


def test_the_remaining_two_variants_parse_from_their_own_statuses() -> None:
    """403 and 422 are envelope variants, so dispatch is on the body, not the status."""
    unauthorized = parse_tool_response(
        403,
        {"ok": False, "kind": "unauthorized_write", "reason": "missing_authorized_proposal"},
        PostReconciliationAdjustmentOutputWire,
    )
    incomplete = parse_tool_response(
        422,
        {
            "ok": False,
            "kind": "incomplete_evidence",
            "unavailable": [{"type": "settlement_recon_report", "count": 3}],
        },
        PostReconciliationAdjustmentOutputWire,
    )

    assert isinstance(unauthorized, UnauthorizedWriteWire)
    assert isinstance(incomplete, IncompleteEvidenceWire)


# ---------------------------------------------------------------------------
# The two facts that are not a ToolResult
# ---------------------------------------------------------------------------


@driven
async def test_a_refused_caller_is_an_exception_rather_than_a_tool_result() -> None:
    """No tool was selected and no argument parsed, so there is no envelope to return."""
    async with _client(
        _answering(401, {"error": {"code": "service_credential_required"}})
    ) as client:
        with pytest.raises(ToolEndpointRejectedError) as caught:
            await client.invoke(
                tool_name="get_trial_balance",
                arguments=_arguments(),
                out_model=PostReconciliationAdjustmentOutputWire,
                user_access_token=USER_TOKEN,
            )

    assert caught.value.status_code == 401
    assert caught.value.code == "service_credential_required"


@driven
async def test_a_permission_refusal_is_distinguishable_from_unauthorized_write() -> None:
    """Both are 403. One is an endpoint rejection, one is a Requirement 12.10 envelope."""
    body = {"error": {"code": "permission_denied", "required": "view_financial_data"}}

    async with _client(_answering(403, body)) as client:
        with pytest.raises(ToolEndpointRejectedError) as caught:
            await client.invoke(
                tool_name="get_trial_balance",
                arguments=_arguments(),
                out_model=PostReconciliationAdjustmentOutputWire,
                user_access_token=USER_TOKEN,
            )

    assert caught.value.code == "permission_denied"


@driven
async def test_a_request_that_never_arrives_is_a_transport_error_not_a_tool_timeout() -> None:
    """'State unchanged' and 'state unknown' are different facts with different recovery."""

    def handler(request: httpx.Request) -> httpx.Response:
        no_answer = "the response never completed"
        raise httpx.ReadTimeout(no_answer, request=request)

    async with _client(handler) as client:
        with pytest.raises(ToolTransportError, match="Tenant state is unknown"):
            await client.invoke(
                tool_name="get_trial_balance",
                arguments=_arguments(),
                out_model=PostReconciliationAdjustmentOutputWire,
                user_access_token=USER_TOKEN,
            )


@driven
async def test_a_body_that_is_not_json_is_a_transport_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="<html>bad gateway")

    async with _client(handler) as client:
        with pytest.raises(ToolTransportError, match="was not JSON"):
            await client.invoke(
                tool_name="get_trial_balance",
                arguments=_arguments(),
                out_model=PostReconciliationAdjustmentOutputWire,
                user_access_token=USER_TOKEN,
            )


@driven
async def test_json_that_is_neither_an_envelope_nor_a_rejection_is_a_transport_error() -> None:
    """A well-formed body of the wrong shape must not be read as any of the five variants."""
    async with _client(_answering(200, {"total_paise": 84260000})) as client:
        with pytest.raises(ToolTransportError, match="Tenant state is unknown"):
            await client.invoke(
                tool_name="get_trial_balance",
                arguments=_arguments(),
                out_model=PostReconciliationAdjustmentOutputWire,
                user_access_token=USER_TOKEN,
            )
