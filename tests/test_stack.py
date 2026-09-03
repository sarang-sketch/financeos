"""The Python runtime's package tree and test stack are wired as design.md describes.

A structural test rather than a behavioural one: it asserts the four subpackages the
Python side owns are importable, that the package ships its typing marker so mypy
checks callers against real annotations instead of ``Any``, and that the Hypothesis
profile the property suite depends on is loaded.

Validates: Requirements 15.1, 15.8
"""

import importlib
from pathlib import Path

import pytest
from hypothesis import settings

import financeos

SUBPACKAGES = ("agents", "ai", "validator", "wire")

MINIMUM_EXAMPLES = 100


@pytest.mark.parametrize("subpackage", SUBPACKAGES)
def test_runtime_subpackage_imports(subpackage: str) -> None:
    module = importlib.import_module(f"financeos.{subpackage}")

    assert module.__doc__, f"financeos.{subpackage} should say what it owns"


def test_package_ships_a_typing_marker() -> None:
    package_root = Path(financeos.__file__).parent

    assert (package_root / "py.typed").is_file()


def test_hypothesis_profile_meets_the_minimum_iteration_count() -> None:
    """design.md holds every property test to at least 100 iterations."""
    assert settings().max_examples >= MINIMUM_EXAMPLES
    assert settings().deadline is None, "a deadline would flake the database-free suite"
