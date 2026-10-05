"""Seasons, event calendars and service status."""
from datetime import datetime, timezone

import pandas as pd
from fastapi import APIRouter

from app.config import MIN_SEASON
from app.data import get_schedule, store
from app.serialize import clean

router = APIRouter(prefix="/api", tags=["calendar"])


@router.get("/seasons", summary="Seasons with FastF1 timing data")
def seasons():
    now = datetime.now(timezone.utc).year
    return {"seasons": list(range(now, MIN_SEASON - 1, -1))}


@router.get("/seasons/{year}/events", summary="Event calendar with session names and UTC start times")
def events(year: int):
    sched = get_schedule(year)
    now = pd.Timestamp.now(tz="UTC").tz_localize(None)
    out = []
    for _, ev in sched.iterrows():
        sessions = []
        for i in range(1, 6):
            name = ev.get(f"Session{i}")
            if not name or pd.isna(name):
                continue
            start = ev.get(f"Session{i}DateUtc")
            start = pd.Timestamp(start) if pd.notna(start) else None
            sessions.append({
                "name": name,
                "code": _session_code(name),
                "start_utc": clean(start),
                "available": bool(start is not None and start < now),
            })
        out.append({
            "round": int(ev["RoundNumber"]),
            "name": ev["EventName"],
            "official_name": ev["OfficialEventName"],
            "country": ev["Country"],
            "location": ev["Location"],
            "date": clean(ev["EventDate"]),
            "format": ev["EventFormat"],
            "sessions": sessions,
        })
    return {"year": year, "events": out}


@router.get("/status", tags=["meta"], summary="Sessions currently held in memory")
def status():
    return {"loaded_sessions": [{"year": y, "event": e, "session": s} for y, e, s in store.loaded()]}


_CODES = {
    "Practice 1": "FP1", "Practice 2": "FP2", "Practice 3": "FP3",
    "Qualifying": "Q", "Sprint Qualifying": "SQ", "Sprint Shootout": "SS",
    "Sprint": "S", "Race": "R",
}


def _session_code(name: str) -> str:
    return _CODES.get(name, name)
