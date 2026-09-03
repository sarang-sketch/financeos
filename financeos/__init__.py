"""FinanceOS Control Tower — Python runtime.

The runtime split (design.md, Architecture) is one line: money arithmetic and
database writes are TypeScript, Model interaction and agent reasoning are Python.
This package holds the Python side and nothing else.

Two invariants hold everywhere below this package:

* Every paise value inside this process is ``int`` — arbitrary precision, exact,
  never ``float`` (Requirement 15.1, 15.8). This is the Python half of P12.
* Every paise value on the wire is a decimal ``str`` (Requirement 15.8), parsed
  at the boundary. This is P15.

There is no Postgres client here. The Python runtime reaches Tenant data only
through the internal TypeScript endpoints.

Subpackages
-----------
wire
    The money wire contract: paise encode/decode and the Pydantic transport
    models mirroring the Zod schemas in ``src/wire/``.
agents
    The Agent Engine, the seven-stage Action_Pipeline, and the six Agents.
ai
    The AI_Gateway: provider adapters, per-Task_Class routing, retry, failover,
    metering measurement and the monthly cost cap check.
validator
    FinanceOS_Response_Validator, which gates Model output against the allowed
    value set before a figure reaches a User.
"""
