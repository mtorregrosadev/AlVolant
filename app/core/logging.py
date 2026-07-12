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

import json
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Final

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
LOG_FORMAT: Final[str] = (
    "%(asctime)s | %(levelname)-8s | %(name)-30s | %(message)s"
)
DATE_FORMAT: Final[str] = "%Y-%m-%dT%H:%M:%S%z"

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]+")
_URL_QUERY_RE = re.compile(r"(https?://[^\s?#]+)(?:[?#][^\s]*)?", re.IGNORECASE)
_REDIS_CREDENTIAL_RE = re.compile(r"(redis(?:s)?://)(?:[^@/\s]+@)", re.IGNORECASE)
_SECRET_RE = re.compile(
    r"(?i)(\b(?:x[_-]?)?(?:api[_-]?key|authorization|password|secret|token)\b"
    r"[\"']?\s*[:=]\s*)[\"']?(?:(?:bearer|basic)\s+)?[^\"'\s,;}\]]+[\"']?"
)
_COORDINATE_PAIR_RE = re.compile(r"(?<!\d)-?\d{1,3}\.\d{4,}\s*[,;]\s*-?\d{1,3}\.\d{4,}(?!\d)")
_COORDINATE_FIELD_RE = re.compile(
    r"(?i)\b(lat(?:itude)?|lon(?:gitude)?)\b[\"']?\s*[:=]\s*"
    r"[\"']?-?\d{1,3}(?:\.\d+)?[\"']?"
)


def redact_log_text(value: object) -> str:
    """Remove common secret/location shapes from operational log text."""
    text = _CONTROL_RE.sub(" ", str(value))
    text = _URL_QUERY_RE.sub(r"\1", text)
    text = _REDIS_CREDENTIAL_RE.sub(r"\1[redacted]@", text)
    text = _SECRET_RE.sub(r"\1[redacted]", text)
    text = _COORDINATE_PAIR_RE.sub("[redacted-coordinates]", text)
    text = _COORDINATE_FIELD_RE.sub(r"\1=[redacted]", text)
    return " ".join(text.split())


class RedactingFormatter(logging.Formatter):
    """Ensure formatted messages and exception tails use the same scrubber."""

    def format(self, record: logging.LogRecord) -> str:
        clone = logging.makeLogRecord(record.__dict__.copy())
        clone.msg = redact_log_text(record.getMessage())
        clone.args = ()
        return redact_log_text(super().format(clone))


class JSONFormatter(RedactingFormatter):
    """Minimal structured production logs without request bodies or locals."""

    def format(self, record: logging.LogRecord) -> str:
        message = redact_log_text(record.getMessage())
        if record.exc_info:
            message = f"{message} | {redact_log_text(self.formatException(record.exc_info))}"
        return json.dumps({
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": message,
        }, ensure_ascii=False, separators=(",", ":"))


def setup_logging(level: str = "info", *, json_logs: bool = False) -> None:
    """Configure the root logger for the application.

    Args:
        level: Log level string (debug, info, warning, error, critical).
    """
    numeric_level = getattr(logging, level.upper(), logging.INFO)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JSONFormatter()
        if json_logs
        else RedactingFormatter(LOG_FORMAT, datefmt=DATE_FORMAT)
    )
    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(numeric_level)

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
