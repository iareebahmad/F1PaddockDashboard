"""Championship standings and season-long points progression (Jolpica/Ergast API)."""
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from app.data import get_schedule, get_standings
from app.serialize import clean, df_records

router = APIRouter(prefix="/api/standings", tags=["championship"])


def _tidy(df: pd.DataFrame, kind: str) -> pd.DataFrame:
    if df.empty:
        return df
    if kind == "drivers":
        df = df.assign(
            name=df["givenName"] + " " + df["familyName"],
            code=df["driverCode"],
            team=df["constructorNames"].map(lambda v: v[-1] if isinstance(v, list) and v else v),
        )
        cols = ["position", "code", "name", "team", "points", "wins", "driverNationality", "round"]
    else:
        df = df.assign(name=df["constructorName"], code=df["constructorId"])
        cols = ["position", "code", "name", "points", "wins", "constructorNationality", "round"]
    return df[[c for c in cols if c in df.columns]]


@router.get("/{year}/{kind}", summary="Current (or as-of-round) standings")
def standings(year: int, kind: str, round: int | None = Query(None, ge=1)):
    if kind not in ("drivers", "constructors"):
        raise HTTPException(400, "kind must be 'drivers' or 'constructors'")
    df = _tidy(get_standings(kind, year, round), kind)
    return {"year": year, "kind": kind, "round": int(df["round"].iloc[0]) if len(df) else None, "standings": df_records(df)}


@router.get("/{year}/{kind}/progression", summary="Cumulative points after every completed round")
def progression(year: int, kind: str):
    if kind not in ("drivers", "constructors"):
        raise HTTPException(400, "kind must be 'drivers' or 'constructors'")
    latest = get_standings(kind, year)
    if latest.empty:
        return {"year": year, "rounds": [], "series": []}
    last_round = int(latest["round"].iloc[0])
    sched = get_schedule(year).set_index("RoundNumber")

    frames = []
    for rnd in range(1, last_round + 1):
        df = _tidy(get_standings(kind, year, rnd), kind)
        df["round"] = rnd
        frames.append(df)
    all_rounds = pd.concat(frames, ignore_index=True)
    order = _tidy(latest, kind)["code"].tolist()
    series = []
    for code in order:
        sub = all_rounds[all_rounds["code"] == code].drop_duplicates("round", keep="last").set_index("round")
        series.append({
            "code": code,
            "name": sub["name"].iloc[-1] if len(sub) else code,
            "points": [clean(sub["points"].get(r)) for r in range(1, last_round + 1)],
            "positions": [clean(sub["position"].get(r)) for r in range(1, last_round + 1)],
        })
    rounds = [{"round": r, "name": sched.loc[r, "EventName"] if r in sched.index else str(r)} for r in range(1, last_round + 1)]
    return {"year": year, "kind": kind, "rounds": rounds, "series": series}
