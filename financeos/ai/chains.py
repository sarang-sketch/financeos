"""Task_Class provider chains (Requirement 11.2, 11.3, 11.4).

- complex_reasoning: OpenRouter -> Gemini -> Groq
- document_analysis: Gemini -> OpenRouter -> Groq
- fast_classification: Groq -> Gemini -> OpenRouter
"""

from typing import Final, Literal

TaskClass = Literal["complex_reasoning", "document_analysis", "fast_classification"]

TASK_CLASSES: Final[list[TaskClass]] = [
    "complex_reasoning",
    "document_analysis",
    "fast_classification",
]

PROVIDER_CHAINS: Final[dict[TaskClass, list[str]]] = {
    "complex_reasoning": ["openrouter", "gemini", "groq"],
    "document_analysis": ["gemini", "openrouter", "groq"],
    "fast_classification": ["groq", "gemini", "openrouter"],
}
