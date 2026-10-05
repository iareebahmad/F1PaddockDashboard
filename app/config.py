"""Runtime configuration, overridable through environment variables."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

CACHE_DIR = Path(os.getenv("F1P_CACHE_DIR", BASE_DIR / ".cache"))
STATIC_DIR = BASE_DIR / "static"

# How many fully-loaded sessions to keep in memory (each is ~50-200 MB with telemetry).
SESSION_MEMORY_SLOTS = int(os.getenv("F1P_SESSION_SLOTS", "4"))

# FastF1 timing data is available from 2018 onwards.
MIN_SEASON = 2018

# Default fuel-burn correction used to normalise race lap times (seconds gained per lap
# as the car gets lighter). ~1.6 kg/lap burned * ~0.035 s/kg.
DEFAULT_FUEL_EFFECT = 0.055
