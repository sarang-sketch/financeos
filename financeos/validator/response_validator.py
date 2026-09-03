"""FinanceOS_Response_Validator implementation (Requirements 11.10, 11.11, 12.6).

Extracts monetary tokens from LLM narrative, normalises them to exact integer paise,
and validates that every figure is grounded in the allowed value set.
"""

import re
from collections.abc import Sequence
from decimal import Decimal

from financeos.wire.paise import PaiseWire, from_wire, to_wire
from financeos.wire.validator_transport import (
    MAX_RELEASED_CHARS,
    UngroundedFigureWire,
    UnresolvedEvidenceChainWire,
    ValidationReleasedWire,
    ValidationResultWire,
)

# Regexes for Indian currency extraction
# Matches ₹1,234.56, ₹ 100, ₹50.00, Rs. 100, Rs 50, etc.
INR_SYMBOL_PATTERN = re.compile(
    r"(?:₹|Rs\.?|INR)\s*([0-9]+(?:,[0-9]+)*(?:\.[0-9]{1,2})?)\s*(lakhs?|crores?|cr|l|k)?",
    re.IGNORECASE,
)

# Matches bare numbers with lakh/crore: 3.82 Cr, 8.4 lakh, 10 crore
LAKH_CRORE_PATTERN = re.compile(
    r"\b([0-9]+(?:\.[0-9]+)?)\s*(lakhs?|crores?|cr)\b",
    re.IGNORECASE,
)


def parse_monetary_token_to_paise(token_str: str) -> int | None:
    """Parse a single extracted monetary string into integer paise.

    Returns None if the token cannot be parsed into a clean integer paise value.
    """
    cleaned = token_str.strip()
    # Match symbol pattern
    m_sym = INR_SYMBOL_PATTERN.search(cleaned)
    if m_sym:
        num_part = m_sym.group(1).replace(",", "")
        unit = (m_sym.group(2) or "").lower()
        return _scale_to_paise(num_part, unit)

    m_unit = LAKH_CRORE_PATTERN.search(cleaned)
    if m_unit:
        num_part = m_unit.group(1).replace(",", "")
        unit = m_unit.group(2).lower()
        return _scale_to_paise(num_part, unit)

    # Bare rupee number
    try:
        dec = Decimal(cleaned.replace(",", ""))
        # Multiply by 100 to get paise
        return int((dec * Decimal(100)).to_integral_value())
    except Exception:
        return None


def _scale_to_paise(num_str: str, unit: str) -> int | None:
    try:
        dec = Decimal(num_str)
        if unit in ("lakh", "lakhs", "l"):
            # 1 lakh = 100,000 INR = 10,000,000 paise
            return int((dec * Decimal(10_000_000)).to_integral_value())
        if unit in ("crore", "crores", "cr"):
            # 1 crore = 10,000,000 INR = 1,000,000,000 paise
            return int((dec * Decimal(1_000_000_000)).to_integral_value())
        if unit == "k":
            # 1k = 1,000 INR = 100,000 paise
            return int((dec * Decimal(100_000)).to_integral_value())
        # Default rupees -> paise
        return int((dec * Decimal(100)).to_integral_value())
    except Exception:
        return None


def extract_monetary_tokens(text: str) -> list[tuple[str, int | None]]:
    """Find all monetary references in narrative text and parse each to paise.

    Returns list of (token_text, parsed_paise).
    """
    results: list[tuple[str, int | None]] = []

    # 1. Currency symbol matches
    for match in INR_SYMBOL_PATTERN.finditer(text):
        full_token = match.group(0)
        paise = parse_monetary_token_to_paise(full_token)
        results.append((full_token, paise))

    # 2. Bare lakh / crore matches
    for match in LAKH_CRORE_PATTERN.finditer(text):
        full_token = match.group(0)
        # Avoid duplicating if already matched by symbol pattern
        if not any(full_token in t[0] for t in results):
            paise = parse_monetary_token_to_paise(full_token)
            results.append((full_token, paise))

    return results


class ResponseValidator:
    """Validator that ensures no fabricated or ungrounded monetary figures reach users."""

    def __init__(self, resolvable_evidence_chain_ids: set[str] | None = None) -> None:
        self._resolvable_chains = resolvable_evidence_chain_ids

    def validate(
        self,
        narrative: str,
        allowed_values_paise: Sequence[PaiseWire],
        evidence_chain_ids: Sequence[str],
    ) -> ValidationResultWire:
        """Validate narrative against grounded tool figures and evidence chains."""
        # 1. Check all evidence chain IDs resolve (Req 12.6)
        if self._resolvable_chains is not None:
            for chain_id in evidence_chain_ids:
                if chain_id not in self._resolvable_chains:
                    return UnresolvedEvidenceChainWire(
                        ok=False,
                        kind="unresolved_evidence_chain",
                        evidence_chain_id=chain_id,
                    )

        # Parse allowed values into frozenset of integer paise
        allowed_set = frozenset(
            from_wire(val, "allowed_values_paise") for val in allowed_values_paise
        )

        # Extract tokens from narrative
        tokens = extract_monetary_tokens(narrative)

        for token_text, parsed_paise in tokens:
            if parsed_paise is None or parsed_paise not in allowed_set:
                # Whole response withheld (Req 11.11)
                return UngroundedFigureWire(
                    ok=False,
                    kind="ungrounded_figure",
                    figure_text=token_text,
                    parsed_paise=to_wire(parsed_paise) if parsed_paise is not None else None,
                )

        # Truncate at MAX_RELEASED_CHARS (Req 11.10)
        released_narrative = narrative[:MAX_RELEASED_CHARS]

        return ValidationReleasedWire(
            ok=True,
            released=released_narrative,
        )
