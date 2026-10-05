"""F1 Paddock - a data-science platform for Formula 1 timing and telemetry.

Run:  uvicorn app.main:app --reload
UI:   http://127.0.0.1:8000        API docs: http://127.0.0.1:8000/docs
"""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import STATIC_DIR
from app.routers import meta, session, standings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(
    title="F1 Paddock API",
    version="1.0.0",
    description=(
        "Timing, telemetry, tyre models and statistical tests for every Formula 1 session since 2018, "
        "powered by FastF1 and the Jolpica (Ergast) API. Times are in seconds. "
        "Path parameter `event` accepts a round number or an event name (e.g. `Monza`); "
        "`session` is one of FP1, FP2, FP3, Q, SQ, S, R. "
        "The first request for a session downloads and parses it (30-90 s); later requests are served from memory."
    ),
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

@app.middleware("http")
async def revalidate_ui_assets(request, call_next):
    """Make browsers re-check the UI files on every load (cheap 304s via ETag), so edits show up on refresh."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.include_router(meta.router)
app.include_router(standings.router)
app.include_router(session.router)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")
