"""The Python money wire helpers encode exactly, and reject rather than coerce.

The example-based half of the money wire contract, mirroring
``src/wire/paise-wire.test.ts`` case for case so a value asserted on one side is
asserted on the other. P15's generated round-trip over the shared fixture vectors
is task 29.4's ``tests/property/test_money_wire.py``; these are the named cases
that a generator is a poor way to reach — the ``bool`` guard, the malformed
strings, the two range extremes, and the above-2^53 magnitude.

Every deliberate wrong-typed argument goes through ``cast``. The lie to the type
checker is the point: these guards exist for values arriving from a JSON payload,
where the annotation guarantees nothing.

Validates: Requirements 15.1, 15.8
"""

from typing import Final, cast

import pytest

from financeos.wire.paise import (
    PAISE_MAX,
    PAISE_MIN,
    PaiseWire,
    WireError,
    assert_in_range,
    decode_paise,
    encode_paise,
    from_wire,
    to_wire,
)

# The constants P15 biases its generator toward, plus a realistic settlement figure.
IN_RANGE_VECTORS: Final[tuple[int, ...]] = (
    0,
    1,
    -1,
    99,
    100,
    84260000,
    PAISE_MIN,
    PAISE_MAX,
)

TWO_POW_53: Final[int] = 2**53

# The magnitude an unrounded `applyRate` product actually reaches: the range
# maximum times a 30% rate in basis points is roughly 3 * 10^19.
UNROUNDED_PRODUCT: Final[int] = 10**19

BOOLS: Final[tuple[object, ...]] = (True, False)

NON_INT_VALUES = [
    pytest.param(1.0, id="a float that happens to be whole"),
    pytest.param(842600.5, id="a float with a fraction"),
    pytest.param("84260000", id="a decimal string"),
    pytest.param(None, id="null"),
]

NON_STRING_WIRE_VALUES = [
    pytest.param(84260000, id="a JSON number"),
    pytest.param(842600.0, id="a JSON float"),
    pytest.param(None, id="null"),
    pytest.param({"figure_paise": "84260000"}, id="a nested object"),
    pytest.param(["84260000"], id="an array"),
]

MALFORMED_WIRE_STRINGS = [
    pytest.param("842600.00", id="a decimal point"),
    pytest.param("+84260000", id="a leading plus sign"),
    pytest.param(" 84260000", id="leading whitespace"),
    pytest.param("84260000\n", id="a trailing newline"),
    pytest.param("1e19", id="exponent notation"),
    pytest.param("eighty-four lakh", id="a non-numeric string"),
    pytest.param("-", id="a lone minus sign"),
    pytest.param("", id="an empty string"),
]


@pytest.mark.parametrize("value", IN_RANGE_VECTORS)
def test_to_wire_encodes_an_in_range_value_as_its_decimal_digits(value: int) -> None:
    assert to_wire(value) == str(value)


def test_to_wire_encodes_both_range_extremes_exactly() -> None:
    assert to_wire(PAISE_MIN) == "-99999999999999"
    assert to_wire(PAISE_MAX) == "99999999999999"


@pytest.mark.parametrize("value", IN_RANGE_VECTORS)
def test_from_wire_round_trips_every_value_to_wire_produced(value: int) -> None:
    round_tripped = from_wire(to_wire(value))

    assert round_tripped == value
    # `type(...) is int` rather than isinstance, which would accept a bool: the
    # assertion is that a paise value in this process is an int and never a float.
    assert type(round_tripped) is int


def test_from_wire_decodes_both_range_extremes() -> None:
    assert from_wire("-99999999999999") == PAISE_MIN
    assert from_wire("99999999999999") == PAISE_MAX


@pytest.mark.parametrize("value", [PAISE_MIN - 1, PAISE_MAX + 1])
def test_to_wire_raises_rather_than_emitting_a_string_beyond_each_extreme(value: int) -> None:
    with pytest.raises(WireError, match="out of paise range"):
        to_wire(value)


@pytest.mark.parametrize("value", [PAISE_MIN - 1, PAISE_MAX + 1])
def test_from_wire_rejects_a_well_formed_string_one_paisa_beyond_each_extreme(value: int) -> None:
    # The string is well formed, so this is the range guard failing, not the
    # format guard. TypeScript tells them apart by error class; Python raises one
    # WireError for both, so the message is what separates the two facts.
    with pytest.raises(WireError, match="out of paise range"):
        from_wire(str(value))


@pytest.mark.parametrize("value", BOOLS)
def test_the_bool_guard_rejects_a_bool_that_would_otherwise_pass_as_an_int(
    value: object,
) -> None:
    # bool subclasses int, so True satisfies isinstance(v, int) and sits inside the
    # paise range. Without the guard, to_wire(True) returns "True".
    with pytest.raises(WireError, match="is not an int"):
        assert_in_range(cast("int", value))
    with pytest.raises(WireError, match="is not an int"):
        to_wire(cast("int", value))
    with pytest.raises(WireError, match="is not an int"):
        encode_paise(cast("int", value))


@pytest.mark.parametrize("value", NON_INT_VALUES)
def test_assert_in_range_rejects_anything_that_is_not_an_int(value: object) -> None:
    with pytest.raises(WireError, match="is not an int"):
        assert_in_range(cast("int", value))


@pytest.mark.parametrize("value", NON_STRING_WIRE_VALUES)
def test_from_wire_rejects_a_non_string(value: object) -> None:
    with pytest.raises(WireError, match="is not an integer string"):
        from_wire(cast("PaiseWire", value))


@pytest.mark.parametrize("value", MALFORMED_WIRE_STRINGS)
def test_from_wire_rejects_a_malformed_string(value: PaiseWire) -> None:
    with pytest.raises(WireError, match="is not an integer string"):
        from_wire(value)


def test_the_wire_error_names_the_field_when_the_caller_supplies_one() -> None:
    with pytest.raises(WireError, match="monetary field expected_amount_paise") as caught:
        from_wire("842600.00", "expected_amount_paise")

    assert caught.value.field == "expected_amount_paise"


def test_encode_and_decode_round_trip_a_magnitude_above_two_to_the_fifty_third() -> None:
    assert UNROUNDED_PRODUCT > TWO_POW_53
    assert encode_paise(UNROUNDED_PRODUCT) == "10000000000000000000"
    assert decode_paise(encode_paise(UNROUNDED_PRODUCT)) == UNROUNDED_PRODUCT
    assert decode_paise(encode_paise(-UNROUNDED_PRODUCT)) == -UNROUNDED_PRODUCT
    # The same magnitude the range guard rejects by design, which is why the
    # range-free pair exists at all.
    with pytest.raises(WireError, match="out of paise range"):
        to_wire(UNROUNDED_PRODUCT)


@pytest.mark.parametrize("value", MALFORMED_WIRE_STRINGS)
def test_decode_paise_still_rejects_a_malformed_string(value: PaiseWire) -> None:
    with pytest.raises(WireError, match="is not an integer string"):
        decode_paise(value)


@pytest.mark.parametrize("value", IN_RANGE_VECTORS)
def test_the_range_free_pair_agrees_with_to_wire_inside_the_range(value: int) -> None:
    assert encode_paise(value) == to_wire(value)
    assert decode_paise(encode_paise(value)) == from_wire(to_wire(value))
