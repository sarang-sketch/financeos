"""The field-typing audit, Python side (task 29.3).

design.md's money wire contract states the rule this file enforces: "Every monetary
field on the wire carries a ``_paise`` suffix and is typed ``string`` in the
transport schema. The suffix is what makes the rule mechanically checkable: the
transport schema tests can enumerate every ``_paise`` field in every payload shape
and assert its declared type is ``string``."

So this is not a test of one model. It is a test of the *set* of models, and it is
why a new monetary field typed as an ``int`` fails in CI rather than at runtime with
a rounded figure nobody can trace. ``test/transport/field-typing-audit.test.ts`` is
the same assertion against the Zod side.

The negative controls matter as much as the positive assertion. An audit that passes
because it found nothing is worse than no audit, so this file also proves the audit
**fails** on a ``_paise`` field typed ``int``, on one typed ``float``, and on a
monetary field hidden inside a ``dict``.

Placement: this sits directly under ``tests/`` rather than in ``tests/transport/``
so that CI stage 4 (``npm run py:test:unit``) collects it today. The stage-7 Python
command lands with task 29.7, which owns the rest of the cross-runtime suite.

Validates: Requirements 15.1, 15.8
"""

import pytest
from pydantic import ValidationError

from financeos.wire.fields import PaiseWireField, WireModel
from financeos.wire.metering_transport import (
    ModelRequestPayloadWire,
    ModelRequestResponseWire,
)
from financeos.wire.transport_models import (
    TRANSPORT_BOUNDARIES,
    TRANSPORT_MODELS,
    TransportModelEntry,
    TransportModelError,
    is_monetary_field_name,
    paise_field_typing_violations,
    paise_leaves_of,
    transport_leaves_of,
)

# The one registered payload that declares no monetary field at all: the Gateway
# reports token counts and latency, and TypeScript computes the price.
MONEY_FREE_BY_DESIGN = "POST /internal/model-requests (request)"


def entry_for(annotation: object) -> tuple[TransportModelEntry, ...]:
    """A registry of one, so a negative control is audited exactly as the real one is."""
    return (
        TransportModelEntry(
            name="specimen",
            boundary="tool",
            direction="to_python",
            annotation=annotation,
        ),
    )


def find(name: str) -> TransportModelEntry:
    return next(entry for entry in TRANSPORT_MODELS if entry.name == name)


class TestEveryPaiseFieldIsStr:
    def test_no_violation_across_the_registry(self) -> None:
        assert paise_field_typing_violations() == []

    def test_each_of_the_three_boundaries_is_covered(self) -> None:
        # An empty registry, or one that quietly lost a boundary, would satisfy the
        # assertion above by finding nothing. design.md names three places money
        # crosses; each must be represented or the audit is not auditing them.
        for boundary in TRANSPORT_BOUNDARIES:
            covered = [entry for entry in TRANSPORT_MODELS if entry.boundary == boundary]
            assert covered, f"no transport model registered for the {boundary} boundary"

    def test_every_model_but_one_declares_a_monetary_field(self) -> None:
        # A model with no `_paise` field is audited vacuously, so each one has to be
        # accounted for. There is exactly one, and its emptiness is the contract: a
        # body carrying `cost_paise` is a rejected extra key rather than a field with
        # a wrong type (Requirement 11.8).
        assert any(entry.name == MONEY_FREE_BY_DESIGN for entry in TRANSPORT_MODELS)

        for entry in TRANSPORT_MODELS:
            found = paise_leaves_of(entry)
            if entry.name == MONEY_FREE_BY_DESIGN:
                assert found == [], f"{entry.name} declares a monetary field it must not"
            else:
                assert found, f"{entry.name} declares no _paise field"

    def test_reaches_the_figure_and_every_step_result_in_the_envelope(self) -> None:
        paths = [leaf.path for leaf in paise_leaves_of(find(
            "ToolResult<PostReconciliationAdjustmentOutput> (response)"
        ))]

        # The success branch of the union is `|0`, matching the Zod side's path.
        assert "|0.evidence.figure_paise" in paths
        assert "|0.evidence.steps[].result_paise" in paths
        assert "|0.value.total_debit_paise" in paths
        assert "|0.value.total_credit_paise" in paths

    def test_reaches_the_allowed_value_set_the_validator_compares_against(self) -> None:
        leaves = paise_leaves_of(find("ResponseValidator.validate (request)"))

        # The leaf is the list *element*; the name that carries the suffix is the
        # field itself, which is what the audit keys on.
        assert [leaf.path for leaf in leaves] == ["allowed_values_paise[]"]
        assert leaves[0].field == "allowed_values_paise"
        assert leaves[0].type_name == "str"

    def test_reaches_both_metering_payloads(self) -> None:
        paths = [
            leaf.path
            for entry in TRANSPORT_MODELS
            if entry.boundary == "metering"
            for leaf in paise_leaves_of(entry)
        ]

        assert set(paths) == {"cap_paise", "month_to_date_paise", "cost_paise"}


class TestTheAuditFails:
    def test_rejects_a_paise_field_declared_int(self) -> None:
        class IntPaise(WireModel):
            settlement_total_paise: int

        findings = paise_field_typing_violations(entry_for(IntPaise))

        assert len(findings) == 1
        assert "settlement_total_paise is declared int" in findings[0]

    def test_rejects_a_paise_field_declared_float(self) -> None:
        class FloatPaise(WireModel):
            impact_paise: float

        findings = paise_field_typing_violations(entry_for(FloatPaise))

        assert len(findings) == 1
        assert "is declared float" in findings[0]

    def test_reports_every_offending_field_not_just_the_first(self) -> None:
        class Nested(WireModel):
            c_paise: int

        class Outer(WireModel):
            a_paise: int
            b_paise: int
            nested: Nested

        assert len(paise_field_typing_violations(entry_for(Outer))) == 3

    def test_finds_a_monetary_field_under_a_list_a_union_and_an_optional(self) -> None:
        class Good(WireModel):
            kind: str
            amount_paise: PaiseWireField

        class Bad(WireModel):
            kind: int
            amount_paise: int | None

        class Rows(WireModel):
            rows: list[Good | Bad]

        findings = paise_field_typing_violations(entry_for(Rows))

        assert len(findings) == 1
        assert "rows[]|1.amount_paise" in findings[0]


class TestTheWalkFailsClosed:
    def test_refuses_a_mapping_whose_contents_it_cannot_enumerate(self) -> None:
        # `dict[str, int]` could hold `figure_paise` at runtime with nothing in the
        # declaration to enumerate. Refusing is the only honest answer.
        class Cells(WireModel):
            cells: dict[str, int]

        with pytest.raises(TransportModelError, match="cannot enumerate"):
            transport_leaves_of(Cells, "specimen")

    def test_refuses_a_bare_mapping_rather_than_recording_it_as_a_leaf(self) -> None:
        # The terminal types are an allowlist, so an unparameterised `dict` is
        # refused too. Recording it as a leaf named `dict` would let a monetary field
        # inside it go unenumerated while the audit reported success.
        class BareCells(WireModel):
            cells: dict  # type: ignore[type-arg]

        with pytest.raises(TransportModelError, match="cannot enumerate"):
            transport_leaves_of(BareCells, "specimen")

    def test_visits_a_shared_alias_once_per_path(self) -> None:
        # `PaiseWireField` is one shared alias. Deduplicating by identity would find
        # the first field and silently skip the rest — the failure mode that would
        # make this whole audit look green while checking one field.
        class Two(WireModel):
            first_paise: PaiseWireField
            second_paise: PaiseWireField

        leaves = transport_leaves_of(Two, "specimen")

        assert [leaf.path for leaf in leaves] == ["first_paise", "second_paise"]


class TestTheSuffixRule:
    @pytest.mark.parametrize("name", ["figure_paise", "allowed_values_paise", "a_paise"])
    def test_matches_a_monetary_field_name(self, name: str) -> None:
        assert is_monetary_field_name(name)

    @pytest.mark.parametrize("name", ["paise", "paise_figure", "latency_ms", "count"])
    def test_does_not_match_anything_else(self, name: str) -> None:
        assert not is_monetary_field_name(name)


class TestTheWireRejectsANumber:
    """One assertion, not the matrix — task 29.7 owns the full rejection grid.

    It is here because the audit above proves the *declaration* is ``str`` and this
    proves the declaration is enforced: a ``str`` field that pydantic quietly
    coerced an ``int`` into would pass the audit and lose the guarantee.
    """

    def test_a_json_number_in_a_paise_field_is_a_validation_error(self) -> None:
        payload = {
            "model_request_id": "3f2b1c9d-4a5e-4b7c-8d9e-0f1a2b3c4d5e",
            "cost_paise": 84260000,
        }

        with pytest.raises(ValidationError, match="cost_paise"):
            ModelRequestResponseWire.model_validate(payload)


def test_the_metering_request_declares_no_cost_field() -> None:
    """Cost is computed server-side, so the payload has no field for it to arrive in."""
    assert "cost_paise" not in ModelRequestPayloadWire.model_fields
