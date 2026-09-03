"""Agent Engine — Runs the 7-stage Action_Pipeline.

Requirements: 5.1, 5.2, 13.7, 15.4, 15.6
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final, Literal

StageName = Literal[
    "DETECT",
    "INVESTIGATE",
    "EXPLAIN",
    "PROPOSE",
    "AUTHORIZE",
    "EXECUTE",
    "VERIFY",
]

STAGE_ORDER: Final[list[StageName]] = [
    "DETECT",
    "INVESTIGATE",
    "EXPLAIN",
    "PROPOSE",
    "AUTHORIZE",
    "EXECUTE",
    "VERIFY",
]


@dataclass(frozen=True)
class StageOutcome:
    stage: StageName
    outcome: Literal["succeeded", "failed", "blocked"]
    at: str
    detail: dict[str, str] | None = None


@dataclass(frozen=True)
class AgentRunResult:
    run_id: str
    agent_name: str
    tenant_id: str
    complete: bool
    stage_outcomes: list[StageOutcome]
    unprocessed_source_types: list[str]
    exceptions_upserted: list[str]
    proposals: list[str]


class AgentEngine:
    """Orchestrates stage progression through the Action_Pipeline."""

    def __init__(self, max_concurrent_runs: int = 5) -> None:
        self._max_concurrent = max_concurrent_runs
        self._active_runs: dict[str, int] = {}  # tenant_id -> count

    async def execute_stage(
        self,
        stage: StageName,
        tenant_id: str,
        handler: Callable[[], object] | None = None,
    ) -> StageOutcome:
        """Run a single stage handler and record audit timestamp."""
        now_str = datetime.now(UTC).isoformat()
        try:
            res = await handler() if callable(handler) else None  # type: ignore[misc]
            detail_map: dict[str, str] = {"tenant_id": tenant_id}
            if res is not None:
                detail_map["result"] = str(res)
            return StageOutcome(
                stage=stage,
                outcome="succeeded",
                at=now_str,
                detail=detail_map,
            )
        except Exception as exc:
            return StageOutcome(
                stage=stage,
                outcome="failed",
                at=now_str,
                detail={"tenant_id": tenant_id, "error": str(exc)},
            )
