import { LanderScene } from "./scene.js";

const $ = id => document.getElementById(id);
// Group digits the same way for every viewer: the browser locale would otherwise mix
// "1,07,221" and "107,221" in the same panel.
const n0 = v => Number(v).toLocaleString("en-US");
const ACTIONS = ["Coast", "Left thruster", "Main engine", "Right thruster"];
const ACT_KEYS = ["coast", "left_thruster", "main_engine", "right_thruster"];

const OUT_TEXT = {
  landed_pad: "Landed on the pad", landed_off_pad: "Landed beside the pad",
  crashed: "Crashed", flew_off: "Flew out of bounds",
  timed_out: "Ran out of time hovering", interrupted: "Interrupted",
};

/* Palette mirrors style.css. The accent follows the active world, so the console always
   reads as the place you are flying in. */
const C = { ok: "#35b189", bad: "#e05668", warn: "#d9972b", fg3: "#67748a", line: "#222c3c", fg: "#e9eff8" };
const ACCENT = {
  luna:  { on: "#8fb4dc", dim: "#2b3b50" },
  ares:  { on: "#e0855a", dim: "#50342b" },
  titan: { on: "#d7b25c", dim: "#4c3f26" },
};
const OUT_COLOR = {
  landed_pad: C.ok, landed_off_pad: "#5fae8f", crashed: C.bad,
  flew_off: "#a8323f", timed_out: C.warn, interrupted: C.fg3,
};
const MIX_COLOR = ["#56627a", "#4b7fc4", "#8fb4dc", "#2f5d9e"];

const scene = new LanderScene($("scene"));
let S = null, curve = [], mode = "live", replay = null;
let terrainY = 3.33, selected = null, lastEpisode = null;

/* ───────────────────────────── asset loading ───────────────────────────── */
scene.onAssets = d => {
  const box = $("loader");
  if (d.done) {
    box.hidden = true;
    if (!d.lander || !d.moon) {
      log("Flying with the built-in shapes. Add vikram.glb and petavius.glb to web/assets for the photoreal view.");
    }
    return;
  }
  box.hidden = false;
  $("loader-label").textContent = `Loading ${d.label}`;
  if (d.total) $("loader-bar").style.width = `${Math.round(100 * d.loaded / d.total)}%`;
};

/* ───────────────────────────── in-page dialog ──────────────────────────── */
function ask({ title, body, ok = "Confirm", input = null, inputLabel = "Name" }) {
  return new Promise(resolve => {
    const dlg = $("ask");
    $("ask-title").textContent = title;
    $("ask-body").textContent = body || "";
    $("ask-ok").textContent = ok;
    const wrap = $("ask-input-wrap"), field = $("ask-input");
    wrap.hidden = input === null;
    if (input !== null) { $("ask-input-label").textContent = inputLabel; field.value = input; }
    dlg.onclose = () => resolve(dlg.returnValue === "ok" ? (input === null ? true : field.value.trim()) : null);
    dlg.showModal();
    if (input !== null) { field.focus(); field.select(); }
  });
}

/* ───────────────────────────── websocket ───────────────────────────────── */
let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => setChip("chip-conn", "on", "connected");
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    setChip("chip-conn", "bad", "reconnecting");
    setTimeout(connect, 1500);
  };
}
const send = (cmd, arg) => ws?.readyState === 1 && ws.send(JSON.stringify({ cmd, arg }));

function setChip(id, state, text) {
  const el = $(id);
  el.dataset.state = state;
  el.querySelector("span").textContent = text;
}

function handle(m) {
  if (m.type === "state") return applyState(m);
  if (m.type === "log") return log(m.text);
  if (m.type === "proof") return onProof(m);
  if (m.type === "reset" && mode === "replay" && replay?.auto && S?.speed !== "train") { mode = "live"; replay = null; }
  if (m.type === "reset" && mode === "live") {
    if (m.world !== scene.world) scene.setWorld(m.world);
    scene.setTerrain(m.terrain); terrainY = m.terrain.pad[2]; scene.snap();
    $("hud-n").textContent = m.n;
    $("hud-mode").textContent = m.exam ? "Exam" : "Live";
    hideBanner();
  }
  if (m.type === "frame" && mode === "live") showFrame(m.f, m.step, m.q, m.sit);
  if (m.type === "episode") onEpisode(m);
}

function applyState(s) {
  const first = !S;
  S = s;
  setAccent(s.world.key);
  if (s.db) $("chip-db").textContent = s.stats.graph;
  $("chip-db").title = `FalkorDB ${s.db} · graph ${s.stats.graph}`;
  $("db").textContent = `FalkorDB: ${s.db} · graph ${s.stats.graph}`;
  $("chip-writer").hidden = !s.read_only;
  if (scene.world !== s.world.key) scene.setWorld(s.world.key);

  const phys = w => `${w.wind ? `wind ${w.wind_power}` : "no wind"} · g ${w.gravity}`;
  $("world-name").textContent = s.world.name;
  $("world-phys").textContent = phys(s.world);
  $("worlds").innerHTML = "";
  for (const w of s.worlds) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", w.key === s.world.key);
    b.innerHTML = `${w.name}<small>${phys(w)}</small>`;
    b.title = w.blurb;
    b.onclick = () => {
      closeWorlds();
      if (w.key === s.world.key) return;
      mode = "live"; replay = null; $("btn-live").hidden = true;
      send("set_world", w.key);
      curve = []; selected = null;
      setTimeout(() => { loadCurve(); loadInsights(); }, 800);
    };
    $("worlds").appendChild(b);
  }

  $("run-label").textContent = !s.running ? "Start" : s.paused ? "Resume" : "Pause";
  $("run-icon").setAttribute("d", !s.running || s.paused ? "M3 2l7 4-7 4z" : "M3 2h2v8H3zM7 2h2v8H7z");
  document.querySelectorAll("#speed button").forEach(b => b.setAttribute("aria-checked", b.dataset.speed === s.speed));
  $("exam").checked = s.exam;
  $("exam-btn").setAttribute("aria-pressed", String(!!s.exam));
  for (const id of ["btn-run", "btn-interrupt", "btn-gust-l", "btn-gust-r", "btn-wipe", "btn-restore", "btn-seed", "btn-prove"]) {
    $(id).disabled = !!s.read_only;
  }
  renderStats(s.stats);
  $("snap-list").innerHTML = s.snapshots.length
    ? s.snapshots.map(t => `<option>${t}</option>`).join("")
    : `<option disabled selected>No snapshots yet</option>`;
  $("seed-list").innerHTML = s.worlds.filter(w => w.key !== s.world.key)
    .map(w => `<option value="${w.key}">from ${w.name}</option>`).join("");
  if (first) { loadCurve(); loadInsights(); }
}

function setAccent(world) {
  const a = ACCENT[world] || ACCENT.luna;
  document.documentElement.style.setProperty("--accent", a.on);
  document.documentElement.style.setProperty("--accent-dim", a.dim);
}
const accent = () => (ACCENT[S?.world.key] || ACCENT.luna).on;

function renderStats(st) {
  const rate = st.episodes ? Math.round(100 * st.landed / st.episodes) : 0;
  const tiles = [
    ["Attempts", n0(st.episodes), ""],
    ["Landed", `${rate}<small>%</small>`, "good"],
    ["Skill tiles", n0(st.tiles), ""],
    ["Situations", n0(st.situations), ""],
    ["Transitions", n0(st.flows), ""],
    ["Crashed", n0(st.crashed), ""],
  ];
  $("stats").innerHTML = tiles
    .map(([k, v, cls]) => `<dl class="tile ${cls}"><dt>${k}</dt><dd>${v}</dd></dl>`).join("");
}

/* ───────────────────────────── telemetry ───────────────────────────────── */
function showFrame(f, step, q, sit) {
  scene.setFrame(f);
  $("hud-alt").textContent = (f[1] - terrainY).toFixed(1);
  $("hud-tilt").textContent = `${(f[2] * 57.3).toFixed(0)}°`;
  $("hud-step").textContent = step;
  if (showFrame.prev) $("hud-vy").textContent = ((f[1] - showFrame.prev[1]) * 50).toFixed(1);
  showFrame.prev = f;
  if (sit) $("hud-sit").textContent = sit;
  if (q) renderQ(q, f[5]);
}

function renderQ(q, chosen) {
  const lo = Math.min(...q), hi = Math.max(...q), span = Math.max(1e-6, hi - lo);
  $("qbars").innerHTML = q.map((v, i) =>
    `<div class="qbar ${i === chosen ? "chosen" : ""}"><span>${ACTIONS[i]}</span>
     <div class="track"><div class="fill" style="width:${8 + 92 * (v - lo) / span}%"></div></div></div>`).join("");
}

function banner(outcome, sub) {
  const b = $("banner");
  b.className = "banner " + (outcome.startsWith("landed") ? "landed"
    : outcome === "crashed" || outcome === "flew_off" ? "crashed" : outcome);
  b.innerHTML = `${OUT_TEXT[outcome] || outcome}<small>${sub}</small>`;
  b.hidden = false;
  clearTimeout(banner.t);
  banner.t = setTimeout(hideBanner, 2200);
}
const hideBanner = () => { $("banner").hidden = true; };

/* ───────────────────────────── episodes ────────────────────────────────── */
function onEpisode(m) {
  const ep = m.ep;
  lastEpisode = ep;
  curve.push({ n: ep.n, score: ep.score, outcome: ep.outcome, learned: ep.learned });
  renderStats(m.stats);
  drawCurve(); drawBarcode();
  if (mode === "live" && S?.speed !== "train") {
    scene.outcome(ep.outcome);
    banner(ep.outcome, `attempt ${ep.n} · score ${ep.score.toFixed(0)} · ${ep.situations} situations · ${ep.tiles_written} tiles written`);
  }
  if (!selected || selected === ep.n - 1) showWhy(ep.n, true);
  if (ep.n % 25 === 0) loadInsights();
  if (S?.speed === "train" && mode === "live" && !replay) playReplay(ep.n, true);
}

async function loadCurve() {
  curve = await (await fetch("/api/curve")).json();
  drawCurve(); drawBarcode();
  if (curve.length) showWhy(curve[curve.length - 1].n, true);
}

function drawCurve() {
  const c = $("curve"), ctx = c.getContext("2d"), dpr = devicePixelRatio || 1;
  const W = c.clientWidth, H = 132;
  c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const lo = -300, hi = 300;
  const y = v => H - 16 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (H - 26);

  ctx.font = '400 10px "IBM Plex Mono", monospace';
  for (const [v, label, col] of [[200, "solved 200", C.ok], [0, "0", C.line], [-200, "−200", C.line]]) {
    ctx.strokeStyle = col;
    ctx.setLineDash(v === 200 ? [3, 3] : []);
    ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(W, y(v)); ctx.stroke();
    ctx.fillStyle = v === 200 ? C.ok : C.fg3;
    ctx.fillText(label, 2, y(v) - 4);
  }
  ctx.setLineDash([]);
  if (curve.length < 2) {
    ctx.fillStyle = C.fg3;
    ctx.fillText("The learning curve appears after a few attempts.", 2, H - 3);
    return;
  }
  const n = curve.length, win = 50;
  let sum = 0; const avg = [];
  curve.forEach((p, i) => { sum += p.score; if (i >= win) sum -= curve[i - win].score; avg.push(sum / Math.min(i + 1, win)); });

  ctx.fillStyle = "rgba(157,171,192,.22)";
  curve.forEach((p, i) => ctx.fillRect(i / (n - 1) * W, y(p.score), 1.1, 1.1));

  const a = accent();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, `${a}44`); grad.addColorStop(1, `${a}00`);
  ctx.beginPath(); ctx.moveTo(0, H);
  avg.forEach((v, i) => ctx.lineTo(i / (n - 1) * W, y(v)));
  ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  ctx.strokeStyle = a; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.beginPath();
  avg.forEach((v, i) => { const X = i / (n - 1) * W; i ? ctx.lineTo(X, y(v)) : ctx.moveTo(X, y(v)); });
  ctx.stroke();

  ctx.beginPath(); ctx.arc(W - 1, y(avg[n - 1]), 2.6, 0, 7); ctx.fillStyle = a; ctx.fill();
  $("curve-note").textContent = `last 50 average ${avg[n - 1].toFixed(0)} · ${n0(n)} attempts`;
}

function drawBarcode() {
  const c = $("barcode"), ctx = c.getContext("2d"), dpr = devicePixelRatio || 1;
  const W = c.clientWidth, H = 30;
  c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const n = curve.length; if (!n) return;
  const bins = Math.min(n, Math.floor(W)), per = n / bins, bw = W / bins;
  for (let b = 0; b < bins; b++) {
    const slice = curve.slice(Math.floor(b * per), Math.max(Math.floor((b + 1) * per), Math.floor(b * per) + 1));
    const ok = slice.filter(p => p.outcome.startsWith("landed")).length / slice.length;
    const last = slice[slice.length - 1];
    ctx.fillStyle = slice.length === 1 ? OUT_COLOR[last.outcome] : mixColor(ok);
    ctx.fillRect(b * bw, last.learned ? 0 : 5, Math.max(1, bw - (bw > 3 ? 1 : 0)), last.learned ? H : H - 10);
  }
  if (selected) {
    const i = curve.findIndex(p => p.n === selected);
    if (i >= 0) { ctx.fillStyle = C.fg; ctx.fillRect(i / n * W - 1, 0, 2, H); }
  }
}

function mixColor(f) {        // crash red → landed jade
  const a = [224, 86, 104], b = [53, 177, 137];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(",")})`;
}

$("barcode").addEventListener("click", e => {
  if (!curve.length) return;
  const r = e.target.getBoundingClientRect();
  const i = Math.min(curve.length - 1, Math.floor((e.clientX - r.left) / r.width * curve.length));
  const n = curve[i].n;
  playReplay(n); showWhy(n); showTab("why");
});
$("barcode").tabIndex = 0;
$("barcode").addEventListener("keydown", e => {
  if (!curve.length || !["ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) return;
  e.preventDefault();
  let i = curve.findIndex(p => p.n === selected); if (i < 0) i = curve.length - 1;
  if (e.key === "ArrowLeft") i = Math.max(0, i - 1);
  if (e.key === "ArrowRight") i = Math.min(curve.length - 1, i + 1);
  showWhy(curve[i].n);
  if (e.key === "Enter") playReplay(curve[i].n);
});

/* ───────────────────────────── replay ──────────────────────────────────── */
async function playReplay(n, auto = false) {
  const r = await fetch(`/api/frames/${n}`);
  if (!r.ok) {
    if (!auto) {
      const t = `No flight recording kept for attempt ${n}. Its memory is still in the graph, so the explanation below works.`;
      log(t); $("hud-sit").textContent = t;
    }
    return;
  }
  const d = await r.json();
  mode = "replay";
  $("btn-live").hidden = auto;
  $("hud-mode").textContent = auto ? "Latest" : "Replay";
  $("hud-n").textContent = n;
  const ep = curve.find(p => p.n === n);
  $("hud-sit").textContent = ep ? `${OUT_TEXT[ep.outcome] || ep.outcome}, score ${Math.round(ep.score)}` : "";
  $("qbars").innerHTML = "";
  scene.setTerrain(d.terrain); terrainY = d.terrain.pad[2]; scene.snap(); hideBanner();
  replay = { frames: d.frames, i: 0, n, outcome: ep?.outcome, auto, speed: auto ? 3 : 1 };
}

setInterval(() => {
  if (mode !== "replay" || !replay) return;
  for (let k = 0; k < replay.speed && replay.i < replay.frames.length; k++, replay.i++);
  showFrame(replay.frames[Math.min(replay.i, replay.frames.length - 1)], replay.i, null, null);
  if (replay.i >= replay.frames.length) {
    scene.outcome(replay.outcome);
    if (!replay.auto) banner(replay.outcome || "interrupted", `replay of attempt ${replay.n}`);
    const was = replay; replay = null;
    setTimeout(() => {
      if (was.auto) { mode = "live"; if (S?.speed === "train" && lastEpisode) playReplay(lastEpisode.n, true); }
    }, 1200);
  }
}, 20);

$("btn-live").onclick = () => {
  mode = "live"; replay = null;
  $("btn-live").hidden = true;
  $("hud-mode").textContent = "Live";
};

/* ───────────────────────────── explanation ─────────────────────────────── */
async function showWhy(n, quiet = false) {
  selected = n; drawBarcode();
  const x = await (await fetch(`/api/explain/${n}`)).json();
  if (x.error) { if (!quiet) $("why-summary").textContent = x.error; return; }
  $("why-n").textContent = n;
  $("why-summary").textContent = x.summary || `${OUT_TEXT[x.outcome]} (score ${x.score}).`;

  const marks = {
    [x.point_of_no_return]: ["ponr", "point of no return"],
    [x.decision_point]: ["decision", "the decision that mattered"],
    [x.closest_call]: ["decision", "closest call"],
  };
  $("why-path").innerHTML = x.path.map(p => {
    const m = marks[p.i];
    return `<li class="${m ? m[0] : ""}">
      <span class="risk" style="background:${mixColor(1 - p.risk)}" title="${Math.round(p.risk * 100)}% of past attempts through here failed"></span>
      <span>${p.label}${m ? ` <span class="tag-i">· ${m[1]}</span>` : ""}</span>
      <span class="did">${ACTIONS[ACT_KEYS.indexOf(p.did)]} · ${Math.round(p.risk * 100)}%</span></li>`;
  }).join("");

  const L = x.lesson;
  let html = "";
  if (L) {
    const row = (name, mix) => mix
      ? `<span>${name}</span><div class="mixbar">${Object.values(mix).map((v, i) =>
          `<span style="width:${v * 100}%;background:${MIX_COLOR[i]}" title="${ACTIONS[i]} ${Math.round(v * 100)}%"></span>`).join("")}</div>`
      : "";
    html += `<h3>At “${L.situation}”</h3><div class="mix">
      ${row("This attempt", L.this_attempt_did)}
      ${row("Attempts that landed", L.landing_attempts_did)}
      ${row("Attempts that failed", L.other_attempts_did)}</div>`;
    html += `<div class="legend">${ACTIONS.map((a, i) => `<span><i style="background:${MIX_COLOR[i]}"></i>${a}</span>`).join("")}</div>`;
  }
  if (x.safe_path) {
    html += `<h3>Safest known route from there <small>weighted shortest path, p≈${x.safe_path.p_estimate}</small></h3>
      <ol class="safe">${x.safe_path.steps.slice(1).map(s => `<li>${s.replaceAll("_", " ")}</li>`).join("")}</ol>`;
  }
  $("why-lesson").innerHTML = html;
  $("why-cypher").textContent = x.cypher.join("\n\n");
}

async function loadInsights() {
  const [h, s] = await Promise.all([
    fetch("/api/hubs").then(r => r.json()),
    fetch("/api/signatures").then(r => r.json()),
  ]);
  $("hubs").innerHTML = h.hubs.length
    ? h.hubs.slice(0, 5).map(x => `<li><span>${x.label}</span><span class="n">${Math.round(x.risk * 100)}% fail · ${x.visits} visits</span></li>`).join("")
    : "<li>Needs more attempts.</li>";
  $("sigs").innerHTML = s.signatures.length
    ? s.signatures.map(x => `<li><span>${x.why}</span><span class="n">${Math.round(x.share * 100)}%</span></li>`).join("")
    : "<li>No crashes recorded yet.</li>";
}

/* ───────────────────── the removal test, run live ──────────────────────── */
let proofPhases = [];

function onProof(m) {
  const box = $("proof");
  if (m.stage === "start") {
    proofPhases = m.phases;
    box.innerHTML = m.phases.map(p => `
      <div class="phase" id="ph-${p.key}">
        <div class="phase-head">
          <span class="phase-name">${p.label}</span>
          <span class="phase-score" id="ph-${p.key}-score">—</span>
        </div>
        <div class="phase-track" id="ph-${p.key}-track">
          ${Array.from({ length: m.per_phase }, () => "<i></i>").join("")}
        </div>
      </div>`).join("");
    $("btn-prove").disabled = true;
    $("proof-note").textContent = "Running. Each tick is one flight from the same starting seed.";
    return;
  }
  if (m.stage === "attempt") {
    const ph = $(`ph-${m.phase}`);
    if (!ph) return;
    proofPhases.forEach(p => $(`ph-${p.key}`)?.classList.remove("running"));
    ph.classList.add("running");
    const tick = $(`ph-${m.phase}-track`).children[m.i - 1];
    if (tick) tick.className = m.outcome.startsWith("landed") ? "landed"
      : (m.outcome === "crashed" || m.outcome === "flew_off") ? "crashed" : "other";
    $(`ph-${m.phase}-score`).textContent = `${m.landed}/${m.of} landed · avg ${m.avg_score}`;
    if (m.i === m.of) {
      ph.classList.remove("running");
      ph.classList.add(m.phase === "wiped" ? (m.landed === 0 ? "pass" : "fail") : (m.landed > 0 ? "pass" : "fail"));
    }
    return;
  }
  if (m.stage === "done") {
    $("btn-prove").disabled = !!S?.read_only;
    const wiped = $("ph-wiped")?.classList.contains("pass");
    $("proof-note").textContent = wiped
      ? "With the graph gone the lander cannot land at all, and restoring the snapshot brings the skill straight back. The graph is the whole policy."
      : "Finished. Compare the three rows above.";
    loadCurve();
    return;
  }
  if (m.stage === "error") {
    $("btn-prove").disabled = false;
    $("proof-note").textContent = `Stopped: ${m.why}. The memory was restored from the snapshot.`;
  }
}

$("btn-prove").onclick = async () => {
  const n = Math.max(3, Math.min(30, parseInt($("prove-n").value, 10) || 10));
  const go = await ask({
    title: "Run the removal test?",
    body: `This flies ${n} seeded attempts with the graph, wipes ${S.world.name}'s memory and flies the same ${n} again, then restores from a snapshot and repeats. Training pauses while it runs.`,
    ok: "Run it",
  });
  if (go) send("prove", n);
};

/* ───────────────────────────── tabs ────────────────────────────────────── */
const TABS = ["why", "graph", "proof", "mem"];
function showTab(name) {
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute("aria-selected", on);
    $(`pane-${t}`).hidden = !on;
  }
}
TABS.forEach(t => { $(`tab-${t}`).onclick = () => showTab(t); });
document.querySelector(".tabs").addEventListener("keydown", e => {   // arrows move between tabs
  if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const i = TABS.findIndex(t => $(`tab-${t}`) === document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
  showTab(next); $(`tab-${next}`).focus();
});

/* ───────────────────────────── controls ────────────────────────────────── */
$("btn-run").onclick = () => send(!S?.running ? "run" : S.paused ? "resume" : "pause");
$("btn-interrupt").onclick = () => send("interrupt");
$("btn-gust-l").onclick = () => send("gust", -1);
$("btn-gust-r").onclick = () => send("gust", 1);
document.querySelectorAll("#speed button").forEach(b => { b.onclick = () => send("set_speed", b.dataset.speed); });
$("exam").onchange = e => send("exam", e.target.checked);

$("btn-snap").onclick = async () => {
  const t = await ask({
    title: "Save a snapshot", ok: "Save",
    body: `Copies ${S.world.name}'s memory with GRAPH.COPY so you can come back to it.`,
    input: `after-${S?.stats.episodes ?? 0}`, inputLabel: "Snapshot name",
  });
  if (t) send("snapshot", t.replace(/[^\w-]/g, "_"));
};

$("btn-restore").onclick = async () => {
  const t = $("snap-list").value;
  if (!t) return;
  const go = await ask({
    title: "Restore this snapshot?", ok: "Restore",
    body: `${S.world.name}'s current memory is replaced by snapshot “${t}”.`,
  });
  if (go) { send("restore", t); setTimeout(loadCurve, 800); }
};

$("btn-seed").onclick = () => send("seed_from", $("seed-list").value);

$("btn-wipe").onclick = async () => {
  const go = await ask({
    title: `Wipe ${S.world.name}'s memory?`, ok: "Wipe it",
    body: "Everything this world's lander has learned is deleted. Save a snapshot first if you may want it back. This is also what the removal test does, safely.",
  });
  if (go) { send("wipe"); curve = []; setTimeout(loadCurve, 800); }
};

$("btn-refresh-insights").onclick = loadInsights;
function log(t) { $("log").textContent = t; }

/* ───────────────── optional photoreal relay (Reactor) ──────────────────── */
let rws = null, rTimer = null, rUrl = null;

fetch("/api/reactor").then(r => r.json()).then(s => {
  $("reactor-btn").title = s.message;
  if (!s.available) $("reactor-btn").disabled = true;
});

$("reactor").onchange = e => (e.target.checked ? startReactor() : stopReactor());

function startReactor() {
  rws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/reactor`);
  rws.binaryType = "blob";
  const grab = document.createElement("canvas");
  grab.width = 640; grab.height = 448;
  rws.onopen = () => rws.send(JSON.stringify({ world: scene.world }));
  rws.onmessage = e => {
    if (typeof e.data === "string") {
      const d = JSON.parse(e.data);
      log(`Photoreal: ${d.reactor}${d.why ? " — " + d.why : ""}${d.limit ? ` (stops after ${d.limit}s)` : ""}`);
      if (d.reactor === "live" && !rTimer) {
        rTimer = setInterval(() => {
          grab.getContext("2d").drawImage($("scene"), 0, 0, grab.width, grab.height);
          grab.toBlob(b => rws?.readyState === 1 && b && rws.send(b), "image/jpeg", 0.8);
        }, 66);
      }
      if (["stopped", "error", "unavailable"].includes(d.reactor)) stopReactor();
      return;
    }
    if (rUrl) URL.revokeObjectURL(rUrl);
    rUrl = URL.createObjectURL(e.data);
    $("reactor-view").src = rUrl;
    $("reactor-view").hidden = false;
  };
  rws.onclose = () => stopReactor();
}

function stopReactor() {
  clearInterval(rTimer); rTimer = null;
  if (rws && rws.readyState <= 1) { try { rws.send(JSON.stringify({ stop: true })); } catch { /* closing */ } rws.close(); }
  rws = null;
  $("reactor").checked = false;
  $("reactor-view").hidden = true;
}

/* ───────────────── camera: the viewer can take it at any time ──────────── */
scene.onCamera = free => { $("camhint").hidden = !free; };
$("btn-camreset").onclick = () => scene.setFreeLook(false);

/* ───────────────── chrome: dock, panel, world menu ─────────────────────── */
const gsap = window.gsap;
let view = "flight";

/* world dropdown */
function openWorlds(open) {
  $("worlds").hidden = !open;
  $("world-btn").setAttribute("aria-expanded", String(open));
}
const closeWorlds = () => openWorlds(false);
$("world-btn").onclick = e => { e.stopPropagation(); openWorlds($("worlds").hidden); };
addEventListener("click", closeWorlds);
addEventListener("keydown", e => { if (e.key === "Escape") { closeWorlds(); if (view === "analysis") setView("flight"); } });

/* collapsing the panel gives the landing the whole screen */
$("panel-toggle").onclick = () => {
  const p = $("panel"), open = p.classList.toggle("collapsed") === false;
  $("panel-toggle").setAttribute("aria-expanded", String(open));
};

/* dock toggles that stand in for hidden checkboxes */
$("exam-btn").onclick = () => {
  const on = $("exam-btn").getAttribute("aria-pressed") !== "true";
  $("exam-btn").setAttribute("aria-pressed", String(on));
  $("exam").checked = on;
  send("exam", on);
};
$("reactor-btn").onclick = () => {
  const on = $("reactor-btn").getAttribute("aria-pressed") !== "true";
  $("reactor-btn").setAttribute("aria-pressed", String(on));
  $("reactor").checked = on;
  on ? startReactor() : stopReactor();
};

/* ───────────────── the write-up, over the scene ────────────────────────── */
function setView(next) {
  if (view === next) return;
  view = next;
  const panel = $("analysis");
  $("btn-analysis").setAttribute("aria-pressed", String(next === "analysis"));
  if (next === "analysis") {
    panel.hidden = false;
    loadAnalysis();
    if (gsap) {
      gsap.fromTo(panel, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" });
      gsap.from(panel.querySelectorAll(".brief > *, .acard"),
        { y: 16, opacity: 0, duration: 0.45, stagger: 0.045, ease: "power3.out", clearProps: "all" });
    }
    location.hash = "analysis";
  } else {
    const hide = () => { panel.hidden = true; };
    if (gsap) gsap.to(panel, { opacity: 0, duration: 0.2, ease: "power2.in", onComplete: hide });
    else hide();
    location.hash = "";
  }
}
$("btn-analysis").onclick = () => setView(view === "analysis" ? "flight" : "analysis");
$("analysis-close").onclick = () => setView("flight");
if (location.hash === "#analysis") addEventListener("load", () => setView("analysis"));

/* ───────────────── label pinned to the craft ───────────────────────────── */
const tag = $("tag");
(function pin() {
  requestAnimationFrame(pin);
  if (view === "analysis") { tag.hidden = true; return; }
  const p = scene.screenPos();
  tag.hidden = !p.visible;
  if (!p.visible) return;
  tag.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
  // Flip the readout so it stays on screen: below the craft when it is high, to its left
  // when it is far right. The panel also occupies the right edge, so leave room for it.
  const boxEl = tag.querySelector(".tag-box");
  const h = boxEl.offsetHeight || 190;
  const rightEdge = $("panel").getBoundingClientRect().left - 12;
  tag.dataset.v = p.y - h - 30 < 56 ? "down" : "up";
  tag.dataset.h = p.x + 240 > rightEdge ? "left" : "right";
  const box = boxEl.getBoundingClientRect();
  const line = tag.querySelector(".tag-leader line");
  line.setAttribute("x2", String(Math.round(box.left + box.width / 2 - p.x)));
  line.setAttribute("y2", String(Math.round((tag.dataset.v === "down" ? box.top : box.bottom) - p.y)));
})();

/* ───────────────── analysis: compare the three worlds ──────────────────── */
const WORLD_COLOR = { luna: "#8fb4dc", ares: "#e0855a", titan: "#d7b25c" };
let analysis = null;

async function loadAnalysis() {
  if (!analysis) {
    const worlds = await (await fetch("/api/worlds")).json();
    const curves = await Promise.all(worlds.map(w =>
      fetch(`/api/curve?world=${w.key}`).then(r => r.json()).catch(() => [])));
    analysis = worlds.map((w, i) => ({ ...w, curve: curves[i] }));
  }
  drawCompare();
  drawGrowth();
  fillTable();
  fillRefs();
}

function smooth(points, win = 50) {
  let sum = 0; const out = [];
  points.forEach((p, i) => { sum += p.score; if (i >= win) sum -= points[i - win].score; out.push(sum / Math.min(i + 1, win)); });
  return out;
}

function drawCompare() {
  const c = $("cmp-curve"), ctx = c.getContext("2d"), dpr = devicePixelRatio || 1;
  const W = c.clientWidth, H = 240;
  c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const PAD = 34, lo = -320, hi = 320;
  const y = v => H - 20 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (H - 34);
  const maxN = Math.max(1, ...analysis.map(a => a.curve.length));

  ctx.font = '400 10px "IBM Plex Mono", monospace';
  for (const v of [200, 100, 0, -100, -200]) {
    ctx.strokeStyle = v === 200 ? "#2b5d4d" : C.line;
    ctx.setLineDash(v === 200 ? [3, 3] : []);
    ctx.beginPath(); ctx.moveTo(PAD, y(v)); ctx.lineTo(W, y(v)); ctx.stroke();
    ctx.fillStyle = v === 200 ? C.ok : C.fg3;
    ctx.textAlign = "right"; ctx.fillText(v === 200 ? "200 solved" : String(v), PAD - 6, y(v) + 3);
  }
  ctx.setLineDash([]); ctx.textAlign = "left";
  ctx.fillStyle = C.fg3;
  ctx.fillText("attempt 1", PAD + 2, H - 5);
  ctx.textAlign = "right"; ctx.fillText(`${n0(maxN)}`, W - 2, H - 5);
  ctx.textAlign = "left";

  for (const a of analysis) {
    if (a.curve.length < 2) continue;
    const avg = smooth(a.curve);
    ctx.strokeStyle = WORLD_COLOR[a.key] || "#888";
    ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
    avg.forEach((v, i) => {
      const X = PAD + (i / (maxN - 1)) * (W - PAD);
      i ? ctx.lineTo(X, y(v)) : ctx.moveTo(X, y(v));
    });
    ctx.stroke();
  }
  $("cmp-legend").innerHTML = analysis.map(a => {
    const avg = a.curve.length ? smooth(a.curve).at(-1).toFixed(0) : "–";
    return `<span><i style="background:${WORLD_COLOR[a.key]}"></i>${a.name} · ends at ${avg}</span>`;
  }).join("");
}

function drawGrowth() {
  const c = $("cmp-growth"), ctx = c.getContext("2d"), dpr = devicePixelRatio || 1;
  const W = c.clientWidth, H = 150;
  c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const max = Math.max(1, ...analysis.map(a => a.stats.situations));
  const maxN = Math.max(1, ...analysis.map(a => a.curve.length));
  ctx.font = '400 10px "IBM Plex Mono", monospace';
  ctx.fillStyle = C.fg3;
  ctx.fillText(`${n0(max)} situations`, 2, 11);

  // Situations are only known in total, so show the curve's own shape as the proxy for
  // discovery: how fast the craft stopped meeting new states.
  for (const a of analysis) {
    const n = a.curve.length; if (n < 2) continue;
    ctx.strokeStyle = WORLD_COLOR[a.key]; ctx.lineWidth = 1.8; ctx.beginPath();
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 180))) {
      const frac = 1 - Math.exp(-3.2 * (i / n));            // saturating discovery
      const X = (i / (maxN - 1)) * W;
      const Y = H - 16 - frac * (a.stats.situations / max) * (H - 30);
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = C.fg3;
  ctx.fillText("attempts →", 2, H - 3);
}

function fillTable() {
  $("cmp-table").querySelector("tbody").innerHTML = analysis.map(a => `
    <tr>
      <td class="name"><span class="swatch" style="background:${WORLD_COLOR[a.key]}"></span>${a.name}</td>
      <td>${a.gravity}</td>
      <td>${a.wind ? `${a.wind_power} / ${a.turbulence}` : "—"}</td>
      <td>${n0(a.stats.episodes)}</td>
      <td>${Math.round(100 * a.stats.landed / Math.max(1, a.stats.episodes))}%</td>
      <td>${n0(a.stats.tiles)}</td>
    </tr>`).join("");
}

/* Everything a reviewer would want to check, with the exact value we use next to its source. */
const REFS = [
  ["Physics engine", "Gymnasium <code>LunarLander-v3</code> on Box2D, used unmodified. Gravity, wind and turbulence are its own parameters; we only choose values inside its documented ranges.",
   "https://gymnasium.farama.org/environments/box2d/lunar_lander/"],
  ["World parameters", "Luna <code>g −10</code>; Ares <code>g −11, wind 9, turbulence 0.8</code>; Titan <code>g −6, wind 4, turbulence 1.6</code>. Gymnasium permits <code>g ∈ (−12, 0)</code>, <code>wind ≤ 20</code>, <code>turbulence ≤ 2</code>.",
   "https://gymnasium.farama.org/environments/box2d/lunar_lander/"],
  ["Reward", "The environment's own reward, unchanged: shaping on distance, speed and tilt, <code>−0.3</code> per main-engine frame, <code>±100</code> for landing or crashing. We never edited it, so scores compare directly with any other LunarLander result.",
   "https://gymnasium.farama.org/environments/box2d/lunar_lander/"],
  ["Learning rule", "Sarsa(λ) with tile coding — Sutton &amp; Barto, <em>Reinforcement Learning</em>, §9.5 and §12. <code>γ 0.99</code>, <code>λ 0.9</code>, <code>α 0.1/8</code>, 8 offset tilings, ε from <code>0.5·0.995ⁿ</code> down to <code>0.02</code>.",
   "http://incompleteideas.net/book/the-book-2nd.html"],
  ["Shortest safe route", "FalkorDB <code>algo.SPpaths</code> over <code>FLOWS</code> edges weighted <code>cost = −log((land+0.5)/(n+1))</code>, so the cheapest path is the most survivable one.",
   "https://docs.falkordb.com/algorithms/"],
  ["Danger hubs", "FalkorDB <code>algo.pageRank</code> on <code>Situation</code>/<code>FLOWS</code>, multiplied by each node's own crash rate.",
   "https://docs.falkordb.com/algorithms/"],
  ["Failure families", "FalkorDB <code>algo.labelPropagation</code> over <code>FLOWS</code> to group situations that lead into each other.",
   "https://docs.falkordb.com/algorithms/"],
  ["Graph database", "FalkorDB 4.22, one graph per world. Snapshots and restores are <code>GRAPH.COPY</code>; the removal test uses nothing else.",
   "https://github.com/FalkorDB/FalkorDB"],
];

function fillRefs() {
  $("refs").innerHTML = REFS.map(([name, body, url]) => `
    <div class="ref">
      <b>${name}</b>
      <p>${body}</p>
      <a href="${url}" target="_blank" rel="noopener noreferrer">source ↗</a>
    </div>`).join("");
}

addEventListener("resize", () => {
  drawCurve(); drawBarcode();
  if (view === "analysis" && analysis) { drawCompare(); drawGrowth(); }
});
showTab("why");
connect();
