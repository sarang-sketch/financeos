"""The tool boundary on the wire, Python side (task 29.3).

Requirements 15.1, 15.8; 12.3, 12.7, 12.9, 12.10, 12.11 for the envelope variants.

The mirror of ``src/wire/tool-transport.ts``, model for model and field for field.
This is the first of design.md's "three places money crosses": the tool input an
Agent posts to ``POST /internal/tools/{tool_name}``, and the ``ToolResult<Out>``
envelope that comes back — including ``figure_paise`` on the Evidence_Chain and
``result_paise`` on every :class:`EvidenceStepWire`.

Every ``_paise`` field is ``str`` (:data:`~financeos.wire.fields.PaiseWireField`)
and every accessor beside it returns ``int`` through
:func:`~financeos.wire.paise.from_wire`. That split is the contract: ``str`` on the
wire, ``int`` in memory, parsed at the boundary and nowhere else.

The closed sets are transcribed
-------------------------------

``SOURCE_RECORD_TYPES`` and ``EVIDENCE_OPERATIONS`` are imported from
``@/ledger/posting-rules`` and ``@/evidence/chain-builder`` on the TypeScript side.
Two runtimes cannot share a literal, so they are transcribed here as ``Literal``
unions — which is exactly the drift risk design.md accepts when it says the two
sides are hand-written and test-verified rather than generated. Task 29.7's shared
fixture vectors are where the two transcriptions are held to each other; the audit
in this task checks the money typing only.
"""

from typing import Final, Literal, get_args

from pydantic import Field

from financeos.wire.fields import (
    DateOnlyField,
    NullablePaiseWireField,
    PaiseWireField,
    TimestampField,
    UuidField,
    WireModel,
)
from financeos.wire.paise import from_wire

# ---------------------------------------------------------------------------
# Closed sets
# ---------------------------------------------------------------------------

#: The 13 labels of the ``source_record_type`` enum, in migration order.
SourceRecordType = Literal[
    "payment",
    "order",
    "refund",
    "settlement",
    "settlement_recon_report",
    "transfer",
    "transfer_reversal",
    "razorpay_invoice",
    "credit_note",
    "linked_account",
    "ledger_entry_set",
    "proposal",
    "forecast_component",
]

SOURCE_RECORD_TYPES: Final[tuple[str, ...]] = get_args(SourceRecordType)

#: The 9 labels of the ``evidence_operation`` enum, in migration order.
EvidenceOperation = Literal[
    "sum",
    "subtract",
    "add",
    "multiply",
    "divide",
    "round_half_up",
    "negate",
    "select",
    "compare",
]

EVIDENCE_OPERATIONS: Final[tuple[str, ...]] = get_args(EvidenceOperation)

#: Requirement 12.2: at most 500 Source_Record identifiers per retrieved page.
MAX_SOURCE_PAGE_SIZE: Final[int] = 500

#: Requirement 2.1's 2..20 Ledger_Entries per set.
MIN_ENTRIES: Final[int] = 2
MAX_ENTRIES: Final[int] = 20

#: Requirement 2.2: at least 1 Source_Record link on a posted adjustment.
MIN_SOURCE_REFS: Final[int] = 1
MAX_SOURCE_REFS: Final[int] = 50

_SOURCE_RECORD_ID_RE: Final[str] = r"^[A-Za-z0-9_-]{1,128}$"
_ACCOUNT_CODE_RE: Final[str] = r"^[a-z][a-z0-9_]{0,62}$"
_TOOL_NAME_RE: Final[str] = r"^[a-z][a-z0-9_]{2,63}$"


# ---------------------------------------------------------------------------
# Evidence shapes
# ---------------------------------------------------------------------------


class SourceRefWire(WireModel):
    """One Source_Record link. Carries no money, so it is identical either side."""

    type: SourceRecordType
    id: str = Field(pattern=_SOURCE_RECORD_ID_RE)


class SourceOperandWire(WireModel):
    """A field of a Source_Record."""

    kind: Literal["source"]
    ref: SourceRefWire
    field: str = Field(min_length=1, max_length=128)


class StepOperandWire(WireModel):
    """A preceding step's output. ``index`` is an ordinal, so it stays an ``int``."""

    kind: Literal["step"]
    index: int = Field(gt=0)


class LiteralOperandWire(WireModel):
    """A literal. Always a string, in process as well as on the wire.

    A monetary literal is never a JSON number — that is
    ``@/evidence/chain-builder``'s rule, not a wire concession.
    """

    kind: Literal["literal"]
    value: str = Field(min_length=1, max_length=128)


EvidenceOperandWire = SourceOperandWire | StepOperandWire | LiteralOperandWire


class EvidenceStepWire(WireModel):
    """One computation step, stating exactly one arithmetic operation."""

    index: int = Field(gt=0)
    operation: EvidenceOperation
    operands: list[EvidenceOperandWire] = Field(min_length=1)
    result_paise: NullablePaiseWireField
    note: str | None = Field(default=None, min_length=1, max_length=500)

    def result(self) -> int | None:
        """The step's monetary result as an ``int``, or ``None`` for a non-monetary step."""
        if self.result_paise is None:
            return None
        return from_wire(self.result_paise, "result_paise")


class UnavailableSourceCountWire(WireModel):
    """One unavailable Source_Record type with its count of unreadable identifiers."""

    type: SourceRecordType
    count: int = Field(gt=0)


class EvidenceChainWire(WireModel):
    """The Evidence_Chain as it crosses the wire.

    ``sources`` is capped at :data:`MAX_SOURCE_PAGE_SIZE` because that is the page
    size on retrieval (Requirement 12.2), so no single payload is unbounded.
    """

    evidence_chain_id: UuidField
    figure_paise: PaiseWireField
    sources: list[SourceRefWire] = Field(min_length=1, max_length=MAX_SOURCE_PAGE_SIZE)
    source_count: int = Field(gt=0)
    steps: list[EvidenceStepWire] = Field(min_length=1)
    as_of: TimestampField
    produced_by: str = Field(pattern=_TOOL_NAME_RE)

    def figure(self) -> int:
        """The presented figure as an ``int``, range-checked."""
        return from_wire(self.figure_paise, "figure_paise")


# ---------------------------------------------------------------------------
# The four rejection variants of ToolResult<T>
# ---------------------------------------------------------------------------


class IncompleteEvidenceWire(WireModel):
    """Requirement 12.3. **There is no figure field.**

    The figure is omitted entirely rather than sent as ``0``, as ``None``, or beside
    a count — and ``extra="forbid"`` is what makes a smuggled one a rejection rather
    than a silently accepted extra key.
    """

    ok: Literal[False]
    kind: Literal["incomplete_evidence"]
    unavailable: list[UnavailableSourceCountWire] = Field(
        min_length=1, max_length=len(SOURCE_RECORD_TYPES)
    )


class ToolArgumentViolationWire(WireModel):
    """One non-conforming argument, named, with why it was refused."""

    argument: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=500)


class SchemaViolationWire(WireModel):
    """Requirement 12.9. One entry per non-conforming argument. Never empty."""

    ok: Literal[False]
    kind: Literal["schema_violation"]
    violations: list[ToolArgumentViolationWire] = Field(min_length=1)


class ToolFailureWire(WireModel):
    """Requirement 12.11. The invocation was terminated; Tenant state is unchanged.

    This shape is why the Python client in task 29.5 sets a 13-second deadline
    against the 10-second server-side bound: a shorter client deadline would mask
    this result behind a transport error, and "the tool timed out and Tenant state
    is unchanged" is a different fact from "the request never arrived".
    """

    ok: Literal[False]
    kind: Literal["tool_failure"]
    tool: str = Field(pattern=_TOOL_NAME_RE)
    cause: Literal["timeout", "execution_error"]


class UnauthorizedWriteWire(WireModel):
    """Requirement 12.10. One reason, so a caller learns nothing about another Tenant."""

    ok: Literal[False]
    kind: Literal["unauthorized_write"]
    reason: Literal["missing_authorized_proposal"]


class ToolSuccessWire[OutT: WireModel](WireModel):
    """A figure with its chain. There is no success variant without an Evidence_Chain."""

    ok: Literal[True]
    value: OutT
    evidence: EvidenceChainWire


# ---------------------------------------------------------------------------
# post_reconciliation_adjustment, both directions
# ---------------------------------------------------------------------------


class LedgerEntryWire(WireModel):
    """One drafted Ledger_Entry.

    The ``> 0`` bound the in-process schema states as ``z.bigint().positive()`` is
    **not** restated as a pattern here. A pattern excluding ``0`` and a leading
    minus would be a second spelling of the money format, and there is deliberately
    only one. Positivity is the tool's check, applied after ``from_wire`` alongside
    the range guard.
    """

    account_code: str = Field(pattern=_ACCOUNT_CODE_RE)
    side: Literal["debit", "credit"]
    amount_paise: PaiseWireField

    def amount(self) -> int:
        """The entry amount as an ``int``, range-checked."""
        return from_wire(self.amount_paise, "amount_paise")


class PostReconciliationAdjustmentInputWire(WireModel):
    """The request body for ``post_reconciliation_adjustment``.

    No ``tenant_id`` at any depth: the Tenant comes from the forwarded session, and
    a body-supplied one is rejected rather than ignored (Requirement 12.7, 14.8).
    """

    entry_date: DateOnlyField
    entries: list[LedgerEntryWire] = Field(min_length=MIN_ENTRIES, max_length=MAX_ENTRIES)
    source_refs: list[SourceRefWire] = Field(
        min_length=MIN_SOURCE_REFS, max_length=MAX_SOURCE_REFS
    )


class PostReconciliationAdjustmentOutputWire(WireModel):
    """The tool's output. Two figures, two derivations, two chains."""

    set_id: UuidField
    total_debit_paise: PaiseWireField
    total_credit_paise: PaiseWireField
    total_debit_evidence_chain_id: UuidField
    total_debit_evidence_as_of: TimestampField
    total_credit_evidence_chain_id: UuidField
    total_credit_evidence_as_of: TimestampField

    def total_debit(self) -> int:
        """The debit total as an ``int``, range-checked."""
        return from_wire(self.total_debit_paise, "total_debit_paise")

    def total_credit(self) -> int:
        """The credit total as an ``int``, range-checked."""
        return from_wire(self.total_credit_paise, "total_credit_paise")


#: The whole envelope for that tool: the success variant plus the four rejections.
PostReconciliationAdjustmentResultWire = (
    ToolSuccessWire[PostReconciliationAdjustmentOutputWire]
    | IncompleteEvidenceWire
    | SchemaViolationWire
    | ToolFailureWire
    | UnauthorizedWriteWire
)
