"""The mypy configuration is strict enough to reject float money and int wire fields.

design.md, CI ordering and merge gates: on the Python side mypy carries less weight
for money than on the TypeScript side — ``int`` is already exact — but it is what
catches a ``float`` annotation on a paise field and a ``_paise`` field typed as
``int`` in a transport model where it must be ``str``.

Those two rejections are a property of the ``[tool.mypy]`` configuration in
``pyproject.toml``, not of any one module, so they are asserted here against that
config directly. Loosening the config to let float money back in fails this test,
which is the point: the guarantee is checked rather than assumed.

Validates: Requirements 15.1, 15.8
"""

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = REPO_ROOT / "pyproject.toml"

# A paise field annotated `float`. Every paise value in this runtime is `int`
# (Requirement 15.1), and `float` is not assignable to `int` — the numeric tower
# promotes `int` to `float`, never the reverse — so the annotation fails the moment
# the value reaches an encoder.
FLOAT_PAISE_FIELD = '''\
"""A paise field annotated float."""

PaiseWire = str


def to_wire(value: int) -> PaiseWire:
    return str(value)


class SettlementFigure:
    difference_paise: float


def serialise(figure: SettlementFigure) -> PaiseWire:
    return to_wire(figure.difference_paise)
'''

# A `_paise` field annotated `int` in a transport model. On the wire a paise value
# is a decimal string (Requirement 15.8), so the field must be `str` and the `int`
# is parsed out of it at the boundary.
INT_PAISE_WIRE_FIELD = '''\
"""A _paise field annotated int in a transport model."""

from pydantic import BaseModel

PaiseWire = str


def from_wire(raw: PaiseWire) -> int:
    return int(raw)


class ToolResultEnvelope(BaseModel):
    figure_paise: int


def read_figure(envelope: ToolResultEnvelope) -> int:
    return from_wire(envelope.figure_paise)
'''

# The same two shapes annotated correctly: `str` on the wire, `int` in memory.
# Without this control the two rejections above could come from a broken config
# rather than from the annotations under test.
CORRECT_PAISE_TYPING = '''\
"""str on the wire, int in memory."""

from pydantic import BaseModel

PaiseWire = str


def from_wire(raw: PaiseWire) -> int:
    return int(raw)


def to_wire(value: int) -> PaiseWire:
    return str(value)


class ToolResultEnvelope(BaseModel):
    figure_paise: PaiseWire


def read_figure(envelope: ToolResultEnvelope) -> int:
    return from_wire(envelope.figure_paise)


def build(value: int) -> ToolResultEnvelope:
    return ToolResultEnvelope(figure_paise=to_wire(value))
'''


@pytest.fixture(scope="session")
def mypy_cache_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """One cache shared by every check in this module, so only the first pays setup."""
    return tmp_path_factory.mktemp("mypy-cache")


def check_with_project_config(source: str, workspace: Path, cache_dir: Path) -> str:
    """Type check one snippet under the committed mypy configuration."""
    module = workspace / "snippet.py"
    module.write_text(source, encoding="utf-8")
    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, sys.executable
        [
            sys.executable,
            "-m",
            "mypy",
            "--config-file",
            str(PYPROJECT),
            "--cache-dir",
            str(cache_dir),
            str(module),
        ],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=False,
    )
    return completed.stdout + completed.stderr


def test_float_annotation_on_a_paise_field_is_rejected(
    tmp_path: Path, mypy_cache_dir: Path
) -> None:
    output = check_with_project_config(FLOAT_PAISE_FIELD, tmp_path, mypy_cache_dir)

    assert "[arg-type]" in output, output
    assert '"float"' in output, output
    assert "Success" not in output, output


def test_int_annotation_on_a_paise_wire_field_is_rejected(
    tmp_path: Path, mypy_cache_dir: Path
) -> None:
    output = check_with_project_config(INT_PAISE_WIRE_FIELD, tmp_path, mypy_cache_dir)

    assert "[arg-type]" in output, output
    assert '"int"' in output, output
    assert "Success" not in output, output


def test_correct_paise_typing_is_accepted(tmp_path: Path, mypy_cache_dir: Path) -> None:
    output = check_with_project_config(CORRECT_PAISE_TYPING, tmp_path, mypy_cache_dir)

    assert "Success" in output, output
