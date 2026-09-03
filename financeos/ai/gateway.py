"""AI_Gateway — Pluggable multi-provider routing, failover, retries and metering.

Requirements: 11.1..11.14
"""

import asyncio
import re
import time
from typing import Final

from financeos.ai.chains import PROVIDER_CHAINS, TaskClass
from financeos.ai.providers.gemini import GeminiAdapter
from financeos.ai.providers.groq import GroqAdapter
from financeos.ai.providers.openrouter import OpenRouterAdapter
from financeos.ai.providers.provider import (
    CompletionResult,
    ModelProviderAdapter,
    ProviderAttempt,
    ProviderFailureReason,
)

MAX_INPUT_CHARS: Final[int] = 100_000
MAX_OUTPUT_CHARS: Final[int] = 8_000
MAX_PROVIDER_ATTEMPTS: Final[int] = 3
MAX_RETRIES: Final[int] = 2

CREDENTIAL_PATTERNS = [
    re.compile(r"rzp_(?:test|live)_[A-Za-z0-9]{14,20}"),
    re.compile(r"sk-[A-Za-z0-9-_]{20,}"),
    re.compile(r"AIzaSy[A-Za-z0-9_-]{33}"),
    re.compile(r"gsk_[A-Za-z0-9]{20,}"),
    re.compile(
        r"(?:password|secret|bearer)\s*[:=]\s*['\"]?[A-Za-z0-9_\-\.]{8,}['\"]?",
        re.IGNORECASE,
    ),
]


def strip_credentials(text: str) -> str:
    """Strip API keys and sensitive tokens from text (Requirement 11.12)."""
    sanitized = text
    for pattern in CREDENTIAL_PATTERNS:
        sanitized = pattern.sub("[REDACTED_CREDENTIAL]", sanitized)
    return sanitized


class AIGatewayError(Exception):
    """Base exception for AI gateway errors."""


class CostCapExceededError(AIGatewayError):
    """Raised when monthly model request cost cap is reached."""


class ProviderUnavailableError(AIGatewayError):
    """Raised when all provider options in chain have failed."""

    def __init__(self, attempts: list[ProviderAttempt]) -> None:
        msg = f"All providers exhausted: {[a.provider for a in attempts]}"
        super().__init__(msg)
        self.attempts = attempts


class AIGateway:
    """The AI_Gateway coordinating model provider access."""

    def __init__(
        self,
        providers: dict[str, ModelProviderAdapter] | None = None,
        *,
        cost_cap_exceeded: bool = False,
    ) -> None:
        self._providers = providers or {
            "gemini": GeminiAdapter(),
            "groq": GroqAdapter(),
            "openrouter": OpenRouterAdapter(),
        }
        self._cost_cap_exceeded = cost_cap_exceeded

    async def route(
        self,
        prompt: str,
        task_class: TaskClass = "complex_reasoning",
        system_prompt: str | None = None,
        timeout_ms: int = 30_000,
    ) -> CompletionResult:
        """Route request through provider chain with retries and failover."""
        # 1. Enforce payload bounds (Req 11.9)
        if len(prompt) > MAX_INPUT_CHARS:
            msg = f"Prompt length {len(prompt)} exceeds maximum {MAX_INPUT_CHARS}"
            raise AIGatewayError(msg)

        # 2. Check cost cap (Req 11.13)
        if self._cost_cap_exceeded:
            cap_msg = "Monthly model request cost cap exceeded"
            raise CostCapExceededError(cap_msg)

        # 3. Strip credentials from prompt (Req 11.12)
        sanitized_prompt = strip_credentials(prompt)
        sanitized_system = strip_credentials(system_prompt) if system_prompt else None

        chain = PROVIDER_CHAINS.get(task_class, ["gemini", "openrouter", "groq"])
        attempts: list[ProviderAttempt] = []

        for provider_name in chain[:MAX_PROVIDER_ATTEMPTS]:  # max 3 providers (Req 11.7)
            adapter = self._providers.get(provider_name)
            if not adapter:
                continue

            # Up to 2 retries on rate limit or timeout (total 3 tries on this provider)
            for attempt_idx in range(MAX_PROVIDER_ATTEMPTS):
                start_time = time.monotonic()
                try:
                    text, in_tokens, out_tokens = await adapter.complete(
                        prompt=sanitized_prompt,
                        system_prompt=sanitized_system,
                        timeout_ms=timeout_ms,
                    )
                    latency = int((time.monotonic() - start_time) * 1000)
                    cleaned_output = strip_credentials(text)[:MAX_OUTPUT_CHARS]

                    attempts.append(
                        ProviderAttempt(
                            provider=provider_name,
                            model_name=adapter.default_model,
                            latency_ms=latency,
                            input_tokens=in_tokens,
                            output_tokens=out_tokens,
                            outcome="succeeded",
                        )
                    )

                    return CompletionResult(
                        content=cleaned_output,
                        provider=provider_name,
                        resolved_model_name=adapter.default_model,
                        input_tokens=in_tokens,
                        output_tokens=out_tokens,
                        latency_ms=latency,
                        attempts=attempts,
                    )
                except TimeoutError as exc:
                    latency = int((time.monotonic() - start_time) * 1000)
                    attempts.append(
                        ProviderAttempt(
                            provider=provider_name,
                            model_name=adapter.default_model,
                            latency_ms=latency,
                            input_tokens=0,
                            output_tokens=0,
                            outcome="failed",
                            failure_reason="timeout",
                            error_message=str(exc),
                        )
                    )
                    if attempt_idx < MAX_RETRIES:
                        # Exponential backoff 1s, 2s
                        await asyncio.sleep(1.0 if attempt_idx == 0 else 2.0)
                    else:
                        break  # Failover to next provider

                except Exception as exc:
                    latency = int((time.monotonic() - start_time) * 1000)
                    err_str = str(exc).lower()
                    is_rate_limit = "429" in err_str or "rate limit" in err_str
                    failure_reason: ProviderFailureReason = (
                        "rate_limit" if is_rate_limit else "provider_error"
                    )

                    attempts.append(
                        ProviderAttempt(
                            provider=provider_name,
                            model_name=adapter.default_model,
                            latency_ms=latency,
                            input_tokens=0,
                            output_tokens=0,
                            outcome="failed",
                            failure_reason=failure_reason,
                            error_message=str(exc),
                        )
                    )

                    if is_rate_limit and attempt_idx < MAX_RETRIES:
                        await asyncio.sleep(1.0 if attempt_idx == 0 else 2.0)
                    else:
                        # Non-rate-limit error: failover immediately (Req 11.6)
                        break

        raise ProviderUnavailableError(attempts)
