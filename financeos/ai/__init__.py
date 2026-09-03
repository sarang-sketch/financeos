"""The AI_Gateway — the only component that talks to a Model_Provider.

It observes and reports what only it can see, token counts and elapsed latency,
and receives a computed ``cost_paise`` back from the TypeScript metering
endpoint. It holds no rate table, computes no cost, and opens no database
connection.
"""
