"""The Hypothesis half of the property suite (CI stage 8).

P12's paise-handling half and P15's Python direction run in-process here, with no
database and no network: the TypeScript suite owns every database-backed
property. Strategies emit ``int`` for every monetary field, which is
arbitrary-precision and so carries the same exactness guarantee as ``bigint`` on
the TypeScript side.
"""
