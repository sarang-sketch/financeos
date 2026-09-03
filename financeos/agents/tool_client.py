"""The client for ``POST /internal/tools/{tool_name}`` (task 29.5).

Requirements 12.7, 12.9, 12.11, 14.8.

This is the Python runtime's **only** data path. It opens no database connection
and holds no money arithmetic (design.md, Architecture): every figure it sees
arrives as a decimal string inside a ``ToolResult`` envelope and becomes an ``int``
only through :func:`financeos.wire.paise.from_wire`.

The 13-second deadline, and why it is longer on purpose
-------------------------------------------------------

The 10-second tool bound is enforced on the TypeScript side, where the tool
actually runs (Requirement 12.11, ``TOOL_TIMEOUT_MS`` in ``src/tools/tool.ts``).
This client waits **13** seconds — :data:`CLIENT_DEADLINE_SECONDS` against
:data:`SERVER_TOOL_TIMEOUT_SECONDS` — so an overrunning tool is answered by the
server's own :class:`~financeos.wire.tool_transport.ToolFailureWire` envelope with
cause ``timeout`` before this client gives up on the socket.

A client deadline shorter than or equal to the server's would collapse two facts
into one:

* ``tool_failure`` with cause ``timeout`` — the invocation was terminated, any open
  transaction was rolled back, **Tenant state is unchanged**, and the Agent may
  report that truthfully or retry;
* :class:`ToolTransportError` — no answer arrived at all, so what happened on the
  far side is **unknown**, and the Agent may not claim Tenant state is unchanged.

Those have different recovery paths, so the deadline ordering is not a tuning
choice. :func:`assert_deadline_ordering` states the inequality as a check rather
than a comment, and ``tests/agents/test_tool_client.py`` asserts it.

Two credentials, and no Tenant argument anywhere
------------------------------------------------

Every request carries two independent credentials, mirroring the endpoint:

* :data:`SERVICE_CREDENTIAL_HEADER` — the service credential. It establishes only
  that the caller is the Agent runtime and authorizes nothing.
* :data:`FORWARDED_USER_SESSION_HEADER` — the originating user's session, forwarded
  as ``Bearer <access token>``. The endpoint resolves ``tenant_id``, ``user_id``
  and ``permissions`` from this and from nothing else.

There is **no** ``tenant_id`` parameter on :meth:`InternalToolClient.invoke`, and
there is no way to add one to the body: the arguments are a
:class:`~financeos.wire.fields.WireModel`, whose ``extra="forbid"`` refuses an
undeclared key, and no transport model declares ``tenant_id`` (Requirement 12.7,
14.8). The endpoint rejects one anyway, as a schema violation rather than by
ignoring it — so the two sides agree, and neither relies on the other.

The header names are transcribed
--------------------------------

Two runtimes cannot share a literal, so :data:`SERVICE_CREDENTIAL_HEADER`,
:data:`FORWARDED_USER_SESSION_HEADER` and :data:`INTERNAL_TOOL_ROUTE_PREFIX` are
transcribed from ``src/api/internal-tools.ts``, exactly as the closed sets in
``financeos/wire/tool_transport.py`` are. That is the drift risk design.md accepts
when it says the two sides are hand-written and test-verified rather than
generated.
"""

import re
from types import TracebackType
from typing import Any, Final, Self, cast, override

import httpx
from pydantic import TypeAdapter, ValidationError

from financeos.wire.fields import WireModel
from financeos.wire.tool_transport import (
    IncompleteEvidenceWire,
    SchemaViolationWire,
    ToolFailureWire,
    ToolSuccessWire,
    UnauthorizedWriteWire,
)

# ---------------------------------------------------------------------------
# The route and its two headers, transcribed from src/api/internal-tools.ts
# ---------------------------------------------------------------------------

INTERNAL_TOOL_ROUTE_PREFIX: Final[str] = "/internal/tools/"
SERVICE_CREDENTIAL_HEADER: Final[str] = "x-financeos-service-credential"
FORWARDED_USER_SESSION_HEADER: Final[str] = "x-financeos-forwarded-user-session"

#: ``TOOL_TIMEOUT_MS`` in ``src/tools/tool.ts``, in seconds (Requirement 12.11).
SERVER_TOOL_TIMEOUT_SECONDS: Final[float] = 10.0

#: This client's deadline. Deliberately longer. See the module docstring.
CLIENT_DEADLINE_SECONDS: Final[float] = 13.0

#: ``snake_case``, 3..64 — ``TOOL_NAME_RE`` in ``src/tools/registry.ts``.
_TOOL_NAME_PATTERN: Final[str] = r"^[a-z][a-z0-9_]{2,63}$"
_TOOL_NAME_RE: Final[re.Pattern[str]] = re.compile(_TOOL_NAME_PATTERN)


type ToolResultWire[OutT: WireModel] = (
    ToolSuccessWire[OutT]
    | IncompleteEvidenceWire
    | SchemaViolationWire
    | ToolFailureWire
    | UnauthorizedWriteWire
)
"""design.md's ``ToolResult<Out>`` on the wire, over a concrete output model."""


# ---------------------------------------------------------------------------
# Errors — the facts that are *not* a ToolResult
# ---------------------------------------------------------------------------


class ToolClientError(Exception):
    """Base for every outcome that is not a ``ToolResult`` envelope."""


class ToolTransportError(ToolClientError):
    """No ``ToolResult`` arrived: the request failed, timed out, or came back malformed.

    Distinct from ``tool_failure`` with cause ``timeout`` on purpose. That envelope
    says the tool was terminated and Tenant state is unchanged; this exception says
    the far side's state is **unknown**. An Agent that conflated them would report
    "nothing happened" for a request that may well have happened.
    """


class ToolEndpointRejectedError(ToolClientError):
    """The endpoint refused the *caller* before any tool ran.

    A missing or invalid service credential, an unusable forwarded user session, or
    a forwarded user context lacking the tool's Permission. The endpoint answers
    these with ``{"error": {"code": ...}}`` rather than a ``ToolResult``, because a
    refused caller is not a tool outcome — no tool was selected, no argument was
    parsed, and Tenant state is unchanged.
    """

    def __init__(self, status_code: int, code: str) -> None:
        message = f"the internal tool endpoint refused the caller: {code} (HTTP {status_code})"
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class ToolClientConfigurationError(ToolClientError):
    """The client itself is misconfigured: an unusable deadline or a malformed name.

    A caller fault of the composition root, never of the endpoint.
    """


# ---------------------------------------------------------------------------
# The deadline ordering, as a check rather than a comment
# ---------------------------------------------------------------------------


def assert_deadline_ordering(
    client_seconds: float = CLIENT_DEADLINE_SECONDS,
    server_seconds: float = SERVER_TOOL_TIMEOUT_SECONDS,
) -> None:
    """Refuse a client deadline that would mask the server's ``tool_failure`` result.

    Raises :class:`ToolClientConfigurationError` when the client would give up first
    or at the same moment. Strictly greater, not greater-or-equal: at equality the
    race between the two timers is unspecified, and an unspecified race between
    "state unchanged" and "state unknown" is the failure this ordering prevents.
    """
    if client_seconds <= server_seconds:
        message = (
            f"the client deadline of {client_seconds}s must exceed the server-side tool "
            f"timeout of {server_seconds}s, or an overrunning tool surfaces as a transport "
            f"error instead of the tool_failure result with cause timeout that says Tenant "
            f"state is unchanged (Requirement 12.11)"
        )
        raise ToolClientConfigurationError(message)


# ---------------------------------------------------------------------------
# Envelope parsing
# ---------------------------------------------------------------------------


def _result_adapter[OutT: WireModel](out_model: type[OutT]) -> TypeAdapter[ToolResultWire[OutT]]:
    """A validator for the envelope over one concrete output model.

    ``ToolSuccessWire`` is parameterised through ``__class_getitem__`` because the
    output model is a value here, not a static type expression; the union is then
    built from real class objects. The ``cast`` restores the static type the caller
    is entitled to, and it is sound in the one direction that matters: the union
    handed to pydantic is exactly the union the alias names.
    """
    success = ToolSuccessWire.__class_getitem__(out_model)
    union = (
        success
        | IncompleteEvidenceWire
        | SchemaViolationWire
        | ToolFailureWire
        | UnauthorizedWriteWire
    )
    return cast("TypeAdapter[ToolResultWire[OutT]]", TypeAdapter(union))


def _rejection_code(payload: object) -> str | None:
    """The ``error.code`` of an endpoint rejection body, or ``None`` if it is not one."""
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    return code if isinstance(code, str) else None


def parse_tool_response[OutT: WireModel](
    status_code: int,
    payload: object,
    out_model: type[OutT],
) -> ToolResultWire[OutT]:
    """A response body as a ``ToolResult``, or the reason it is not one.

    Dispatch is on the **body shape**, never on the status line. ``403`` is both the
    ``unauthorized_write`` envelope (Requirement 12.10) and a permission refusal, and
    ``503`` is the ``tool_failure`` envelope — so reading the status first would
    misfile two of the five variants the Agent has to branch on.

    :raises ToolEndpointRejectedError: for an ``{"error": {"code": ...}}`` body.
    :raises ToolTransportError: for a body that is neither.
    """
    try:
        return _result_adapter(out_model).validate_python(payload)
    except ValidationError as error:
        code = _rejection_code(payload)
        if code is not None:
            raise ToolEndpointRejectedError(status_code, code) from error
        message = (
            f"HTTP {status_code} from the internal tool endpoint carried neither a ToolResult "
            f"envelope nor an endpoint rejection, so what happened to Tenant state is unknown"
        )
        raise ToolTransportError(message) from error


# ---------------------------------------------------------------------------
# The client
# ---------------------------------------------------------------------------


class InternalToolClient:
    """The Agent runtime's client for the internal tool endpoint.

    One instance per runtime; it holds a connection pool. The deadline is **not** a
    constructor argument and no pre-built ``httpx.AsyncClient`` is accepted: a caller
    that could supply either could supply one shorter than the server's bound, which
    is the single misconfiguration this module exists to prevent. ``transport`` is
    injectable so the tests can answer without a socket, and it cannot change the
    timeout.
    """

    def __init__(
        self,
        *,
        base_url: str,
        service_credential: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        assert_deadline_ordering()
        self._base_url = base_url
        # Private, and kept off every repr: it is a credential, and an Agent traceback
        # is read by humans and shipped to logs (Requirement 14.5).
        self._service_credential = service_credential
        self._client = httpx.AsyncClient(
            base_url=base_url,
            transport=transport,
            timeout=httpx.Timeout(CLIENT_DEADLINE_SECONDS),
        )

    @override
    def __repr__(self) -> str:
        """Names the endpoint and the deadline. Never the credential."""
        return (
            f"InternalToolClient(base_url={self._base_url!r}, "
            f"deadline_seconds={CLIENT_DEADLINE_SECONDS})"
        )

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Release the connection pool."""
        await self._client.aclose()

    async def invoke[OutT: WireModel](
        self,
        *,
        tool_name: str,
        arguments: WireModel,
        out_model: type[OutT],
        user_access_token: str,
    ) -> ToolResultWire[OutT]:
        """Invoke one Financial_Tool and return its ``ToolResult``.

        :param tool_name: The catalogue name. An unknown one comes back as a
            ``schema_violation`` naming ``tool_name``, not as a 404, so a typo is a
            value to branch on rather than an exception to catch.
        :param arguments: The tool's typed input. Serialised with ``mode="json"``, so
            every ``_paise`` field crosses as the decimal string it already is.
        :param out_model: The output model the success variant is validated against.
        :param user_access_token: The originating user's access token, forwarded as
            the only source of the Tenant scope. Never logged.

        :raises ToolTransportError: no answer arrived, or the answer was not a
            ``ToolResult`` — a different fact from ``tool_failure``/``timeout``.
        :raises ToolEndpointRejectedError: the endpoint refused the caller.
        :raises ToolClientConfigurationError: ``tool_name`` is not a tool name.
        """
        self._assert_tool_name(tool_name)
        body: Any = arguments.model_dump(mode="json")

        try:
            response = await self._client.post(
                f"{INTERNAL_TOOL_ROUTE_PREFIX}{tool_name}",
                json=body,
                headers={
                    SERVICE_CREDENTIAL_HEADER: self._service_credential,
                    FORWARDED_USER_SESSION_HEADER: f"Bearer {user_access_token}",
                },
            )
        except httpx.TimeoutException as error:
            # 13 s elapsed with no answer at all. The server's own 10 s bound should
            # have produced a tool_failure long before this, so reaching here means
            # the request or the response never completed — state on the far side is
            # unknown, and this is deliberately not reported as a tool timeout.
            message = (
                f"no response from {tool_name} within {CLIENT_DEADLINE_SECONDS}s, which is "
                f"longer than the {SERVER_TOOL_TIMEOUT_SECONDS}s server-side tool timeout; the "
                f"request may never have arrived, so Tenant state is unknown rather than unchanged"
            )
            raise ToolTransportError(message) from error
        except httpx.HTTPError as error:
            message = f"the request to {tool_name} did not complete: {type(error).__name__}"
            raise ToolTransportError(message) from error

        try:
            payload: object = response.json()
        except ValueError as error:
            message = (
                f"HTTP {response.status_code} from {tool_name} was not JSON, so no ToolResult "
                f"could be read from it and Tenant state is unknown"
            )
            raise ToolTransportError(message) from error

        return parse_tool_response(response.status_code, payload, out_model)

    @staticmethod
    def _assert_tool_name(tool_name: str) -> None:
        """A name is a URL path segment, so it is bounded before it becomes one.

        The endpoint refuses a malformed name as a schema violation, which is the
        control. This check is here so a name that could not possibly be a tool never
        becomes a request at all, and so the failure names the caller's mistake.
        """
        if _TOOL_NAME_RE.fullmatch(tool_name) is None:
            message = (
                f"{tool_name!r} is not a Financial_Tool name: snake_case, 3..64 characters, "
                f"matching {_TOOL_NAME_PATTERN}"
            )
            raise ToolClientConfigurationError(message)
