"""Pure analytics over FastF1 DataFrames.

Nothing in this module touches the network or FastF1 session objects, so every
function can be unit-tested with synthetic frames.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats

COMPOUND_ORDER = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN", "TEST_UNKNOWN"]


# --------------------------------------------------------------------------- laps

def with_seconds(laps: pd.DataFrame) -> pd.DataFrame:
    """Add float-second columns next to the timedelta ones used throughout the analytics."""
    out = pd.DataFrame(laps).copy()
    for src, dst in [
        ("LapTime", "LapTimeS"),
        ("Sector1Time", "S1"),
        ("Sector2Time", "S2"),
        ("Sector3Time", "S3"),
        ("Time", "SessionTimeS"),
        ("LapStartTime", "LapStartS"),
        ("PitInTime", "PitInS"),
        ("PitOutTime", "PitOutS"),
    ]:
        if src in out.columns:
            out[dst] = out[src].dt.total_seconds()
    return out


def clean_laps(
    laps: pd.DataFrame,
    *,
    exclude_pit: bool = True,
    green_only: bool = True,
    quick_threshold: float | None = 1.07,
    include_deleted: bool = False,
) -> pd.DataFrame:
    """Return representative laps: no in/out laps, green flag only, within X% of the fastest.

    `quick_threshold` mirrors FastF1's pick_quicklaps (107% rule by default); None disables it.
    """
    df = with_seconds(laps)
    df = df[df["LapTimeS"].notna()]
    if exclude_pit:
        df = df[df["PitInTime"].isna() & df["PitOutTime"].isna()]
    if green_only and "TrackStatus" in df.columns:
        # TrackStatus is a string of every status seen during the lap; '1' = green.
        df = df[df["TrackStatus"].astype(str).str.fullmatch(r"1+")]
    if not include_deleted and "Deleted" in df.columns:
        df = df[df["Deleted"].fillna(False) != True]  # noqa: E712 - nullable bool column
    if quick_threshold and len(df):
        df = df[df["LapTimeS"] <= df["LapTimeS"].min() * quick_threshold]
    return df


def fuel_corrected(laps: pd.DataFrame, fuel_effect: float, total_laps: int | None = None) -> pd.Series:
    """Lap time normalised to an empty tank: subtract the time cost of fuel still on board."""
    total = total_laps or int(laps["LapNumber"].max())
    remaining = (total - laps["LapNumber"]).clip(lower=0)
    return laps["LapTimeS"] - fuel_effect * remaining


# --------------------------------------------------------------------------- distributions

def describe_times(values: pd.Series) -> dict:
    v = pd.Series(values).dropna().astype(float)
    if v.empty:
        return {"n": 0}
    q1, q3 = v.quantile([0.25, 0.75])
    mean = v.mean()
    std = v.std(ddof=1) if len(v) > 1 else 0.0
    return {
        "n": int(len(v)),
        "best": v.min(),
        "mean": mean,
        "median": v.median(),
        "std": std,
        "iqr": q3 - q1,
        "p10": v.quantile(0.10),
        "p90": v.quantile(0.90),
        "cv_pct": 100 * std / mean if mean else None,
        "skew": float(stats.skew(v)) if len(v) > 2 else None,
    }


def pace_summary(clean: pd.DataFrame, value_col: str = "LapTimeS") -> pd.DataFrame:
    """Per-driver distribution stats of `value_col`, sorted by median (fastest first)."""
    rows = []
    for driver, grp in clean.groupby("Driver"):
        row = {"Driver": driver, "Team": grp["Team"].iloc[0] if "Team" in grp else None}
        row.update(describe_times(grp[value_col]))
        rows.append(row)
    if not rows:
        return pd.DataFrame()
    out = pd.DataFrame(rows).sort_values("median").reset_index(drop=True)
    out["gap_to_best_median"] = out["median"] - out["median"].min()
    return out


def head_to_head(a: pd.Series, b: pd.Series, *, n_boot: int = 4000, seed: int = 7) -> dict:
    """Is driver A really faster than B? Parametric + non-parametric tests and effect sizes.

    Positive differences mean A is slower than B.
    """
    a = pd.Series(a).dropna().to_numpy(float)
    b = pd.Series(b).dropna().to_numpy(float)
    if len(a) < 3 or len(b) < 3:
        return {"error": "Need at least 3 clean laps per driver.", "n_a": len(a), "n_b": len(b)}

    welch = stats.ttest_ind(a, b, equal_var=False)
    mwu = stats.mannwhitneyu(a, b, alternative="two-sided")
    ks = stats.ks_2samp(a, b)
    pooled = np.sqrt(((len(a) - 1) * a.var(ddof=1) + (len(b) - 1) * b.var(ddof=1)) / (len(a) + len(b) - 2))
    cohens_d = (a.mean() - b.mean()) / pooled if pooled > 0 else 0.0
    # Common-language effect size: P(random lap of A is faster than random lap of B).
    prob_a_faster = 1 - mwu.statistic / (len(a) * len(b))

    rng = np.random.default_rng(seed)
    boots = np.median(rng.choice(a, (n_boot, len(a))), axis=1) - np.median(rng.choice(b, (n_boot, len(b))), axis=1)
    lo, hi = np.percentile(boots, [2.5, 97.5])

    return {
        "n_a": len(a),
        "n_b": len(b),
        "mean_diff": a.mean() - b.mean(),
        "median_diff": float(np.median(a) - np.median(b)),
        "median_diff_ci95": [float(lo), float(hi)],
        "welch_t": float(welch.statistic),
        "welch_p": float(welch.pvalue),
        "mannwhitney_u": float(mwu.statistic),
        "mannwhitney_p": float(mwu.pvalue),
        "ks_stat": float(ks.statistic),
        "ks_p": float(ks.pvalue),
        "cohens_d": float(cohens_d),
        "prob_a_faster": float(prob_a_faster),
        "bootstrap_samples": n_boot,
    }


# --------------------------------------------------------------------------- tyres & strategy

def stints(laps: pd.DataFrame) -> pd.DataFrame:
    df = laps.dropna(subset=["Stint"])
    if df.empty:
        return pd.DataFrame(columns=["Driver", "Stint", "Compound", "StartLap", "EndLap", "Laps", "TyreLifeStart", "FreshTyre"])
    agg = (
        df.groupby(["Driver", "Stint"])
        .agg(
            Compound=("Compound", "first"),
            StartLap=("LapNumber", "min"),
            EndLap=("LapNumber", "max"),
            Laps=("LapNumber", "count"),
            TyreLifeStart=("TyreLife", "min"),
            FreshTyre=("FreshTyre", "first"),
        )
        .reset_index()
    )
    agg["Compound"] = agg["Compound"].fillna("UNKNOWN")
    return agg


def degradation(
    laps: pd.DataFrame,
    *,
    fuel_effect: float,
    total_laps: int | None = None,
    min_laps: int = 5,
    quick_threshold: float = 1.07,
) -> dict:
    """Tyre degradation models.

    * per stint: OLS of fuel-corrected lap time on tyre age.
    * per compound: pooled *within-stint* (fixed-effects) slope - each stint is demeaned
      first, so car pace and driver skill do not leak into the degradation estimate.
    """
    clean = clean_laps(laps, quick_threshold=quick_threshold)
    if clean.empty:
        return {"stints": [], "compounds": [], "points": []}
    clean = clean.assign(Corrected=fuel_corrected(clean, fuel_effect, total_laps))
    clean["Compound"] = clean["Compound"].fillna("UNKNOWN")

    stint_rows, points = [], []
    for (driver, stint), grp in clean.groupby(["Driver", "Stint"]):
        if len(grp) < min_laps or grp["TyreLife"].nunique() < 3:
            continue
        fit = stats.linregress(grp["TyreLife"].astype(float), grp["Corrected"])
        stint_rows.append({
            "Driver": driver,
            "Team": grp["Team"].iloc[0],
            "Stint": int(stint),
            "Compound": grp["Compound"].iloc[0],
            "n": len(grp),
            "slope": fit.slope,
            "slope_stderr": fit.stderr,
            "intercept": fit.intercept,
            "r2": fit.rvalue ** 2,
            "p": fit.pvalue,
            "tyre_life_min": float(grp["TyreLife"].min()),
            "tyre_life_max": float(grp["TyreLife"].max()),
        })
        points.extend(
            {"Driver": driver, "Stint": int(stint), "Compound": grp["Compound"].iloc[0],
             "TyreLife": float(t), "LapNumber": int(n), "LapTimeS": float(raw), "Corrected": float(c)}
            for t, n, raw, c in zip(grp["TyreLife"], grp["LapNumber"], grp["LapTimeS"], grp["Corrected"])
        )

    compound_rows = []
    valid = {(r["Driver"], r["Stint"]) for r in stint_rows}
    pool = clean[[(d, int(s)) in valid for d, s in zip(clean["Driver"], clean["Stint"])]]
    for compound, grp in pool.groupby("Compound"):
        x = grp["TyreLife"] - grp.groupby(["Driver", "Stint"])["TyreLife"].transform("mean")
        y = grp["Corrected"] - grp.groupby(["Driver", "Stint"])["Corrected"].transform("mean")
        if x.var() == 0 or len(x) < 3:
            continue
        fit = stats.linregress(x.astype(float), y)
        compound_rows.append({
            "Compound": compound,
            "stints": int(grp.groupby(["Driver", "Stint"]).ngroups),
            "laps": int(len(grp)),
            "slope": fit.slope,
            "slope_ci95": [fit.slope - 1.96 * fit.stderr, fit.slope + 1.96 * fit.stderr],
            "r2_within": fit.rvalue ** 2,
            "p": fit.pvalue,
        })
    compound_rows.sort(key=lambda r: COMPOUND_ORDER.index(r["Compound"]) if r["Compound"] in COMPOUND_ORDER else 99)
    return {"stints": stint_rows, "compounds": compound_rows, "points": points}


def pit_stops(laps: pd.DataFrame) -> pd.DataFrame:
    """Pit-lane time = PitOutTime on the out-lap minus PitInTime on the preceding in-lap."""
    df = laps.sort_values(["Driver", "LapNumber"])
    rows = []
    for driver, grp in df.groupby("Driver"):
        grp = grp.reset_index(drop=True)
        for i in range(len(grp) - 1):
            pin, pout = grp.loc[i, "PitInTime"], grp.loc[i + 1, "PitOutTime"]
            if pd.notna(pin) and pd.notna(pout):
                rows.append({
                    "Driver": driver,
                    "Team": grp.loc[i, "Team"],
                    "Lap": int(grp.loc[i, "LapNumber"]),
                    "PitLaneTime": (pout - pin).total_seconds(),
                    "From": grp.loc[i, "Compound"],
                    "To": grp.loc[i + 1, "Compound"],
                })
    out = pd.DataFrame(rows)
    return out.sort_values("PitLaneTime").reset_index(drop=True) if len(out) else out


# --------------------------------------------------------------------------- race evolution

def race_trace(laps: pd.DataFrame) -> pd.DataFrame:
    """Gap to the leader after every lap, from the session timestamp at each lap's end."""
    df = with_seconds(laps)[["Driver", "LapNumber", "SessionTimeS", "Position"]].dropna(subset=["SessionTimeS"])
    leader = df.groupby("LapNumber")["SessionTimeS"].transform("min")
    df = df.assign(GapToLeader=df["SessionTimeS"] - leader)
    return df.sort_values(["Driver", "LapNumber"]).reset_index(drop=True)


def position_changes(results: pd.DataFrame) -> pd.DataFrame:
    df = results[["Abbreviation", "TeamName", "GridPosition", "Position", "Status", "Points"]].copy()
    df["GridPosition"] = df["GridPosition"].replace(0, np.nan)  # 0 = pit lane start
    df["Gained"] = df["GridPosition"] - df["Position"]
    return df.sort_values("Position")


# --------------------------------------------------------------------------- sectors & speed

def sector_analysis(laps: pd.DataFrame) -> dict:
    df = with_seconds(laps)
    if "Deleted" in df.columns:
        df = df[df["Deleted"].fillna(False) != True]  # noqa: E712
    rows = []
    for driver, grp in df.groupby("Driver"):
        best = {s: grp[s].min() for s in ("S1", "S2", "S3")}
        ideal = sum(best.values()) if all(pd.notna(v) for v in best.values()) else np.nan
        rows.append({
            "Driver": driver,
            "Team": grp["Team"].iloc[0],
            "BestS1": best["S1"], "BestS2": best["S2"], "BestS3": best["S3"],
            "IdealLap": ideal,
            "BestLap": grp["LapTimeS"].min(),
        })
    out = pd.DataFrame(rows)
    if out.empty:
        return {"drivers": [], "session_best": {}}
    out["LapLeftOnTable"] = out["BestLap"] - out["IdealLap"]
    out = out.sort_values("BestLap").reset_index(drop=True)
    session_best = {s: out[f"Best{s}"].min() for s in ("S1", "S2", "S3")}
    for s in ("S1", "S2", "S3"):
        out[f"Gap{s}"] = out[f"Best{s}"] - session_best[s]
    session_best["Ideal"] = sum(session_best.values())
    return {"drivers": out, "session_best": session_best}


def speed_traps(laps: pd.DataFrame) -> pd.DataFrame:
    cols = ["SpeedI1", "SpeedI2", "SpeedFL", "SpeedST"]
    out = laps.groupby("Driver").agg(Team=("Team", "first"), **{c: (c, "max") for c in cols}).reset_index()
    return out.sort_values("SpeedST", ascending=False).reset_index(drop=True)


# --------------------------------------------------------------------------- telemetry

def delta_to_reference(ref: pd.DataFrame, other: pd.DataFrame) -> np.ndarray:
    """Time delta (s) of `other` vs `ref`, sampled at ref's Distance points. Positive = slower."""
    ref_t = ref["Time"].dt.total_seconds().to_numpy()
    oth_t = other["Time"].dt.total_seconds().to_numpy()
    oth_d = other["Distance"].to_numpy()
    order = np.argsort(oth_d)
    oth_on_ref = np.interp(ref["Distance"].to_numpy(), oth_d[order], oth_t[order])
    return oth_on_ref - ref_t


def mini_sectors(tels: dict[str, pd.DataFrame], n_sectors: int = 25) -> dict:
    """Split the lap into equal-distance mini-sectors and find who is quickest through each.

    `tels` maps driver -> lap telemetry with Distance, Time, X, Y, Speed.
    """
    if not tels:
        return {"segments": [], "summary": []}
    lap_len = min(t["Distance"].max() for t in tels.values())
    edges = np.linspace(0, lap_len, n_sectors + 1)
    seg_times: dict[str, np.ndarray] = {}
    seg_speed: dict[str, np.ndarray] = {}
    for drv, tel in tels.items():
        d = tel["Distance"].to_numpy()
        t = tel["Time"].dt.total_seconds().to_numpy()
        seg_times[drv] = np.diff(np.interp(edges, d, t))
        idx = np.clip(np.digitize(d, edges) - 1, 0, n_sectors - 1)
        seg_speed[drv] = np.array([tel["Speed"].to_numpy()[idx == i].mean() if (idx == i).any() else np.nan
                                   for i in range(n_sectors)])

    drivers = list(tels)
    matrix = np.vstack([seg_times[d] for d in drivers])
    winners = [drivers[i] for i in matrix.argmin(axis=0)]

    ref = next(iter(tels.values()))
    rd = ref["Distance"].to_numpy()
    segments = []
    for i in range(n_sectors):
        mask = (rd >= edges[i]) & (rd <= edges[i + 1])
        # include one point past the edge so polylines connect without gaps
        last = np.flatnonzero(mask)
        if len(last) and last[-1] + 1 < len(rd):
            mask[last[-1] + 1] = True
        segments.append({
            "index": i,
            "start": edges[i],
            "end": edges[i + 1],
            "winner": winners[i],
            "x": ref["X"].to_numpy()[mask].tolist(),
            "y": ref["Y"].to_numpy()[mask].tolist(),
            "times": {d: float(seg_times[d][i]) for d in drivers},
            "avg_speed": {d: (None if np.isnan(seg_speed[d][i]) else float(seg_speed[d][i])) for d in drivers},
        })
    summary = [{"Driver": d, "sectors_won": winners.count(d)} for d in drivers]
    return {"segments": segments, "summary": summary, "lap_length": float(lap_len)}


def braking_zones(tel: pd.DataFrame, min_duration_m: float = 15.0) -> pd.DataFrame:
    """Contiguous braking events with entry speed, minimum speed and length."""
    brake = tel["Brake"].astype(bool).to_numpy()
    if not brake.any():
        return pd.DataFrame()
    edges = np.flatnonzero(np.diff(np.r_[0, brake.astype(int), 0]))
    rows = []
    for start, end in zip(edges[::2], edges[1::2]):
        seg = tel.iloc[start:end]
        length = seg["Distance"].iloc[-1] - seg["Distance"].iloc[0]
        if length < min_duration_m:
            continue
        rows.append({
            "start_m": float(seg["Distance"].iloc[0]),
            "length_m": float(length),
            "entry_speed": float(seg["Speed"].iloc[0]),
            "min_speed": float(seg["Speed"].min()),
            "speed_shed": float(seg["Speed"].iloc[0] - seg["Speed"].min()),
        })
    return pd.DataFrame(rows)


def lap_profile(tel: pd.DataFrame) -> dict:
    """Driving-style fingerprint of a lap: how much is flat out, coasting, braking, top speed..."""
    n = len(tel)
    if n == 0:
        return {}
    dist = tel["Distance"].to_numpy()
    w = np.diff(dist, prepend=dist[0])  # weight samples by distance covered
    w = np.where(w < 0, 0, w)
    tot = w.sum() or 1
    throttle = tel["Throttle"].to_numpy()
    brake = tel["Brake"].astype(bool).to_numpy()
    zones = braking_zones(tel)
    return {
        "full_throttle_pct": 100 * w[throttle >= 98].sum() / tot,
        "braking_pct": 100 * w[brake].sum() / tot,
        "coasting_pct": 100 * w[(throttle < 5) & ~brake].sum() / tot,
        "top_speed": float(tel["Speed"].max()),
        "min_speed": float(tel["Speed"].min()),
        "avg_speed": float(np.average(tel["Speed"], weights=w) if w.sum() else tel["Speed"].mean()),
        "gear_changes": int((tel["nGear"].diff().fillna(0) != 0).sum()),
        "braking_zones": int(len(zones)),
        "drs_pct": 100 * w[tel["DRS"].to_numpy() >= 10].sum() / tot if "DRS" in tel else None,
    }


# --------------------------------------------------------------------------- feature table

FEATURE_COLUMNS = [
    "Driver", "Team", "LapNumber", "Stint", "Compound", "TyreLife", "FreshTyre", "Position",
    "LapTimeS", "FuelCorrectedS", "S1", "S2", "S3", "SpeedI1", "SpeedI2", "SpeedFL", "SpeedST",
    "IsPitLap", "IsGreen", "IsAccurate", "AirTemp", "TrackTemp", "Humidity", "Pressure",
    "WindSpeed", "WindDirection", "Rainfall", "GapToLeader",
]


def feature_table(laps: pd.DataFrame, weather: pd.DataFrame | None, fuel_effect: float) -> pd.DataFrame:
    """One tidy, model-ready row per lap: timing + tyre + weather + race-state features."""
    df = with_seconds(laps)
    df["FuelCorrectedS"] = fuel_corrected(df, fuel_effect)
    df["IsPitLap"] = df["PitInTime"].notna() | df["PitOutTime"].notna()
    df["IsGreen"] = df["TrackStatus"].astype(str).str.fullmatch(r"1+")
    trace = race_trace(laps)[["Driver", "LapNumber", "GapToLeader"]]
    df = df.merge(trace, on=["Driver", "LapNumber"], how="left")

    if weather is not None and len(weather):
        w = weather.copy()
        w["WeatherTimeS"] = w["Time"].dt.total_seconds()
        w = w.drop(columns=["Time"]).sort_values("WeatherTimeS")
        df = df.sort_values("SessionTimeS")
        has_t = df["SessionTimeS"].notna()
        merged = pd.merge_asof(df[has_t], w, left_on="SessionTimeS", right_on="WeatherTimeS", direction="backward")
        df = pd.concat([merged, df[~has_t]], ignore_index=True)

    cols = [c for c in FEATURE_COLUMNS if c in df.columns]
    return df[cols].sort_values(["Driver", "LapNumber"]).reset_index(drop=True)


def correlation_matrix(df: pd.DataFrame, method: str = "spearman") -> dict:
    num = df.select_dtypes(include=[np.number, "bool"]).astype(float)
    num = num.loc[:, num.nunique() > 1]
    corr = num.corr(method=method)
    return {"columns": corr.columns.tolist(), "matrix": corr.round(4).to_numpy().tolist(), "method": method, "n": int(len(num))}
