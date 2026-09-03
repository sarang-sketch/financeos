"""Transport schema and wire round-trip tests, Python side (CI stage 7).

Stage 7 runs before the property stage deliberately: a wire contract failure
makes every cross-runtime property result untrustworthy, so it is cheaper to fail
here than to debug a P12 or P15 failure that turns out to be a serialization bug
two stages later.
"""
