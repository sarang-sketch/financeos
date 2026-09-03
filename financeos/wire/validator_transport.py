"""The FinanceOS_Response_Validator boundary on the wire, Python side (task 29.3).

Requirements 15.1, 15.8; supports 11.11 and 12.6.

The mirror of ``src/wire/validator-transport.ts``. The second of design.md's "three
places money crosses", and the one where the Python side does the comparing: the
Validator is Python, so ``allowed_values_paise`` arrives as decimal strings and is
parsed to ``int`` **before any set-membership comparison**.

:meth:`ResponseValidatorRequestWire.allowed_values` is that parse, and it returns a
``frozenset[int]`` rather than a list because the only question asked of the set is
membership. Requirement 11.11 is a zero-tolerance exact match, which is meaningful
only if the set arrived exactly: a coerced double anywhere in it would silently
widen what counts as grounded — an invented figure matching a neighbouring rounded
member — or narrow it, withholding a response that was correct. The set would have
the right length, the right shape and the wrong contents.
"""

from typing import Final, Literal

from pydantic import Field

from financeos.wire.fields import (
    NullablePaiseWireField,
    PaiseWireField,
    UuidField,
    WireModel,
)
from financeos.wire.paise import from_wire

#: Requirement 11.9's payload bound: at most 200 tool values reach the Model, so at
#: most 200 values can be grounded. A larger allowed set would describe figures the
#: Model was never given.
MAX_ALLOWED_VALUES: Final[int] = 200

#: Requirement 11.9's input ceiling, and therefore the narrative ceiling.
MAX_NARRATIVE_CHARS: Final[int] = 100_000

#: Requirement 11.10 truncates Model output at 8000 characters before release.
MAX_RELEASED_CHARS: Final[int] = 8_000


class ResponseValidatorRequestWire(WireModel):
    """What an Agent hands the Validator.

    No ``tenant_id``: design.md's in-process ``ResponseValidator.validate`` shows
    one, but on the wire the Tenant comes from the forwarded session and a
    body-supplied one is rejected as a schema violation (Requirement 12.7, 14.8).
    """

    narrative: str = Field(min_length=1, max_length=MAX_NARRATIVE_CHARS)
    allowed_values_paise: list[PaiseWireField] = Field(max_length=MAX_ALLOWED_VALUES)
    evidence_chain_ids: list[UuidField] = Field(max_length=MAX_ALLOWED_VALUES)

    def allowed_values(self) -> frozenset[int]:
        """The allowed set as ``int``, parsed before any comparison (Requirement 11.11)."""
        return frozenset(
            from_wire(value, "allowed_values_paise") for value in self.allowed_values_paise
        )


class ValidationReleasedWire(WireModel):
    """Every figure matched an allowed value and every chain resolved."""

    ok: Literal[True]
    released: str = Field(max_length=MAX_RELEASED_CHARS)


class UngroundedFigureWire(WireModel):
    """A monetary token in the narrative matched no allowed value. The whole response
    is withheld (Requirement 11.11).

    ``parsed_paise`` is nullable because a token that could not be normalised to
    paise at all still has to be reported: the figure text is what a reviewer needs,
    and ``None`` states that no paise value was recoverable from it. When a value
    *was* recovered it is reported at the precision it was compared at.
    """

    ok: Literal[False]
    kind: Literal["ungrounded_figure"]
    figure_text: str = Field(min_length=1, max_length=200)
    parsed_paise: NullablePaiseWireField

    def parsed(self) -> int | None:
        """The offending figure as an ``int``, or ``None`` when none was recoverable."""
        if self.parsed_paise is None:
            return None
        return from_wire(self.parsed_paise, "parsed_paise")


class UnresolvedEvidenceChainWire(WireModel):
    """A cited Evidence_Chain identifier did not resolve (Requirement 12.6)."""

    ok: Literal[False]
    kind: Literal["unresolved_evidence_chain"]
    evidence_chain_id: UuidField


ValidationResultWire = ValidationReleasedWire | UngroundedFigureWire | UnresolvedEvidenceChainWire
