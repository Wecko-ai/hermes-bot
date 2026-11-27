"""Per-backend circuit breaker: after ``failure_threshold`` consecutive failures the
backend is skipped for ``cooldown_seconds`` so a dead SearXNG/DDGS never adds its
full timeout to every search while still recovering automatically.
"""
from __future__ import annotations

import threading
import time


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 3, cooldown_seconds: float = 60.0) -> None:
        self.failure_threshold = max(1, int(failure_threshold))
        self.cooldown_seconds = max(1.0, float(cooldown_seconds))
        self._failures = 0
        self._opened_until = 0.0
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            return time.monotonic() >= self._opened_until

    def on_success(self) -> None:
        with self._lock:
            self._failures = 0
            self._opened_until = 0.0

    def on_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._failures >= self.failure_threshold:
                self._opened_until = time.monotonic() + self.cooldown_seconds

    @property
    def failures(self) -> int:
        with self._lock:
            return self._failures
