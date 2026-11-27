"""places plugin — nearby places from OpenStreetMap/Overture with a shared
``hermes-places`` JSON contract, pedestrian routing and Google Maps walking
directions.  No API keys, no paid services, no Hermes core edits."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def register(ctx) -> None:
    """Hermes plugin entrypoint: register the places tools (called once by the loader)."""
    from . import tools

    tools.register_tools(ctx)
    logger.debug("places plugin registered")
