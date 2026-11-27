"""Loads the plugin directory as the package ``web_resilient`` so relative imports
resolve exactly as they do under Hermes' directory-plugin loader — without
requiring Hermes or any third-party dependency. All network access in tests is
replaced by the seams each module exposes; no test touches the network.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

PLUGIN_DIR = pathlib.Path(__file__).resolve().parent.parent


def load_plugin(pkg_name: str = "web_resilient"):
    existing = sys.modules.get(pkg_name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(
        pkg_name,
        PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(PLUGIN_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    module.__package__ = pkg_name
    module.__path__ = [str(PLUGIN_DIR)]
    sys.modules[pkg_name] = module
    spec.loader.exec_module(module)
    return module


load_plugin()
