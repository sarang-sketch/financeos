"""Hypothesis profiles for the FinanceOS property suite.

Hypothesis registers profiles through its Python API rather than through a
``pyproject.toml`` table, so this conftest is the one place they live. Everything
else the Python stack configures — pytest, ruff, mypy — is in ``pyproject.toml``.

design.md, Property-based tests: every property test runs with an explicit seed in
CI so a failure is reproducible, at a minimum of 100 iterations and 1000 for P1,
P3, P11 and P12. ``derandomize`` is the seed discipline: it fixes the seed from
the test source, so a CI failure reproduces locally from the same commit.

Select a profile with ``HYPOTHESIS_PROFILE``; ``CI`` picks ``ci`` by default.
"""

import os

from hypothesis import Verbosity, settings

MINIMUM_EXAMPLES = 100
THOROUGH_EXAMPLES = 1000

settings.register_profile(
    "dev",
    max_examples=MINIMUM_EXAMPLES,
    deadline=None,
    print_blob=True,
)
settings.register_profile(
    "ci",
    max_examples=MINIMUM_EXAMPLES,
    deadline=None,
    print_blob=True,
    derandomize=True,
)
settings.register_profile(
    # For P12 and P15, which design.md holds to 1000 iterations.
    "thorough",
    max_examples=THOROUGH_EXAMPLES,
    deadline=None,
    print_blob=True,
    derandomize=True,
)
settings.register_profile(
    "debug",
    max_examples=MINIMUM_EXAMPLES,
    deadline=None,
    print_blob=True,
    verbosity=Verbosity.verbose,
)

settings.load_profile(
    os.environ.get("HYPOTHESIS_PROFILE") or ("ci" if os.environ.get("CI") else "dev")
)
