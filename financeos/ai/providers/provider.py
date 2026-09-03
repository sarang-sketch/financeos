"""Model_Provider adapter Protocol and result types (Requirements 11.1..11.8)."""

from dataclasses import dataclass
from typing import Literal, Protocol

ProviderFailureReason = Literal["rate_limit", "timeout", "provider_error", "unauthorized"]


@dataclass(frozen=True)
class ProviderAttempt:
    provider: str
    model_name: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    outcome: Literal["succeeded", "failed"]
    failure_reason: ProviderFailureReason | None = None
    error_message: str | None = None


@dataclass(frozen=True)
class CompletionResult:
    content: str
    provider: str
    resolved_model_name: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    attempts: list[ProviderAttempt]


class ModelProviderAdapter(Protocol):
    """Protocol for pluggable Model Provider adapters."""

    @property
    def name(self) -> str:
        ...

    @property
    def default_model(self) -> str:
        ...

    async def complete(
        self,
        prompt: str,
        system_prompt: str | None = None,
        timeout_ms: int = 30_000,
    ) -> tuple[str, int, int]:
        """Perform completion returning (content, input_tokens, output_tokens)."""
        ...
