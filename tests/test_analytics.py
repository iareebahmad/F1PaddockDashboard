"""Offline tests for the analytics layer, using synthetic laps with known properties."""
import numpy as np
import pandas as pd
import pytest

from app.serialize import clean, df_records
from app.services import analytics as an

TD = pd.to_timedelta


def make_laps(n_laps=30, drivers=("AAA", "BBB"), base=90.0, deg=0.05, offset=0.4, fuel=0.06, noise=0.05, seed=0):
    """Two-stint race. BBB is `offset` seconds slower; times include fuel and tyre effects."""
    rng = np.random.default_rng(seed)
    rows = []
    for i, drv in enumerate(drivers):
        t = 0.0
        for lap in range(1, n_laps + 1):
            stint = 1 if lap <= n_laps // 2 else 2
            life = lap if stint == 1 else lap - n_laps // 2
            lt = base + i * offset + deg * life + fuel * (n_laps - lap) + rng.normal(0, noise)
            t += lt
            rows.append({
                "Driver": drv, "Team": f"T{i}", "LapNumber": lap, "Stint": stint, "TyreLife": float(life),
                "Compound": "MEDIUM" if stint == 1 else "HARD", "FreshTyre": True, "Position": i + 1,
                "LapTime": TD(lt, "s"), "Time": TD(t, "s"), "LapStartTime": TD(t - lt, "s"),
                "Sector1Time": TD(lt * 0.3, "s"), "Sector2Time": TD(lt * 0.4, "s"), "Sector3Time": TD(lt * 0.3, "s"),
                "PitInTime": TD(t - 1, "s") if lap == n_laps // 2 else pd.NaT,
                "PitOutTime": TD(t - lt + 23, "s") if lap == n_laps // 2 + 1 else pd.NaT,
                "TrackStatus": "1", "Deleted": False,
                "SpeedI1": 300.0 + i, "SpeedI2": 280.0, "SpeedFL": 290.0, "SpeedST": 320.0 - i,
            })
    return pd.DataFrame(rows)


def test_clean_laps_drops_pit_and_neutralised_laps():
    laps = make_laps()
    laps.loc[5, "TrackStatus"] = "14"  # SC during lap
    laps.loc[6, "Deleted"] = True
    cleaned = an.clean_laps(laps, quick_threshold=None)
    assert cleaned["PitInTime"].isna().all() and cleaned["PitOutTime"].isna().all()
    assert 5 not in cleaned.index and 6 not in cleaned.index
    assert len(cleaned) == len(laps) - 4 - 2  # 2 pit laps per driver + SC + deleted


def test_degradation_recovers_true_slope_after_fuel_correction():
    laps = make_laps(deg=0.05, fuel=0.06, noise=0.01)
    out = an.degradation(laps, fuel_effect=0.06, quick_threshold=1.2)
    for row in out["compounds"]:
        # point estimate within a few standard errors; a single draw's CI may miss 5% of the time
        assert row["slope"] == pytest.approx(0.05, abs=0.002)
        assert row["slope_ci95"][0] < row["slope"] < row["slope_ci95"][1]


def test_head_to_head_detects_real_gap_and_ignores_noise():
    laps = make_laps(offset=0.4, noise=0.05)
    c = an.clean_laps(laps, quick_threshold=None)
    c["Corr"] = an.fuel_corrected(c, 0.06)
    a, b = c[c.Driver == "AAA"]["Corr"], c[c.Driver == "BBB"]["Corr"]
    r = an.head_to_head(a, b)
    assert r["median_diff"] == pytest.approx(-0.4, abs=0.08)
    assert r["mannwhitney_p"] < 0.01 and r["prob_a_faster"] > 0.9
    assert r["median_diff_ci95"][0] < -0.3 < r["median_diff_ci95"][1] < 0

    same = an.head_to_head(a, a + np.random.default_rng(1).normal(0, 1e-3, len(a)))
    assert same["welch_p"] > 0.5


def test_pit_stops_and_stints():
    laps = make_laps()
    stops = an.pit_stops(laps)
    assert len(stops) == 2 and set(stops["Driver"]) == {"AAA", "BBB"}
    assert (stops["PitLaneTime"] > 0).all()
    st = an.stints(laps)
    assert st.groupby("Driver").size().tolist() == [2, 2]
    assert st.loc[st.Stint == 2, "Compound"].eq("HARD").all()


def test_race_trace_leader_has_zero_gap():
    tr = an.race_trace(make_laps())
    assert tr[tr.Driver == "AAA"]["GapToLeader"].eq(0).all()
    assert (tr[tr.Driver == "BBB"]["GapToLeader"] > 0).all()


def test_sector_analysis_ideal_lap_not_slower_than_best():
    out = an.sector_analysis(make_laps())
    d = out["drivers"]
    assert (d["IdealLap"] <= d["BestLap"] + 1e-9).all()
    assert out["session_best"]["Ideal"] == pytest.approx(d["IdealLap"].min())


def _tel(speed_scale=1.0, n=500, length=5000.0):
    dist = np.linspace(0, length, n)
    speed = (200 + 80 * np.sin(dist / 400)) * speed_scale
    dt = np.diff(dist, prepend=0) / (speed / 3.6)
    return pd.DataFrame({
        "Distance": dist, "Speed": speed, "Time": pd.to_timedelta(np.cumsum(dt), "s"),
        "X": np.cos(dist / length * 2 * np.pi), "Y": np.sin(dist / length * 2 * np.pi),
        "Throttle": np.where(np.sin(dist / 400) > -0.5, 100, 0), "Brake": np.sin(dist / 400) < -0.7,
        "nGear": np.clip((speed / 40).astype(int), 1, 8), "DRS": 0,
    })


def test_delta_and_mini_sectors_pick_faster_car():
    ref, slow = _tel(1.0), _tel(0.98)
    delta = an.delta_to_reference(ref, slow)
    assert delta[0] == pytest.approx(0, abs=1e-6) and delta[-1] > 0 and np.all(np.diff(delta) >= -1e-9)
    out = an.mini_sectors({"FAST": ref, "SLOW": slow}, 10)
    assert {s["winner"] for s in out["segments"]} == {"FAST"}


def test_lap_profile_and_braking_zones():
    tel = _tel()
    prof = an.lap_profile(tel)
    assert 0 < prof["braking_pct"] < 100 and 0 < prof["full_throttle_pct"] < 100
    assert prof["braking_zones"] == len(an.braking_zones(tel)) > 0


def test_feature_table_joins_weather_asof():
    laps = make_laps()
    weather = pd.DataFrame({"Time": pd.to_timedelta([0, 1000, 2000], "s"), "AirTemp": [20.0, 21.0, 22.0],
                            "TrackTemp": [30.0, 31.0, 32.0], "Humidity": 50.0, "Pressure": 1010.0,
                            "Rainfall": False, "WindSpeed": 1.0, "WindDirection": 90})
    ft = an.feature_table(laps, weather, 0.06)
    assert len(ft) == len(laps) and ft["AirTemp"].notna().all()
    late = ft[ft["LapNumber"] == 30]
    assert (late["AirTemp"] == 22.0).all()
    corr = an.correlation_matrix(ft)
    assert len(corr["matrix"]) == len(corr["columns"])


def test_serialisation_is_json_safe():
    df = pd.DataFrame({"t": [TD(1.5, "s"), pd.NaT], "x": [np.float64("nan"), np.int64(3)], "p": [1e-12, 0.5]})
    rows = df_records(df)
    assert rows[0]["t"] == 1.5 and rows[1]["t"] is None and rows[0]["x"] is None
    assert rows[0]["p"] == pytest.approx(1e-12)  # tiny p-values must not round to zero
    assert clean(np.bool_(True)) is True
