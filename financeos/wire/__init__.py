"""The money wire contract, Python side.

``paise.py`` holds the encode and decode pair and the range guard; the transport
models mirroring the Zod schemas in ``src/wire/`` sit alongside it. Every field
whose name ends in ``_paise`` is ``str`` on the wire and ``int`` in memory
(Requirement 15.1, 15.8).
"""
