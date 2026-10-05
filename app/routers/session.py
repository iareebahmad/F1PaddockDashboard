"""Everything scoped to a single session: timing, telemetry, strategy, statistics, exports.

`event` is a round number or a fuzzy event name; `session` is FP1/FP2/FP3/Q/SQ/S/R.
"""
from __future__ import annotations

import io
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response, StreamingResponse

from app.config import DEFAULT_FUEL_EFFECT
from app.data import get_session
from app.serialize import clean, df_columns, df_records, flatten_timedeltas
from app.services import analytics as an

router = APIRouter(prefix="/api/sessions/{year}/{event}/{session}", tags=["session"])

FuelQ = Query(DEFAULT_FUEL_EFFECT, ge=0, le=0.2, description="Seconds of lap time per lap of fuel on board")


def _drivers_param(raw: str | None, session) -> list[str]:
    if not raw:
        return []
    known = set(session.laps["Driver"].unique())
    picked = [d.strip().upper() for d in raw.split(",") if d.strip()]
    unknown = [d for d in picked if d not in known]
    if unknown:
        raise HTTPException(404, f"Unknown driver(s) for this session: {', '.join(unknown)}")
    return picked


def _driver_lap(session, driver: str, lap: str):
    laps = session.laps.pick_drivers(driver)
    if laps.empty:
        raise HTTPException(404, f"No laps for {driver}")
    if lap == "fastest":
        chosen = laps.pick_fastest()
        if chosen is None or (hasattr(chosen, "empty") and chosen.empty):
            raise HTTPException(404, f"{driver} has no timed lap")
        return chosen
    if not lap.isdigit():
        raise HTTPException(400, "lap must be 'fastest' or a lap number")
    match = laps[laps["LapNumber"] == int(lap)]
    if match.empty:
        raise HTTPException(404, f"{driver} has no lap {lap}")
    return match.iloc[0]


# --------------------------------------------------------------------------- overview

@router.get("", summary="Session info, classification and driver directory")
def overview(year: int, event: str, session: str):
    s = get_session(year, event, session)
    res = s.results.copy()
    laps = an.with_seconds(s.laps)
    fastest = s.laps.pick_fastest()
    drivers = [
        {
            "code": r.Abbreviation, "number": r.DriverNumber, "name": r.FullName, "team": r.TeamName,
            "team_color": f"#{r.TeamColor}" if isinstance(r.TeamColor, str) and r.TeamColor else None,
            "headshot": r.HeadshotUrl if isinstance(r.HeadshotUrl, str) else None,
        }
        for r in res.itertuples()
        if isinstance(r.Abbreviation, str) and r.Abbreviation in set(s.laps["Driver"])
    ]
    classification = df_records(
        res,
        ["Position", "ClassifiedPosition", "Abbreviation", "FullName", "TeamName", "GridPosition",
         "Q1", "Q2", "Q3", "Time", "Status", "Points", "Laps"],
    )
    weather = s.weather_data
    return {
        "event": {
            "name": s.event["EventName"], "round": int(s.event["RoundNumber"]), "country": s.event["Country"],
            "location": s.event["Location"], "session": s.name, "date": clean(s.date),
            "total_laps": clean(getattr(s, "total_laps", None)),
        },
        "kpis": {
            "laps_completed": int(laps["LapNumber"].max()) if len(laps) else 0,
            "timed_laps": int(laps["LapTimeS"].notna().sum()),
            "fastest_lap": {
                "driver": fastest["Driver"] if fastest is not None else None,
                "time": clean(fastest["LapTime"]) if fastest is not None else None,
                "lap": clean(fastest["LapNumber"]) if fastest is not None else None,
                "compound": fastest["Compound"] if fastest is not None else None,
            },
            "top_speed": clean(laps["SpeedST"].max()),
            "top_speed_driver": laps.loc[laps["SpeedST"].idxmax(), "Driver"] if laps["SpeedST"].notna().any() else None,
            "pit_stops": int(s.laps["PitInTime"].notna().sum()),
            "track_temp_range": [clean(weather["TrackTemp"].min()), clean(weather["TrackTemp"].max())] if len(weather) else None,
            "air_temp_range": [clean(weather["AirTemp"].min()), clean(weather["AirTemp"].max())] if len(weather) else None,
            "rain": bool(weather["Rainfall"].any()) if len(weather) else False,
        },
        "drivers": drivers,
        "classification": classification,
    }


# --------------------------------------------------------------------------- laps & pace

@router.get("/laps", summary="Lap-by-lap timing (times in seconds)")
def laps(
    year: int, event: str, session: str,
    drivers: str | None = Query(None, description="Comma separated codes, e.g. VER,NOR"),
    clean_only: bool = Query(False, description="Drop pit, non-green, deleted and >107% laps"),
):
    s = get_session(year, event, session)
    df = an.clean_laps(s.laps) if clean_only else an.with_seconds(s.laps)
    picked = _drivers_param(drivers, s)
    if picked:
        df = df[df["Driver"].isin(picked)]
    cols = ["Driver", "Team", "LapNumber", "LapTimeS", "S1", "S2", "S3", "Compound", "TyreLife", "Stint",
            "Position", "TrackStatus", "SpeedST", "SpeedFL", "SpeedI1", "SpeedI2", "PitInS", "PitOutS",
            "IsPersonalBest", "Deleted", "IsAccurate", "SessionTimeS"]
    return {"count": len(df), "laps": df_records(df.sort_values(["Driver", "LapNumber"]), cols)}


@router.get("/pace", summary="Lap-time distributions and dispersion statistics per driver")
def pace(
    year: int, event: str, session: str,
    threshold: float = Query(1.07, ge=1.0, le=1.5, description="Keep laps within this ratio of the fastest"),
    fuel_correct: bool = Query(False),
    fuel_effect: float = FuelQ,
):
    s = get_session(year, event, session)
    df = an.clean_laps(s.laps, quick_threshold=threshold)
    col = "LapTimeS"
    if fuel_correct and len(df):
        df = df.assign(Corrected=an.fuel_corrected(df, fuel_effect, getattr(s, "total_laps", None)))
        col = "Corrected"
    summary = an.pace_summary(df, col)
    dist = {d: [clean(v) for v in g[col]] for d, g in df.groupby("Driver")}
    return {"metric": col, "summary": df_records(summary), "distributions": dist,
            "laps": df_records(df, ["Driver", "LapNumber", col, "Compound", "TyreLife", "Stint"])}


@router.get("/h2h", summary="Statistical head-to-head of two drivers' clean-lap pace")
def h2h(
    year: int, event: str, session: str,
    a: str = Query(..., description="Driver A code"),
    b: str = Query(..., description="Driver B code"),
    threshold: float = Query(1.07, ge=1.0, le=1.5),
    fuel_correct: bool = Query(True),
    fuel_effect: float = FuelQ,
    compound: str | None = Query(None, description="Restrict to one compound, e.g. MEDIUM"),
):
    s = get_session(year, event, session)
    a, b = _drivers_param(f"{a},{b}", s)
    df = an.clean_laps(s.laps, quick_threshold=threshold)
    if compound:
        df = df[df["Compound"] == compound.upper()]
    col = "LapTimeS"
    if fuel_correct and len(df):
        df = df.assign(Corrected=an.fuel_corrected(df, fuel_effect, getattr(s, "total_laps", None)))
        col = "Corrected"
    ra, rb = df[df["Driver"] == a], df[df["Driver"] == b]
    result = {k: clean(v) if not isinstance(v, list) else [clean(x) for x in v]
              for k, v in an.head_to_head(ra[col], rb[col]).items()}
    return {
        "a": a, "b": b, "metric": col, "compound": compound, "result": result,
        "summary_a": {k: clean(v) for k, v in an.describe_times(ra[col]).items()},
        "summary_b": {k: clean(v) for k, v in an.describe_times(rb[col]).items()},
        "laps_a": df_records(ra, ["LapNumber", col, "Compound", "TyreLife"]),
        "laps_b": df_records(rb, ["LapNumber", col, "Compound", "TyreLife"]),
    }


# --------------------------------------------------------------------------- strategy

@router.get("/strategy", summary="Tyre stints and pit-lane times")
def strategy(year: int, event: str, session: str):
    s = get_session(year, event, session)
    order = [d for d in s.results["Abbreviation"].tolist() if isinstance(d, str)]
    st = an.stints(s.laps)
    st["order"] = st["Driver"].map({d: i for i, d in enumerate(order)}).fillna(99)
    st = st.sort_values(["order", "Stint"]).drop(columns="order")
    return {"driver_order": order, "stints": df_records(st), "pit_stops": df_records(an.pit_stops(s.laps))}


@router.get("/degradation", summary="Fuel-corrected tyre degradation regression (per stint and per compound)")
def degradation(
    year: int, event: str, session: str,
    fuel_effect: float = FuelQ,
    min_laps: int = Query(5, ge=3, le=40),
    threshold: float = Query(1.07, ge=1.0, le=1.5),
):
    s = get_session(year, event, session)
    out = an.degradation(s.laps, fuel_effect=fuel_effect, total_laps=getattr(s, "total_laps", None),
                         min_laps=min_laps, quick_threshold=threshold)
    return {
        "fuel_effect": fuel_effect,
        "stints": [{k: clean(v) for k, v in r.items()} for r in out["stints"]],
        "compounds": [{k: (clean(v) if not isinstance(v, list) else [clean(x) for x in v]) for k, v in r.items()}
                      for r in out["compounds"]],
        "points": out["points"],
    }


@router.get("/race-trace", summary="Gap to leader and running position for every lap")
def race_trace(year: int, event: str, session: str):
    s = get_session(year, event, session)
    tr = an.race_trace(s.laps)
    series = {d: df_columns(g, ["LapNumber", "GapToLeader", "Position"]) for d, g in tr.groupby("Driver")}
    sc_laps = an.with_seconds(s.laps)
    status = sc_laps.groupby("LapNumber")["TrackStatus"].agg(lambda x: "".join(sorted(set("".join(map(str, x))))))
    neutral = [int(lap) for lap, st in status.items() if any(c in st for c in "4567")]
    changes = an.position_changes(s.results) if session.upper() in ("R", "S") else pd.DataFrame()
    return {"series": series, "neutralised_laps": neutral, "position_changes": df_records(changes)}


# --------------------------------------------------------------------------- sectors / speed / weather

@router.get("/sectors", summary="Best sectors, ideal lap and time left on the table")
def sectors(year: int, event: str, session: str):
    s = get_session(year, event, session)
    out = an.sector_analysis(s.laps)
    return {"drivers": df_records(out["drivers"]) if len(out["drivers"]) else [],
            "session_best": {k: clean(v) for k, v in out["session_best"].items()}}


@router.get("/speed-traps", summary="Maximum speeds at the four FIA speed traps")
def speed_traps(year: int, event: str, session: str):
    s = get_session(year, event, session)
    return {"traps": df_records(an.speed_traps(s.laps))}


@router.get("/weather", summary="Weather time series")
def weather(year: int, event: str, session: str):
    s = get_session(year, event, session)
    w = s.weather_data.copy()
    w["TimeMin"] = w["Time"].dt.total_seconds() / 60
    return df_columns(w.drop(columns=["Time"]))


@router.get("/race-control", summary="Race control messages (flags, penalties, investigations)")
def race_control(year: int, event: str, session: str):
    s = get_session(year, event, session)
    return {"messages": df_records(s.race_control_messages)}


# --------------------------------------------------------------------------- telemetry

TEL_COLS = ["Distance", "Speed", "Throttle", "Brake", "nGear", "RPM", "DRS", "X", "Y", "Time"]


@router.get("/telemetry", summary="Car telemetry for one lap per driver, with time delta to the first driver")
def telemetry(
    year: int, event: str, session: str,
    drivers: str = Query(..., description="Comma separated, first one is the reference"),
    lap: str = Query("fastest", description="'fastest' or a lap number"),
):
    s = get_session(year, event, session)
    picked = _drivers_param(drivers, s)[:6]
    if not picked:
        raise HTTPException(400, "Pick at least one driver")
    out, ref_tel = {}, None
    for drv in picked:
        lp = _driver_lap(s, drv, lap)
        tel = lp.get_telemetry().copy()
        tel["Brake"] = tel["Brake"].astype(int)
        if ref_tel is None:
            ref_tel = tel
            delta = np.zeros(len(tel))
        else:
            delta = an.delta_to_reference(ref_tel, tel)
        payload = df_columns(tel, TEL_COLS)
        payload["Delta"] = {"Distance": [clean(v) for v in ref_tel["Distance"]], "Delta": [clean(v) for v in delta]}
        out[drv] = {
            "lap_number": clean(lp["LapNumber"]),
            "lap_time": clean(lp["LapTime"]),
            "compound": lp["Compound"],
            "tyre_life": clean(lp["TyreLife"]),
            "profile": {k: clean(v) for k, v in an.lap_profile(tel).items()},
            "braking_zones": df_records(an.braking_zones(tel)),
            "telemetry": payload,
        }
    corners = []
    try:
        ci = s.get_circuit_info()
        corners = df_records(ci.corners, ["Number", "Letter", "Distance", "X", "Y", "Angle"])
        rotation = float(ci.rotation)
    except Exception:
        rotation = 0.0
    return {"reference": picked[0], "drivers": out, "corners": corners, "rotation": rotation}


@router.get("/dominance", summary="Mini-sector dominance map across drivers' laps")
def dominance(
    year: int, event: str, session: str,
    drivers: str = Query(...),
    lap: str = Query("fastest"),
    sectors_n: int = Query(25, ge=5, le=100, alias="n"),
):
    s = get_session(year, event, session)
    picked = _drivers_param(drivers, s)[:6]
    tels = {d: _driver_lap(s, d, lap).get_telemetry() for d in picked}
    out = an.mini_sectors(tels, sectors_n)
    try:
        rotation = float(s.get_circuit_info().rotation)
    except Exception:
        rotation = 0.0
    out["segments"] = [{k: (clean(v) if not isinstance(v, (list, dict)) else v) for k, v in seg.items()}
                       for seg in out["segments"]]
    out["rotation"] = rotation
    return out


@router.get("/track-map", summary="Track outline coloured by a telemetry channel for one lap")
def track_map(
    year: int, event: str, session: str,
    driver: str = Query(...),
    lap: str = Query("fastest"),
    channel: Literal["Speed", "nGear", "Throttle", "Brake", "RPM", "DRS"] = "Speed",
):
    s = get_session(year, event, session)
    (drv,) = _drivers_param(driver, s)[:1]
    tel = _driver_lap(s, drv, lap).get_telemetry()
    if channel == "Brake":
        tel["Brake"] = tel["Brake"].astype(int)
    try:
        ci = s.get_circuit_info()
        corners, rotation = df_records(ci.corners, ["Number", "Letter", "X", "Y"]), float(ci.rotation)
    except Exception:
        corners, rotation = [], 0.0
    return {"driver": drv, "channel": channel, "rotation": rotation, "corners": corners,
            **df_columns(tel, ["X", "Y", "Distance", channel])}


# --------------------------------------------------------------------------- data science

@router.get("/features", summary="Model-ready lap feature table (timing + tyres + weather + race state)")
def features(year: int, event: str, session: str, fuel_effect: float = FuelQ):
    s = get_session(year, event, session)
    df = an.feature_table(s.laps, s.weather_data, fuel_effect)
    return {"columns": df.columns.tolist(), "rows": df_records(df)}


@router.get("/correlation", summary="Correlation matrix over the lap feature table")
def correlation(
    year: int, event: str, session: str,
    method: Literal["pearson", "spearman", "kendall"] = "spearman",
    clean_only: bool = Query(True, description="Only green-flag, non-pit laps"),
    fuel_effect: float = FuelQ,
):
    s = get_session(year, event, session)
    df = an.feature_table(s.laps, s.weather_data, fuel_effect)
    if clean_only:
        df = df[df["IsGreen"].fillna(False) & ~df["IsPitLap"].fillna(False)]
        df = df[df["LapTimeS"] <= df["LapTimeS"].min() * 1.07]
    out = an.correlation_matrix(df.drop(columns=["IsGreen", "IsPitLap"], errors="ignore"), method)
    out["matrix"] = [[clean(v) for v in row] for row in out["matrix"]]
    return out


DATASETS = ("laps", "features", "results", "weather", "race-control", "stints", "pit-stops", "telemetry")


@router.get("/export/{dataset}", summary="Download a dataset as CSV, Parquet or JSON", tags=["export"])
def export(
    year: int, event: str, session: str, dataset: str,
    fmt: Literal["csv", "parquet", "json"] = "csv",
    driver: str | None = Query(None, description="Required for telemetry"),
    lap: str = Query("fastest", description="Telemetry lap: 'fastest' or a number"),
    fuel_effect: float = FuelQ,
):
    if dataset not in DATASETS:
        raise HTTPException(404, f"dataset must be one of {DATASETS}")
    s = get_session(year, event, session)
    if dataset == "laps":
        df = s.laps.copy()
    elif dataset == "features":
        df = an.feature_table(s.laps, s.weather_data, fuel_effect)
    elif dataset == "results":
        df = s.results.copy()
    elif dataset == "weather":
        df = s.weather_data.copy()
    elif dataset == "race-control":
        df = s.race_control_messages.copy()
    elif dataset == "stints":
        df = an.stints(s.laps)
    elif dataset == "pit-stops":
        df = an.pit_stops(s.laps)
    else:
        if not driver:
            raise HTTPException(400, "telemetry export needs ?driver=")
        (drv,) = _drivers_param(driver, s)[:1]
        df = _driver_lap(s, drv, lap).get_telemetry().copy()
        df.insert(0, "Driver", drv)

    df = flatten_timedeltas(pd.DataFrame(df))
    for col in df.columns:  # timezone-naive datetimes and plain object columns travel best
        if df[col].dtype == object:
            df[col] = df[col].astype("string")
    slug = f"{year}_{str(s.event['EventName']).replace(' ', '_')}_{session.upper()}_{dataset}"
    if fmt == "csv":
        return StreamingResponse(io.StringIO(df.to_csv(index=False)), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{slug}.csv"'})
    if fmt == "parquet":
        buf = io.BytesIO()
        df.to_parquet(buf, index=False)
        return Response(buf.getvalue(), media_type="application/vnd.apache.parquet",
                        headers={"Content-Disposition": f'attachment; filename="{slug}.parquet"'})
    return Response(df.to_json(orient="records", date_format="iso"), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{slug}.json"'})
