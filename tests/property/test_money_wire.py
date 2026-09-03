# Feature: financeos-control-tower, Property 15: Money wire round-trip — for all paise
# values `p` in the signed range -99999999999999 to 99999999999999, serializing `p` on one
# runtime and parsing it on the other reproduces `p` exactly, in both directions; and for
# all monetary fields, a payload carrying a JSON number in a `_paise` field is rejected
# with a schema violation naming the field rather than coerced.
"""The Hypothesis half of Property 15. Requirements 15.1, 15.8.

P15 is owned by **both** runtimes. This is the Python half; the fast-check half is
``test/property/money-wire.property.test.ts``. Both read ONE committed file —
``fixtures/wire/money-wire-vectors.json`` — not two copies of it.

What is asserted in-process, and what is asserted across processes
-----------------------------------------------------------------

Read this before trusting a green run, because the distinction is the whole reason
the fixture exists.

**In-process, here.** ``from_wire(to_wire(p)) == p`` for every generated ``p``;
``to_wire`` raising on every out-of-range value; the range-free pair round-tripping
every above-2^53 value; and every malformed ``_paise`` payload being rejected by the
pydantic transport model with the offending field named.

**Across processes, through the shared fixture.** There is no Node process in this
test run, so ``py_parse(ts_serialize(p))`` is not evaluated here as a function
composition. It is asserted as a *chain through one committed artifact*, and each
link is checked in the runtime that owns it::

    link 1 (money-wire.property.test.ts)   toWire(BigInt(v.paise)) === v.wire
    link 2 (here)                          from_wire(v.wire) == int(v.paise)
    => composite                           py_parse(ts_serialize(p)) == p

    link 3 (here)                          to_wire(int(v.paise)) == v.wire
    link 4 (money-wire.property.test.ts)   fromWire(v.wire) === BigInt(v.paise)
    => composite                           BigInt(py_serialize(p)) === p

``v.wire`` is a byte string in a committed file, so the composition is sound: the
string link 2 parses is character-for-character the string link 1 produced. What
this cannot catch is a fixture whose ``wire`` field is wrong in a way both runtimes
reproduce — which is why ``wire`` is never trusted on its own and is always checked
against an independently computed ``str(p)``. Live process-to-process exchange over
the real internal endpoints is task 29.7's ``tests/transport/``, once 29.5 and 29.6
exist to be called.

**Coverage, not omission.** A generated value outside the fixture is asserted only
on the side that drew it. The fixture is what makes the *boundary* values symmetric,
so :func:`test_the_fixture_covers_every_constant_the_strategy_is_biased_toward` is
load-bearing: adding a constant to the strategy without adding it to the fixture
fails here, which forces it into the file the fast-check suite reads.

Validates: Requirements 15.1, 15.8
"""

import copy
import json
from pathlib import Path
from typing import Any, Final, cast

import pytest
from hypothesis import given, seed, settings
from hypothesis import strategies as st
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from financeos.wire.metering_transport import (
    ModelCostCapResponseWire,
    ModelRequestResponseWire,
)
from financeos.wire.paise import (
    PAISE_MAX,
    PAISE_MIN,
    PaiseWire,
    WireError,
    decode_paise,
    encode_paise,
    from_wire,
    to_wire,
)
from financeos.wire.tool_transport import (
    EvidenceChainWire,
    PostReconciliationAdjustmentInputWire,
    PostReconciliationAdjustmentResultWire,
)
from financeos.wire.transport_models import TRANSPORT_MODELS, paise_leaves_of
from financeos.wire.validator_transport import (
    ResponseValidatorRequestWire,
    ValidationResultWire,
)

# ---------------------------------------------------------------------------
# The shared fixture
# ---------------------------------------------------------------------------

#: ``tests/property/test_money_wire.py`` -> repo root -> the one shared vector file.
FIXTURE_PATH: Final[Path] = (
    Path(__file__).resolve().parents[2] / "fixtures" / "wire" / "money-wire-vectors.json"
)


class _FixtureModel(BaseModel):
    """The fixture's own shape, declared rather than assumed.

    ``extra="forbid"`` on purpose: a key renamed on the TypeScript side and not here
    would otherwise show up as an assertion silently iterating an empty list, which
    is exactly the "green suite by omission" this property is written against.

    Several fields are read through an alias because the JSON spells them with a
    Python builtin's name — ``id``, ``min``, ``max``, ``range``, ``property`` — and
    ``$comment`` is not an identifier at all.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)


class _RoundTripVector(_FixtureModel):
    """One value with the decimal string both runtimes must agree it serialises to."""

    vector_id: str = Field(alias="id", min_length=1)
    paise: str
    wire: str
    note: str | None = None


class _OutOfRangeVector(_FixtureModel):
    """One value the range guard must reject rather than encode."""

    vector_id: str = Field(alias="id", min_length=1)
    paise: str


class _MalformedCase(_FixtureModel):
    """One malformed wire value, held as raw JSON text.

    Text rather than a parsed value so ``a_json_number`` and ``a_json_float`` reach
    the model as the number the sender wrote: each side parses it with its own JSON
    parser, which is the step that would round it.
    """

    case_id: str = Field(alias="id", min_length=1)
    raw_json: str = Field(alias="json", min_length=1)
    why: str = Field(min_length=1)
    accepted_when_nullable: bool


class _PaisePath(_FixtureModel):
    """Where a monetary field sits in a payload, and whether it admits ``None``."""

    path: str = Field(min_length=1)
    field: str = Field(min_length=1)
    nullable: bool


class _Payload(_FixtureModel):
    """One valid payload shape, with every monetary field in it named."""

    payload_id: str = Field(alias="id", min_length=1)
    typescript_schema: str = Field(min_length=1)
    python_model: str = Field(min_length=1)
    boundary: str = Field(min_length=1)
    body: dict[str, object]
    paise_paths: list[_PaisePath] = Field(min_length=1)


class _Seeds(_FixtureModel):
    """Committed, so any counterexample reproduces from the tests alone."""

    comment: str = Field(alias="$comment")
    fast_check_seed: int
    fast_check_num_runs: int
    hypothesis_max_examples: int
    hypothesis_seed: int


class _Range(_FixtureModel):
    """The one statement of the paise range both runtimes check themselves against."""

    min_paise: str = Field(alias="min")
    max_paise: str = Field(alias="max")


class _Fixture(_FixtureModel):
    """``fixtures/wire/money-wire-vectors.json``, whole."""

    comment: list[str] = Field(alias="$comment")
    version: int
    property_name: str = Field(alias="property")
    validates: list[str]
    seeds: _Seeds
    paise_range: _Range = Field(alias="range")
    boundary_constants: list[str] = Field(min_length=1)
    in_range: list[_RoundTripVector] = Field(min_length=1)
    out_of_range: list[_OutOfRangeVector] = Field(min_length=1)
    above_two_pow_53: list[_RoundTripVector] = Field(min_length=1)
    malformed: list[_MalformedCase] = Field(min_length=1)
    payloads: list[_Payload] = Field(min_length=1)


def _load_fixture() -> _Fixture:
    raw: object = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    return _Fixture.model_validate(raw)


FIXTURE: Final[_Fixture] = _load_fixture()

#: The committed Hypothesis seed. ``derandomize`` in conftest.py's ``ci`` profile fixes
#: a seed from the test source; this states one in the file instead, so the same
#: examples are drawn under every profile.
P15_SEED: Final[int] = FIXTURE.seeds.hypothesis_seed

#: design.md holds P12 and P15 to 1000 iterations.
MAX_EXAMPLES: Final[int] = FIXTURE.seeds.hypothesis_max_examples

TWO_POW_53: Final[int] = 2**53

#: The generator ceiling on both sides. An unrounded ``applyRate`` product at the range
#: maximum reaches roughly 3 * 10^19, so the set has to reach past it.
GENERATOR_CEILING: Final[int] = 10**20


# ---------------------------------------------------------------------------
# Strategies — the Hypothesis mirror of the fast-check arbitraries
# ---------------------------------------------------------------------------

#: design.md's boundary constants as ``int``: 0, 1, -1, 99, 100 and both range extremes,
#: read from the shared file rather than transcribed, so the constant set this strategy
#: is biased toward and the constant set ``fc.constantFrom`` is biased toward cannot
#: drift apart.
BOUNDARY_CONSTANTS: Final[tuple[int, ...]] = tuple(
    int(constant) for constant in FIXTURE.boundary_constants
)

#: ``st.integers`` where fast-check uses ``fc.bigInt``, ``st.sampled_from`` where it uses
#: ``fc.constantFrom``. Every value is ``int``; there is no ``float`` money strategy
#: anywhere in this suite.
in_range_paise: Final[st.SearchStrategy[int]] = st.one_of(
    st.integers(min_value=PAISE_MIN, max_value=PAISE_MAX),
    st.sampled_from(BOUNDARY_CONSTANTS),
)

#: One paisa past each extreme, out to the magnitude an unrounded rate product reaches.
out_of_range_paise: Final[st.SearchStrategy[int]] = st.one_of(
    st.integers(min_value=PAISE_MAX + 1, max_value=GENERATOR_CEILING),
    st.integers(min_value=-GENERATOR_CEILING, max_value=PAISE_MIN - 1),
)

#: design.md's second, separately generated set: magnitudes above 2^53, fed through the
#: range-free pair because ``assert_in_range`` rejects them by design.
above_two_pow_53_paise: Final[st.SearchStrategy[int]] = st.integers(
    min_value=TWO_POW_53, max_value=GENERATOR_CEILING
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# The transport model each fixture payload is held to. The two unions are validated as
# unions rather than as their matching member, so the smart-union dispatch is exercised
# the same way the Zod side exercises `z.union`.
_ADAPTERS: Final[dict[str, TypeAdapter[Any]]] = {
    "PostReconciliationAdjustmentInputWire": TypeAdapter(PostReconciliationAdjustmentInputWire),
    "PostReconciliationAdjustmentResultWire": TypeAdapter(PostReconciliationAdjustmentResultWire),
    "EvidenceChainWire": TypeAdapter(EvidenceChainWire),
    "ResponseValidatorRequestWire": TypeAdapter(ResponseValidatorRequestWire),
    "ValidationResultWire": TypeAdapter(ValidationResultWire),
    "ModelCostCapResponseWire": TypeAdapter(ModelCostCapResponseWire),
    "ModelRequestResponseWire": TypeAdapter(ModelRequestResponseWire),
}


def _validate(model_name: str, body: object) -> None:
    """Validate ``body`` against the named transport model.

    Raises :class:`pydantic.ValidationError` on a bad payload, and nothing is
    returned: a rejection means no model instance exists, which is the Python
    spelling of "no coerced value is produced".
    """
    adapter = _ADAPTERS.get(model_name)
    if adapter is None:
        message = (
            f"the fixture names transport model {model_name}, which this suite does not "
            f"import; a payload shape nobody parses is a payload shape nobody checks"
        )
        raise LookupError(message)
    adapter.validate_python(body)


def _tokens_of(path: str) -> list[str | int]:
    """``evidence.steps[0].result_paise`` -> ``["evidence", "steps", 0, "result_paise"]``."""
    tokens: list[str | int] = []
    for part in path.split("."):
        head, *brackets = part.split("[")
        if head:
            tokens.append(head)
        tokens.extend(int(bracket.removesuffix("]")) for bracket in brackets)
    if not tokens:
        message = f"fixture path {path!r} is empty"
        raise ValueError(message)
    return tokens


def _step_into(cursor: object, token: str | int, path: str) -> object:
    """Read one step, refusing a path the payload does not have rather than returning None."""
    if isinstance(token, int):
        if not isinstance(cursor, list) or token >= len(cursor):
            message = f"fixture path {path!r}: no element {token} to step into"
            raise ValueError(message)
        return cast("object", cursor[token])
    if not isinstance(cursor, dict) or token not in cursor:
        message = f"fixture path {path!r}: no key {token!r} to step into"
        raise ValueError(message)
    return cast("object", cursor[token])


def _assign(cursor: object, token: str | int, value: object, path: str) -> None:
    if isinstance(token, int):
        if not isinstance(cursor, list):
            message = f"fixture path {path!r}: {token} is not an index into a list"
            raise TypeError(message)
        cursor[token] = value
        return
    if not isinstance(cursor, dict):
        message = f"fixture path {path!r}: {token!r} is not a key of an object"
        raise TypeError(message)
    cursor[token] = value


def _with_value_at(body: dict[str, object], path: str, value: object) -> dict[str, object]:
    """A deep copy of ``body`` with ``value`` at ``path``.

    Refuses a path that does not already exist, so a fixture typo fails loudly instead
    of quietly adding a key the model would reject for the wrong reason — a rejection
    naming ``amount_pasie`` would look like a pass.
    """
    clone = copy.deepcopy(body)
    tokens = _tokens_of(path)
    cursor: object = clone
    for token in tokens[:-1]:
        cursor = _step_into(cursor, token, path)
    last = tokens[-1]
    _step_into(cursor, last, path)  # assert the leaf exists before overwriting it
    _assign(cursor, last, value, path)
    return clone


def _locations(error: ValidationError) -> list[list[str]]:
    """Every location pydantic reported an error at, as strings.

    A union failure reports one error per member with the member's name at the head of
    ``loc``, so the field name is a *segment* rather than the whole location — which is
    why membership is what is asserted rather than equality.
    """
    return [[str(part) for part in detail["loc"]] for detail in error.errors()]


def _malformed_value(case: _MalformedCase) -> object:
    """The malformed value as a real JSON parse produces it."""
    value: object = json.loads(case.raw_json)
    return value


_MALFORMED_CASES: Final[list[tuple[_Payload, _PaisePath, _MalformedCase]]] = [
    (payload, target, case)
    for payload in FIXTURE.payloads
    for target in payload.paise_paths
    for case in FIXTURE.malformed
]


def _malformed_case_id(case: tuple[_Payload, _PaisePath, _MalformedCase]) -> str:
    payload, target, malformed = case
    return f"{payload.payload_id}::{target.path}::{malformed.case_id}"


# ---------------------------------------------------------------------------
# The range constants agree with the shared statement of the range
# ---------------------------------------------------------------------------


def test_the_shared_fixture_is_the_file_the_other_runtime_reads() -> None:
    # `money-wire.property.test.ts` pins the same two values with `z.literal`. If the file
    # is ever forked into a per-runtime copy, the copies drift and one of these fails.
    assert FIXTURE.version == 1
    assert FIXTURE.property_name == "P15"
    assert FIXTURE.validates == ["15.1", "15.8"]


def test_the_paise_range_matches_the_range_the_shared_fixture_states() -> None:
    # If this fails, every other assertion in both suites is about a different range.
    assert int(FIXTURE.paise_range.min_paise) == PAISE_MIN
    assert int(FIXTURE.paise_range.max_paise) == PAISE_MAX
    assert PAISE_MIN == -99999999999999
    assert PAISE_MAX == 99999999999999


def test_the_fixture_covers_every_constant_the_strategy_is_biased_toward() -> None:
    # The omission guard. A boundary constant added to `in_range_paise` but not to the
    # fixture would be drawn here and never asserted on the TypeScript side; this test
    # is what turns that into a failure rather than a silently one-sided property.
    covered = {vector.paise for vector in FIXTURE.in_range}
    for constant in BOUNDARY_CONSTANTS:
        assert str(constant) in covered, f"{constant} is not a shared in-range vector"

    required = [
        "0",
        "1",
        "-1",
        "99",
        "100",
        FIXTURE.paise_range.min_paise,
        FIXTURE.paise_range.max_paise,
    ]
    for value in required:
        assert value in FIXTURE.boundary_constants


# ---------------------------------------------------------------------------
# The generated in-range round-trip
# ---------------------------------------------------------------------------


@seed(P15_SEED)
@settings(max_examples=MAX_EXAMPLES, deadline=None, print_blob=True)
@given(in_range_paise)
def test_every_generated_in_range_value_round_trips_through_to_wire_and_from_wire(
    value: int,
) -> None:
    # `type(...) is int` rather than isinstance, which would accept a bool: a paise
    # value in this process is an int and never a float, and never a bool either.
    assert type(value) is int

    wire = to_wire(value)

    # A decimal string, which is the only thing that survives the crossing:
    # `JSON.stringify` throws on a bigint and `JSON.parse` doubles a numeric literal.
    assert type(wire) is str
    # Character-for-character what TypeScript's `v.toString()` produces for the same
    # integer. This is link 3 of the cross-runtime chain, generalised past the fixture.
    assert wire == str(value)

    parsed = from_wire(wire)
    assert type(parsed) is int
    assert parsed == value


def test_the_shared_vectors_round_trip_through_the_exact_byte_string_typescript_emits() -> None:
    # Link 2 of the chain: `py_parse(ts_serialize(p)) == p`. money-wire.property.test.ts
    # asserts `toWire(BigInt(v.paise)) === v.wire` over this same list, so the string
    # parsed here is the string TypeScript emits.
    for vector in FIXTURE.in_range:
        value = int(vector.paise)

        # Link 3: `BigInt(py_serialize(p)) === p`, whose second half TypeScript asserts.
        assert to_wire(value) == vector.wire, f"py_serialize disagrees with {vector.vector_id}"
        # The fixture's own `wire` field is never trusted on its own.
        assert vector.wire == str(value)

        assert from_wire(vector.wire) == value, f"py_parse disagrees with {vector.vector_id}"

    assert len(FIXTURE.in_range) >= len(BOUNDARY_CONSTANTS)


# ---------------------------------------------------------------------------
# The range guard, asserted as its own fact
# ---------------------------------------------------------------------------


@seed(P15_SEED)
@settings(max_examples=MAX_EXAMPLES, deadline=None, print_blob=True)
@given(out_of_range_paise)
def test_to_wire_raises_rather_than_emitting_a_string_for_an_out_of_range_value(
    value: int,
) -> None:
    # Separate from the round-trip property on purpose: design.md wants the range guard
    # and the encoding guarantee asserted as two facts, because an implementation that
    # saturated at PAISE_MAX would satisfy the round-trip and lose the figure.
    assert value > PAISE_MAX or value < PAISE_MIN

    with pytest.raises(WireError, match="out of paise range"):
        to_wire(value)


def test_a_well_formed_string_past_each_extreme_is_rejected_on_the_way_in_and_out() -> None:
    for vector in FIXTURE.out_of_range:
        value = int(vector.paise)
        assert value > PAISE_MAX or value < PAISE_MIN, f"{vector.vector_id} is inside the range"

        # The format guard passes and the range guard fails. TypeScript tells the two
        # apart by error class; Python raises one WireError, so the message separates them.
        with pytest.raises(WireError, match="out of paise range"):
            to_wire(value)
        with pytest.raises(WireError, match="out of paise range"):
            from_wire(vector.paise)


# ---------------------------------------------------------------------------
# Above 2^53 — its own named test, not left to the generator
# ---------------------------------------------------------------------------


@seed(P15_SEED)
@settings(max_examples=MAX_EXAMPLES, deadline=None, print_blob=True)
@given(above_two_pow_53_paise)
def test_the_range_free_pair_round_trips_every_generated_magnitude_above_two_pow_53(
    magnitude: int,
) -> None:
    assert magnitude >= TWO_POW_53
    # The range guard rejects these by design, which is the whole reason the range-free
    # pair exists rather than a second range.
    with pytest.raises(WireError, match="out of paise range"):
        to_wire(magnitude)

    for value in (magnitude, -magnitude):
        wire = encode_paise(value)
        assert wire == str(value)
        assert decode_paise(wire) == value
        # The assertion a JSON-number implementation fails: the digits survive a
        # magnitude an IEEE-754 double cannot hold.
        assert int(wire) == value


def test_the_shared_above_two_pow_53_vectors_round_trip_including_two_pow_53_plus_one() -> None:
    # 2^53 + 1 is the first integer a double cannot represent:
    # `JSON.parse('9007199254740993')` yields 9007199254740992. Committed as a vector so
    # the fast-check suite asserts the same digits.
    ids = {vector.vector_id for vector in FIXTURE.above_two_pow_53}
    assert "two_pow_53_plus_one" in ids
    assert "unrounded_rate_product" in ids

    for vector in FIXTURE.above_two_pow_53:
        value = int(vector.paise)
        assert abs(value) >= TWO_POW_53, f"{vector.vector_id} is not above 2^53"

        assert encode_paise(value) == vector.wire, f"encode disagrees with {vector.vector_id}"
        assert decode_paise(vector.wire) == value, f"decode disagrees with {vector.vector_id}"
        assert vector.wire == str(value)

        # What a JSON-number implementation would have done to the same value, stated so
        # the failure mode this test exists for is visible rather than implied.
        if vector.vector_id == "two_pow_53_plus_one":
            assert int(float(vector.wire)) != value


# ---------------------------------------------------------------------------
# Malformed payload rejection, per _paise field
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("payload", FIXTURE.payloads, ids=lambda payload: payload.payload_id)
def test_every_shared_base_payload_is_accepted_unmodified(payload: _Payload) -> None:
    # The control. Eight rejections mean nothing if the base payload was already invalid:
    # the suite would be green because everything fails, which is the failure mode that
    # looks most like success. This also checks the fixture is a payload BOTH runtimes
    # accept, since money-wire.property.test.ts asserts the same bodies.
    _validate(payload.python_model, payload.body)


def test_the_fixture_pokes_every_paise_field_the_field_typing_audit_finds() -> None:
    # "Per `_paise` field" is only true if the field list is complete. The audit walker
    # from task 29.3 is the independent enumeration, so a monetary field added to a
    # transport model without a fixture path fails here.
    audited = {
        leaf.field for entry in TRANSPORT_MODELS for leaf in paise_leaves_of(entry)
    }
    poked = {target.field for payload in FIXTURE.payloads for target in payload.paise_paths}

    assert poked == audited
    assert len(audited) > 0


def test_the_fixture_states_all_eight_malformed_cases() -> None:
    # The eight design.md names, one each: a JSON number, a JSON float, a numeric string
    # with a decimal point, one with leading whitespace, one with a leading plus sign, a
    # non-numeric string, `null`, and a nested object.
    assert len(FIXTURE.malformed) == 8
    assert {case.case_id for case in FIXTURE.malformed} == {
        "a_json_number",
        "a_json_float",
        "a_numeric_string_with_a_decimal_point",
        "a_numeric_string_with_leading_whitespace",
        "a_numeric_string_with_a_leading_plus_sign",
        "a_non_numeric_string",
        "null",
        "a_nested_object",
    }


@pytest.mark.parametrize("case", _MALFORMED_CASES, ids=_malformed_case_id)
def test_a_malformed_paise_field_is_a_schema_violation_naming_the_field(
    case: tuple[_Payload, _PaisePath, _MalformedCase],
) -> None:
    payload, target, malformed = case
    body = _with_value_at(payload.body, target.path, _malformed_value(malformed))

    if malformed.accepted_when_nullable and target.nullable:
        # `None` in a nullable monetary field is a stated absence, not a violation: an
        # EvidenceStep that compared rather than computed has no figure, and the wire
        # says so. Asserting rejection here would be asserting a bug.
        _validate(payload.python_model, body)
        return

    with pytest.raises(ValidationError) as caught:
        _validate(payload.python_model, body)

    locations = _locations(caught.value)
    assert any(target.field in location for location in locations), (
        f"no error named {target.field}; locations were {locations}"
    )


@pytest.mark.parametrize("case", FIXTURE.malformed, ids=lambda case: case.case_id)
def test_from_wire_rejects_every_malformed_value_at_the_helper_too(case: _MalformedCase) -> None:
    # The model guards a payload; `from_wire` guards every other call site. Both, because
    # a value can reach `from_wire` from a source that never went through a model.
    value = _malformed_value(case)

    with pytest.raises(WireError, match="is not an integer string") as caught:
        from_wire(cast("PaiseWire", value), "figure_paise")

    assert caught.value.field == "figure_paise"
