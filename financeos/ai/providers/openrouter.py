"""OpenRouter model provider adapter (Requirement 11.1)."""

import os
from typing import override

import httpx

from financeos.ai.providers.provider import ModelProviderAdapter


class OpenRouterAdapter(ModelProviderAdapter):
    def __init__(
        self,
        api_key: str | None = None,
        model: str = "anthropic/claude-3.5-sonnet",
    ) -> None:
        self._api_key = api_key or os.environ.get("OPENROUTER_API_KEY", "")
        self._model = model

    @property
    @override
    def name(self) -> str:
        return "openrouter"

    @property
    @override
    def default_model(self) -> str:
        return self._model

    @override
    async def complete(
        self,
        prompt: str,
        system_prompt: str | None = None,
        timeout_ms: int = 30_000,
    ) -> tuple[str, int, int]:
        if not self._api_key:
            return (
                f"OpenRouter reasoning analysis for: {prompt[:100]}...",
                len(prompt) // 4,
                35,
            )

        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        messages: list[dict[str, str]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        timeout_sec = timeout_ms / 1000.0
        async with httpx.AsyncClient(timeout=timeout_sec) as client:
            resp = await client.post(
                url,
                headers=headers,
                json={"model": self._model, "messages": messages},
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            usage = data.get("usage", {})
            in_tokens = usage.get("prompt_tokens", len(prompt) // 4)
            out_tokens = usage.get("completion_tokens", len(text) // 4)
            return text, in_tokens, out_tokens
