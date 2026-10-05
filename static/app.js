/* F1 Paddock front-end. Plain JS + Plotly; every chart is fed by a documented API endpoint. */
"use strict";

// ------------------------------------------------------------------ state

const state = {
  year: null, event: null, session: null,
  overview: null,
  focus: [],              // [{code, slot}] - slot is a fixed palette index, so colours never repaint
  teamColors: false,
  view: "overview",
  cache: new Map(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c.nodeType ? c : String(c));
  return node;
};

// ------------------------------------------------------------------ api

async function api(path, { cache = true } = {}) {
  if (cache && state.cache.has(path)) return state.cache.get(path);
  const p = fetch(path).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || `${r.status} ${r.statusText}`);
    return body;
  });
  if (cache) state.cache.set(path, p);
  try { return await p; } catch (e) { state.cache.delete(path); throw e; }
}
const sbase = () => `/api/sessions/${state.year}/${encodeURIComponent(state.event)}/${state.session}`;
const qs = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 7000);
}
function loading(on, text = "Loading…") {
  $("#loading").hidden = !on; $("#loading-text").textContent = text;
}

// ------------------------------------------------------------------ colours

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const palette = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => css(`--s${i}`));
const TYRES = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN"];
function tyreColor(c) {
  const key = { SOFT: "soft", MEDIUM: "medium", HARD: "hard", INTERMEDIATE: "inter", WET: "wet" }[c] || "unknown";
  return css(`--tyre-${key}`);
}
const driverInfo = (code) => state.overview?.drivers.find((d) => d.code === code);
const isFocus = (code) => state.focus.some((f) => f.code === code);

/** Colour of a driver: their fixed focus slot, or team colour when that mode is on. Null = not highlighted. */
function driverColor(code, { any = false } = {}) {
  const f = state.focus.find((x) => x.code === code);
  if (state.teamColors) {
    if (!f && !any) return null;
    return driverInfo(code)?.team_color || css("--text-secondary");
  }
  if (f) return palette()[f.slot];
  return any ? css("--neutral-mark") : null;
}
/** In team-colour mode teammates share a hue, so the second driver of each team gets a dashed line. */
function driverDash(code) {
  if (!state.teamColors) return "solid";
  const d = driverInfo(code); if (!d) return "solid";
  const mates = state.overview.drivers.filter((x) => x.team === d.team);
  return mates.length > 1 && mates[1].code === code ? "dot" : "solid";
}

// ------------------------------------------------------------------ formatting

function fmtLap(s) {
  if (s === null || s === undefined || Number.isNaN(s)) return "–";
  const m = Math.floor(s / 60), r = s - m * 60;
  return m ? `${m}:${r.toFixed(3).padStart(6, "0")}` : r.toFixed(3);
}
const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? "–" : (Math.abs(v) < 0.5 * 10 ** -d ? 0 : Number(v)).toFixed(d));
const fmtSigned = (v, d = 3) => (v === null || v === undefined ? "–" : (v > 0 ? "+" : "") + Number(v).toFixed(d));
function fmtP(p) {
  if (p === null || p === undefined) return "–";
  if (p < 0.0001) return "< 0.0001";
  return p.toFixed(4);
}

// ------------------------------------------------------------------ plotting

function baseLayout(extra = {}) {
  const ink = css("--text-secondary"), grid = css("--grid"), axis = css("--axis");
  const ax = { gridcolor: grid, linecolor: axis, zerolinecolor: axis, tickfont: { color: css("--text-muted"), size: 11 },
               title: { font: { color: ink, size: 12 } }, automargin: true };
  const merged = {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "system-ui, -apple-system, Segoe UI, sans-serif", color: ink, size: 12 },
    margin: { l: 56, r: 16, t: 16, b: 44 },
    hoverlabel: { bgcolor: css("--surface-1"), bordercolor: css("--axis"), font: { color: css("--text-primary") } },
    legend: { orientation: "h", y: -0.18, font: { size: 11 } },
    ...extra,
  };
  for (const k of Object.keys(merged)) {
    if (/^[xy]axis\d*$/.test(k)) merged[k] = { ...ax, ...merged[k], title: { ...ax.title, ...(merged[k].title || {}) } };
  }
  if (!merged.xaxis) merged.xaxis = ax;
  if (!merged.yaxis) merged.yaxis = ax;
  return merged;
}
function plot(node, traces, layout = {}, filename = "f1paddock") {
  Plotly.react(node, traces, baseLayout(layout), {
    responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
    toImageButtonOptions: { format: "png", filename, scale: 2 },
  });
}
const plotDiv = (cls = "") => el("div", { class: `plot ${cls}` });

// ------------------------------------------------------------------ tables

/**
 * Sortable table with CSV download.
 * cols: [{key, label, fmt?(value,row) -> string|Node, left?, sortValue?}]
 */
function dataTable(rows, cols, { filename = "table", maxHeight } = {}) {
  let sortKey = null, asc = true;
  const wrap = el("div");
  const tools = el("div", { class: "table-tools" },
    el("span", { class: "muted", style: "margin-right:auto;font-size:12px" }, `${rows.length} rows`),
    el("button", { onclick: () => downloadCSV(rows, cols, filename) }, "Download CSV"));
  const tw = el("div", { class: "table-wrap" });
  if (maxHeight) tw.style.maxHeight = maxHeight;
  const table = el("table");
  tw.append(table); wrap.append(tools, tw);

  function render() {
    let data = rows.slice();
    if (sortKey) {
      const c = cols.find((x) => x.key === sortKey);
      const val = (r) => (c.sortValue ? c.sortValue(r) : r[sortKey]);
      data.sort((a, b) => {
        const va = val(a), vb = val(b);
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        return (va > vb ? 1 : va < vb ? -1 : 0) * (asc ? 1 : -1);
      });
    }
    table.innerHTML = "";
    const thead = el("thead", {}, el("tr", {}, cols.map((c) =>
      el("th", { class: c.left ? "left" : "", scope: "col", onclick: () => { asc = sortKey === c.key ? !asc : true; sortKey = c.key; render(); } },
        c.label, " ", el("span", { class: "arrow" }, sortKey === c.key ? (asc ? "▲" : "▼") : "")))));
    const tbody = el("tbody", {}, data.map((r) => el("tr", {}, cols.map((c) => {
      const v = c.fmt ? c.fmt(r[c.key], r) : r[c.key];
      return el("td", { class: c.left ? "left" : "" }, v === null || v === undefined ? "–" : v);
    }))));
    table.append(thead, tbody);
  }
  render();
  return wrap;
}
function downloadCSV(rows, cols, filename) {
  const esc = (v) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const keys = cols ? cols.map((c) => c.key) : Object.keys(rows[0] || {});
  const lines = [keys.join(","), ...rows.map((r) => keys.map((k) => esc(Array.isArray(r[k]) ? r[k].join(";") : r[k])).join(","))];
  const a = el("a", { href: URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })), download: `${filename}.csv` });
  document.body.append(a); a.click(); a.remove();
}
const driverCell = (code) => {
  const c = driverColor(code);
  return el("span", {}, el("span", { class: "dot", style: `background:${c || "transparent"};border:1px solid ${c || css("--axis")}` }), code);
};
const tyreCell = (c) => (c ? el("span", { class: "tyre", style: `color:${tyreColor(c)}` }, el("i"), el("span", { style: "color:var(--text-primary)" }, c)) : "–");

// ------------------------------------------------------------------ view helpers

function card(title, sub, ...body) {
  return el("section", { class: "card" },
    el("div", { class: "card-head" }, el("h3", {}, title), sub ? el("span", { class: "sub" }, sub) : null), ...body);
}
function viewHead(title, desc, endpoint) {
  return el("div", { class: "view-head" },
    el("div", {}, el("h2", {}, title), desc ? el("p", {}, desc) : null),
    endpoint ? el("a", { class: "ghost", href: endpoint, target: "_blank", rel: "noopener", title: "Raw JSON behind this view" }, "{ } JSON") : null);
}
const focusCodes = () => state.focus.map((f) => f.code);
function needFocus(min = 1) {
  if (state.focus.length >= min) return null;
  return el("div", { class: "card inline-loading" }, `Add at least ${min} focus driver${min > 1 ? "s" : ""} in the bar above.`);
}
function select(options, value, onchange, attrs = {}) {
  const s = el("select", { ...attrs, onchange: (e) => onchange(e.target.value) },
    options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return el("option", { value: v, selected: String(v) === String(value) }, l); }));
  return s;
}
const labelled = (text, control, inline = false) => el("label", { class: inline ? "inline" : "" }, inline ? control : text, inline ? text : control);
const isRace = () => ["R", "S"].includes(state.session);

// ================================================================== VIEWS

const VIEWS = [
  { group: "Session" },
  { id: "overview", label: "Overview", render: renderOverview },
  { id: "laps", label: "Lap explorer", render: renderLaps },
  { id: "pace", label: "Pace distribution", render: renderPace },
  { id: "h2h", label: "Head-to-head test", render: renderH2H },
  { group: "Race craft" },
  { id: "strategy", label: "Strategy & tyres", render: renderStrategy },
  { id: "trace", label: "Race trace", render: renderTrace },
  { group: "Car" },
  { id: "telemetry", label: "Telemetry", render: renderTelemetry },
  { id: "track", label: "Track maps", render: renderTrack },
  { id: "sectors", label: "Sectors & speed", render: renderSectors },
  { id: "conditions", label: "Conditions", render: renderConditions },
  { group: "Data science" },
  { id: "lab", label: "Data Lab", render: renderLab },
  { group: "Season" },
  { id: "championship", label: "Championship", render: renderChampionship, global: true },
  { id: "about", label: "About", render: renderAbout, global: true, topbar: true },
];

// ------------------------------------------------------------------ overview

async function renderOverview(root) {
  const o = state.overview, k = o.kpis;
  root.append(viewHead(`${o.event.name} · ${o.event.session}`,
    `${o.event.location}, ${o.event.country} · Round ${o.event.round} · ${new Date(o.event.date).toUTCString().slice(0, 16)}`, sbase()));
  const tile = (label, value, detail) => el("div", { class: "tile" }, el("div", { class: "label" }, label), el("div", { class: "value" }, value), el("div", { class: "detail" }, detail || " "));
  root.append(el("div", { class: "tiles" },
    tile("Fastest lap", fmtLap(k.fastest_lap.time), k.fastest_lap.driver ? `${k.fastest_lap.driver} · lap ${k.fastest_lap.lap} · ${k.fastest_lap.compound || ""}` : ""),
    tile("Top speed (trap)", k.top_speed ? `${k.top_speed} km/h` : "–", k.top_speed_driver),
    tile("Laps", k.laps_completed, `${k.timed_laps} timed laps in dataset`),
    tile("Pit entries", k.pit_stops, ""),
    tile("Track temp", k.track_temp_range ? `${k.track_temp_range[0]}–${k.track_temp_range[1]} °C` : "–", k.air_temp_range ? `Air ${k.air_temp_range[0]}–${k.air_temp_range[1]} °C` : ""),
    tile("Rain", k.rain ? "Yes" : "No", k.rain ? "Rainfall recorded during session" : "Dry session"),
  ));

  const isQ = ["Q", "SQ", "SS"].includes(state.session);
  const cols = [
    { key: "Position", label: "Pos", fmt: (v) => (v ? Math.round(v) : "–") },
    { key: "Abbreviation", label: "Driver", left: true, fmt: driverCell },
    { key: "FullName", label: "Name", left: true },
    { key: "TeamName", label: "Team", left: true },
    ...(isQ ? ["Q1", "Q2", "Q3"].map((q) => ({ key: q, label: q, fmt: fmtLap }))
      : isRace() ? [{ key: "GridPosition", label: "Grid", fmt: (v) => (v ? Math.round(v) : "Pit") },
        { key: "Time", label: "Time / gap", fmt: (v, r) => (v === null ? "–" : r.Position === 1 ? fmtLap(v) : `+${fmt(v)}`) },
        { key: "Laps", label: "Laps", fmt: (v) => (v === null ? "–" : Math.round(v)) },
        { key: "Points", label: "Pts" }] : []),
    { key: "Status", label: "Status", left: true },
  ];
  const grid = el("div", { class: isRace() ? "grid two wide-left" : "grid" });
  grid.append(card("Classification", "click a column to sort", dataTable(o.classification, cols, { filename: "classification" })));
  if (isRace()) {
    const trace = await api(`${sbase()}/race-trace`);
    const pc = trace.position_changes.filter((r) => r.Gained !== null);
    const div = plotDiv("tall");
    grid.append(card("Positions gained", "grid → finish", div));
    queueMicrotask(() => plot(div, [{
      type: "bar", orientation: "h", y: pc.map((r) => r.Abbreviation), x: pc.map((r) => r.Gained),
      marker: { color: pc.map((r) => (r.Gained >= 0 ? css("--div-neg") : css("--div-pos"))) },
      hovertemplate: "%{y}: %{x:+d} places<extra></extra>",
      text: pc.map((r) => (r.Gained > 0 ? `+${r.Gained}` : r.Gained)), textposition: "outside", cliponaxis: false,
    }], { yaxis: { autorange: "reversed", type: "category" }, xaxis: { title: { text: "Places gained (blue) / lost (red)" }, zeroline: true }, showlegend: false, bargap: 0.25 }, "positions-gained"));
  }
  root.append(grid);
}

// ------------------------------------------------------------------ lap explorer

async function renderLaps(root) {
  const opts = renderLaps.opts ||= { clean: false, colorBy: "driver", cap: 1.15 };
  root.append(viewHead("Lap explorer", "Every lap of the session. Focus drivers are coloured; the rest of the field is a grey backdrop. Use the cap to hide safety-car and pit laps that flatten the scale.", `${sbase()}/laps`));
  const div = plotDiv("tall");
  root.append(el("div", { class: "controls" },
    labelled(" Clean laps only (no pit, green flag, ≤107%)", el("input", { type: "checkbox", checked: opts.clean, onchange: (e) => { opts.clean = e.target.checked; rerender(); } }), true),
    labelled("Colour by", select([["driver", "Driver"], ["compound", "Tyre compound"]], opts.colorBy, (v) => { opts.colorBy = v; rerender(); })),
    labelled("Y-axis cap (× fastest)", select([[1.05, "105%"], [1.1, "110%"], [1.15, "115%"], [1.3, "130%"], [10, "none"]], opts.cap, (v) => { opts.cap = +v; rerender(); }))));
  root.append(card("Lap time by lap number", "hover a point for tyre, stint and sector data", div));

  const data = await api(`${sbase()}/laps?${qs({ clean_only: opts.clean })}`);
  const laps = data.laps.filter((l) => l.LapTimeS !== null);
  const fastest = Math.min(...laps.map((l) => l.LapTimeS));
  const hover = "<b>%{customdata[0]}</b> lap %{x}<br>%{y:.3f}s · %{customdata[1]} (age %{customdata[2]})<br>S1 %{customdata[3]:.3f} · S2 %{customdata[4]:.3f} · S3 %{customdata[5]:.3f}<extra></extra>";
  const cd = (ls) => ls.map((l) => [l.Driver, l.Compound, l.TyreLife, l.S1, l.S2, l.S3]);
  const traces = [];
  const back = laps.filter((l) => !isFocus(l.Driver));
  if (opts.colorBy === "driver") {
    traces.push({ type: "scattergl", mode: "markers", name: "Rest of field", x: back.map((l) => l.LapNumber), y: back.map((l) => l.LapTimeS),
      customdata: cd(back), hovertemplate: hover, marker: { size: 5, color: css("--neutral-mark") } });
    for (const code of focusCodes()) {
      const ls = laps.filter((l) => l.Driver === code);
      traces.push({ type: "scatter", mode: "lines+markers", name: code, x: ls.map((l) => l.LapNumber), y: ls.map((l) => l.LapTimeS),
        customdata: cd(ls), hovertemplate: hover, connectgaps: false,
        line: { width: 2, color: driverColor(code), dash: driverDash(code) }, marker: { size: 8, color: driverColor(code), line: { width: 2, color: css("--surface-1") } } });
    }
  } else {
    const subset = state.focus.length ? laps.filter((l) => isFocus(l.Driver)) : laps;
    for (const c of TYRES) {
      const ls = subset.filter((l) => (l.Compound || "UNKNOWN") === c);
      if (!ls.length) continue;
      traces.push({ type: "scattergl", mode: "markers", name: c, x: ls.map((l) => l.LapNumber), y: ls.map((l) => l.LapTimeS),
        customdata: cd(ls), hovertemplate: hover, marker: { size: 8, color: tyreColor(c), line: { width: 1, color: css("--surface-1") } } });
    }
  }
  plot(div, traces, { yaxis: { title: { text: "Lap time (s)" }, range: opts.cap < 5 ? [fastest - 0.5, fastest * opts.cap] : undefined },
    xaxis: { title: { text: "Lap" } }, hovermode: "closest" }, "lap-times");

  const rows = state.focus.length ? data.laps.filter((l) => isFocus(l.Driver)) : data.laps;
  root.append(card("Lap table", state.focus.length ? "focus drivers" : "all drivers", dataTable(rows, [
    { key: "Driver", label: "Driver", left: true, fmt: driverCell },
    { key: "LapNumber", label: "Lap" },
    { key: "LapTimeS", label: "Lap time", fmt: fmtLap },
    { key: "S1", label: "S1", fmt: (v) => fmt(v) }, { key: "S2", label: "S2", fmt: (v) => fmt(v) }, { key: "S3", label: "S3", fmt: (v) => fmt(v) },
    { key: "Compound", label: "Tyre", left: true, fmt: tyreCell }, { key: "TyreLife", label: "Age" }, { key: "Stint", label: "Stint" },
    { key: "Position", label: "Pos" }, { key: "SpeedST", label: "Trap km/h" }, { key: "TrackStatus", label: "Track status", left: true },
  ], { filename: "laps" })));
}

// ------------------------------------------------------------------ pace distribution

async function renderPace(root) {
  const opts = renderPace.opts ||= { threshold: 1.07, fuel: false, kind: "box" };
  root.append(viewHead("Pace distribution", "Clean laps only: no in/out laps, green flag, not deleted, within the threshold of the session's fastest lap. Drivers are sorted by median.", `${sbase()}/pace`));
  root.append(el("div", { class: "controls" },
    labelled("Threshold", select([[1.03, "103%"], [1.05, "105%"], [1.07, "107%"], [1.1, "110%"]], opts.threshold, (v) => { opts.threshold = +v; rerender(); })),
    labelled("Chart", select([["box", "Box plot"], ["violin", "Violin"], ["strip", "Strip (every lap)"]], opts.kind, (v) => { opts.kind = v; rerender(); })),
    labelled(" Fuel-correct lap times", el("input", { type: "checkbox", checked: opts.fuel, onchange: (e) => { opts.fuel = e.target.checked; rerender(); } }), true)));
  const div = plotDiv("tall");
  root.append(card("Lap-time distribution", opts.fuel ? "fuel-corrected to empty tank" : "raw lap times", div));

  const d = await api(`${sbase()}/pace?${qs({ threshold: opts.threshold, fuel_correct: opts.fuel })}`);
  const order = d.summary.map((r) => r.Driver);
  const traces = order.map((code) => {
    const c = driverColor(code) || css("--neutral-mark");
    const y = d.distributions[code];
    const common = { name: code, y, x: y.map(() => code), showlegend: false, hoverinfo: "y+name" };
    if (opts.kind === "violin") return { ...common, type: "violin", line: { color: c, width: 1.5 }, fillcolor: c, opacity: isFocus(code) || !state.focus.length ? 0.75 : 0.35, meanline: { visible: true }, points: false, spanmode: "hard" };
    if (opts.kind === "strip") return { ...common, type: "box", boxpoints: "all", jitter: 0.5, pointpos: 0, fillcolor: "rgba(0,0,0,0)", line: { color: "rgba(0,0,0,0)" }, marker: { color: c, size: 6 } };
    return { ...common, type: "box", boxpoints: "outliers", line: { color: c, width: 1.5 }, fillcolor: c + "55", marker: { color: c, size: 5 } };
  });
  plot(div, traces, { yaxis: { title: { text: d.metric === "Corrected" ? "Fuel-corrected lap time (s)" : "Lap time (s)" } }, xaxis: { type: "category" } }, "pace-distribution");

  root.append(card("Dispersion statistics", "CV = std / mean; lower is more consistent", dataTable(d.summary, [
    { key: "Driver", label: "Driver", left: true, fmt: driverCell }, { key: "Team", label: "Team", left: true },
    { key: "n", label: "Laps" }, { key: "best", label: "Best", fmt: fmtLap }, { key: "median", label: "Median", fmt: fmtLap },
    { key: "mean", label: "Mean", fmt: fmtLap }, { key: "std", label: "Std (s)", fmt: (v) => fmt(v) }, { key: "iqr", label: "IQR (s)", fmt: (v) => fmt(v) },
    { key: "p10", label: "P10", fmt: fmtLap }, { key: "p90", label: "P90", fmt: fmtLap },
    { key: "cv_pct", label: "CV %", fmt: (v) => fmt(v, 2) }, { key: "skew", label: "Skew", fmt: (v) => fmt(v, 2) },
    { key: "gap_to_best_median", label: "Δ median", fmt: (v) => fmtSigned(v) },
  ], { filename: "pace-summary" })));
}

// ------------------------------------------------------------------ head to head

async function renderH2H(root) {
  const drivers = state.overview.drivers.map((d) => d.code);
  const opts = renderH2H.opts ||= {};
  opts.a = drivers.includes(opts.a) ? opts.a : focusCodes()[0] || drivers[0];
  opts.b = drivers.includes(opts.b) ? opts.b : focusCodes()[1] || drivers[1];
  opts.fuel ??= true; opts.compound ??= ""; opts.threshold ??= 1.07;
  root.append(viewHead("Head-to-head significance test", "Is the pace gap real or noise? Compares two drivers' clean-lap distributions with parametric and non-parametric tests, an effect size, and a bootstrap confidence interval on the median gap."));
  root.append(el("div", { class: "controls" },
    labelled("Driver A", select(drivers, opts.a, (v) => { opts.a = v; rerender(); })),
    labelled("Driver B", select(drivers, opts.b, (v) => { opts.b = v; rerender(); })),
    labelled("Compound", select([["", "All"], ...TYRES.slice(0, 5)], opts.compound, (v) => { opts.compound = v; rerender(); })),
    labelled("Threshold", select([[1.03, "103%"], [1.05, "105%"], [1.07, "107%"], [1.1, "110%"]], opts.threshold, (v) => { opts.threshold = +v; rerender(); })),
    labelled(" Fuel-correct", el("input", { type: "checkbox", checked: opts.fuel, onchange: (e) => { opts.fuel = e.target.checked; rerender(); } }), true)));
  if (opts.a === opts.b) { root.append(el("div", { class: "card inline-loading" }, "Pick two different drivers.")); return; }

  const url = `${sbase()}/h2h?${qs({ a: opts.a, b: opts.b, compound: opts.compound, fuel_correct: opts.fuel, threshold: opts.threshold })}`;
  root.querySelector(".view-head").append(el("a", { class: "ghost", href: url, target: "_blank" }, "{ } JSON"));
  const d = await api(url);
  const r = d.result;
  if (r.error) { root.append(el("div", { class: "card inline-loading" }, r.error)); return; }

  const faster = r.median_diff < 0 ? d.a : d.b, slower = faster === d.a ? d.b : d.a;
  const sig = r.mannwhitney_p < 0.05 && !(r.median_diff_ci95[0] < 0 && r.median_diff_ci95[1] > 0);
  const mag = Math.abs(r.cohens_d) < 0.2 ? "negligible" : Math.abs(r.cohens_d) < 0.5 ? "small" : Math.abs(r.cohens_d) < 0.8 ? "medium" : "large";
  const colA = driverColor(d.a, { any: true }) === css("--neutral-mark") ? palette()[0] : driverColor(d.a, { any: true });
  let colB = driverColor(d.b, { any: true }) === css("--neutral-mark") ? palette()[1] : driverColor(d.b, { any: true });
  if (colB === colA) colB = palette()[1];

  root.append(el("div", { class: "verdict", html:
    `<b>${faster}</b> is ${sig ? "" : "<i>not</i> "}significantly faster than <b>${slower}</b>: median gap <b>${fmt(Math.abs(r.median_diff))} s</b>/lap ` +
    `(95% CI ${fmtSigned(r.median_diff_ci95[0])} to ${fmtSigned(r.median_diff_ci95[1])} s, A − B). Effect size is <b>${mag}</b> (Cohen's d = ${fmt(r.cohens_d, 2)}).` }));

  const stat = (k, v, h) => el("div", { class: "stat" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), el("div", { class: "h" }, h));
  root.append(card("Test results", `${d.metric === "Corrected" ? "fuel-corrected" : "raw"} lap times · A = ${d.a}, B = ${d.b}`, el("div", { class: "stat-grid" },
    stat("Laps (A / B)", `${r.n_a} / ${r.n_b}`, "clean laps compared"),
    stat("Median diff A − B", `${fmtSigned(r.median_diff)} s`, `CI95 [${fmt(r.median_diff_ci95[0])}, ${fmt(r.median_diff_ci95[1])}]`),
    stat("Mean diff A − B", `${fmtSigned(r.mean_diff)} s`, "negative = A faster"),
    stat("Welch t-test", `p = ${fmtP(r.welch_p)}`, `t = ${fmt(r.welch_t, 2)} · unequal variances`),
    stat("Mann-Whitney U", `p = ${fmtP(r.mannwhitney_p)}`, `U = ${fmt(r.mannwhitney_u, 1)} · rank-based`),
    stat("Kolmogorov-Smirnov", `p = ${fmtP(r.ks_p)}`, `D = ${fmt(r.ks_stat, 3)} · shape difference`),
    stat("Cohen's d", fmt(r.cohens_d, 2), `${mag} effect`),
    stat("P(A lap < B lap)", `${(100 * r.prob_a_faster).toFixed(1)}%`, "common-language effect size"))));

  const hist = plotDiv(), byLap = plotDiv();
  root.append(el("div", { class: "grid two" },
    card("Distributions", "overlaid histograms", hist),
    card("Lap-by-lap gap", "A − B on laps both drivers completed cleanly", byLap)));
  const ya = d.laps_a.map((l) => l[d.metric]), yb = d.laps_b.map((l) => l[d.metric]);
  plot(hist, [
    { type: "histogram", x: ya, name: d.a, opacity: 0.6, marker: { color: colA, line: { width: 1, color: css("--surface-1") } }, nbinsx: 25 },
    { type: "histogram", x: yb, name: d.b, opacity: 0.6, marker: { color: colB, line: { width: 1, color: css("--surface-1") } }, nbinsx: 25 },
  ], { barmode: "overlay", xaxis: { title: { text: "Lap time (s)" } }, yaxis: { title: { text: "Laps" } } }, "h2h-hist");
  const mapB = new Map(d.laps_b.map((l) => [l.LapNumber, l[d.metric]]));
  const common = d.laps_a.filter((l) => mapB.has(l.LapNumber));
  const diffs = common.map((l) => l[d.metric] - mapB.get(l.LapNumber));
  plot(byLap, [{ type: "bar", x: common.map((l) => l.LapNumber), y: diffs, marker: { color: diffs.map((v) => (v < 0 ? colA : colB)) },
    hovertemplate: `Lap %{x}: %{y:+.3f}s<extra></extra>` }],
    { xaxis: { title: { text: "Lap" } }, yaxis: { title: { text: `${d.a} − ${d.b} (s) · below 0 = ${d.a} faster` } }, showlegend: false, bargap: 0.15 }, "h2h-by-lap");
}

// ------------------------------------------------------------------ strategy & tyres

async function renderStrategy(root) {
  const opts = renderStrategy.opts ||= { fuel: 0.055, minLaps: 5 };
  root.append(viewHead("Strategy & tyre degradation", "Stint timeline, pit-lane times, and a degradation model. Lap times are fuel-corrected (the car gets lighter every lap), then regressed on tyre age. The per-compound slope uses a within-stint estimator, so car pace and driver skill don't leak into the degradation number.", `${sbase()}/degradation`));
  root.append(el("div", { class: "controls" },
    labelled("Fuel effect (s/lap)", el("input", { type: "number", step: "0.005", min: "0", max: "0.2", value: opts.fuel, style: "width:100px", onchange: (e) => { opts.fuel = +e.target.value; rerender(); } })),
    labelled("Min laps per stint", el("input", { type: "number", min: "3", max: "40", value: opts.minLaps, style: "width:90px", onchange: (e) => { opts.minLaps = +e.target.value; rerender(); } }))));

  const gantt = plotDiv("tall");
  root.append(card("Tyre strategy", "each bar is one stint, in classification order", gantt));
  const [st, deg] = await Promise.all([api(`${sbase()}/strategy`), api(`${sbase()}/degradation?${qs({ fuel_effect: opts.fuel, min_laps: opts.minLaps })}`)]);

  const traces = [];
  for (const c of TYRES) {
    const ss = st.stints.filter((s) => s.Compound === c);
    if (!ss.length) continue;
    traces.push({ type: "bar", orientation: "h", name: c, y: ss.map((s) => s.Driver), x: ss.map((s) => s.Laps), base: ss.map((s) => s.StartLap - 1),
      marker: { color: tyreColor(c), line: { color: css("--surface-1"), width: 2 } },
      customdata: ss.map((s) => [s.Stint, s.StartLap, s.EndLap, s.TyreLifeStart, s.FreshTyre ? "new" : "used"]),
      hovertemplate: `<b>%{y}</b> stint %{customdata[0]}: ${c}<br>laps %{customdata[1]}–%{customdata[2]} (%{x} laps)<br>tyre age at start %{customdata[3]} · %{customdata[4]}<extra></extra>` });
  }
  plot(gantt, traces, { barmode: "overlay", yaxis: { autorange: "reversed", type: "category", categoryorder: "array", categoryarray: st.driver_order },
    xaxis: { title: { text: "Lap" } }, bargap: 0.3, legend: { orientation: "h", y: 1.06 } }, "tyre-strategy");

  const compDiv = plotDiv(), scatter = plotDiv("tall");
  root.append(el("div", { class: "grid two" },
    card("Degradation by compound", "s/lap of tyre age, ±95% CI", compDiv),
    card("Pit-lane time", "pit entry to pit exit", st.pit_stops.length ? dataTable(st.pit_stops, [
      { key: "Driver", label: "Driver", left: true, fmt: driverCell }, { key: "Lap", label: "Lap" },
      { key: "PitLaneTime", label: "Pit lane (s)", fmt: (v) => fmt(v, 2) },
      { key: "From", label: "From", left: true, fmt: tyreCell }, { key: "To", label: "To", left: true, fmt: tyreCell },
    ], { filename: "pit-stops", maxHeight: "300px" }) : el("p", { class: "muted" }, "No pit stops in this session."))));
  plot(compDiv, [{
    type: "scatter", mode: "markers", x: deg.compounds.map((c) => c.Compound), y: deg.compounds.map((c) => c.slope),
    error_y: { type: "data", symmetric: false, array: deg.compounds.map((c) => c.slope_ci95[1] - c.slope), arrayminus: deg.compounds.map((c) => c.slope - c.slope_ci95[0]), color: css("--text-secondary"), thickness: 1.5 },
    marker: { size: 14, color: deg.compounds.map((c) => tyreColor(c.Compound)), line: { width: 2, color: css("--surface-1") } },
    customdata: deg.compounds.map((c) => [c.stints, c.laps, c.r2_within, c.p]),
    hovertemplate: "%{x}: %{y:+.4f} s/lap<br>%{customdata[0]} stints · %{customdata[1]} laps<br>within-R² %{customdata[2]:.3f} · p %{customdata[3]:.2g}<extra></extra>",
  }], { yaxis: { title: { text: "Seconds lost per lap of tyre age" }, zeroline: true }, xaxis: { type: "category" }, showlegend: false }, "degradation-compounds");

  root.append(card("Degradation curves", state.focus.length ? "focus drivers · dots = laps, lines = per-stint OLS fit" : "add focus drivers to draw their stints", scatter));
  const tr = [];
  const focusPts = deg.points.filter((p) => isFocus(p.Driver));
  for (const s of deg.stints.filter((s) => isFocus(s.Driver))) {
    const pts = focusPts.filter((p) => p.Driver === s.Driver && p.Stint === s.Stint);
    const col = driverColor(s.Driver);
    tr.push({ type: "scatter", mode: "markers", name: `${s.Driver} S${s.Stint}`, legendgroup: `${s.Driver}${s.Stint}`, showlegend: false,
      x: pts.map((p) => p.TyreLife), y: pts.map((p) => p.Corrected),
      marker: { size: 8, color: tyreColor(s.Compound), line: { width: 2, color: col } },
      customdata: pts.map((p) => [p.LapNumber, p.LapTimeS]),
      hovertemplate: `${s.Driver} stint ${s.Stint} (${s.Compound})<br>age %{x} · lap %{customdata[0]}<br>corrected %{y:.3f}s · raw %{customdata[1]:.3f}s<extra></extra>` });
    const xs = [s.tyre_life_min, s.tyre_life_max];
    tr.push({ type: "scatter", mode: "lines", name: `${s.Driver} stint ${s.Stint} · ${s.Compound} · ${fmtSigned(s.slope, 3)} s/lap`, legendgroup: `${s.Driver}${s.Stint}`,
      x: xs, y: xs.map((x) => s.intercept + s.slope * x), line: { color: col, width: 2, dash: driverDash(s.Driver) }, hoverinfo: "name" });
  }
  plot(scatter, tr, { xaxis: { title: { text: "Tyre age (laps)" } }, yaxis: { title: { text: "Fuel-corrected lap time (s)" } }, legend: { orientation: "v", x: 1.02, y: 1 } }, "degradation-curves");

  root.append(card("Per-stint regression", "OLS: corrected lap time ~ tyre age", dataTable(deg.stints, [
    { key: "Driver", label: "Driver", left: true, fmt: driverCell }, { key: "Stint", label: "Stint" },
    { key: "Compound", label: "Tyre", left: true, fmt: tyreCell }, { key: "n", label: "Laps" },
    { key: "slope", label: "Slope (s/lap)", fmt: (v) => fmtSigned(v, 4) }, { key: "slope_stderr", label: "SE", fmt: (v) => fmt(v, 4) },
    { key: "intercept", label: "Intercept", fmt: (v) => fmt(v, 2) }, { key: "r2", label: "R²", fmt: (v) => fmt(v, 3) }, { key: "p", label: "p", fmt: fmtP },
    { key: "tyre_life_min", label: "Age from" }, { key: "tyre_life_max", label: "Age to" },
  ], { filename: "stint-degradation" })));
}

// ------------------------------------------------------------------ race trace

async function renderTrace(root) {
  root.append(viewHead("Race trace", "Gap to the leader at the end of every lap (from timing-line timestamps) and running position. Shaded bands are laps run under SC / VSC / red flag.", `${sbase()}/race-trace`));
  const gap = plotDiv("tall"), pos = plotDiv("tall");
  root.append(card("Gap to leader", "focus drivers coloured · lower is better", gap), card("Running position", "", pos));
  const d = await api(`${sbase()}/race-trace`);
  const order = [...Object.keys(d.series).filter((c) => !isFocus(c)), ...focusCodes().filter((c) => d.series[c])];
  const shapes = d.neutralised_laps.map((l) => ({ type: "rect", xref: "x", yref: "paper", x0: l - 1, x1: l, y0: 0, y1: 1, fillcolor: css("--tyre-medium"), opacity: 0.12, line: { width: 0 }, layer: "below" }));
  const mk = (key) => order.map((code) => {
    const s = d.series[code], f = isFocus(code);
    return { type: "scatter", mode: "lines", name: code, x: s.LapNumber, y: s[key], showlegend: f,
      line: { width: f ? 2.5 : 1, color: f ? driverColor(code) : css("--neutral-mark"), dash: f ? driverDash(code) : "solid" },
      opacity: f || !state.focus.length ? 1 : 0.7,
      hovertemplate: `<b>${code}</b> lap %{x}: ${key === "GapToLeader" ? "+%{y:.2f}s" : "P%{y}"}<extra></extra>` };
  });
  plot(gap, mk("GapToLeader"), { yaxis: { autorange: "reversed", title: { text: "Gap to leader (s)" } }, xaxis: { title: { text: "Lap" } }, shapes, hovermode: "closest" }, "race-trace");
  plot(pos, mk("Position"), { yaxis: { autorange: "reversed", dtick: 1, title: { text: "Position" } }, xaxis: { title: { text: "Lap" } }, shapes, hovermode: "closest" }, "positions");
}

// ------------------------------------------------------------------ telemetry

async function renderTelemetry(root) {
  const opts = renderTelemetry.opts ||= { lap: "fastest" };
  root.append(viewHead("Telemetry", "Car data for each focus driver's lap, aligned on distance. The first focus driver is the reference for the delta trace (above 0 = losing time to the reference). Dotted lines mark corners.", null));
  const lapIn = el("input", { type: "text", value: opts.lap, style: "width:90px", onchange: (e) => { opts.lap = e.target.value.trim() || "fastest"; rerender(); } });
  root.append(el("div", { class: "controls" }, labelled("Lap ('fastest' or number)", lapIn),
    el("span", { class: "muted", style: "font-size:12px" }, "Up to 6 focus drivers; reorder by removing and re-adding.")));
  const nf = needFocus(1); if (nf) { root.append(nf); return; }

  const url = `${sbase()}/telemetry?${qs({ drivers: focusCodes().slice(0, 6).join(","), lap: opts.lap })}`;
  root.querySelector(".view-head").append(el("a", { class: "ghost", href: url, target: "_blank" }, "{ } JSON"));
  const div = plotDiv("xtall");
  root.append(card("Telemetry traces", `reference: ${focusCodes()[0]} · lap: ${opts.lap}`, div));
  const d = await api(url);

  const panels = [ // [channel, title, domain]
    ["Speed", "Speed km/h", [0.60, 1]], ["Delta", "Δ to ref (s)", [0.46, 0.57]], ["Throttle", "Throttle %", [0.32, 0.43]],
    ["Brake", "Brake", [0.25, 0.29]], ["nGear", "Gear", [0.12, 0.22]], ["RPM", "RPM", [0, 0.09]],
  ];
  const layout = { hovermode: "x", margin: { l: 70, r: 16, t: 50, b: 44 }, legend: { orientation: "h", x: 0, y: 1, yanchor: "top", yref: "container" },
    xaxis: { title: { text: "Distance (m)" }, anchor: "y6", showspikes: true, spikemode: "across", spikethickness: 1, spikecolor: css("--text-muted"), spikedash: "solid" } };
  panels.forEach(([, title, dom], i) => {
    layout[`yaxis${i ? i + 1 : ""}`] = { domain: dom, title: { text: title }, anchor: "x", fixedrange: false, ...(i === 3 ? { tickvals: [0, 1], ticktext: ["off", "on"], range: [-0.1, 1.1] } : {}) };
  });
  const traces = [];
  Object.entries(d.drivers).forEach(([code, info]) => {
    const t = info.telemetry, col = driverColor(code), dash = driverDash(code);
    panels.forEach(([ch], i) => {
      const x = ch === "Delta" ? t.Delta.Distance : t.Distance, y = ch === "Delta" ? t.Delta.Delta : t[ch];
      traces.push({ type: "scatter", mode: "lines", x, y, yaxis: `y${i ? i + 1 : ""}`, name: `${code} · L${info.lap_number} ${fmtLap(info.lap_time)} (${info.compound})`,
        legendgroup: code, showlegend: i === 0, line: { color: col, width: ch === "Brake" ? 1.5 : 2, dash, shape: ["nGear", "Brake"].includes(ch) ? "hv" : "linear" },
        hovertemplate: `${code} %{y:${ch === "Delta" ? "+.3f" : ".0f"}}<extra></extra>` });
    });
  });
  const shapes = d.corners.map((c) => ({ type: "line", xref: "x", yref: "paper", x0: c.Distance, x1: c.Distance, y0: 0, y1: 1, line: { color: css("--grid"), width: 1, dash: "dot" }, layer: "below" }));
  const annotations = d.corners.map((c) => ({ x: c.Distance, y: 1, xref: "x", yref: "paper", text: `${c.Number}${c.Letter || ""}`, showarrow: false, font: { size: 10, color: css("--text-muted") }, yanchor: "top" }));
  plot(div, traces, { ...layout, shapes, annotations }, "telemetry");

  const prof = Object.entries(d.drivers).map(([code, i]) => ({ Driver: code, Lap: i.lap_number, LapTime: i.lap_time, Compound: i.compound, TyreLife: i.tyre_life, ...i.profile }));
  root.append(card("Driving-style fingerprint", "shares are by distance covered", dataTable(prof, [
    { key: "Driver", label: "Driver", left: true, fmt: driverCell }, { key: "Lap", label: "Lap" }, { key: "LapTime", label: "Time", fmt: fmtLap },
    { key: "Compound", label: "Tyre", left: true, fmt: tyreCell },
    { key: "full_throttle_pct", label: "Full throttle %", fmt: (v) => fmt(v, 1) }, { key: "braking_pct", label: "Braking %", fmt: (v) => fmt(v, 1) },
    { key: "coasting_pct", label: "Coasting %", fmt: (v) => fmt(v, 1) }, { key: "drs_pct", label: "DRS open %", fmt: (v) => fmt(v, 1) },
    { key: "top_speed", label: "Vmax", fmt: (v) => fmt(v, 0) }, { key: "min_speed", label: "Vmin", fmt: (v) => fmt(v, 0) },
    { key: "avg_speed", label: "Vavg", fmt: (v) => fmt(v, 1) }, { key: "gear_changes", label: "Shifts" }, { key: "braking_zones", label: "Brake zones" },
  ], { filename: "lap-profile" })));

  const bz = Object.entries(d.drivers).flatMap(([code, i]) => i.braking_zones.map((z) => ({ Driver: code, ...z })));
  const bzDiv = plotDiv();
  root.append(card("Braking zones", "entry speed vs speed shed · each dot is one braking event", bzDiv));
  plot(bzDiv, Object.keys(d.drivers).map((code) => {
    const z = bz.filter((r) => r.Driver === code);
    return { type: "scatter", mode: "markers", name: code, x: z.map((r) => r.start_m), y: z.map((r) => r.speed_shed),
      marker: { size: z.map((r) => Math.max(8, Math.min(22, r.length_m / 8))), color: driverColor(code), line: { width: 2, color: css("--surface-1") } },
      customdata: z.map((r) => [r.entry_speed, r.min_speed, r.length_m]),
      hovertemplate: `<b>${code}</b> at %{x:.0f} m<br>%{customdata[0]:.0f} → %{customdata[1]:.0f} km/h<br>%{customdata[2]:.0f} m on the brakes<extra></extra>` };
  }), { xaxis: { title: { text: "Distance (m)" } }, yaxis: { title: { text: "Speed shed (km/h)" } } }, "braking-zones");
}

// ------------------------------------------------------------------ track maps

function rotate(xs, ys, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [xs.map((x, i) => x * c - ys[i] * s), xs.map((x, i) => x * s + ys[i] * c)];
}

async function renderTrack(root) {
  const opts = renderTrack.opts ||= { n: 25, channel: "Speed", driver: null, lap: "fastest" };
  root.append(viewHead("Track maps", "Mini-sector dominance: the lap is cut into equal-distance segments and each is painted in the colour of the focus driver who covered it fastest. The channel map paints one driver's lap by any telemetry channel."));
  const drivers = state.overview.drivers.map((d) => d.code);
  opts.driver = drivers.includes(opts.driver) ? opts.driver : focusCodes()[0] || drivers[0];
  root.append(el("div", { class: "controls" },
    labelled("Mini-sectors", select([10, 15, 25, 40, 60, 100], opts.n, (v) => { opts.n = +v; rerender(); })),
    labelled("Lap", el("input", { type: "text", value: opts.lap, style: "width:90px", onchange: (e) => { opts.lap = e.target.value.trim() || "fastest"; rerender(); } })),
    labelled("Channel-map driver", select(drivers, opts.driver, (v) => { opts.driver = v; rerender(); })),
    labelled("Channel", select(["Speed", "nGear", "Throttle", "Brake", "RPM", "DRS"], opts.channel, (v) => { opts.channel = v; rerender(); }))));

  const dom = plotDiv("tall"), ch = plotDiv("tall");
  root.append(el("div", { class: "grid two" }, card("Mini-sector dominance", focusCodes().length >= 2 ? focusCodes().slice(0, 6).join(" vs ") : "needs ≥ 2 focus drivers", dom), card(`${opts.driver} · ${opts.channel}`, `lap: ${opts.lap}`, ch)));
  const mapLayout = { xaxis: { visible: false, scaleanchor: "y" }, yaxis: { visible: false }, margin: { l: 10, r: 10, t: 10, b: 10 }, hovermode: "closest" };

  const tasks = [];
  if (focusCodes().length >= 2) {
    tasks.push(api(`${sbase()}/dominance?${qs({ drivers: focusCodes().slice(0, 6).join(","), lap: opts.lap, n: opts.n })}`).then((d) => {
      const seen = new Set();
      const traces = d.segments.map((s) => {
        const [x, y] = rotate(s.x, s.y, d.rotation);
        const first = !seen.has(s.winner); seen.add(s.winner);
        const won = d.summary.find((r) => r.Driver === s.winner).sectors_won;
        const times = Object.entries(s.times).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k} ${v.toFixed(3)}s`).join("<br>");
        return { type: "scatter", mode: "lines", x, y, name: `${s.winner} (${won}/${d.segments.length})`, legendgroup: s.winner, showlegend: first,
          line: { color: driverColor(s.winner), width: 7, dash: driverDash(s.winner) }, hovertemplate: `Mini-sector ${s.index + 1}<br>${times}<extra></extra>` };
      });
      plot(dom, traces, { ...mapLayout, legend: { orientation: "h", y: -0.02 } }, "dominance");
    }));
  } else dom.replaceWith(needFocus(2));

  tasks.push(api(`${sbase()}/track-map?${qs({ driver: opts.driver, channel: opts.channel, lap: opts.lap })}`).then((d) => {
    const [x, y] = rotate(d.X, d.Y, d.rotation);
    const [cx, cy] = rotate(d.corners.map((c) => c.X), d.corners.map((c) => c.Y), d.rotation);
    const seq = [0, 1, 2, 3, 4].map((i) => [i / 4, css(`--seq-${i}`)]);
    plot(ch, [
      { type: "scatter", mode: "markers", x, y, marker: { size: 8, color: d[opts.channel], colorscale: seq, showscale: true,
        colorbar: { title: { text: opts.channel, font: { color: css("--text-secondary") } }, thickness: 12, tickfont: { color: css("--text-muted") }, outlinewidth: 0 } },
        customdata: d.Distance, hovertemplate: `%{customdata:.0f} m · ${opts.channel} %{marker.color}<extra></extra>`, showlegend: false },
      { type: "scatter", mode: "text", x: cx, y: cy, text: d.corners.map((c) => `${c.Number}${c.Letter || ""}`), textfont: { size: 10, color: css("--text-muted") }, hoverinfo: "skip", showlegend: false },
    ], mapLayout, "channel-map");
  }));
  await Promise.all(tasks);
}

// ------------------------------------------------------------------ sectors & speed

async function renderSectors(root) {
  root.append(viewHead("Sectors & speed traps", "Best individual sectors combine into an ideal lap; the difference to the best actual lap is time left on the table. Sector cells are shaded by gap to the session-best sector.", `${sbase()}/sectors`));
  const [sec, traps] = await Promise.all([api(`${sbase()}/sectors`), api(`${sbase()}/speed-traps`)]);
  const sb = sec.session_best;
  root.append(el("div", { class: "tiles" }, ["S1", "S2", "S3", "Ideal"].map((k) => {
    const who = k === "Ideal" ? "theoretical session best" : sec.drivers.find((r) => r[`Best${k}`] === sb[k])?.Driver;
    return el("div", { class: "tile" }, el("div", { class: "label" }, k === "Ideal" ? "Ideal lap" : `Best ${k}`), el("div", { class: "value" }, k === "Ideal" ? fmtLap(sb[k]) : fmt(sb[k])), el("div", { class: "detail" }, who || ""));
  })));

  const maxGap = Math.max(0.001, ...sec.drivers.flatMap((r) => [r.GapS1, r.GapS2, r.GapS3].filter((v) => v !== null)));
  const shade = (v) => {
    if (v === null) return "–";
    const t = Math.min(1, v / Math.min(maxGap, 1.0));
    const bg = v === 0 ? css("--seq-3") : `color-mix(in srgb, ${css("--seq-1")} ${Math.round((1 - t) * 70)}%, transparent)`;
    return el("span", { style: `display:inline-block;min-width:64px;padding:1px 6px;border-radius:4px;background:${bg};${v === 0 ? `color:${css("--surface-1")};font-weight:700` : ""}` }, v === 0 ? "best" : `+${v.toFixed(3)}`);
  };
  const bar = plotDiv();
  root.append(el("div", { class: "grid two" },
    card("Sector table", "", dataTable(sec.drivers, [
      { key: "Driver", label: "Driver", left: true, fmt: driverCell },
      { key: "BestLap", label: "Best lap", fmt: fmtLap }, { key: "IdealLap", label: "Ideal", fmt: fmtLap },
      { key: "LapLeftOnTable", label: "Left on table", fmt: (v) => fmt(v) },
      { key: "BestS1", label: "S1", fmt: (v) => fmt(v) }, { key: "GapS1", label: "ΔS1", fmt: shade },
      { key: "BestS2", label: "S2", fmt: (v) => fmt(v) }, { key: "GapS2", label: "ΔS2", fmt: shade },
      { key: "BestS3", label: "S3", fmt: (v) => fmt(v) }, { key: "GapS3", label: "ΔS3", fmt: shade },
    ], { filename: "sectors" })),
    card("Time left on the table", "best lap − ideal lap", bar)));
  const sorted = sec.drivers.filter((r) => r.LapLeftOnTable !== null).sort((a, b) => a.LapLeftOnTable - b.LapLeftOnTable);
  plot(bar, [{ type: "bar", orientation: "h", y: sorted.map((r) => r.Driver), x: sorted.map((r) => r.LapLeftOnTable),
    marker: { color: sorted.map((r) => driverColor(r.Driver) || css("--neutral-mark")) }, hovertemplate: "%{y}: %{x:.3f}s<extra></extra>" }],
    { yaxis: { autorange: "reversed", type: "category" }, xaxis: { title: { text: "Seconds" } }, showlegend: false, bargap: 0.25 }, "left-on-table");

  const traps4 = [["SpeedST", "Speed trap"], ["SpeedFL", "Finish line"], ["SpeedI1", "Intermediate 1"], ["SpeedI2", "Intermediate 2"]];
  const divs = traps4.map(() => plotDiv());
  root.append(el("div", { class: "grid two" }, traps4.map(([, label], i) => card(label, "max km/h", divs[i]))));
  traps4.forEach(([key], i) => {
    const rows = traps.traps.filter((r) => r[key] !== null).sort((a, b) => b[key] - a[key]);
    const lo = Math.min(...rows.map((r) => r[key]));
    plot(divs[i], [{ type: "bar", x: rows.map((r) => r.Driver), y: rows.map((r) => r[key]),
      marker: { color: rows.map((r) => driverColor(r.Driver) || css("--neutral-mark")) }, hovertemplate: "%{x}: %{y} km/h<extra></extra>" }],
      { yaxis: { range: [lo - 5, rows[0]?.[key] + 2], title: { text: "km/h" } }, xaxis: { type: "category" }, showlegend: false, bargap: 0.2 }, `speed-${key}`);
  });
  root.append(el("p", { class: "note" }, "Speed-trap axes start near the slowest value so differences are visible; read the numbers, not bar lengths."));
}

// ------------------------------------------------------------------ conditions

async function renderConditions(root) {
  root.append(viewHead("Conditions & race control", "Weather station samples (≈ once a minute) and every race-control message.", `${sbase()}/weather`));
  const [w, rc] = await Promise.all([api(`${sbase()}/weather`), api(`${sbase()}/race-control`)]);
  const panels = [
    ["Temperature", "°C", [["TrackTemp", "Track", 0], ["AirTemp", "Air", 1]]],
    ["Humidity", "%", [["Humidity", "Humidity", 0]]],
    ["Wind speed", "m/s", [["WindSpeed", "Wind", 0]]],
    ["Pressure", "mbar", [["Pressure", "Pressure", 0]]],
  ];
  const divs = panels.map(() => plotDiv());
  root.append(el("div", { class: "grid two" }, panels.map(([t, u], i) => card(t, u, divs[i]))));
  const pal = palette();
  panels.forEach(([, unit, series], i) => plot(divs[i], series.map(([k, name, slot]) => ({
    type: "scatter", mode: "lines", name, x: w.TimeMin, y: w[k], line: { color: pal[slot], width: 2 }, hovertemplate: `${name} %{y} ${unit}<extra></extra>`,
  })), { xaxis: { title: { text: "Session time (min)" } }, yaxis: { title: { text: unit } }, hovermode: "x unified", showlegend: series.length > 1 }, `weather-${i}`));
  if (w.Rainfall?.some(Boolean)) root.append(el("p", { class: "note" }, "Rainfall was recorded during this session."));

  const cats = ["All", ...new Set(rc.messages.map((m) => m.Category))];
  const opts = renderConditions.opts ||= { cat: "All" };
  const holder = el("div");
  const draw = () => {
    holder.innerHTML = "";
    const rows = rc.messages.filter((m) => opts.cat === "All" || m.Category === opts.cat);
    holder.append(dataTable(rows, [
      { key: "Lap", label: "Lap" }, { key: "Time", label: "Time (UTC)", left: true, fmt: (v) => (v ? v.slice(11, 19) : "–") },
      { key: "Category", label: "Category", left: true }, { key: "Flag", label: "Flag", left: true },
      { key: "Message", label: "Message", left: true, fmt: (v) => el("span", { style: "white-space:normal" }, v) },
    ], { filename: "race-control" }));
  };
  root.append(card("Race control", "", el("div", { class: "controls" }, labelled("Category", select(cats, opts.cat, (v) => { opts.cat = v; draw(); }))), holder));
  draw();
}

// ------------------------------------------------------------------ data lab

function ols(x, y) {
  const n = x.length; if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  if (!sxx || !syy) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: sxy / Math.sqrt(sxx * syy), n };
}

async function renderLab(root) {
  const opts = renderLab.opts ||= { method: "spearman", x: "TyreLife", y: "FuelCorrectedS", color: "Compound", cleanOnly: true };
  root.append(viewHead("Data Lab", "A tidy, model-ready lap table joining timing, tyres, weather (as-of join on session time) and race state. Explore relationships, check correlations, then take the data to your own notebook.", `${sbase()}/features`));
  const [feat, corr] = await Promise.all([api(`${sbase()}/features`), api(`${sbase()}/correlation?${qs({ method: opts.method })}`)]);
  const numeric = feat.columns.filter((c) => feat.rows.some((r) => typeof r[c] === "number"));

  // scatter explorer
  const sc = plotDiv("tall");
  const statLine = el("div", { class: "note" });
  root.append(card("Scatter explorer", "pick any two features · OLS line + Pearson r", el("div", { class: "controls" },
    labelled("X", select(numeric, opts.x, (v) => { opts.x = v; drawScatter(); })),
    labelled("Y", select(numeric, opts.y, (v) => { opts.y = v; drawScatter(); })),
    labelled("Colour", select([["Compound", "Compound"], ["Driver", "Focus drivers"], ["none", "None"]], opts.color, (v) => { opts.color = v; drawScatter(); })),
    labelled(" Clean laps only", el("input", { type: "checkbox", checked: opts.cleanOnly, onchange: (e) => { opts.cleanOnly = e.target.checked; drawScatter(); } }), true)), sc, statLine));

  function drawScatter() {
    let rows = feat.rows.filter((r) => typeof r[opts.x] === "number" && typeof r[opts.y] === "number");
    if (opts.cleanOnly) {
      rows = rows.filter((r) => r.IsGreen && !r.IsPitLap && !r.Deleted);
      const best = Math.min(...rows.map((r) => r.LapTimeS).filter((v) => v !== null));
      rows = rows.filter((r) => r.LapTimeS !== null && r.LapTimeS <= best * 1.07);
    }
    const hover = `<b>%{customdata[0]}</b> lap %{customdata[1]} · %{customdata[2]}<br>${opts.x} %{x}<br>${opts.y} %{y}<extra></extra>`;
    const cd = (rs) => rs.map((r) => [r.Driver, r.LapNumber, r.Compound]);
    const groups = opts.color === "Compound" ? TYRES.map((c) => [c, rows.filter((r) => (r.Compound || "UNKNOWN") === c), tyreColor(c)])
      : opts.color === "Driver" ? [["Rest of field", rows.filter((r) => !isFocus(r.Driver)), css("--neutral-mark")], ...focusCodes().map((c) => [c, rows.filter((r) => r.Driver === c), driverColor(c)])]
      : [["Laps", rows, palette()[0]]];
    const traces = groups.filter(([, rs]) => rs.length).map(([name, rs, color]) => ({
      type: "scattergl", mode: "markers", name, x: rs.map((r) => r[opts.x]), y: rs.map((r) => r[opts.y]), customdata: cd(rs), hovertemplate: hover,
      marker: { size: 7, color, opacity: 0.8, line: { width: 1, color: css("--surface-1") } } }));
    const fit = ols(rows.map((r) => r[opts.x]), rows.map((r) => r[opts.y]));
    if (fit) {
      const xs = rows.map((r) => r[opts.x]), lo = Math.min(...xs), hi = Math.max(...xs);
      traces.push({ type: "scatter", mode: "lines", name: "OLS fit", x: [lo, hi], y: [lo, hi].map((v) => fit.intercept + fit.slope * v), line: { color: css("--text-primary"), width: 2, dash: "dash" }, hoverinfo: "skip" });
      statLine.textContent = `n = ${fit.n} · slope = ${fit.slope.toPrecision(4)} · intercept = ${fit.intercept.toPrecision(5)} · Pearson r = ${fit.r.toFixed(3)} · r² = ${(fit.r ** 2).toFixed(3)}`;
    } else statLine.textContent = `n = ${rows.length} · not enough variation to fit a line`;
    plot(sc, traces, { xaxis: { title: { text: opts.x } }, yaxis: { title: { text: opts.y } }, hovermode: "closest" }, `scatter-${opts.x}-${opts.y}`);
  }
  drawScatter();

  // correlation heatmap
  const hm = plotDiv("tall");
  root.append(card("Correlation matrix", `${corr.method} · ${corr.n} clean laps`, el("div", { class: "controls" },
    labelled("Method", select(["spearman", "pearson", "kendall"], opts.method, (v) => { opts.method = v; rerender(); }))), hm));
  const scale = [[0, css("--div-neg")], [0.5, css("--div-mid")], [1, css("--div-pos")]];
  plot(hm, [{ type: "heatmap", z: corr.matrix, x: corr.columns, y: corr.columns, zmin: -1, zmax: 1, colorscale: scale, xgap: 2, ygap: 2,
    colorbar: { thickness: 12, outlinewidth: 0, tickfont: { color: css("--text-muted") } },
    hovertemplate: "%{y} × %{x}<br>ρ = %{z:.3f}<extra></extra>" }],
    { yaxis: { autorange: "reversed", tickfont: { size: 10 } }, xaxis: { tickangle: -45, tickfont: { size: 10 } }, margin: { l: 110, r: 10, t: 10, b: 110 } }, "correlation");

  // feature table preview
  root.append(card("Feature table", `${feat.rows.length} laps × ${feat.columns.length} columns · first 300 shown, download for all`,
    dataTable(feat.rows.slice(0, 300), feat.columns.map((c) => ({ key: c, label: c, left: ["Driver", "Team", "Compound"].includes(c),
      fmt: (v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(3) : typeof v === "boolean" ? (v ? "✓" : "") : v) })), { filename: "features-preview" })));

  // exports
  const datasets = [
    ["features", "Lap feature table", "the table above, every lap"], ["laps", "Raw laps", "FastF1 laps frame, timedeltas → seconds"],
    ["results", "Results", "classification, grid, Q times"], ["weather", "Weather", "per-minute station samples"],
    ["stints", "Stints", "one row per tyre stint"], ["pit-stops", "Pit stops", "pit-lane durations"],
    ["race-control", "Race control", "flags, penalties, messages"],
  ];
  const exportItem = (key, title, desc, extra = {}) => el("div", { class: "export-item" }, el("b", {}, title), el("span", { class: "muted", style: "font-size:12px" }, desc),
    el("div", { class: "links" }, ["csv", "parquet", "json"].map((f) => el("a", { href: `${sbase()}/export/${key}?${qs({ fmt: f, ...extra })}` }, f.toUpperCase()))));
  const telItems = focusCodes().slice(0, 4).map((c) => exportItem("telemetry", `Telemetry · ${c}`, "fastest lap, merged car + position data", { driver: c }));
  root.append(card("Downloads", "every dataset in three formats", el("div", { class: "export-grid" }, datasets.map(([k, t, d]) => exportItem(k, t, d)), telItems)));

  const origin = location.origin;
  root.append(card("Use it from a notebook", "", el("pre", { class: "code" },
`import pandas as pd

base = "${origin}${sbase()}"

laps = pd.read_parquet(f"{base}/export/features?fmt=parquet")     # model-ready lap table
tel  = pd.read_csv(f"{base}/export/telemetry?driver=${focusCodes()[0] || "VER"}")   # fastest-lap telemetry

# statistical endpoints return JSON
import requests
h2h = requests.get(f"{base}/h2h", params={"a": "${focusCodes()[0] || "VER"}", "b": "${focusCodes()[1] || "NOR"}"}).json()["result"]
deg = pd.DataFrame(requests.get(f"{base}/degradation").json()["stints"])`)));
}

// ------------------------------------------------------------------ championship

async function renderChampionship(root) {
  const opts = renderChampionship.opts ||= { kind: "drivers", top: 8 };
  root.append(viewHead(`${state.year} championship`, "Standings and cumulative points after every round (Jolpica / Ergast API). The first load of a season fetches one request per round.", `/api/standings/${state.year}/${opts.kind}/progression`));
  root.append(el("div", { class: "controls" },
    labelled("Championship", select([["drivers", "Drivers"], ["constructors", "Constructors"]], opts.kind, (v) => { opts.kind = v; rerender(); })),
    labelled("Highlight top", select([3, 5, 8], opts.top, (v) => { opts.top = +v; rerender(); }))));
  const div = plotDiv("tall");
  root.append(card("Points progression", `top ${opts.top} coloured, rest grey`, div));
  const [prog, table] = await Promise.all([api(`/api/standings/${state.year}/${opts.kind}/progression`), api(`/api/standings/${state.year}/${opts.kind}`)]);
  const pal = palette();
  const x = prog.rounds.map((r) => r.name.replace(" Grand Prix", ""));
  const traces = prog.series.map((s, i) => ({ type: "scatter", mode: "lines+markers", name: s.code, x, y: s.points, showlegend: i < opts.top,
    line: { width: i < opts.top ? 2.5 : 1, color: i < opts.top ? pal[i] : css("--neutral-mark") }, marker: { size: i < opts.top ? 6 : 3 },
    hovertemplate: `<b>${s.name}</b><br>%{x}: %{y} pts<extra></extra>` })).reverse();
  plot(div, traces, { yaxis: { title: { text: "Points" } }, xaxis: { tickangle: -40, type: "category" }, hovermode: "closest", legend: { orientation: "v", x: 1.01, y: 1, traceorder: "reversed" } }, "points-progression");

  const cols = opts.kind === "drivers"
    ? [{ key: "position", label: "Pos" }, { key: "code", label: "Code", left: true }, { key: "name", label: "Driver", left: true }, { key: "team", label: "Team", left: true }, { key: "points", label: "Points" }, { key: "wins", label: "Wins" }, { key: "driverNationality", label: "Nationality", left: true }]
    : [{ key: "position", label: "Pos" }, { key: "name", label: "Constructor", left: true }, { key: "points", label: "Points" }, { key: "wins", label: "Wins" }, { key: "constructorNationality", label: "Nationality", left: true }];
  root.append(card("Standings", `after round ${table.round}`, dataTable(table.standings, cols, { filename: `${state.year}-${opts.kind}-standings` })));
}

// ------------------------------------------------------------------ about

function renderAbout(root) {
  root.append(el("section", { class: "about" },
    el("h2", {}, "About"),
    el("p", {}, "From a sincere Ferrari fan who doesn’t believe in Santa, but somehow still believes Ferrari will get the strategy right this time."),
    el("p", { class: "about-punchline" }, "That is not optimism. That is an unhealthy relationship.")));
}

// ================================================================== shell

function buildNav() {
  const nav = $("#nav"); nav.innerHTML = "";
  for (const v of VIEWS) {
    if (v.group) { nav.append(el("div", { class: "nav-group" }, v.group)); continue; }
    if (v.topbar) continue;
    nav.append(el("button", { "data-view": v.id, class: state.view === v.id ? "active" : "", disabled: !state.overview && !v.global, onclick: () => go(v.id) }, v.label));
  }
}

let renderToken = 0;
async function rerender() {
  const v = VIEWS.find((x) => x.id === state.view);
  if (!v || (!state.overview && !v.global)) return;
  $("#welcome").hidden = true;
  const token = ++renderToken;
  const root = el("div");
  const spinner = el("div", { class: "inline-loading" }, "Crunching…");
  $("#view").replaceChildren(root, spinner);
  try {
    await v.render(root);
  } catch (e) {
    if (token === renderToken) root.append(el("div", { class: "card inline-loading" }, `Couldn't load this view: ${e.message}`));
  } finally {
    spinner.remove();
  }
}
function go(id) {
  state.view = id;
  document.querySelectorAll("#nav button, #btn-about").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
  writeHash(); rerender();
}

// ---- focus drivers

function renderFocus() {
  const chips = $("#focus-chips"); chips.innerHTML = "";
  for (const f of state.focus) {
    const c = driverColor(f.code);
    chips.append(el("span", { class: "chip" },
      el("span", { class: `swatch ${driverDash(f.code) === "dot" ? "dashed" : ""}`, style: `background:${c};color:${c}` }), f.code,
      el("button", { "aria-label": `Remove ${f.code}`, onclick: () => { state.focus = state.focus.filter((x) => x.code !== f.code); focusChanged(); } }, "×")));
  }
  const add = $("#focus-add");
  add.replaceChildren(el("option", { value: "" }, state.focus.length >= 8 ? "max 8 drivers" : "+ add driver"),
    ...(state.overview?.drivers || []).filter((d) => !isFocus(d.code)).map((d) => el("option", { value: d.code }, `${d.code} · ${d.team}`)));
  add.disabled = state.focus.length >= 8;
}
function addFocus(code) {
  if (!code || isFocus(code) || state.focus.length >= 8) return;
  const used = new Set(state.focus.map((f) => f.slot));
  const slot = [0, 1, 2, 3, 4, 5, 6, 7].find((s) => !used.has(s));
  state.focus.push({ code, slot });
}
function focusChanged() { renderFocus(); writeHash(); rerender(); }

// ---- session selection

async function loadYears() {
  const { seasons } = await api("/api/seasons");
  $("#sel-year").replaceChildren(...seasons.map((y) => el("option", { value: y }, y)));
}
async function loadEvents(year, preferRound) {
  const { events } = await api(`/api/seasons/${year}/events`);
  const ev = $("#sel-event");
  ev.replaceChildren(...events.map((e) => el("option", { value: e.round, disabled: !e.sessions.some((s) => s.available) }, `R${e.round} · ${e.name}${e.sessions.some((s) => s.available) ? "" : " (upcoming)"}`)));
  ev._events = events;
  const lastDone = [...events].reverse().find((e) => e.sessions.some((s) => s.available));
  ev.value = preferRound && events.some((e) => String(e.round) === String(preferRound)) ? preferRound : lastDone?.round ?? events[0]?.round;
  loadSessions();
}
function loadSessions(prefer) {
  const ev = $("#sel-event"), e = ev._events?.find((x) => String(x.round) === ev.value);
  const ss = e ? e.sessions : [];
  $("#sel-session").replaceChildren(...ss.map((s) => el("option", { value: s.code, disabled: !s.available }, s.name)));
  const avail = ss.filter((s) => s.available);
  $("#sel-session").value = prefer && avail.some((s) => s.code === prefer) ? prefer : (avail.find((s) => s.code === "R") || avail.at(-1))?.code || "";
}

async function loadSession(year, event, session, focus = null) {
  loading(true, "Loading session… the first load of a session downloads the timing feed and can take a minute.");
  try {
    state.year = year; state.event = event; state.session = session;
    state.overview = await api(sbase());
    state.focus = [];
    const codes = focus?.length ? focus : state.overview.classification.slice(0, 3).map((r) => r.Abbreviation);
    codes.filter((c) => driverInfo(c)).forEach(addFocus);
    $("#focusbar").hidden = false;
    renderFocus(); buildNav(); writeHash();
    await rerender();
  } catch (e) {
    toast(e.message);
  } finally {
    loading(false);
  }
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.year) p.set("y", state.year);
  if (state.event) p.set("e", state.event);
  if (state.session) p.set("s", state.session);
  if (state.focus.length) p.set("f", focusCodes().join(","));
  p.set("v", state.view);
  history.replaceState(null, "", `#${p}`);
}

async function init() {
  buildNav();
  $("#btn-theme").addEventListener("click", () => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const cur = document.documentElement.dataset.theme || (dark ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("f1p-theme", next); } catch (e) { /* storage unavailable */ }
    renderFocus(); rerender();
  });
  $("#btn-about").addEventListener("click", () => go("about"));
  $("#team-colors").addEventListener("change", (e) => { state.teamColors = e.target.checked; focusChanged(); });
  $("#focus-add").addEventListener("change", (e) => { addFocus(e.target.value); focusChanged(); });
  $("#sel-year").addEventListener("change", (e) => {
    if (!state.overview) { state.year = +e.target.value; if (state.view === "championship") rerender(); }
    loadEvents(e.target.value).catch((err) => toast(err.message));
  });
  $("#sel-event").addEventListener("change", () => loadSessions());
  $("#picker").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!$("#sel-session").value) return toast("No completed session selected.");
    loadSession(+$("#sel-year").value, $("#sel-event").value, $("#sel-session").value);
  });

  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("v") && VIEWS.some((v) => v.id === h.get("v"))) state.view = h.get("v");
  try {
    await loadYears();
    const year = h.get("y") || $("#sel-year").value;
    $("#sel-year").value = year;
    state.year = +year;
    await loadEvents(year, h.get("e"));
    if (h.get("s")) loadSessions(h.get("s"));
    if (h.get("y") && h.get("e") && h.get("s")) {
      await loadSession(+h.get("y"), h.get("e"), h.get("s"), h.get("f")?.split(","));
    } else if (VIEWS.find((v) => v.id === state.view)?.global) go(state.view);
  } catch (e) { toast(e.message); }
}
init();
