"""The money wire contract, Python side.

Every monetary value crossing the TypeScript↔Python boundary is a JSON string of
the integer paise value — ``"84260000"``, not ``84260000``. ``JSON.stringify``
throws on a ``bigint`` and ``JSON.parse`` produces an IEEE-754 double for every
numeric literal, so the decimal string is the only sanctioned path (Requirement
15.1, 15.8). This module is the exact mirror of ``src/wire/paise-wire.ts``: the
same regex, the same range, the same rejection-not-coercion rule, and the same
range-free pair for the magnitudes the range guard rejects by design.

Inside this process a paise value is always ``int``, never ``float``. Python
``int`` is arbitrary-precision, so ``str(v)`` and ``int(s)`` are exact at any
digit length and no rounding step exists to hide — that is the Python half of
P12's assertion.

Rejection, not coercion: a malformed value fails loudly here rather than being
quietly turned into a confident-looking number.

Two deliberate differences from the TypeScript side, both of them Python facts:

* ``bool`` is a subclass of ``int``, so ``True`` satisfies ``isinstance(v, int)``
  and sits comfortably inside the paise range. Without the ``bool`` guard,
  ``to_wire(True)`` returns ``"True"`` — a value that fails at the far end of the
  wire instead of at the source that produced it.
* TypeScript raises a distinct ``PaiseRangeError`` for a range violation because
  its range guard lives in ``src/calc/paise.ts`` and is shared with the
  Calculation Service. Python holds no money arithmetic at all (design.md,
  Architecture), so there is no second caller for a second error type: both
  failures raise :class:`WireError`, with distinct messages so the transport
  suite can still assert the format guard and the range guard as separate facts.

:class:`WireError` derives from ``ValueError`` so that the pydantic transport
models mirroring the Zod schemas surface a bad ``_paise`` field as a validation
error naming the field, rather than letting it escape a validator uncaught.
"""

import re
from typing import Final

# A monetary value in transit. Always the decimal digits of an integer paise value.
PaiseWire = str

#: The signed paise floor: -99999999999999 (Requirement 15.1, 15.8).
PAISE_MIN: Final[int] = -99_999_999_999_999

#: The signed paise ceiling: 99999999999999 (Requirement 15.1, 15.8).
PAISE_MAX: Final[int] = 99_999_999_999_999

# The only accepted wire shape: optional minus sign, then digits. Matched with
# `fullmatch`, not `match`: Python's `$` also matches just before a trailing
# newline, so `match` would accept "84260000\n" where the JavaScript regex does
# not. `fullmatch` keeps the two runtimes reading the same string the same way.
_INTEGER_RE: Final[re.Pattern[str]] = re.compile(r"^-?[0-9]+$")


class WireError(ValueError):
    """A monetary value is not an integer string, not an ``int``, or out of range.

    Carries the offending field name when the caller named one, so a transport
    failure points at the field rather than at the payload.
    """

    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.field = field


def _is_paise_int(value: object) -> bool:
    """True only for a real ``int``. ``bool`` is a subclass of ``int``, and is not."""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_integer_string(value: object) -> bool:
    """True only for a ``str`` of an optional minus sign followed by digits."""
    return isinstance(value, str) and _INTEGER_RE.fullmatch(value) is not None


def _named(field: str | None) -> str:
    return "" if field is None else f" {field}"


def _assert_integer_string(s: PaiseWire, field: str | None = None) -> None:
    """The wire-format guard. The runtime check the ``PaiseWire`` annotation cannot make."""
    if not _is_integer_string(s):
        message = f"monetary field{_named(field)} is not an integer string: {s!r}"
        raise WireError(message, field)


def _assert_paise_int(v: int) -> None:
    """The type guard, mirroring the TypeScript ``assertPaise``. No range check."""
    if not _is_paise_int(v):
        message = f"monetary value is not an int: {v!r}"
        raise WireError(message)


def assert_in_range(v: int) -> None:
    """The single paise range guard for the Python runtime.

    Raises rather than wrapping or saturating (Requirement 15.1, 15.8). The
    ``bool`` half of the type guard is load-bearing: ``True`` would otherwise pass
    as ``1``.
    """
    _assert_paise_int(v)
    if not (PAISE_MIN <= v <= PAISE_MAX):
        message = f"monetary value out of paise range: {v}"
        raise WireError(message)


def to_wire(v: int) -> PaiseWire:
    """int -> wire. Range-checked. The only sanctioned way a paise value leaves this process."""
    assert_in_range(v)
    return str(v)  # int is arbitrary-precision, so this is exact


def from_wire(s: PaiseWire, field: str | None = None) -> int:
    """wire -> int. Raises a :class:`WireError` on a non-integer string, then range-checks."""
    _assert_integer_string(s, field)
    v = int(s)  # exact for any digit length
    assert_in_range(v)  # -99999999999999 .. 99999999999999
    return v


def encode_paise(v: int) -> PaiseWire:
    """Range-free encode.

    The same encoding as :func:`to_wire` with no range check, because
    :func:`assert_in_range` rejects magnitudes above 2^53 by design and P15 must
    still prove the encoding survives them: an unrounded ``applyRate`` product at
    the range maximum reaches roughly 3 * 10^19.
    """
    _assert_paise_int(v)
    return str(v)


def decode_paise(s: PaiseWire, field: str | None = None) -> int:
    """Range-free decode. The exact inverse of :func:`encode_paise`."""
    _assert_integer_string(s, field)
    return int(s)
