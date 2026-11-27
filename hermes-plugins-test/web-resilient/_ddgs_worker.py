"""Disposable DDGS worker: reads a JSON request from stdin, prints one JSON envelope
line on stdout, exits. Runs as a script under the same interpreter as the agent;
the parent enforces the hard wall-clock cap and kills this process on expiry.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys


def main() -> int:
    try:
        request = json.loads(sys.stdin.readline() or "{}")
        query = str(request.get("query") or "")
        safe_limit = max(1, int(request.get("safe_limit") or 5))
        if not query.strip():
            print(json.dumps({"ok": False, "error": "empty query"}), flush=True)
            return 0
        here = os.path.dirname(os.path.abspath(__file__))
        # Synthetic package so the backend's relative imports resolve outside Hermes.
        import types

        if "wrpkg" not in sys.modules:
            pkg = types.ModuleType("wrpkg")
            pkg.__path__ = [here]  # type: ignore[attr-defined]
            sys.modules["wrpkg"] = pkg
        mod = None
        for name in ("_standalone", "_contract", "_ddgs"):
            spec = importlib.util.spec_from_file_location(f"wrpkg.{name}", os.path.join(here, f"{name}.py"))
            mod = importlib.util.module_from_spec(spec)
            sys.modules[f"wrpkg.{name}"] = mod
            spec.loader.exec_module(mod)
        results = mod._run_query(query, safe_limit)
        print(json.dumps({"ok": True, "results": results}), flush=True)
    except Exception as exc:  # everything becomes an envelope error; stderr is /dev/null
        try:
            print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
