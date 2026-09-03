"""The two AI_Gateway metering payloads on the wire, Python side (task 29.3).

Requirements 11.8, 11.13, 15.1, 15.8.

The mirror of ``src/wire/metering-transport.ts``. The third of design.md's "three
places money crosses", and the one where this runtime is the caller: the Gateway
holds no database connection and no money arithmetic of its own, so it reads the
monthly cap through ``GET /internal/model-cost-cap`` and posts a measurement to
``POST /internal/model-requests``, receiving a computed ``cost_paise`` back.

Two rejections these models carry structurally
----------------------------------------------

* :class:`ModelRequestPayloadWire` declares **no** ``cost_paise``, and
  ``extra="forbid"`` makes a supplied one a validation error rather than an ignored
  key. A Gateway that priced its own measurement would be doing money arithmetic in
  the runtime that is not allowed to, and the resulting figure would be one nobody
  could reproduce from the rate table.
* Neither model declares ``tenant_id`` (Requirement 12.7, 14.8). The Tenant comes
  from the forwarded session.

``exceeded`` arrives as a boolean rather than being re-derived here from the two
strings. Requirement 11.13 rejects a request when month-to-date spend has *reached*
the cap, so the comparison is ``>=`` and reaching the cap exactly rejects — and two
implementations of one ``>=`` is one more than the number of places that rule can be
got right. The Gateway branches on the flag. The two figures still cross as decimal
strings because the Gateway quotes them back to the Agent in the
``cost_cap_exceeded`` result, and a rounded cap would be read by a User as fact.
"""

from typing import Final, Literal, get_args

from pydantic import Field

from financeos.wire.fields import PaiseWireField, UuidField, WireModel
from financeos.wire.paise import from_wire

# ---------------------------------------------------------------------------
# Closed sets, transcribed from design.md's DDL and routing table
# ---------------------------------------------------------------------------

#: ``model_requests.provider``. The three Model_Providers of Requirement 11.2-11.4.
ModelProvider = Literal["openrouter", "gemini", "groq"]

MODEL_PROVIDERS: Final[tuple[str, ...]] = get_args(ModelProvider)

#: ``model_requests.task_class``. Agents declare the class; they never choose the provider.
TaskClass = Literal["complex_reasoning", "document_analysis", "fast_classification"]

TASK_CLASSES: Final[tuple[str, ...]] = get_args(TaskClass)

#: The failure categories a ``ModelProviderAdapter`` classifies into (Requirement
#: 11.5, 11.6, 11.7). ``rate_limit`` and ``timeout`` are retryable on the same
#: provider; ``provider_error`` fails over immediately.
ProviderFailureKind = Literal["rate_limit", "timeout", "provider_error"]

PROVIDER_FAILURE_KINDS: Final[tuple[str, ...]] = get_args(ProviderFailureKind)

#: Requirement 11.6: at most 3 providers per request.
MAX_PROVIDERS_PER_REQUEST: Final[int] = 3

#: Requirement 11.5: at most 2 retries per provider, so 3 attempts per provider.
MAX_ATTEMPTS_PER_PROVIDER: Final[int] = 3

#: The ceiling on the per-attempt failure record list: every provider, every retry.
MAX_ATTEMPT_RECORDS: Final[int] = MAX_PROVIDERS_PER_REQUEST * MAX_ATTEMPTS_PER_PROVIDER

# Requirement 11.5's configured timeout ceiling, which bounds any one attempt.
_MAX_TIMEOUT_MS: Final[int] = 60_000

# A whole request's latency ceiling. Its job is to make the field bounded, not to
# restate the retry schedule.
_MAX_LATENCY_MS: Final[int] = MAX_ATTEMPT_RECORDS * _MAX_TIMEOUT_MS

# A generous per-request token ceiling, for the same reason.
_MAX_TOKENS: Final[int] = 10_000_000


# ---------------------------------------------------------------------------
# GET /internal/model-cost-cap
# ---------------------------------------------------------------------------


class ModelCostCapResponseWire(WireModel):
    """The cost-cap response (Requirement 11.13).

    There is no request model: the endpoint is a ``GET`` whose only inputs are the
    service credential and the forwarded user context, both headers rather than a
    body. A body carrying a ``tenant_id`` is rejected by the endpoint precisely
    because there is no body shape for it to conform to.
    """

    cap_paise: PaiseWireField
    month_to_date_paise: PaiseWireField
    #: ``month_to_date_paise >= cap_paise``, computed on the TypeScript side.
    exceeded: bool

    def cap(self) -> int:
        """The configured monthly cap as an ``int``, range-checked."""
        return from_wire(self.cap_paise, "cap_paise")

    def month_to_date(self) -> int:
        """Month-to-date Model spend as an ``int``, range-checked."""
        return from_wire(self.month_to_date_paise, "month_to_date_paise")


# ---------------------------------------------------------------------------
# POST /internal/model-requests
# ---------------------------------------------------------------------------


class ProviderAttemptWire(WireModel):
    """One failed provider attempt: who, why, and how long it took (Requirement 11.7)."""

    provider: ModelProvider
    failure: ProviderFailureKind
    elapsed_ms: int = Field(ge=0, le=_MAX_LATENCY_MS)


class ModelRequestPayloadWire(WireModel):
    """What the Gateway posts: measurements only, never a price.

    ``model`` is the **resolved** model name, not the routing label. OpenRouter is
    itself a gateway, so recording what it resolved to is what keeps cost
    attribution accurate rather than collapsing every OpenRouter call into one line.

    ``outcome`` uses design.md's endpoint literals. **design.md gap, reported rather
    than patched:** the ``model_requests`` DDL spells the success label ``succeeded``
    and admits a third value, ``cost_cap_exceeded``, that this payload cannot
    express — a capped request never reaches a provider, so the Gateway has no
    measurement to post. Task 29.6 owns the label mapping and the
    ``cost_cap_exceeded`` row; this model stays with the endpoint contract it mirrors.
    """

    provider: ModelProvider
    model: str = Field(min_length=1, max_length=200)
    task_class: TaskClass
    attempt_count: int = Field(ge=1, le=MAX_PROVIDERS_PER_REQUEST)
    input_tokens: int = Field(ge=0, le=_MAX_TOKENS)
    output_tokens: int = Field(ge=0, le=_MAX_TOKENS)
    latency_ms: int = Field(ge=0, le=_MAX_LATENCY_MS)
    outcome: Literal["success", "provider_unavailable"]
    attempts: list[ProviderAttemptWire] = Field(max_length=MAX_ATTEMPT_RECORDS)


class ModelRequestResponseWire(WireModel):
    """The persisted row's identifier and the price TypeScript computed."""

    model_request_id: UuidField
    cost_paise: PaiseWireField

    def cost(self) -> int:
        """The computed cost as an ``int``, range-checked."""
        return from_wire(self.cost_paise, "cost_paise")
