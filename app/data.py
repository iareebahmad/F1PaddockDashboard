"""Data access layer: FastF1 sessions, schedules and Ergast/Jolpica standings.

Loading a session is slow (network + parsing), so sessions are kept in a small
in-memory LRU on top of FastF1's on-disk HTTP cache. Each session key gets its own
lock so concurrent requests for the same session wait for one load instead of
triggering several.
"""
from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from functools import lru_cache

import fastf1
import pandas as pd
from fastapi import HTTPException
from fastf1.ergast import Ergast

from app.config import CACHE_DIR, MIN_SEASON, SESSION_MEMORY_SLOTS

log = logging.getLogger("f1paddock")

CACHE_DIR.mkdir(parents=True, exist_ok=True)
fastf1.Cache.enable_cache(str(CACHE_DIR))
fastf1.set_log_level("WARNING")

SESSION_CODES = {"FP1", "FP2", "FP3", "Q", "SQ", "SS", "S", "R"}


class _SessionStore:
    def __init__(self, slots: int):
        self.slots = slots
        self._sessions: OrderedDict[tuple, fastf1.core.Session] = OrderedDict()
        self._locks: dict[tuple, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock_for(self, key: tuple) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    def get(self, year: int, event: int | str, code: str) -> fastf1.core.Session:
        key = (year, str(event).lower(), code)
        with self._guard:
            if key in self._sessions:
                self._sessions.move_to_end(key)
                return self._sessions[key]
        with self._lock_for(key):
            with self._guard:
                if key in self._sessions:
                    return self._sessions[key]
            session = _load_session(year, event, code)
            with self._guard:
                self._sessions[key] = session
                while len(self._sessions) > self.slots:
                    self._sessions.popitem(last=False)
            return session

    def loaded(self) -> list[tuple]:
        with self._guard:
            return list(self._sessions.keys())


def _validate(year: int, code: str) -> None:
    if year < MIN_SEASON:
        raise HTTPException(400, f"FastF1 timing data starts in {MIN_SEASON}.")
    if code not in SESSION_CODES:
        raise HTTPException(400, f"Unknown session '{code}'. Use one of {sorted(SESSION_CODES)}.")


def _load_session(year: int, event: int | str, code: str) -> fastf1.core.Session:
    _validate(year, code)
    try:
        session = fastf1.get_session(year, event, code)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    start = pd.Timestamp(session.date) if session.date is not None else None
    if start is not None and start.tzinfo is not None:
        start = start.tz_convert("UTC").tz_localize(None)
    if start is not None and start > pd.Timestamp.now(tz="UTC").tz_localize(None):
        raise HTTPException(409, f"{session.event['EventName']} {code} has not happened yet.")
    log.info("Loading %s %s %s", year, event, code)
    try:
        session.load(laps=True, telemetry=True, weather=True, messages=True)
        _ = session.laps  # raises DataNotLoadedError if the timing feed was unavailable
    except Exception as exc:  # FastF1 raises a variety of errors for missing feeds
        raise HTTPException(502, f"Could not load session data: {exc}") from exc
    return session


store = _SessionStore(SESSION_MEMORY_SLOTS)


def get_session(year: int, event: str, code: str) -> fastf1.core.Session:
    """`event` may be a round number ("12") or a fuzzy event name ("Monza")."""
    ev: int | str = int(event) if str(event).isdigit() else event
    return store.get(year, ev, code.upper())


@lru_cache(maxsize=16)
def _schedule_cached(year: int, day: str) -> pd.DataFrame:
    # `day` is part of the cache key so a long-running server refreshes daily.
    return fastf1.get_event_schedule(year, include_testing=False)


def get_schedule(year: int) -> pd.DataFrame:
    if year < MIN_SEASON:
        raise HTTPException(400, f"FastF1 timing data starts in {MIN_SEASON}.")
    try:
        return _schedule_cached(year, datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    except Exception as exc:
        raise HTTPException(502, f"Could not fetch schedule: {exc}") from exc


_ergast = Ergast(result_type="pandas", auto_cast=True)


@lru_cache(maxsize=256)
def _standings_cached(kind: str, year: int, rnd: int | None, day: str) -> pd.DataFrame:
    fn = _ergast.get_driver_standings if kind == "drivers" else _ergast.get_constructor_standings
    resp = fn(season=year, round=rnd) if rnd else fn(season=year)
    if not resp.content:
        return pd.DataFrame()
    df = resp.content[0].copy()
    df["round"] = int(resp.description["round"].iloc[0])
    return df


def get_standings(kind: str, year: int, rnd: int | None = None) -> pd.DataFrame:
    try:
        return _standings_cached(kind, year, rnd, datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    except Exception as exc:
        raise HTTPException(502, f"Could not fetch standings: {exc}") from exc
