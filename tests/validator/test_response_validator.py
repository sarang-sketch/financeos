"""Adversarial and functional test suite for ResponseValidator (Requirements 11.10, 11.11, 12.6)."""

from financeos.validator.response_validator import ResponseValidator
from financeos.wire.validator_transport import UngroundedFigureWire, ValidationReleasedWire


def test_validator_releases_grounded_exact_figures() -> None:
    validator = ResponseValidator()
    # ₹1,500.00 = 150000 paise; ₹200 = 20000 paise
    allowed = ["150000", "20000"]
    narrative = "The fee was ₹1,500.00 and the GST was ₹200."
    res = validator.validate(narrative, allowed, [])

    assert isinstance(res, ValidationReleasedWire)
    assert res.ok is True
    assert res.released == narrative


def test_validator_withholds_ungrounded_fabricated_figure() -> None:
    validator = ResponseValidator()
    allowed = ["150000"]
    # ₹1,500.01 is fabricated by 1 paisa
    narrative = "The fee was ₹1,500.01."
    res = validator.validate(narrative, allowed, [])

    assert isinstance(res, UngroundedFigureWire)
    assert res.ok is False
    assert res.kind == "ungrounded_figure"
    assert res.parsed_paise == "150001"


def test_validator_handles_lakh_and_crore() -> None:
    validator = ResponseValidator()
    # 3.82 Cr = 38,200,000 INR = 3,820,000,000 paise
    allowed = ["3820000000"]
    narrative = "Total revenue reached 3.82 Cr during the fiscal year."
    res = validator.validate(narrative, allowed, [])

    assert isinstance(res, ValidationReleasedWire)
    assert res.ok is True


def test_validator_withholds_unresolved_chain() -> None:
    chain_id = "11111111-1111-4111-8111-111111111111"
    validator = ResponseValidator(resolvable_evidence_chain_ids=set())
    res = validator.validate("Revenue was ₹100.", ["10000"], [chain_id])

    assert res.ok is False
    assert res.kind == "unresolved_evidence_chain"
