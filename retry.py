"""Retry helper: exponential backoff for transient failures.

Transient: HTTP 429/529, connection reset, read timeout, requests.ConnectionError.
Non-transient: 400/401/403/schema errors → raise immediately.
"""

from __future__ import annotations

import time
import random
from typing import Callable, TypeVar

import anthropic
import httpx

T = TypeVar("T")


def is_transient(exc: BaseException) -> bool:
    """Classify an exception as transient (worth retrying) or not."""
    # Anthropic SDK exceptions
    if isinstance(exc, (anthropic.RateLimitError, anthropic.APITimeoutError,
                        anthropic.APIConnectionError, anthropic.InternalServerError)):
        return True
    if isinstance(exc, anthropic.APIStatusError):
        # 429, 500, 502, 503, 504, 529
        return exc.status_code in {429, 500, 502, 503, 504, 529}
    # httpx transport errors
    if isinstance(exc, (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout,
                        httpx.RemoteProtocolError, httpx.NetworkError)):
        return True
    # Generic
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return True
    return False


def with_retry(fn: Callable[[], T], *, max_attempts: int = 3,
               base_delay: float = 1.0, on_retry=None) -> T:
    """Call fn(); on transient failure, exp-backoff and retry up to max_attempts.

    on_retry(attempt, wait_seconds, exception) is called before each retry sleep,
    useful for surfacing "retrying…" to SSE.
    """
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except BaseException as exc:
            last_exc = exc
            if not is_transient(exc) or attempt == max_attempts:
                raise
            wait = base_delay * (3 ** (attempt - 1)) + random.uniform(0, 0.3)
            if on_retry:
                try:
                    on_retry(attempt, wait, exc)
                except Exception:
                    pass
            time.sleep(wait)
    # Unreachable
    raise last_exc  # type: ignore
