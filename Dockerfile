# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Build the Python environment separately so the runtime image contains neither
# build caches nor packaging tools beyond what the application needs.
# -----------------------------------------------------------------------------
FROM python:3.12.13-slim-trixie@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /build

# Install the exact audited dependency set with package hashes, then add the
# local wheel without allowing its broad version ranges to re-resolve.
COPY pyproject.toml requirements.lock requirements-build.lock ./
COPY app/ ./app/

RUN python -m venv /opt/buildenv \
    && /opt/buildenv/bin/pip install --no-compile --require-hashes -r requirements-build.lock \
    && /opt/buildenv/bin/pip wheel --no-build-isolation --no-deps --wheel-dir /wheels . \
    && python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-compile --require-hashes -r requirements.lock \
    && /opt/venv/bin/pip install --no-compile --no-deps --no-index /wheels/*.whl


# -----------------------------------------------------------------------------
# Production runtime
# -----------------------------------------------------------------------------
FROM python:3.12.13-slim-trixie@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS runtime

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=random

RUN groupadd --system --gid 10001 appuser \
    && useradd --system --uid 10001 --gid appuser \
        --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin appuser

WORKDIR /app

COPY --from=builder --chown=root:root /opt/venv /opt/venv

# Application code and dependencies stay root-owned/read-only. The named GTFS
# volume mounted at /app/data is the sole writable application-data location.
RUN mkdir -p /app/data \
    && chown appuser:appuser /app/data \
    && chmod 0750 /app/data \
    && chmod -R a-w /opt/venv

USER 10001:10001

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).read(1)"]

CMD ["python", "-m", "app.server"]
