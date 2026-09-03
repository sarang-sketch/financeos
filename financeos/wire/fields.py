"""The wire field types every transport model is built from (task 29.3).

Requirements 15.1, 15.8.

``src/wire/paise-schema.ts`` is the one Zod declaration of a monetary field; this
is its Python counterpart. Every ``_paise`` field in every model under
``financeos/wire/`` is :data:`PaiseWireField` or :data:`NullablePaiseWireField`,
so "every monetary field is a decimal string" is a property of one declaration
rather than a habit spread across three modules.

Why ``str`` and not ``int``
---------------------------

``int`` is exact in Python, so an ``int``-typed wire field would be safe *in this
process*. It would not be safe on the wire: the value has to survive
``json.dumps`` on this side and ``JSON.parse`` on the other, and ``JSON.parse``
produces an IEEE-754 double for every numeric literal. The wire type is therefore
``str`` and the ``int`` appears only after :func:`financeos.wire.paise.from_wire`.
mypy is configured to reject the inverse mistake — a ``_paise`` field annotated
``int`` in a transport model — and ``tests/test_paise_typing_discipline.py``
asserts that it does.

Rejection, not coercion
-----------------------

pydantic v2 does not coerce an ``int`` into a ``str``, and ``strict=True`` on
:class:`WireModel` removes every remaining lax conversion, so a JSON number in a
``_paise`` field is a validation error naming the field rather than a
confident-looking string. That is the same choice the Zod side makes by declaring
``z.string()`` and never ``z.coerce.string()``.

The format guard is :func:`financeos.wire.paise.decode_paise`, which is
**range-free** on purpose. The Zod side does not range-check either: the range
guard belongs to the step where the string becomes a number, so the transport
suite can assert the format guard and the range guard as separate facts, and so
the above-2^53 magnitudes P15 exercises need no second schema.
"""

from datetime import date
from typing import Annotated, Final

from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints

from financeos.wire.paise import PaiseWire, decode_paise


def _wire_format(value: PaiseWire) -> PaiseWire:
    """Reject a value that is not an integer string, and return it unchanged.

    ``decode_paise`` raises :class:`financeos.wire.paise.WireError`, which derives
    from ``ValueError``, so pydantic reports it as a validation error naming the
    offending field. Nothing is converted: the wire form is what the model holds.
    """
    decode_paise(value)
    return value


#: A monetary field on the wire. Not coerced, not defaulted, not transformed.
PaiseWireField = Annotated[PaiseWire, AfterValidator(_wire_format)]

#: A monetary field that may be absent as a *value* rather than as a key.
#:
#: ``EvidenceStep.result_paise`` is ``None`` for a ``compare`` or a non-monetary
#: ``select``, and ``ValidationResult.parsed_paise`` is ``None`` for a token that
#: could not be normalised at all. ``None``, not an omitted key: a step with no
#: monetary result is a fact the wire states, and JSON has a spelling for it.
NullablePaiseWireField = PaiseWireField | None

# The bounded non-monetary field shapes, mirroring the Zod side's `z.uuid()`,
# `z.iso.date()` and `z.iso.datetime()`.
#
# They are held to the *same* acceptance set rather than a looser one, because a
# mirror that accepts more than the other side is not a mirror: a payload TypeScript
# rejects would validate here, and the disagreement would surface as an endpoint
# returning a rejection for a body this runtime believed it had built correctly.
#
# `_UUID_RE` is Zod's own pattern, including the two reserved identifiers it admits
# beside the RFC 9562 shape. `z.iso.datetime()` accepts `Z` only, not an offset, so
# neither does this. Both Zod patterns also check the calendar, which a bare regex
# cannot; :func:`_real_calendar_date` is that half.
#
# Timestamps stay `str` rather than becoming `datetime`: a parsed datetime
# re-serialises to a normalised spelling, and the transport suite compares payloads
# across two runtimes.
_UUID_RE: Final[str] = (
    r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}"
    r"-[0-9a-fA-F]{12}"
    r"|00000000-0000-0000-0000-000000000000"
    r"|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
)
_DATE_RE: Final[str] = r"^\d{4}-\d{2}-\d{2}$"
_TIMESTAMP_RE: Final[str] = r"^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$"


def _real_calendar_date(value: str) -> str:
    """Reject a shape-valid date that is not a date: ``2026-02-30`` is neither."""
    try:
        date.fromisoformat(value[:10])
    except ValueError as error:
        message = f"not a real calendar date: {value!r}"
        raise ValueError(message) from error
    return value


UuidField = Annotated[str, StringConstraints(pattern=_UUID_RE)]
DateOnlyField = Annotated[
    str, StringConstraints(pattern=_DATE_RE), AfterValidator(_real_calendar_date)
]
TimestampField = Annotated[
    str, StringConstraints(pattern=_TIMESTAMP_RE), AfterValidator(_real_calendar_date)
]


class WireModel(BaseModel):
    """The base every transport model shares.

    ``extra="forbid"`` is the pydantic spelling of Zod's ``.strict()``, and it
    carries two rules rather than one tidiness preference:

    * a body-supplied ``tenant_id`` is **rejected, not ignored** (Requirement 12.7,
      14.8) — silently dropping it would let a caller believe it had scoped a
      request when it had not;
    * a metering payload carrying ``cost_paise`` is rejected, because cost is
      computed on the TypeScript side (Requirement 11.8).

    ``strict=True`` removes pydantic's remaining lax conversions, so a JSON number
    reaching a ``_paise`` field fails rather than becoming a string, and a float
    reaching a token count fails rather than truncating.

    ``frozen=True`` because a received payload is a record of what arrived. A model
    that could be edited in place would make "the figure that crossed the wire"
    unanswerable after the fact.
    """

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
