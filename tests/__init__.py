"""FinanceOS Python test suite.

The subdirectories map onto design.md's CI stages:

* ``tests/`` root — unit tests, CI stage 4.
* ``tests/transport/`` — transport schema and wire round-trip tests, CI stage 7.
* ``tests/property/`` — the Hypothesis half of P1..P15, CI stage 8.

These are regular packages rather than rootdir-relative test files so that a
module name may repeat across stages, e.g. a ``test_money_wire.py`` under both
``property/`` and ``transport/``.
"""
