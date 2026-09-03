"""The transport model registry and the field-typing audit, Python side (task 29.3).

Requirements 15.1, 15.8.

The mirror of ``src/wire/transport-schemas.ts``. design.md's money wire contract
ends with the sentence this module exists to make true: every ``_paise`` field in
every payload shape is enumerated and its declared type asserted — ``string`` on
the TypeScript side, ``str`` here. The suffix is the mechanism; a naming convention
is only a convention until something reads it.

The failure this catches is cheap to commit and expensive to miss: someone adds
``settlement_total_paise: int`` to a transport model, every existing test passes,
and the value is emitted as a JSON number that ``JSON.parse`` rounds on the far
side. mypy catches the same mistake when the field is passed to ``to_wire``
(``tests/test_paise_typing_discipline.py`` asserts that it does), but only when a
call site exists. This audit needs no call site: the declaration alone fails it.

Registration is the load-bearing step
-------------------------------------

A model absent from :data:`TRANSPORT_MODELS` is not audited, so the registry is
where this discipline can be lost. Two things push back: the audit refuses an empty
registry and refuses a boundary with no entry, so deleting coverage fails loudly
rather than passing vacuously; and every entry names the boundary it belongs to, so
design.md's three places money crosses are visible as three groups.

The walk fails closed
---------------------

An annotation this walk cannot enumerate raises :class:`TransportModelError` rather
than being skipped. A ``dict[str, object]`` field could hold ``figure_paise`` at
runtime with nothing in the declaration to enumerate, and an audit that quietly
stopped finding fields would be worse than no audit at all.

Scope
-----

This module holds no assertions; ``tests/test_transport_field_typing_audit.py``
runs it. Cross-runtime **parity** — every field the TypeScript schema declares being
present in the Python model — is task 29.7, which owns the shared fixture vectors
both sides read.
"""

import types
import typing
from dataclasses import dataclass
from typing import Annotated, Final, Literal, get_args, get_origin

from pydantic import BaseModel

from financeos.wire.metering_transport import (
    ModelCostCapResponseWire,
    ModelRequestPayloadWire,
    ModelRequestResponseWire,
)
from financeos.wire.tool_transport import (
    EvidenceChainWire,
    PostReconciliationAdjustmentInputWire,
    PostReconciliationAdjustmentResultWire,
)
from financeos.wire.validator_transport import (
    ResponseValidatorRequestWire,
    ValidationResultWire,
)

# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------

#: design.md's three places money crosses TypeScript<->Python.
TransportBoundary = Literal["tool", "validator", "metering"]

TRANSPORT_BOUNDARIES: Final[tuple[str, ...]] = get_args(TransportBoundary)

TransportDirection = Literal["to_python", "to_typescript"]


class TransportModelError(TypeError):
    """A transport model declares something this audit cannot enumerate."""


@dataclass(frozen=True, slots=True)
class TransportModelEntry:
    """One registered payload shape.

    ``annotation`` is a model class or a union of them — ``ToolResult<Out>`` and
    ``ValidationResult`` are unions, so the registry holds annotations rather than
    only :class:`~pydantic.BaseModel` subclasses.
    """

    name: str
    boundary: TransportBoundary
    direction: TransportDirection
    annotation: object


#: Every payload shape that crosses the runtime boundary, in the same order and
#: under the same names as ``TRANSPORT_SCHEMAS`` in ``src/wire/transport-schemas.ts``.
TRANSPORT_MODELS: Final[tuple[TransportModelEntry, ...]] = (
    TransportModelEntry(
        name="POST /internal/tools/post_reconciliation_adjustment (request)",
        boundary="tool",
        direction="to_typescript",
        annotation=PostReconciliationAdjustmentInputWire,
    ),
    TransportModelEntry(
        name="ToolResult<PostReconciliationAdjustmentOutput> (response)",
        boundary="tool",
        direction="to_python",
        annotation=PostReconciliationAdjustmentResultWire,
    ),
    TransportModelEntry(
        name="EvidenceChain (embedded in every successful ToolResult)",
        boundary="tool",
        direction="to_python",
        annotation=EvidenceChainWire,
    ),
    TransportModelEntry(
        name="ResponseValidator.validate (request)",
        boundary="validator",
        direction="to_python",
        annotation=ResponseValidatorRequestWire,
    ),
    TransportModelEntry(
        name="ValidationResult (response)",
        boundary="validator",
        direction="to_typescript",
        annotation=ValidationResultWire,
    ),
    TransportModelEntry(
        name="GET /internal/model-cost-cap (response)",
        boundary="metering",
        direction="to_python",
        annotation=ModelCostCapResponseWire,
    ),
    TransportModelEntry(
        name="POST /internal/model-requests (request)",
        boundary="metering",
        direction="to_typescript",
        annotation=ModelRequestPayloadWire,
    ),
    TransportModelEntry(
        name="POST /internal/model-requests (response)",
        boundary="metering",
        direction="to_python",
        annotation=ModelRequestResponseWire,
    ),
)


# ---------------------------------------------------------------------------
# The walk
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TransportLeaf:
    """One leaf of a transport model: an annotation with no further model inside it."""

    #: Dotted, ``[]`` for a sequence element, ``|n`` for a union branch.
    path: str
    #: The nearest enclosing model field name — the name that carries the suffix.
    #:
    #: ``allowed_values_paise`` is the case this exists for: its leaf is the list's
    #: element, at path ``allowed_values_paise[]``, and the field name is still
    #: ``allowed_values_paise``.
    field: str
    #: The declared type at the leaf: ``str``, ``int``, ``bool``, ``Literal``, ``None``.
    type_name: str


_NONE_TYPE: Final[type] = type(None)
_SEQUENCE_ORIGINS: Final[tuple[type, ...]] = (list, tuple, set, frozenset)

# A genuinely recursive annotation whose cycle the path stack misses.
_MAX_WALK_DEPTH: Final[int] = 64


def _is_union(origin: object) -> bool:
    """True for both union spellings: ``X | Y`` and ``typing.Union[X, Y]``."""
    return origin is types.UnionType or origin is typing.Union


#: The terminal types a transport model may declare. An allowlist rather than
#: "anything that is a class", so a ``dict`` field — whose keys are supplied by the
#: sender and whose contents this walk cannot enumerate — is refused rather than
#: recorded as a leaf named ``dict``. Extending this list is a deliberate act.
_TERMINAL_TYPES: Final[tuple[type, ...]] = (str, int, float, bool, bytes, _NONE_TYPE)


def _is_model(annotation: object) -> bool:
    return isinstance(annotation, type) and issubclass(annotation, BaseModel)


def _leaf_type_name(annotation: object) -> str | None:
    """The declared type name for a terminal annotation, or ``None`` if it is not one."""
    if annotation is _NONE_TYPE:
        return "None"
    if isinstance(annotation, type) and annotation in _TERMINAL_TYPES:
        return annotation.__name__
    if get_origin(annotation) is Literal:
        return "Literal"
    return None


class _Walk:
    """One traversal. A class only so the accumulator and the cycle stack stay together."""

    def __init__(self, model_name: str) -> None:
        self._name = model_name
        self._leaves: list[TransportLeaf] = []
        self._on_path: list[object] = []

    def refuse(self, path: str, why: str) -> TransportModelError:
        where = path or "(root)"
        message = f"{self._name}: {where} {why} (Requirement 15.1, 15.8)"
        return TransportModelError(message)

    def run(self, annotation: object) -> list[TransportLeaf]:
        self._visit(annotation, "", "", 0)
        return self._leaves

    def _visit(self, annotation: object, path: str, field: str, depth: int) -> None:
        if depth > _MAX_WALK_DEPTH:
            raise self.refuse(path, f"is nested deeper than {_MAX_WALK_DEPTH} levels")
        if any(held is annotation for held in self._on_path):
            # A recursive annotation. Recorded once on the way in; the cycle adds no
            # field this walk has not already seen.
            return
        self._on_path.append(annotation)
        try:
            self._dispatch(annotation, path, field, depth)
        finally:
            self._on_path.pop()

    def _dispatch(self, annotation: object, path: str, field: str, depth: int) -> None:
        if get_origin(annotation) is Annotated:
            # The metadata is a constraint, not a type. pydantic strips it from a
            # top-level field annotation; inside a union or a list it stays.
            self._visit(get_args(annotation)[0], path, field, depth + 1)
            return

        if _is_model(annotation):
            self._visit_model(annotation, path, depth)
            return

        leaf = _leaf_type_name(annotation)
        if leaf is not None:
            self._leaves.append(TransportLeaf(path=path, field=field, type_name=leaf))
            return

        origin = get_origin(annotation)
        if _is_union(origin):
            self._visit_union(get_args(annotation), path, field, depth)
            return
        if origin in _SEQUENCE_ORIGINS:
            self._visit_sequence(get_args(annotation), path, field, depth)
            return

        raise self.refuse(
            path,
            f"is declared {annotation!r}, whose contents this audit cannot enumerate, "
            f"so a monetary field inside it would go unchecked",
        )

    def _visit_model(self, annotation: object, path: str, depth: int) -> None:
        fields = typing.cast("type[BaseModel]", annotation).model_fields
        for name, info in fields.items():
            child_path = name if path == "" else f"{path}.{name}"
            # `info.annotation` is the declared type with any top-level `Annotated`
            # metadata lifted into `info.metadata`. The metadata is a constraint, not
            # a type, so the audit reads the annotation alone — and the walk still
            # handles `Annotated` because pydantic leaves it in place inside a union
            # or a list.
            self._visit(info.annotation, child_path, name, depth + 1)

    def _visit_union(
        self, args: tuple[object, ...], path: str, field: str, depth: int
    ) -> None:
        members = [arg for arg in args if arg is not _NONE_TYPE]
        if len(members) == 1:
            # `X | None` is a nullable wrapper, matching Zod's `.nullable()`. The path
            # does not change, so the two runtimes report the same field path.
            self._visit(members[0], path, field, depth + 1)
            return
        for index, member in enumerate(members):
            self._visit(member, f"{path}|{index}", field, depth + 1)

    def _visit_sequence(
        self, args: tuple[object, ...], path: str, field: str, depth: int
    ) -> None:
        # `tuple[X, ...]` carries an Ellipsis arg, which is not an annotation.
        for arg in args:
            if arg is Ellipsis:
                continue
            self._visit(arg, f"{path}[]", field, depth + 1)


def transport_leaves_of(annotation: object, model_name: str) -> list[TransportLeaf]:
    """Every leaf of one transport model, in walk order.

    Shared annotations are visited once per path rather than once per object:
    ``PaiseWireField`` is one shared alias, so deduplicating by identity would find
    the first monetary field and silently skip every other one.

    :raises TransportModelError: for an annotation the walk cannot enumerate.
    """
    return _Walk(model_name).run(annotation)


# ---------------------------------------------------------------------------
# The field-typing audit
# ---------------------------------------------------------------------------

#: The one declared type a monetary field on the wire may have.
PAISE_WIRE_TYPE_NAME: Final[str] = "str"


def is_monetary_field_name(field: str) -> bool:
    """design.md's mechanically checkable rule: money on the wire is named ``*_paise``."""
    return field.endswith("_paise")


def paise_leaves_of(entry: TransportModelEntry) -> list[TransportLeaf]:
    """Every monetary leaf of one registered model."""
    leaves = transport_leaves_of(entry.annotation, entry.name)
    return [leaf for leaf in leaves if is_monetary_field_name(leaf.field)]


def paise_field_typing_violations(
    entries: tuple[TransportModelEntry, ...] = TRANSPORT_MODELS,
) -> list[str]:
    """One message per monetary field whose declared wire type is not ``str``.

    Returns findings rather than raising so a single run reports every offending
    field at once: a reviewer who typed three new fields as ``int`` should see three
    names, not the first one.
    """
    return [
        _violation(entry, leaf)
        for entry in entries
        for leaf in paise_leaves_of(entry)
        if leaf.type_name != PAISE_WIRE_TYPE_NAME
    ]


def _violation(entry: TransportModelEntry, leaf: TransportLeaf) -> str:
    return (
        f"{entry.name}: {leaf.path} is declared {leaf.type_name}; every monetary "
        f"field on the wire is a decimal string, because JSON.parse produces a "
        f"double for every numeric literal (Requirement 15.1, 15.8)"
    )
