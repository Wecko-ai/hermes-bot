"""DDGS (DuckDuckGo) free search backend with a hard process-level timeout.

``ddgs``/``primp`` can block inside native code while holding the GIL, so a
thread-pool ``future.result(timeout=…)`` cap can never fire and Ctrl+C/SIGTERM
would freeze the agent. Every search therefore runs in a disposable child
process the parent terminates, then kills, after a hard wall-clock cap
(mirrors the bundled ``plugins/web/ddgs`` safeguard, #68096).

The module-level ``_run_in_child`` seam lets tests replace the whole subprocess
dance with an in-process callable.
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import logging
import os
import subprocess
import sys
import time
from typing import Any, Callable, Optional

from ._contract import title_hit

logger = logging.getLogger(__name__)

SEARCH_TIMEOUT_SECS = 30
POLL_INTERVAL_SECS = 0.1
TERMINATE_GRACE_SECS = 1.0


class DDGSError(RuntimeError):
    """DDGS worker failed, was interrupted, or timed out."""


class _Interrupted(Exception):
    """Tool interrupt tripped while waiting on the worker."""


def _run_query(query: str, safe_limit: int) -> list[dict[str, Any]]:
    """Blocking ddgs query → normalized hits (module-level so tests can patch it
    and so the child worker can import it)."""
    from ddgs import DDGS  # type: ignore[import-not-found]

    results: list[dict[str, Any]] = []
    with DDGS(timeout=10) as client:
        for i, hit in enumerate(client.text(query, max_results=safe_limit)):
            if i >= safe_limit:
                break
            results.append(
                title_hit(
                    str(hit.get("title", "")),
                    str(hit.get("href") or hit.get("url") or ""),
                    str(hit.get("body", "")),
                    i + 1,
                )
            )
    return results


def _spawn_worker(env: dict[str, str]) -> subprocess.Popen:
    """Start ``_ddgs_worker.py`` under the same interpreter with this package importable."""
    pkg_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_ddgs_worker.py")
    pythonpath = env.get("PYTHONPATH", "")
    parts = [p for p in pythonpath.split(os.pathsep) if p]
    if pkg_parent not in parts:
        env["PYTHONPATH"] = pkg_parent + (os.pathsep + pythonpath if pythonpath else "")
    extra: dict[str, Any] = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == "win32" else {"start_new_session": True}
    return subprocess.Popen(
        [sys.executable, worker],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env=env, text=True, encoding="utf-8", errors="replace", **extra,
    )


def _terminate_and_reap(proc: subprocess.Popen, *, grace: float = TERMINATE_GRACE_SECS) -> None:
    for escalate in (proc.terminate, proc.kill):
        if proc.poll() is None:
            try:
                escalate()
            except OSError:
                pass
            deadline = time.monotonic() + grace
            while proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)


def _parse_envelope(raw: str, proc: subprocess.Popen) -> list[dict[str, Any]]:
    raw = (raw or "").strip()
    if not raw:
        raise DDGSError(f"DDGS worker exited without a result (code={proc.poll()})")
    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise DDGSError(f"DDGS worker returned invalid JSON: {raw[:200]!r}") from exc
    if not isinstance(envelope, dict) or not envelope.get("ok"):
        raise DDGSError(str((envelope or {}).get("error") or "DDGS worker failed"))
    results = envelope.get("results") or []
    if not isinstance(results, list):
        raise DDGSError("DDGS worker returned non-list results")
    return results


def _run_in_child(
    query: str,
    safe_limit: int,
    *,
    timeout: float = SEARCH_TIMEOUT_SECS,
    spawn: Optional[Callable[[dict[str, str]], subprocess.Popen]] = None,
    interrupt: Callable[[], bool] = lambda: False,
) -> list[dict[str, Any]]:
    """Run the DDGS query in a disposable child under a hard wall-clock cap.

    Raises :class:`TimeoutError` on cap expiry, :class:`DDGSError` on worker
    failure/malformed output, ``_Interrupted`` on tool interrupt."""
    spawn_fn = spawn or _spawn_worker
    proc = spawn_fn(dict(os.environ))
    pool = cf.ThreadPoolExecutor(max_workers=1)
    fut = pool.submit(proc.communicate, json.dumps({"query": query, "safe_limit": safe_limit}))
    interrupted, done, raw = False, False, ""
    try:
        deadline = time.monotonic() + timeout
        while not done and not (interrupted := interrupt()) and (remaining := deadline - time.monotonic()) > 0:
            try:
                raw, done = fut.result(timeout=min(POLL_INTERVAL_SECS, remaining))[0] or "", True
            except cf.TimeoutError:
                pass
    finally:
        _terminate_and_reap(proc)
        if not fut.done():
            try:
                raw = raw or fut.result(timeout=TERMINATE_GRACE_SECS)[0] or ""
            except Exception:
                pass
        pool.shutdown(wait=False, cancel_futures=True)
    if interrupted:
        raise _Interrupted("DuckDuckGo search interrupted")
    if not done:
        raise TimeoutError(f"DuckDuckGo search timed out after {timeout:.0f}s")
    return _parse_envelope(raw, proc)


def ddgs_search(query: str, limit: int, *, timeout: float = SEARCH_TIMEOUT_SECS) -> list[dict[str, Any]]:
    """Public entry: hard-capped DDGS search → hit rows (raises on failure)."""
    try:
        return _run_in_child(query, max(1, int(limit)), timeout=timeout)
    except _Interrupted:
        raise
