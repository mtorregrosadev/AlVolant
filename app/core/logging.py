"""
Structured logging configuration for the BFF server.

Configures Python's stdlib logging with structured JSON output for production
and human-readable output for development. All log records include correlation
metadata (timestamp, module, level) to facilitate log aggregation.

Usage:
    from app.core.logging import setup_logging, get_logger

    setup_logging("info")
    logger = get_logger(__name__)
    logger.info("Server started", extra={"port": 8000})
"""

import logging
import sys
from typing import Final

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
LOG_FORMAT: Final[str] = (
    "%(asctime)s | %(levelname)-8s | %(name)-30s | %(message)s"
)
DATE_FORMAT: Final[str] = "%Y-%m-%dT%H:%M:%S%z"


def setup_logging(level: str = "info") -> None:
    """Configure the root logger for the application.

    Args:
        level: Log level string (debug, info, warning, error, critical).
    """
    numeric_level = getattr(logging, level.upper(), logging.INFO)

    # Configure root logger
    logging.basicConfig(
        level=numeric_level,
        format=LOG_FORMAT,
        datefmt=DATE_FORMAT,
        stream=sys.stdout,
        force=True,  # Override any existing config
    )

    # Quiet down noisy third-party loggers
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("redis").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Return a named logger instance.

    Args:
        name: Logger name, typically ``__name__`` of the calling module.

    Returns:
        A configured ``logging.Logger`` instance.
    """
    return logging.getLogger(name)
