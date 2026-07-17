"""Small, cache-first adapter for TMB's stop-level iBus predictions."""

from __future__ import annotations

import asyncio
import hashlib
import math
import re
import time
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
import orjson
from google.protobuf.message import DecodeError
from google.transit import gtfs_realtime_pb2

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.logging import get_logger
from app.models.ibus import (
    IbusAheadPosition,
    IbusFleetSummary,
    IbusRoutePosition,
    IbusVehiclePrediction,
)
from app.services.gtfs_service import GTFSService

logger = get_logger(__name__)

_ALLOWED_TMB_API_HOSTS = frozenset({"api.tmb.cat"})
_ALLOWED_AMB_RT_HOSTS = frozenset({"www.ambmobilitat.cat"})
_STOP_CODE_PATTERN = re.compile(r"^\d{1,8}$")
_AMB_TRIP_ID_PATTERN = re.compile(r"^\d{1,8}(?:\.\d{1,8}){2,8}$")
_SAFE_TEXT_PATTERN = re.compile(r"^[^\x00-\x1f\x7f]{1,300}$")
_MAX_RESPONSE_BYTES = 192 * 1024
_MAX_AMB_RT_RESPONSE_BYTES = 2 * 1024 * 1024
_MAX_PREDICTIONS_PER_STOP = 80
_MAX_ETA_SECONDS = 14_400
_MAX_AMB_RT_ENTITIES = 2_000
_MAX_AMB_RT_STOP_UPDATES = 40_000
_MAX_AMB_ROUTE_TRIPS = 96
_MATCH_WINDOW_SECONDS = 12 * 60
_AMBIGUOUS_MATCH_SECONDS = 45
_MULTI_STOP_MATCH_WINDOW_SECONDS = 3 * 60
_AHEAD_POSITION_MIN_LEAD_SECONDS = 90
_SCHEDULED_DEPARTURE_MATCH_SECONDS = 75
_AHEAD_POSITION_MAX_ETA_SECONDS = 10 * 60
_ROUTE_POSITION_MAX_ETA_SECONDS = 15 * 60
_ROUTE_POSITION_CLUSTER_SECONDS = 3 * 60
_MAX_ROUTE_POSITIONS = 16
_RATE_LIMIT_HEADER_NAMES = frozenset({
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
    "ratelimit-policy",
    "retry-after",
})
_LOOKUP_LOCK_SECONDS = 8
_LOOKUP_WAIT_SECONDS = 5
_LOOKUP_POLL_SECONDS = 0.2
_CACHE_PREFIX = "ibus:stop:v1"
_LOCK_PREFIX = "ibus:stop-lock:v1"
_ROUTE_SCAN_CACHE_PREFIX = "ibus:route-scan:v1"
_AMB_RT_CACHE_KEY = "amb:gtfsrt:trip-updates:v1"
_QUOTA_MINUTE_PREFIX = "rl:ibus:minute"
_QUOTA_DAY_PREFIX = "rl:ibus:day"
_CIRCUIT_KEY = "rl:ibus:circuit"

LookupStatus = Literal["available", "rate_limited", "unavailable"]


@dataclass(frozen=True, slots=True)
class _StopPrediction:
    vehicle_id: str
    line: str
    destination_name: str
    arrival_epoch: int

    def to_cache(self) -> dict[str, object]:
        return {
            "vehicle_id": self.vehicle_id,
            "line": self.line,
            "destination_name": self.destination_name,
            "arrival_epoch": self.arrival_epoch,
        }


@dataclass(frozen=True, slots=True)
class _AMBTripPrediction:
    """A normalized AMB GTFS-RT trip with its upcoming stop arrivals."""

    trip_id: str
    route_id: str
    stop_arrivals: tuple[tuple[str, int], ...]

    def to_cache(self) -> dict[str, object]:
        return {
            "trip_id": self.trip_id,
            "route_id": self.route_id,
            "stop_arrivals": [
                {"stop_id": stop_id, "arrival_epoch": arrival_epoch}
                for stop_id, arrival_epoch in self.stop_arrivals
            ],
        }


class TMBIbusService:
    """Fetch one stop snapshot, shared by every local driver at that stop."""

    def __init__(
        self,
        settings: Settings,
        cache: CacheManager | None,
        gtfs_service: GTFSService,
    ) -> None:
        self._settings = settings
        self._cache = cache
        self._gtfs_service = gtfs_service
        self._client: httpx.AsyncClient | None = None
        self._inflight: dict[str, asyncio.Task[tuple[LookupStatus, list[_StopPrediction]]]] = {}
        self._inflight_lock = asyncio.Lock()
        self._amb_rt_task: asyncio.Task[list[_AMBTripPrediction] | None] | None = None
        self._circuit_open_until = 0.0
        self._last_provider_rate_limits: tuple[tuple[str, str], ...] = ()

    async def start(self) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=3.0, read=7.0, write=3.0, pool=3.0),
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
            headers={"User-Agent": "AlVolant-BFF/0.4"},
            follow_redirects=False,
            trust_env=False,
        )

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def get_fleet_summary(
        self,
        *,
        route_id: str,
        trip_id: str | None,
        direction_id: int,
        stop_id: str,
        scheduled_departure_epoch: int | None,
    ) -> IbusFleetSummary:
        """Return a schedule match plus live positions from the suitable provider."""
        can_use_amb_rt = bool(
            trip_id
            and route_id.startswith("AMB_")
            and trip_id.startswith("AMB_")
        )
        contexts = await self._get_stop_contexts(
            route_id=route_id,
            trip_id=trip_id,
            direction_id=direction_id,
            stop_id=stop_id,
            # AMB's feed is route-wide and does not cost one request per stop.
            # Retain the full remaining static pattern whenever a trip is known
            # so it can position metropolitan services exactly on the rail.
            include_downstream=trip_id is not None,
            full_pattern=can_use_amb_rt,
        )
        context = contexts[0] if contexts else None
        stop_name = str(context.get("stop_name", "")) if context else ""
        if context is None:
            return self._empty_summary("unavailable", stop_id, stop_name)

        if can_use_amb_rt:
            amb_summary = await self._get_amb_fleet_summary(
                route_id=route_id,
                trip_id=trip_id,
                direction_id=direction_id,
                current_stop_id=stop_id,
                contexts=contexts,
                scheduled_departure_epoch=scheduled_departure_epoch,
                now_epoch=int(time.time()),
            )
            if amb_summary is not None:
                return amb_summary

        if not self._configured:
            return self._empty_summary("unconfigured", stop_id, stop_name)

        now_epoch = int(time.time())
        status, candidates = await self._get_context_candidates(context, now_epoch)
        reference_index: int | None = None
        schedule_matched = False
        downstream: list[tuple[dict[str, Any], list[_StopPrediction]]] = []
        full_route_scan = False
        route_scan_contexts = contexts[1:]
        # iBus exposes arrivals per stop rather than a route-wide vehicle
        # feed.  A scan only from the driver's current stop to the terminus
        # can never find the service that left the origin behind them.  For a
        # selected TMB trip, sample the complete static pattern every N stops;
        # the result is shared by the static route fingerprint and protected by
        # the global provider budget.
        if trip_id and not can_use_amb_rt:
            full_contexts = await self._get_full_tmb_route_scan_contexts(route_id, trip_id)
            if full_contexts:
                route_scan_contexts = full_contexts
                full_route_scan = True
        if scheduled_departure_epoch is not None:
            scheduled_offset_seconds = _bounded_int(
                context.get("scheduled_offset_seconds"),
                -1,
                86_400,
            )
            if scheduled_offset_seconds is not None:
                expected_arrival_epoch = scheduled_departure_epoch + scheduled_offset_seconds
                downstream = await self._get_downstream_route_scan(
                    context,
                    route_scan_contexts,
                    now_epoch,
                )
                correlation_scan = [
                    item for item in downstream
                    if item[0].get("stop_id") != context.get("stop_id")
                ]
                reference_index = _find_multistop_reference_prediction(
                    candidates,
                    expected_arrival_epoch,
                    scheduled_departure_epoch,
                    correlation_scan,
                )
                schedule_matched = reference_index is not None

        route_position_observations = [(context, candidates), *downstream]
        if full_route_scan:
            # The current stop may also be one of the every-other-stop samples.
            # Keep the direct, fresh lookup once so it cannot be interpreted as
            # a second physical bus.
            seen_stop_ids = {str(context.get("stop_id", ""))}
            route_position_observations = [
                (context, candidates),
                *[
                    item
                    for item in downstream
                    if str(item[0].get("stop_id", "")) not in seen_stop_ids
                ],
            ]
        route_position_data = _find_route_positions(
            route_position_observations,
            scheduled_departure_epoch,
            now_epoch,
        )
        public_route_positions = self._to_route_positions(route_position_data, now_epoch)
        current_stop_sequence = _bounded_int(context.get("stop_sequence"), 0, 10_000)
        future_downstream = [
            item for item in downstream
            if current_stop_sequence is None
            or (_bounded_int(item[0].get("stop_sequence"), 0, 10_000) or -1) > current_stop_sequence
        ]
        ahead_position = _find_downstream_ahead_position(
            future_downstream,
            scheduled_departure_epoch,
            now_epoch,
        ) or next(
            (
                (item_context, item_prediction)
                for item_context, item_prediction, relation in route_position_data
                if relation == "ahead"
            ),
            None,
        )
        public_ahead_position = self._to_ahead_position(ahead_position, now_epoch)

        # A stop can temporarily have no iBus prediction while a later stop
        # on the very same line does. Keep the downstream scan useful instead
        # of making the primary stop an all-or-nothing gate.
        if status != "available":
            if public_ahead_position is not None:
                return IbusFleetSummary(
                    status="available",
                    stop_id=stop_id,
                    stop_name=stop_name,
                    ahead_position=public_ahead_position,
                    route_positions=public_route_positions,
                )
            return self._empty_summary(status, stop_id, stop_name)
        if not candidates:
            return IbusFleetSummary(
                status="available",
                stop_id=stop_id,
                stop_name=stop_name,
                ahead_position=public_ahead_position,
                route_positions=public_route_positions,
            )

        # A simulation or a route opened before selecting a departure has no
        # trustworthy scheduled reference. Show the live queue nevertheless,
        # with neutral "next bus" language instead of claiming a GPS match.
        if reference_index is None:
            reference_index = next(
                (index for index, item in enumerate(candidates) if item.arrival_epoch >= now_epoch),
                0,
            )

        reference = candidates[reference_index]
        ahead = candidates[reference_index - 1] if reference_index > 0 else None
        behind = (
            candidates[reference_index + 1]
            if reference_index + 1 < len(candidates)
            else None
        )
        inferred_ahead, inferred_behind = _find_inferred_adjacent_predictions(
            route_position_observations,
            reference_arrival_epoch=reference.arrival_epoch,
            reference_stop_offset_seconds=_bounded_int(
                context.get("scheduled_offset_seconds"),
                -1,
                86_400,
            ),
        )
        resolved_ahead = ahead or (inferred_ahead[1] if inferred_ahead else None)
        resolved_behind = behind or (inferred_behind[1] if inferred_behind else None)
        inferred_ahead_gap = (
            inferred_ahead[2]
            if ahead is None and inferred_ahead is not None
            else None
        )
        inferred_behind_gap = (
            inferred_behind[2]
            if behind is None and inferred_behind is not None
            else None
        )
        return IbusFleetSummary(
            status="available",
            stop_id=stop_id,
            stop_name=stop_name,
            reference_vehicle_id=reference.vehicle_id,
            reference_arrival_epoch=reference.arrival_epoch,
            reference_prediction=self._to_public_prediction(reference, now_epoch),
            reference_is_schedule_match=schedule_matched,
            ahead_vehicle=self._to_public_prediction(resolved_ahead, now_epoch),
            behind_vehicle=self._to_public_prediction(resolved_behind, now_epoch),
            ahead_gap_seconds=(
                max(0, reference.arrival_epoch - ahead.arrival_epoch)
                if ahead is not None else inferred_ahead_gap
            ),
            behind_gap_seconds=(
                max(0, behind.arrival_epoch - reference.arrival_epoch)
                if behind is not None else inferred_behind_gap
            ),
            ahead_position=public_ahead_position,
            route_positions=public_route_positions,
        )

    async def _get_stop_contexts(
        self,
        *,
        route_id: str,
        trip_id: str | None,
        direction_id: int,
        stop_id: str,
        include_downstream: bool,
        full_pattern: bool = False,
    ) -> list[dict[str, Any]]:
        if trip_id:
            if include_downstream:
                if full_pattern:
                    get_full_contexts = getattr(self._gtfs_service, "get_full_trip_stop_contexts", None)
                    if callable(get_full_contexts):
                        contexts = await get_full_contexts(
                            route_id,
                            trip_id,
                            max_stops=128,
                            stop_stride=1,
                        )
                        if isinstance(contexts, list) and contexts and all(
                            isinstance(context, dict) for context in contexts
                        ):
                            return contexts
                get_contexts = getattr(self._gtfs_service, "get_trip_stop_contexts", None)
                if callable(get_contexts):
                    contexts = await get_contexts(
                        route_id,
                        trip_id,
                        stop_id,
                        max_stops=(128 if full_pattern else self._settings.TMB_IBUS_ROUTE_SCAN_MAX_STOPS),
                        stop_stride=(1 if full_pattern else self._settings.TMB_IBUS_STOP_STRIDE),
                    )
                    if isinstance(contexts, list) and contexts and all(
                        isinstance(context, dict) for context in contexts
                    ):
                        return contexts
            context = await self._gtfs_service.get_trip_stop_context(route_id, trip_id, stop_id)
            return [context] if isinstance(context, dict) else []

        context = await self._gtfs_service.get_route_stop_context(route_id, direction_id, stop_id)
        return [context] if isinstance(context, dict) else []

    async def _get_full_tmb_route_scan_contexts(
        self,
        route_id: str,
        trip_id: str,
    ) -> list[dict[str, Any]]:
        """Return a bounded every-other-stop TMB radar pattern for one trip."""
        get_full_contexts = getattr(self._gtfs_service, "get_full_trip_stop_contexts", None)
        if not callable(get_full_contexts):
            return []
        contexts = await get_full_contexts(
            route_id,
            trip_id,
            max_stops=self._settings.TMB_IBUS_ROUTE_SCAN_MAX_STOPS,
            stop_stride=self._settings.TMB_IBUS_STOP_STRIDE,
        )
        if not isinstance(contexts, list) or not contexts or not all(
            isinstance(context, dict) for context in contexts
        ):
            return []
        return contexts

    async def _get_amb_fleet_summary(
        self,
        *,
        route_id: str,
        trip_id: str | None,
        direction_id: int,
        current_stop_id: str,
        contexts: list[dict[str, Any]],
        scheduled_departure_epoch: int | None,
        now_epoch: int,
    ) -> IbusFleetSummary | None:
        """Use AMB's shared GTFS-RT feed for non-TMB metropolitan services.

        AMB publishes stop-arrival updates for operators such as Direxis
        TUSGSAL, but not vehicle GPS coordinates.  One feed fetch contains
        every active trip, so it is both more complete and considerably cheaper
        than walking a long metropolitan route stop by stop.
        """
        if not trip_id or len(contexts) < 2:
            return None

        feed = await self._get_amb_trip_predictions()
        if feed is None:
            return None
        route_trips = [item for item in feed if item.route_id == route_id][:_MAX_AMB_ROUTE_TRIPS]
        if not route_trips:
            return None

        # The static trip ID in the driver assignment is normally identical to
        # the GTFS-RT one.  AMB occasionally publishes a sibling trip ID for
        # the very same scheduled departure, though.  Keep the selected trip's
        # static departure too, so that sibling can never be rendered as a bus
        # in front of the driver.
        selected_meta = await self._gtfs_service.get_trip_meta(trip_id)
        metas = await asyncio.gather(
            *(self._gtfs_service.get_trip_meta(item.trip_id) for item in route_trips),
            return_exceptions=True,
        )
        selected: list[tuple[_AMBTripPrediction, dict[str, Any]]] = []
        for item, meta in zip(route_trips, metas, strict=True):
            if not isinstance(meta, dict):
                continue
            if meta.get("route_id") != route_id or meta.get("direction_id") != direction_id:
                continue
            selected.append((item, meta))
        if not selected:
            # The AMB feed is useful only when its static identities match the
            # active GTFS snapshot; otherwise let the TMB iBus fallback decide.
            return None

        contexts_by_stop = {
            str(context.get("stop_id", "")): context
            for context in contexts
            if isinstance(context.get("stop_id"), str)
        }
        current_context = contexts_by_stop.get(current_stop_id, contexts[0])
        positioned: list[
            tuple[dict[str, Any], _StopPrediction, Literal["ahead", "behind"], int | None]
        ] = []
        own_observation: tuple[dict[str, Any], _StopPrediction] | None = None
        own_representative_start: int | None = None
        observed_services: list[tuple[dict[str, Any], _StopPrediction, int | None]] = []

        for item, item_meta in selected:
            observations: list[tuple[dict[str, Any], _StopPrediction]] = []
            for observed_stop_id, arrival_epoch in item.stop_arrivals:
                context = contexts_by_stop.get(observed_stop_id)
                if context is None:
                    continue
                if not now_epoch - 60 <= arrival_epoch <= now_epoch + _ROUTE_POSITION_MAX_ETA_SECONDS:
                    continue
                observations.append((
                    context,
                    _StopPrediction("", "AMB", "", arrival_epoch),
                ))
            if not observations:
                continue

            marker_context, marker_prediction = min(
                observations,
                key=lambda value: value[1].arrival_epoch,
            )
            normalized_starts = [
                prediction.arrival_epoch - offset_seconds
                for context, prediction in observations
                if (offset_seconds := _bounded_int(
                    context.get("scheduled_offset_seconds"),
                    -1,
                    86_400,
                )) is not None
            ]
            representative_start = (
                round(sum(normalized_starts) / len(normalized_starts))
                if normalized_starts else None
            )
            is_selected_trip = item.trip_id == trip_id or _same_scheduled_service(
                selected_meta,
                item_meta,
                scheduled_departure_epoch,
            )
            if is_selected_trip:
                # More than one GTFS-RT record can describe the same vehicle
                # during a feed handover.  Retain its most immediate observed
                # arrival, but never put either record on the public rail.
                if (
                    own_observation is None
                    or marker_prediction.arrival_epoch < own_observation[1].arrival_epoch
                ):
                    own_observation = (marker_context, marker_prediction)
                    own_representative_start = representative_start
                continue

            observed_services.append((marker_context, marker_prediction, representative_start))

        # Once the driver's live service is available, compare every other
        # service against that live inferred journey start. This preserves the
        # useful scheduled fallback during a temporary feed gap, while making
        # ahead/behind resilient to a late or early selected departure.
        reference_start = own_representative_start or scheduled_departure_epoch
        for marker_context, marker_prediction, representative_start in observed_services:

            # AMB gives us stop-arrival predictions, not vehicle GPS.  A
            # different live trip whose first upcoming stop is the driver's
            # very next stop cannot be distinguished reliably from the
            # driver's own bus when trip matching is incomplete.  Do not call
            # it "Bus de davant"; only render it once its observation places
            # it beyond the driver's current stop.
            if str(marker_context.get("stop_id", "")) == current_stop_id:
                continue

            if reference_start is None or representative_start is None:
                relation: Literal["ahead", "behind"] = "ahead"
            else:
                gap_seconds = representative_start - reference_start
                if abs(gap_seconds) < _AHEAD_POSITION_MIN_LEAD_SECONDS:
                    # Same live journey start, but the provider may omit a
                    # trip suffix in rare responses. Never duplicate the
                    # driver's marker on the journey rail.
                    continue
                relation = "ahead" if gap_seconds < 0 else "behind"
            live_gap_seconds = (
                abs(representative_start - reference_start)
                if own_representative_start is not None and representative_start is not None
                else None
            )
            positioned.append((marker_context, marker_prediction, relation, live_gap_seconds))

        positioned.sort(
            key=lambda value: (
                _bounded_int(value[0].get("stop_sequence"), 0, 10_000) or 0,
                value[1].arrival_epoch,
            ),
        )
        public_positions = self._to_route_positions(
            [(context, prediction, relation) for context, prediction, relation, _gap in positioned[:_MAX_ROUTE_POSITIONS]],
            now_epoch,
        )
        ahead_observations = [
            (context, prediction, gap)
            for context, prediction, relation, gap in positioned
            if relation == "ahead"
        ]
        behind_observations = [
            (context, prediction, gap)
            for context, prediction, relation, gap in positioned
            if relation == "behind"
        ]
        # The HUD describes the *nearest* bus in each direction, whereas the
        # rail still receives every inferred position below.
        ahead_position = min(
            ahead_observations,
            key=lambda value: (
                _bounded_int(value[0].get("stop_sequence"), 0, 10_000) or 0,
                value[1].arrival_epoch,
            ),
            default=None,
        )
        behind_position = min(
            behind_observations,
            key=lambda value: value[1].arrival_epoch,
            default=None,
        )
        reference = own_observation or (
            min(
                ((context, prediction) for context, prediction, _relation, _gap in positioned),
                key=lambda value: value[1].arrival_epoch,
                default=None,
            )
        )
        reference_prediction = self._to_public_prediction(
            reference[1] if reference is not None else None,
            now_epoch,
        )
        return IbusFleetSummary(
            source="amb_gtfs_rt",
            status="available",
            stop_id=str(current_context.get("stop_id", "")),
            stop_name=str(current_context.get("stop_name", "")),
            reference_arrival_epoch=(reference_prediction.arrival_epoch if reference_prediction else None),
            reference_prediction=reference_prediction,
            reference_is_schedule_match=own_observation is not None,
            ahead_vehicle=self._to_public_prediction(
                ahead_position[1] if ahead_position is not None else None,
                now_epoch,
            ),
            behind_vehicle=self._to_public_prediction(
                behind_position[1] if behind_position is not None else None,
                now_epoch,
            ),
            ahead_gap_seconds=ahead_position[2] if ahead_position is not None else None,
            behind_gap_seconds=behind_position[2] if behind_position is not None else None,
            ahead_position=self._to_ahead_position(
                (ahead_position[0], ahead_position[1]) if ahead_position is not None else None,
                now_epoch,
            ),
            route_positions=public_positions,
        )

    async def _get_amb_trip_predictions(self) -> list[_AMBTripPrediction] | None:
        cached = await self._get_cached_amb_trip_predictions()
        if cached is not None:
            return cached

        async with self._inflight_lock:
            task = self._amb_rt_task
            if task is None:
                task = asyncio.create_task(
                    self._fetch_and_cache_amb_trip_predictions(),
                    name="amb-gtfsrt-trip-updates",
                )
                self._amb_rt_task = task
        try:
            return await asyncio.shield(task)
        finally:
            if task.done():
                async with self._inflight_lock:
                    if self._amb_rt_task is task:
                        self._amb_rt_task = None

    async def _get_cached_amb_trip_predictions(self) -> list[_AMBTripPrediction] | None:
        if self._cache is None:
            return None
        try:
            value = await self._cache.get_json(_AMB_RT_CACHE_KEY)
        except Exception:
            logger.warning("AMB GTFS-RT cache read failed")
            return None
        if not isinstance(value, list):
            return None
        predictions = [_amb_trip_from_cache(item) for item in value]
        if any(item is None for item in predictions):
            return None
        return [item for item in predictions if item is not None]

    async def _fetch_and_cache_amb_trip_predictions(self) -> list[_AMBTripPrediction] | None:
        predictions = await self._fetch_amb_trip_predictions()
        if predictions is None:
            return None
        if self._cache is not None:
            try:
                await self._cache.set_json(
                    _AMB_RT_CACHE_KEY,
                    [item.to_cache() for item in predictions],
                    ttl=self._settings.AMB_RT_CACHE_TTL_SECONDS,
                )
            except Exception:
                logger.warning("AMB GTFS-RT cache write failed")
        return predictions

    async def _fetch_amb_trip_predictions(self) -> list[_AMBTripPrediction] | None:
        if self._client is None:
            await self.start()
        assert self._client is not None
        url = self._settings.AMB_RT_TRIP_UPDATES_URL.strip()
        if not _is_allowed_amb_rt_endpoint(url):
            logger.warning("AMB GTFS-RT provider configuration rejected")
            return None

        try:
            body = bytearray()
            async with self._client.stream("GET", url) as response:
                response.raise_for_status()
                content_length = response.headers.get("content-length")
                if content_length and int(content_length) > _MAX_AMB_RT_RESPONSE_BYTES:
                    raise ValueError
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > _MAX_AMB_RT_RESPONSE_BYTES:
                        raise ValueError
            return _parse_amb_gtfs_rt_payload(bytes(body), now_epoch=int(time.time()))
        except (httpx.HTTPError, ValueError, DecodeError, OverflowError):
            logger.warning("AMB GTFS-RT provider lookup failed")
            return None

    async def _get_context_candidates(
        self,
        context: dict[str, Any],
        now_epoch: int,
    ) -> tuple[LookupStatus, list[_StopPrediction]]:
        stop_code = str(context.get("stop_code", ""))
        line_codes = {
            line_code
            for line_code in (
                _normalize_line(context.get("route_short_name")),
                _normalize_line(context.get("ibus_line_code")),
            )
            if line_code
        }
        if not _STOP_CODE_PATTERN.fullmatch(stop_code) or not line_codes:
            return "unavailable", []
        status, predictions = await self._get_stop_predictions(stop_code)
        if status != "available":
            return status, []
        return "available", sorted(
            (
                item
                for item in predictions
                if _normalize_line(item.line) in line_codes
                and item.arrival_epoch >= now_epoch - 60
            ),
            key=lambda item: (item.arrival_epoch, item.vehicle_id),
        )

    def _route_scan_cache_key(
        self,
        _primary_context: dict[str, Any],
        downstream_contexts: list[dict[str, Any]],
    ) -> str:
        # The scan contains only public stop codes and prediction epochs; hash
        # the static pattern so cache keys stay bounded and route variants do
        # not accidentally share a radar snapshot.
        # The scan is a route resource, not a driver's current-stop resource.
        # Do not put ``primary_context`` in the key: the full-pattern sample is
        # identical for drivers at different points of the same trip.
        fingerprint = "|".join(sorted(
            f"{item.get('stop_sequence', '')}:{item.get('stop_id', '')}:{item.get('stop_code', '')}:{item.get('scheduled_offset_seconds', '')}"
            for item in downstream_contexts
        ))
        digest = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:32]
        return f"{_ROUTE_SCAN_CACHE_PREFIX}:{digest}"

    async def _get_downstream_route_scan(
        self,
        primary_context: dict[str, Any],
        downstream_contexts: list[dict[str, Any]],
        now_epoch: int,
    ) -> list[tuple[dict[str, Any], list[_StopPrediction]]]:
        """Return a shared every-other-stop radar snapshot for the route."""
        if not downstream_contexts:
            return []
        cache_key = self._route_scan_cache_key(primary_context, downstream_contexts)
        cached = await self._get_cached_route_scan(cache_key, downstream_contexts)
        if cached is not None:
            return cached

        results = await asyncio.gather(
            *(self._get_context_candidates(item, now_epoch) for item in downstream_contexts),
        )
        scan = [
            (context, candidates)
            for context, (status, candidates) in zip(downstream_contexts, results, strict=True)
            if status == "available"
        ]
        # Only cache a complete scan. A transient provider outage should not
        # turn into two minutes of missing buses.
        if len(scan) == len(downstream_contexts):
            await self._set_cached_route_scan(cache_key, scan)
        return scan

    async def _get_cached_route_scan(
        self,
        cache_key: str,
        contexts: list[dict[str, Any]],
    ) -> list[tuple[dict[str, Any], list[_StopPrediction]]] | None:
        if self._cache is None:
            return None
        try:
            value = await self._cache.get_json(cache_key)
        except Exception:
            logger.warning("TMB iBus route scan cache read failed")
            return None
        if not isinstance(value, list) or len(value) != len(contexts):
            return None
        records: dict[str, list[_StopPrediction]] = {}
        for item in value:
            if not isinstance(item, dict) or not isinstance(item.get("stop_id"), str):
                return None
            raw_predictions = item.get("predictions")
            if not isinstance(raw_predictions, list):
                return None
            predictions = [_prediction_from_cache(raw) for raw in raw_predictions]
            if any(prediction is None for prediction in predictions):
                return None
            records[item["stop_id"]] = [
                prediction for prediction in predictions if prediction is not None
            ]
        if {str(context.get("stop_id", "")) for context in contexts} != set(records):
            return None
        return [(context, records[str(context["stop_id"])] ) for context in contexts]

    async def _set_cached_route_scan(
        self,
        cache_key: str,
        scan: list[tuple[dict[str, Any], list[_StopPrediction]]],
    ) -> None:
        if self._cache is None:
            return
        try:
            await self._cache.set_json(
                cache_key,
                [
                    {
                        "stop_id": context["stop_id"],
                        "predictions": [prediction.to_cache() for prediction in predictions],
                    }
                    for context, predictions in scan
                ],
                ttl=self._settings.TMB_IBUS_ROUTE_SCAN_TTL_SECONDS,
            )
        except Exception:
            logger.warning("TMB iBus route scan cache write failed")

    @property
    def _configured(self) -> bool:
        return bool(self._settings.TMB_APP_ID and self._settings.TMB_APP_KEY)

    @staticmethod
    def _empty_summary(
        status: Literal["available", "unconfigured", "rate_limited", "unavailable"],
        stop_id: str,
        stop_name: str,
    ) -> IbusFleetSummary:
        return IbusFleetSummary(status=status, stop_id=stop_id, stop_name=stop_name)

    @staticmethod
    def _to_public_prediction(
        prediction: _StopPrediction | None,
        now_epoch: int,
    ) -> IbusVehiclePrediction | None:
        if prediction is None:
            return None
        return IbusVehiclePrediction(
            vehicle_id=prediction.vehicle_id,
            arrival_epoch=prediction.arrival_epoch,
            eta_seconds=min(_MAX_ETA_SECONDS, max(0, prediction.arrival_epoch - now_epoch)),
            destination_name=prediction.destination_name,
        )

    def _to_ahead_position(
        self,
        value: tuple[dict[str, Any], _StopPrediction] | None,
        now_epoch: int,
    ) -> IbusAheadPosition | None:
        if value is None:
            return None
        context, prediction = value
        public_prediction = self._to_public_prediction(prediction, now_epoch)
        if public_prediction is None:
            return None
        return IbusAheadPosition(
            stop_id=str(context["stop_id"]),
            stop_name=str(context.get("stop_name", "")),
            stop_sequence=_bounded_int(context.get("stop_sequence"), 0, 10_000) or 0,
            prediction=public_prediction,
        )

    def _to_route_positions(
        self,
        values: list[tuple[dict[str, Any], _StopPrediction, Literal["ahead", "behind"]]],
        now_epoch: int,
    ) -> list[IbusRoutePosition]:
        positions: list[IbusRoutePosition] = []
        for context, prediction, relation in values:
            public_prediction = self._to_public_prediction(prediction, now_epoch)
            if public_prediction is None:
                continue
            positions.append(IbusRoutePosition(
                stop_id=str(context["stop_id"]),
                stop_name=str(context.get("stop_name", "")),
                stop_sequence=_bounded_int(context.get("stop_sequence"), 0, 10_000) or 0,
                relation=relation,
                prediction=public_prediction,
            ))
        return positions

    async def _get_stop_predictions(
        self,
        stop_code: str,
    ) -> tuple[LookupStatus, list[_StopPrediction]]:
        cached = await self._get_cached_predictions(stop_code)
        if cached is not None:
            return "available", cached

        async with self._inflight_lock:
            task = self._inflight.get(stop_code)
            if task is None:
                task = asyncio.create_task(
                    self._lookup_and_cache(stop_code),
                    name="tmb-ibus-stop-lookup",
                )
                self._inflight[stop_code] = task
        try:
            return await asyncio.shield(task)
        finally:
            if task.done():
                async with self._inflight_lock:
                    if self._inflight.get(stop_code) is task:
                        self._inflight.pop(stop_code, None)

    async def _lookup_and_cache(self, stop_code: str) -> tuple[LookupStatus, list[_StopPrediction]]:
        cached = await self._get_cached_predictions(stop_code)
        if cached is not None:
            return "available", cached

        if self._cache is not None and not await self._acquire_lock(stop_code):
            cached = await self._wait_for_cached_predictions(stop_code)
            if cached is not None:
                return "available", cached

        if not await self._provider_request_allowed():
            return "rate_limited", []

        status, predictions = await self._fetch_stop_predictions(stop_code)
        if status == "available":
            await self._set_cached_predictions(stop_code, predictions)
        return status, predictions

    @staticmethod
    def _cache_key(stop_code: str) -> str:
        return f"{_CACHE_PREFIX}:{stop_code}"

    @staticmethod
    def _lock_key(stop_code: str) -> str:
        return f"{_LOCK_PREFIX}:{stop_code}"

    async def _get_cached_predictions(self, stop_code: str) -> list[_StopPrediction] | None:
        if self._cache is None:
            return None
        try:
            value = await self._cache.get_json(self._cache_key(stop_code))
        except Exception:
            logger.warning("TMB iBus cache read failed")
            return None
        if not isinstance(value, list):
            return None
        predictions = [_prediction_from_cache(item) for item in value]
        if any(item is None for item in predictions):
            return None
        return [item for item in predictions if item is not None]

    async def _set_cached_predictions(
        self,
        stop_code: str,
        predictions: list[_StopPrediction],
    ) -> None:
        if self._cache is None:
            return
        try:
            await self._cache.set_json(
                self._cache_key(stop_code),
                [item.to_cache() for item in predictions],
                ttl=self._settings.TMB_IBUS_CACHE_TTL_SECONDS,
            )
        except Exception:
            logger.warning("TMB iBus cache write failed")

    async def _acquire_lock(self, stop_code: str) -> bool:
        assert self._cache is not None
        try:
            result = await self._cache.client.set(
                self._lock_key(stop_code),
                b"1",
                nx=True,
                ex=_LOOKUP_LOCK_SECONDS,
            )
            return bool(result)
        except Exception:
            if self._settings.ENVIRONMENT == "production":
                logger.error("TMB iBus lock unavailable — lookup rejected")
                return False
            logger.warning("TMB iBus lock unavailable — development lookup allowed")
            return True

    async def _wait_for_cached_predictions(self, stop_code: str) -> list[_StopPrediction] | None:
        attempts = int(_LOOKUP_WAIT_SECONDS / _LOOKUP_POLL_SECONDS)
        for _ in range(attempts):
            await asyncio.sleep(_LOOKUP_POLL_SECONDS)
            cached = await self._get_cached_predictions(stop_code)
            if cached is not None:
                return cached
        return None

    async def _provider_request_allowed(self) -> bool:
        if time.monotonic() < self._circuit_open_until:
            return False
        if self._cache is None:
            return True
        try:
            if await self._cache.exists(_CIRCUIT_KEY):
                return False
            now = int(time.time())
            minute_key = f"{_QUOTA_MINUTE_PREFIX}:{now // 60}"
            day_key = f"{_QUOTA_DAY_PREFIX}:{now // 86_400}"
            pipe = self._cache.client.pipeline(transaction=True)
            pipe.incr(minute_key)
            pipe.expire(minute_key, 65)
            pipe.incr(day_key)
            pipe.expire(day_key, 86_405)
            minute_count, _minute_expiry, day_count, _day_expiry = await pipe.execute()
            return bool(
                int(minute_count) <= self._settings.TMB_IBUS_GLOBAL_REQUESTS_PER_MINUTE
                and int(day_count) <= self._settings.TMB_IBUS_GLOBAL_REQUESTS_PER_DAY
            )
        except Exception:
            if self._settings.ENVIRONMENT == "production":
                logger.error("TMB iBus quota unavailable — lookup rejected")
                return False
            logger.warning("TMB iBus quota unavailable — development lookup allowed")
            return True

    async def _open_circuit(self) -> None:
        ttl = self._settings.TMB_IBUS_PROVIDER_CIRCUIT_SECONDS
        self._circuit_open_until = time.monotonic() + ttl
        if self._cache is None:
            return
        try:
            await self._cache.set(_CIRCUIT_KEY, b"1", ttl=ttl)
        except Exception:
            logger.warning("TMB iBus circuit marker could not be persisted")

    async def _fetch_stop_predictions(
        self,
        stop_code: str,
    ) -> tuple[LookupStatus, list[_StopPrediction]]:
        if self._client is None:
            await self.start()
        assert self._client is not None

        base_url = self._settings.TMB_API_BASE_URL.rstrip("/")
        url = f"{base_url}/itransit/bus/parades/{stop_code}"
        if not _is_allowed_tmb_endpoint(url):
            logger.warning("TMB iBus provider configuration rejected")
            return "unavailable", []

        try:
            body = bytearray()
            async with self._client.stream(
                "GET",
                url,
                params={
                    "app_id": self._settings.TMB_APP_ID,
                    "app_key": self._settings.TMB_APP_KEY,
                },
            ) as response:
                provider_rate_limits = _provider_rate_limit_headers(response.headers)
                if provider_rate_limits and provider_rate_limits != self._last_provider_rate_limits:
                    self._last_provider_rate_limits = provider_rate_limits
                    logger.info("TMB iBus provider rate limits: %s", dict(provider_rate_limits))
                if response.status_code == 429:
                    await self._open_circuit()
                    return "rate_limited", []
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").lower()
                if content_type and "json" not in content_type:
                    raise TypeError
                content_length = response.headers.get("content-length")
                if content_length and int(content_length) > _MAX_RESPONSE_BYTES:
                    raise ValueError
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > _MAX_RESPONSE_BYTES:
                        raise ValueError
            payload = orjson.loads(body)
            return "available", _parse_tmb_ibus_payload(payload, now_epoch=int(time.time()))
        except (httpx.HTTPError, ValueError, TypeError, AttributeError, OverflowError, orjson.JSONDecodeError):
            # Do not include exceptions in the log: HTTP errors include the complete
            # request URL and therefore the server-only app_key query parameter.
            logger.warning("TMB iBus provider lookup failed")
            return "unavailable", []


def _parse_tmb_ibus_payload(payload: object, *, now_epoch: int) -> list[_StopPrediction]:
    if not isinstance(payload, dict):
        return []
    stops = payload.get("parades")
    if not isinstance(stops, list):
        return []

    parsed: list[_StopPrediction] = []
    for stop in stops[:4]:
        if not isinstance(stop, dict):
            continue
        lines = stop.get("linies_trajectes")
        if not isinstance(lines, list):
            continue
        for line_item in lines[:100]:
            if not isinstance(line_item, dict):
                continue
            line = _safe_text(line_item.get("codi_linia"), maximum=64)
            destination = _safe_text(line_item.get("desti_trajecte"), maximum=300)
            if not line:
                continue
            upcoming = line_item.get("propers_busos")
            if not isinstance(upcoming, list):
                continue
            for bus in upcoming[:_MAX_PREDICTIONS_PER_STOP]:
                if not isinstance(bus, dict):
                    continue
                # TMB's live response currently omits id_bus. Retain it when
                # available, but do not discard a perfectly valid prediction
                # just because it cannot identify a physical bus.
                vehicle_id = _safe_text(bus.get("id_bus"), maximum=160)
                arrival_epoch = _parse_arrival_epoch(bus.get("temps_arribada"), now_epoch)
                if arrival_epoch is None:
                    continue
                parsed.append(
                    _StopPrediction(
                        vehicle_id=vehicle_id,
                        line=line,
                        destination_name=destination,
                        arrival_epoch=arrival_epoch,
                    )
                )
    deduplicated: dict[tuple[str, str, int], _StopPrediction] = {}
    for prediction in parsed:
        deduplicated[(prediction.vehicle_id, prediction.line, prediction.arrival_epoch)] = prediction
    return sorted(deduplicated.values(), key=lambda item: (item.arrival_epoch, item.vehicle_id))[
        :_MAX_PREDICTIONS_PER_STOP
    ]


def _parse_amb_gtfs_rt_payload(payload: bytes, *, now_epoch: int) -> list[_AMBTripPrediction]:
    """Decode AMB's public trip updates into static GTFS identities.

    The AMB feed omits both ``route_id`` and the ``AMB_`` namespace used by
    ATM's static GTFS.  Its trip IDs are nevertheless the same identifiers
    without that prefix (for example ``415.35.2.3.29``), which lets us safely
    join a prediction to the exact route and stop pattern held in Redis.
    """
    message = gtfs_realtime_pb2.FeedMessage()
    message.ParseFromString(payload)
    if (
        message.header.incrementality != gtfs_realtime_pb2.FeedHeader.FULL_DATASET
        or not message.header.HasField("timestamp")
        or not now_epoch - 120 <= int(message.header.timestamp) <= now_epoch + 30
        or len(message.entity) > _MAX_AMB_RT_ENTITIES
    ):
        return []

    total_stop_updates = 0
    parsed: list[_AMBTripPrediction] = []
    for entity in message.entity:
        if not entity.HasField("trip_update"):
            continue
        update = entity.trip_update
        raw_trip_id = _safe_text(update.trip.trip_id if update.HasField("trip") else "", maximum=160)
        if not _AMB_TRIP_ID_PATTERN.fullmatch(raw_trip_id):
            continue
        route_number = raw_trip_id.split(".", 1)[0]
        stop_arrivals: dict[str, int] = {}
        total_stop_updates += len(update.stop_time_update)
        if total_stop_updates > _MAX_AMB_RT_STOP_UPDATES:
            return []
        for stop_update in update.stop_time_update[:_MAX_PREDICTIONS_PER_STOP]:
            raw_stop_id = _safe_text(stop_update.stop_id, maximum=16)
            if not _STOP_CODE_PATTERN.fullmatch(raw_stop_id):
                continue
            arrival_epoch = None
            if stop_update.HasField("arrival") and stop_update.arrival.HasField("time"):
                arrival_epoch = int(stop_update.arrival.time)
            elif stop_update.HasField("departure") and stop_update.departure.HasField("time"):
                arrival_epoch = int(stop_update.departure.time)
            if arrival_epoch is None or not now_epoch - 60 <= arrival_epoch <= now_epoch + _MAX_ETA_SECONDS:
                continue
            stop_id = f"AMB_{raw_stop_id}"
            prior = stop_arrivals.get(stop_id)
            stop_arrivals[stop_id] = min(prior, arrival_epoch) if prior is not None else arrival_epoch
        if stop_arrivals:
            parsed.append(_AMBTripPrediction(
                trip_id=f"AMB_{raw_trip_id}",
                route_id=f"AMB_{route_number}",
                stop_arrivals=tuple(sorted(stop_arrivals.items(), key=lambda item: item[1])),
            ))
    # A provider snapshot can carry a corrected entity for the same trip.
    # Keep one deterministic, most-complete observation so the rail never
    # draws the same scheduled service twice.
    deduplicated: dict[str, _AMBTripPrediction] = {}
    for prediction in parsed:
        previous = deduplicated.get(prediction.trip_id)
        if previous is None or len(prediction.stop_arrivals) > len(previous.stop_arrivals):
            deduplicated[prediction.trip_id] = prediction
    return [deduplicated[trip_id] for trip_id in sorted(deduplicated)]


def _parse_arrival_epoch(value: object, now_epoch: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(float(value)):
        return None
    raw_value = int(value)
    if raw_value >= 10_000_000_000:  # Milliseconds since epoch.
        raw_value //= 1_000
    if 0 <= raw_value <= 86_400:  # Seconds remaining, used by older iBus responses.
        raw_value = now_epoch + raw_value
    if raw_value < 1_577_836_800 or raw_value > 4_102_444_800:
        return None
    return raw_value


def _safe_text(value: object, *, maximum: int) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return ""
    normalized = str(value).strip()
    if len(normalized) > maximum or not _SAFE_TEXT_PATTERN.fullmatch(normalized):
        return ""
    return normalized


def _normalize_line(value: object) -> str:
    return _safe_text(value, maximum=64).upper().replace(" ", "")


def _bounded_int(value: object, minimum: int, maximum: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        return None
    return value


def _prediction_from_cache(value: object) -> _StopPrediction | None:
    if not isinstance(value, dict):
        return None
    vehicle_id = _safe_text(value.get("vehicle_id"), maximum=160)
    line = _safe_text(value.get("line"), maximum=64)
    destination_name = _safe_text(value.get("destination_name"), maximum=300)
    arrival_epoch = _bounded_int(value.get("arrival_epoch"), 1_577_836_800, 4_102_444_800)
    if not line or arrival_epoch is None:
        return None
    return _StopPrediction(vehicle_id, line, destination_name, arrival_epoch)


def _amb_trip_from_cache(value: object) -> _AMBTripPrediction | None:
    if not isinstance(value, dict):
        return None
    trip_id = _safe_text(value.get("trip_id"), maximum=160)
    route_id = _safe_text(value.get("route_id"), maximum=160)
    raw_arrivals = value.get("stop_arrivals")
    if not trip_id.startswith("AMB_") or not route_id.startswith("AMB_") or not isinstance(raw_arrivals, list):
        return None
    arrivals: list[tuple[str, int]] = []
    for item in raw_arrivals[:_MAX_PREDICTIONS_PER_STOP]:
        if not isinstance(item, dict):
            return None
        stop_id = _safe_text(item.get("stop_id"), maximum=160)
        arrival_epoch = _bounded_int(item.get("arrival_epoch"), 1_577_836_800, 4_102_444_800)
        if not stop_id.startswith("AMB_") or arrival_epoch is None:
            return None
        arrivals.append((stop_id, arrival_epoch))
    return _AMBTripPrediction(trip_id, route_id, tuple(arrivals))


def _same_scheduled_service(
    selected_meta: object,
    candidate_meta: object,
    scheduled_departure_epoch: int | None,
) -> bool:
    """Whether two static trips denote the driver's scheduled service.

    AMB's real-time feed can replace the static trip suffix while retaining
    the scheduled departure.  Treating that replacement as a distinct bus
    would paint the driver's own vehicle on the rail.  A matching GTFS service
    departure is the strongest stable fallback after the exact trip ID.
    """
    if not isinstance(selected_meta, dict) or not isinstance(candidate_meta, dict):
        return False
    selected_departure = _safe_text(selected_meta.get("departure_time"), maximum=9)
    candidate_departure = _safe_text(candidate_meta.get("departure_time"), maximum=9)
    # A valid selected static departure is authoritative.  Do not let a
    # coincident wall-clock minute override a different scheduled trip.
    if selected_departure:
        return selected_departure == candidate_departure
    if scheduled_departure_epoch is None or not candidate_departure:
        return False

    candidate_seconds = _service_time_seconds(candidate_departure)
    if candidate_seconds is None:
        return False
    local = time.localtime(scheduled_departure_epoch)
    scheduled_seconds = local.tm_hour * 3_600 + local.tm_min * 60 + local.tm_sec
    # GTFS permits 24:xx / 25:xx service times.  Compare them on a clock face
    # so a 25:20 service correctly matches a 01:20 wall-clock assignment.
    difference = abs((candidate_seconds % 86_400) - scheduled_seconds)
    return min(difference, 86_400 - difference) <= _SCHEDULED_DEPARTURE_MATCH_SECONDS


def _service_time_seconds(value: str) -> int | None:
    match = re.fullmatch(r"(\d{1,2}):(\d{2}):(\d{2})", value)
    if match is None:
        return None
    hours, minutes, seconds = (int(part) for part in match.groups())
    if hours > 47 or minutes > 59 or seconds > 59:
        return None
    return hours * 3_600 + minutes * 60 + seconds


def _find_reference_prediction(
    predictions: list[_StopPrediction],
    expected_arrival_epoch: int,
) -> int | None:
    ranked = sorted(
        (abs(item.arrival_epoch - expected_arrival_epoch), index)
        for index, item in enumerate(predictions)
    )
    if not ranked or ranked[0][0] > _MATCH_WINDOW_SECONDS:
        return None
    if len(ranked) > 1 and ranked[1][0] - ranked[0][0] < _AMBIGUOUS_MATCH_SECONDS:
        return None
    return ranked[0][1]


def _find_multistop_reference_prediction(
    primary_predictions: list[_StopPrediction],
    primary_expected_epoch: int,
    scheduled_departure_epoch: int,
    downstream: list[tuple[dict[str, Any], list[_StopPrediction]]],
) -> int | None:
    """Choose the scheduled trip prediction using its following stop times.

    TMB currently omits ``id_bus`` for many iBus responses.  A matching delay
    pattern across successive stops is the strongest signal available: one
    candidate's delay at the primary stop should be reproduced at the next
    stops for that same scheduled trip.
    """
    eligible = [
        (index, prediction)
        for index, prediction in enumerate(primary_predictions)
        if abs(prediction.arrival_epoch - primary_expected_epoch) <= _MATCH_WINDOW_SECONDS
    ]
    if not eligible:
        return None
    if not downstream:
        return _find_reference_prediction(primary_predictions, primary_expected_epoch)

    scored: list[tuple[int, int, int, int]] = []
    for index, prediction in eligible:
        delay_seconds = prediction.arrival_epoch - primary_expected_epoch
        supports = 0
        total_error = abs(delay_seconds)
        for context, candidates in downstream:
            offset_seconds = _bounded_int(context.get("scheduled_offset_seconds"), -1, 86_400)
            if offset_seconds is None:
                continue
            expected_epoch = scheduled_departure_epoch + offset_seconds + delay_seconds
            nearest_error = min(
                (abs(candidate.arrival_epoch - expected_epoch) for candidate in candidates),
                default=None,
            )
            if nearest_error is not None and nearest_error <= _MULTI_STOP_MATCH_WINDOW_SECONDS:
                supports += 1
                total_error += nearest_error
        scored.append((-supports, total_error, abs(delay_seconds), index))

    scored.sort()
    best = scored[0]
    # At least one downstream observation breaks a close same-stop tie. With
    # no corroboration retain the conservative single-stop ambiguity guard.
    if -best[0] == 0:
        return _find_reference_prediction(primary_predictions, primary_expected_epoch)
    if len(scored) > 1 and scored[1][0] == best[0] and scored[1][1] - best[1] < _AMBIGUOUS_MATCH_SECONDS:
        return None
    return best[3]


def _find_downstream_ahead_position(
    downstream: list[tuple[dict[str, Any], list[_StopPrediction]]],
    scheduled_departure_epoch: int | None,
    now_epoch: int,
) -> tuple[dict[str, Any], _StopPrediction] | None:
    """Locate the nearest preceding service at one of the next route stops."""
    if scheduled_departure_epoch is None:
        return None

    observations: list[tuple[int, int, dict[str, Any], _StopPrediction]] = []
    for context, candidates in downstream:
        offset_seconds = _bounded_int(context.get("scheduled_offset_seconds"), -1, 86_400)
        sequence = _bounded_int(context.get("stop_sequence"), 0, 10_000)
        if offset_seconds is None or sequence is None:
            continue
        expected_own_arrival = scheduled_departure_epoch + offset_seconds
        preceding = [
            candidate
            for candidate in candidates
            if candidate.arrival_epoch <= expected_own_arrival - _AHEAD_POSITION_MIN_LEAD_SECONDS
            and candidate.arrival_epoch <= now_epoch + _AHEAD_POSITION_MAX_ETA_SECONDS
        ]
        if not preceding:
            continue
        # The latest arrival before our own scheduled arrival is the service
        # directly ahead, rather than an older unrelated departure.
        candidate = max(preceding, key=lambda item: item.arrival_epoch)
        observations.append((sequence, candidate.arrival_epoch, context, candidate))

    if not observations:
        return None
    # A bus observed at the furthest downstream imminent stop is visibly the
    # best position cue for the journey rail. Ties use the more recent arrival.
    _, _, context, prediction = max(observations, key=lambda item: (item[0], item[1]))
    return context, prediction


def _find_route_positions(
    observations: list[tuple[dict[str, Any], list[_StopPrediction]]],
    scheduled_departure_epoch: int | None,
    now_epoch: int,
) -> list[tuple[dict[str, Any], _StopPrediction, Literal["ahead", "behind"]]]:
    """Infer the visible services along a route from every-other-stop ETAs.

    No identifier is present in many iBus responses.  Normalising an ETA by
    its scheduled stop offset produces an approximate journey start epoch;
    matching values across sampled stops are treated as one service.  The
    earliest predicted stop in that group is the best on-route position cue.
    """
    if scheduled_departure_epoch is None:
        return []

    candidates: list[tuple[int, dict[str, Any], _StopPrediction]] = []
    for context, predictions in observations:
        offset_seconds = _bounded_int(context.get("scheduled_offset_seconds"), -1, 86_400)
        if offset_seconds is None:
            continue
        for prediction in predictions:
            if not now_epoch - 60 <= prediction.arrival_epoch <= now_epoch + _ROUTE_POSITION_MAX_ETA_SECONDS:
                continue
            candidates.append((prediction.arrival_epoch - offset_seconds, context, prediction))
    if not candidates:
        return []

    candidates.sort(key=lambda item: (item[0], item[2].arrival_epoch))
    groups: list[list[tuple[int, dict[str, Any], _StopPrediction]]] = []
    for candidate in candidates:
        if not groups or candidate[0] - groups[-1][-1][0] > _ROUTE_POSITION_CLUSTER_SECONDS:
            groups.append([candidate])
        else:
            groups[-1].append(candidate)

    positions: list[tuple[dict[str, Any], _StopPrediction, Literal["ahead", "behind"]]] = []
    for group in groups:
        representative_epoch = round(sum(item[0] for item in group) / len(group))
        gap_seconds = representative_epoch - scheduled_departure_epoch
        if abs(gap_seconds) < _AHEAD_POSITION_MIN_LEAD_SECONDS:
            # This is the selected service; its normal route marker already
            # represents the driver and must not be duplicated.
            continue
        relation: Literal["ahead", "behind"] = "ahead" if gap_seconds < 0 else "behind"
        # A bus is closest to its earliest still-predicted sampled stop, not
        # to the final stop where that same journey has a future ETA.
        _, context, prediction = min(
            group,
            key=lambda item: (item[2].arrival_epoch, -(_bounded_int(item[1].get("stop_sequence"), 0, 10_000) or 0)),
        )
        positions.append((context, prediction, relation))

    return sorted(
        positions,
        key=lambda item: (
            _bounded_int(item[0].get("stop_sequence"), 0, 10_000) or 0,
            item[1].arrival_epoch,
        ),
    )[:_MAX_ROUTE_POSITIONS]


def _find_inferred_adjacent_predictions(
    observations: list[tuple[dict[str, Any], list[_StopPrediction]]],
    *,
    reference_arrival_epoch: int,
    reference_stop_offset_seconds: int | None,
) -> tuple[
    tuple[dict[str, Any], _StopPrediction, int] | None,
    tuple[dict[str, Any], _StopPrediction, int] | None,
]:
    """Locate adjacent inferred journeys when neither reaches the current stop.

    iBus only reports a bus after it has entered a stop's prediction horizon.
    A successor that has just left the terminus therefore has no arrival at the
    driver's current stop yet.  Normalize every sampled arrival by its static
    stop offset to compare each journey's live start with the selected bus.
    """
    if reference_stop_offset_seconds is None:
        return None, None
    reference_start_epoch = reference_arrival_epoch - reference_stop_offset_seconds
    ahead: tuple[dict[str, Any], _StopPrediction, int] | None = None
    behind: tuple[dict[str, Any], _StopPrediction, int] | None = None
    for context, predictions in observations:
        offset_seconds = _bounded_int(context.get("scheduled_offset_seconds"), -1, 86_400)
        if offset_seconds is None:
            continue
        for prediction in predictions:
            gap_seconds = prediction.arrival_epoch - offset_seconds - reference_start_epoch
            if gap_seconds <= -_AHEAD_POSITION_MIN_LEAD_SECONDS:
                if ahead is None or gap_seconds > -ahead[2]:
                    ahead = (context, prediction, -gap_seconds)
            elif gap_seconds >= _AHEAD_POSITION_MIN_LEAD_SECONDS:
                if behind is None or gap_seconds < behind[2]:
                    behind = (context, prediction, gap_seconds)
    return ahead, behind


def _provider_rate_limit_headers(headers: httpx.Headers) -> tuple[tuple[str, str], ...]:
    """Keep only standard, non-sensitive provider quota headers for diagnostics."""
    result: list[tuple[str, str]] = []
    for name, value in headers.items():
        normalized_name = name.lower()
        if normalized_name not in _RATE_LIMIT_HEADER_NAMES and not normalized_name.startswith("x-ratelimit-"):
            continue
        # Standard RateLimit values are compact structured numeric strings.
        # Ignore malformed values rather than placing arbitrary server headers
        # into logs.
        normalized_value = value.strip()
        if not normalized_value or len(normalized_value) > 120:
            continue
        if not all(character.isalnum() or character in " -_=;,./" for character in normalized_value):
            continue
        result.append((normalized_name, normalized_value))
    return tuple(sorted(result))


def _is_allowed_tmb_endpoint(raw_url: str) -> bool:
    try:
        parsed = urlsplit(raw_url)
        port = parsed.port
    except (TypeError, ValueError):
        return False
    return (
        parsed.scheme == "https"
        and parsed.hostname in _ALLOWED_TMB_API_HOSTS
        and parsed.username is None
        and parsed.password is None
        and port in (None, 443)
        and parsed.query == ""
        and parsed.path.startswith("/v1/itransit/bus/parades/")
    )


def _is_allowed_amb_rt_endpoint(raw_url: str) -> bool:
    """Allow only AMB's documented public trip-updates feed."""
    try:
        parsed = urlsplit(raw_url)
        port = parsed.port
    except (TypeError, ValueError):
        return False
    return (
        parsed.scheme == "https"
        and parsed.hostname in _ALLOWED_AMB_RT_HOSTS
        and port is None
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
        and parsed.path == "/transit/trips-updates/trips.bin"
    )
