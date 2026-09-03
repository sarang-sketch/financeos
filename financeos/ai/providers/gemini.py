"""Gemini model provider adapter (Requirement 11.1)."""

import os
from typing import Any, override

import httpx

from financeos.ai.providers.provider import ModelProviderAdapter


class GeminiAdapter(ModelProviderAdapter):
    def __init__(self, api_key: str | None = None, model: str = "gemini-2.0-flash") -> None:
        self._api_key = api_key or os.environ.get("GEMINI_API_KEY", "")
        self._model = model

    @property
    @override
    def name(self) -> str:
        return "gemini"

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
            # Fallback mock narrative for local evaluation when key is absent
            return (
                f"Gemini evaluation narrative for: {prompt[:100]}...",
                len(prompt) // 4,
                30,
            )

        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/{self._model}:"
            f"generateContent?key={self._api_key}"
        )
        contents: list[dict[str, Any]] = []
        if system_prompt:
            contents.append({"role": "user", "parts": [{"text": f"System: {system_prompt}"}]})
        contents.append({"role": "user", "parts": [{"text": prompt}]})

        timeout_sec = timeout_ms / 1000.0
        async with httpx.AsyncClient(timeout=timeout_sec) as client:
            resp = await client.post(url, json={"contents": contents})
            resp.raise_for_status()
            data = resp.json()
            text = (
                data.get("candidates", [{}])[0]
                .get("content", {})
                .get("parts", [{}])[0]
                .get("text", "")
            )
            usage = data.get("usageMetadata", {})
            in_tokens = usage.get("promptTokenCount", len(prompt) // 4)
            out_tokens = usage.get("candidatesTokenCount", len(text) // 4)
            return text, in_tokens, out_tokens
