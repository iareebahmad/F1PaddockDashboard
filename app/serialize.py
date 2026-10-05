"""Helpers that turn pandas/numpy objects into strict JSON-safe Python values."""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd


def td_seconds(value: Any) -> float | None:
    """Timedelta -> float seconds; NaT/None -> None."""
    if value is None or value is pd.NaT:
        return None
    if isinstance(value, (pd.Timedelta, timedelta)):
        return round(value.total_seconds(), 4)
    if isinstance(value, np.timedelta64):
        if np.isnat(value):
            return None
        return round(value / np.timedelta64(1, "s"), 4)
    return clean(value)


def clean(value: Any) -> Any:
    """Convert a scalar to something json.dumps accepts (no NaN/inf, no numpy types)."""
    if value is None:
        return None
    if isinstance(value, (pd.Timedelta, timedelta, np.timedelta64)):
        return td_seconds(value)
    if isinstance(value, (pd.Timestamp, datetime, np.datetime64)):
        ts = pd.Timestamp(value)
        return None if pd.isna(ts) else ts.isoformat()
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, (np.floating, float)):
        f = float(value)
        # significant digits, not decimals, so tiny p-values survive serialisation
        return None if math.isnan(f) or math.isinf(f) else float(f"{f:.7g}")
    if value is pd.NA or value is pd.NaT:
        return None
    return value


def df_records(df: pd.DataFrame, columns: list[str] | None = None) -> list[dict]:
    """DataFrame -> list of JSON-safe dicts. Timedeltas become seconds."""
    if columns is not None:
        df = df[[c for c in columns if c in df.columns]]
    out = []
    for row in df.itertuples(index=False, name=None):
        out.append({col: clean(val) for col, val in zip(df.columns, row)})
    return out


def df_columns(df: pd.DataFrame, columns: list[str] | None = None) -> dict[str, list]:
    """DataFrame -> column-oriented dict (compact for long series like telemetry)."""
    if columns is not None:
        df = df[[c for c in columns if c in df.columns]]
    return {col: [clean(v) for v in df[col].tolist()] for col in df.columns}


def flatten_timedeltas(df: pd.DataFrame) -> pd.DataFrame:
    """Return a copy where every timedelta column is float seconds (for CSV/Parquet export)."""
    out = df.copy()
    for col in out.columns:
        if pd.api.types.is_timedelta64_dtype(out[col]):
            out[col] = out[col].dt.total_seconds()
    return out
