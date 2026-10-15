import { LanderScene } from "./scene.js";

const $ = id => document.getElementById(id);
const ACTIONS = ["Coast", "Left thruster", "Main engine", "Right thruster"];
const OUT_COLOR = { landed_pad: "#1f8a70", landed_off_pad: "#5fae8f", crashed: "#d1404f", flew_off: "#a8323f", timed_out: "#c98a1b", interrupted: "#8a94a3" };
const OUT_TEXT = { landed_pad: "Landed on the pad", landed_off_pad: "Landed beside the pad", crashed: "Crashed", flew_off: "Flew out of bounds", timed_out: "Ran out of time hovering", interrupted: "Interrupted" };
const MIX_COLOR = ["#a9b4c2", "#2f5d9e", "#13213a", "#6f8fbf"];

const scene = new LanderScene($("scene"));
let S = null;                 // last server state
let curve = [];               // [{n, score, outcome, learned}]
let mode = "live";            // live | replay
let replay = null;            // {frames, i, n, outcome}
let terrainY = 3.33;
let selected = null;
let lastEpisode = null;

// ------------------------------------------------------------- websocket
let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => { log("Connection lost. Reconnecting…"); setTimeout(connect, 1500); };
}
const send = (cmd, arg) => ws?.readyState === 1 && ws.send(JSON.stringify({ cmd, arg }));

function handle(m) {
  if (m.type === "state") return applyState(m);
  if (m.type === "log") return log(m.text);
  if (m.type === "reset" && mode === "replay" && replay?.auto && S?.speed !== "train") { mode = "live"; replay = null; }
  if (m.type === "reset" && mode === "live") {
    if (m.world !== scene.world) scene.setWorld(m.world);
    scene.setTerrain(m.terrain); terrainY = m.terrain.pad[2]; scene.snap();
    $("hud-n").textContent = m.n; $("hud-mode").textContent = m.exam ? "Exam" : "Live";
    hideBanner();
  }
  if (m.type === "frame" && mode === "live") showFrame(m.f, m.step, m.q, m.sit);
  if (m.type === "episode") onEpisode(m);
}

function applyState(s) {
  const first = !S;
  S = s;
  if (s.db) $("db").textContent = `FalkorDB: ${s.db} · graph ${s.stats.graph}`;
  if (scene.world !== s.world.key) scene.setWorld(s.world.key);
  $("worlds").innerHTML = "";
  for (const w of s.worlds) {
    const b = document.createElement("button");
    b.setAttribute("role", "radio"); b.setAttribute("aria-checked", w.key === s.world.key);
    b.innerHTML = `${w.name}<small>${w.wind ? "wind " + w.wind_power : "no wind"}, g ${w.gravity}</small>`;
    b.title = w.blurb;
    b.onclick = () => {
      if (w.key === s.world.key) return;
      mode = "live"; replay = null; $("btn-live").hidden = true;
      send("set_world", w.key); curve = []; selected = null; setTimeout(() => { loadCurve(); loadInsights(); }, 800);
    };
    $("worlds").appendChild(b);
  }
  $("btn-run").textContent = !s.running ? "Start flying" : s.paused ? "Resume" : "Pause";
  document.querySelectorAll("#speed button").forEach(b => b.setAttribute("aria-checked", b.dataset.speed === s.speed));
  $("exam").checked = s.exam;
  renderStats(s.stats);
  $("snap-list").innerHTML = s.snapshots.length ? s.snapshots.map(t => `<option>${t}</option>`).join("") : "<option disabled selected>No snapshots yet</option>";
  $("seed-list").innerHTML = s.worlds.filter(w => w.key !== s.world.key).map(w => `<option value="${w.key}">from ${w.name}</option>`).join("");
  if (first) { loadCurve(); loadInsights(); }
}

function renderStats(st) {
  const rate = st.episodes ? Math.round(100 * st.landed / st.episodes) : 0;
  $("stats").innerHTML = [
    ["Attempts", st.episodes], ["Landed", `${st.landed} <small>(${rate}%)</small>`], ["Crashed", st.crashed],
    ["Skill tiles", st.tiles.toLocaleString()], ["Situations", st.situations.toLocaleString()], ["Transitions", st.flows.toLocaleString()],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
}

// ------------------------------------------------------------------- HUD
function showFrame(f, step, q, sit) {
  scene.setFrame(f);
  const alt = f[1] - terrainY;
  $("hud-alt").textContent = alt.toFixed(1);
  $("hud-tilt").textContent = `${(f[2] * 57.3).toFixed(0)}°`;
  $("hud-step").textContent = step;
  if (showFrame.prev) $("hud-vy").textContent = ((f[1] - showFrame.prev[1]) * 50).toFixed(1);
  showFrame.prev = f;
  if (sit) $("hud-sit").textContent = sit;
  if (q) renderQ(q, f[5]);
}
function renderQ(q, chosen) {
  const lo = Math.min(...q), hi = Math.max(...q), span = Math.max(1e-6, hi - lo);
  $("qbars").innerHTML = q.map((v, i) => `<div class="qbar ${i === chosen ? "chosen" : ""}"><span>${ACTIONS[i]}</span>
    <div class="track"><div class="fill" style="width:${8 + 92 * (v - lo) / span}%"></div></div></div>`).join("");
}

function banner(outcome, sub) {
  const b = $("banner");
  b.className = "banner " + (outcome.startsWith("landed") ? "landed" : outcome === "crashed" || outcome === "flew_off" ? "crashed" : outcome);
  b.innerHTML = `${OUT_TEXT[outcome] || outcome}<small>${sub}</small>`;
  b.hidden = false;
  clearTimeout(banner.t); banner.t = setTimeout(hideBanner, 2200);
}
function hideBanner() { $("banner").hidden = true; }

// ---------------------------------------------------------- episodes
function onEpisode(m) {
  const ep = m.ep; lastEpisode = ep;
  curve.push({ n: ep.n, score: ep.score, outcome: ep.outcome, learned: ep.learned });
  renderStats(m.stats); drawCurve(); drawBarcode();
  if (mode === "live" && S?.speed !== "train") {
    scene.outcome(ep.outcome);
    banner(ep.outcome, `Attempt ${ep.n} · score ${ep.score.toFixed(0)} · ${ep.situations} situations · ${ep.tiles_written} tiles updated`);
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
  const W = c.clientWidth, H = 120; c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const lo = -300, hi = 300, y = v => H - 14 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (H - 22);
  ctx.font = "12px Barlow Semi Condensed, system-ui, sans-serif"; ctx.fillStyle = "#4a5a72";
  for (const [v, label] of [[200, "solved (200)"], [0, "0"], [-200, "−200"]]) {
    ctx.strokeStyle = v === 200 ? "#1f8a70" : "#b5bfca"; ctx.setLineDash(v === 200 ? [4, 3] : []);
    ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(W, y(v)); ctx.stroke(); ctx.fillText(label, 4, y(v) - 3);
  }
  ctx.setLineDash([]);
  if (curve.length < 2) { ctx.fillText("The learning curve appears after a few attempts.", 4, H - 2); return; }
  const n = curve.length, win = 50; let sum = 0; const avg = [];
  curve.forEach((p, i) => { sum += p.score; if (i >= win) sum -= curve[i - win].score; avg.push(sum / Math.min(i + 1, win)); });
  ctx.fillStyle = "rgba(19,33,58,.18)";
  curve.forEach((p, i) => ctx.fillRect(i / (n - 1) * W, y(p.score), 1.2, 1.2));
  ctx.strokeStyle = "#13213a"; ctx.lineWidth = 2; ctx.beginPath();
  avg.forEach((v, i) => { const X = i / (n - 1) * W; i ? ctx.lineTo(X, y(v)) : ctx.moveTo(X, y(v)); }); ctx.stroke();
  ctx.fillStyle = "#13213a"; ctx.font = "600 13px Barlow Semi Condensed, system-ui, sans-serif";
  ctx.fillText(`avg of last ${win}: ${avg[n - 1].toFixed(0)}`, W - 130, 12);
}

function drawBarcode() {
  const c = $("barcode"), ctx = c.getContext("2d"), dpr = devicePixelRatio || 1;
  const W = c.clientWidth, H = 34; c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const n = curve.length; if (!n) return;
  const bins = Math.min(n, Math.floor(W)), per = n / bins, bw = W / bins;
  for (let b = 0; b < bins; b++) {
    const slice = curve.slice(Math.floor(b * per), Math.max(Math.floor((b + 1) * per), Math.floor(b * per) + 1));
    const ok = slice.filter(p => p.outcome.startsWith("landed")).length / slice.length;
    const last = slice[slice.length - 1];
    ctx.fillStyle = slice.length === 1 ? OUT_COLOR[last.outcome] : mixColor(ok);
    ctx.fillRect(b * bw, last.learned ? 0 : 6, Math.max(1, bw - (bw > 3 ? 1 : 0)), last.learned ? H : H - 12);
  }
  if (selected) {
    const i = curve.findIndex(p => p.n === selected);
    if (i >= 0) { ctx.fillStyle = "#13213a"; ctx.fillRect(i / n * W - 1, 0, 3, H); }
  }
}
function mixColor(f) {   // crash red -> landed teal
  const a = [209, 64, 79], b = [31, 138, 112];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(",")})`;
}
$("barcode").addEventListener("click", e => {
  if (!curve.length) return;
  const r = e.target.getBoundingClientRect(), i = Math.min(curve.length - 1, Math.floor((e.clientX - r.left) / r.width * curve.length));
  const n = curve[i].n;
  playReplay(n); showWhy(n);
});
$("barcode").tabIndex = 0;
$("barcode").addEventListener("keydown", e => {
  if (!curve.length || !["ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) return;
  let i = curve.findIndex(p => p.n === selected); if (i < 0) i = curve.length - 1;
  if (e.key === "ArrowLeft") i = Math.max(0, i - 1); if (e.key === "ArrowRight") i = Math.min(curve.length - 1, i + 1);
  showWhy(curve[i].n); if (e.key === "Enter") playReplay(curve[i].n);
});

// ------------------------------------------------------------- replay
async function playReplay(n, auto = false) {
  const r = await fetch(`/api/frames/${n}`);
  if (!r.ok) {
    if (!auto) { const t = `No flight recording for attempt ${n}. Its memory is in the graph, but the replay file wasn't kept.`; log(t); $("hud-sit").textContent = t; }
    return;
  }
  const d = await r.json();
  mode = "replay";
  $("btn-live").hidden = auto; $("hud-mode").textContent = auto ? "Latest" : "Replay of";
  $("hud-n").textContent = n;
  const ep = curve.find(p => p.n === n);
  $("hud-sit").textContent = ep ? `${OUT_TEXT[ep.outcome] || ep.outcome}, score ${Math.round(ep.score)}` : "";
  $("qbars").innerHTML = "";
  scene.setTerrain(d.terrain); terrainY = d.terrain.pad[2]; scene.snap(); hideBanner();
  const out = curve.find(p => p.n === n)?.outcome;
  replay = { frames: d.frames, i: 0, n, outcome: out, auto, speed: auto ? 3 : 1 };
}
setInterval(() => {
  if (mode !== "replay" || !replay) return;
  const step = replay.speed;
  for (let k = 0; k < step && replay.i < replay.frames.length; k++, replay.i++);
  const f = replay.frames[Math.min(replay.i, replay.frames.length - 1)];
  showFrame(f, replay.i, null, null);
  if (replay.i >= replay.frames.length) {
    scene.outcome(replay.outcome);
    if (!replay.auto) banner(replay.outcome || "interrupted", `Replay of attempt ${replay.n}`);
    const was = replay; replay = null;
    setTimeout(() => {
      if (was.auto) { mode = "live"; if (S?.speed === "train" && lastEpisode) playReplay(lastEpisode.n, true); }
    }, 1200);
  }
}, 20);
$("btn-live").onclick = () => { mode = "live"; replay = null; $("btn-live").hidden = true; $("hud-mode").textContent = "Live"; };

// ------------------------------------------------------------ explain
async function showWhy(n, quiet = false) {
  selected = n; drawBarcode();
  const x = await (await fetch(`/api/explain/${n}`)).json();
  if (x.error) { if (!quiet) $("why-summary").textContent = x.error; return; }
  $("why-n").textContent = n;
  $("why-summary").textContent = x.summary || `${OUT_TEXT[x.outcome]} (score ${x.score}).`;
  const marks = { [x.point_of_no_return]: ["ponr", "point of no return"], [x.decision_point]: ["decision", "decision that mattered"], [x.closest_call]: ["decision", "closest call"] };
  $("why-path").innerHTML = x.path.map(p => {
    const m = marks[p.i];
    return `<li class="${m ? m[0] : ""}"><span class="risk" style="background:${mixColor(1 - p.risk)}" title="${Math.round(p.risk * 100)}% of past attempts through here failed"></span>
      <span>${p.label}${m ? `<span class="tag">· ${m[1]}</span>` : ""}</span><span class="did">${ACTIONS[["coast", "left_thruster", "main_engine", "right_thruster"].indexOf(p.did)]} · ${Math.round(p.risk * 100)}%</span></li>`;
  }).join("");
  const L = x.lesson;
  let html = "";
  if (L) {
    const row = (name, mix) => mix ? `<span>${name}</span><div class="mixbar">${Object.values(mix).map((v, i) => `<span style="width:${v * 100}%;background:${MIX_COLOR[i]}" title="${ACTIONS[i]} ${Math.round(v * 100)}%"></span>`).join("")}</div>` : "";
    html += `<h3>At “${L.situation}”</h3><div class="mix">${row("This attempt", L.this_attempt_did)}${row("Attempts that landed", L.landing_attempts_did)}${row("Attempts that failed", L.other_attempts_did)}</div>`;
    html += `<div class="legend">${ACTIONS.map((a, i) => `<span><i style="background:${MIX_COLOR[i]}"></i>${a}</span>`).join("")}</div>`;
  }
  if (x.safe_path) html += `<h3>Safest known route from there <small>weighted shortest path, p≈${x.safe_path.p_estimate}</small></h3><ol class="safe">${x.safe_path.steps.slice(1).map(s => `<li>${s.replaceAll("_", " ")}</li>`).join("")}</ol>`;
  $("why-lesson").innerHTML = html;
  $("why-cypher").textContent = x.cypher.join("\n\n");
}

async function loadInsights() {
  const [h, s] = await Promise.all([fetch("/api/hubs").then(r => r.json()), fetch("/api/signatures").then(r => r.json())]);
  $("hubs").innerHTML = h.hubs.length ? h.hubs.slice(0, 5).map(x => `<li>${x.label} <span class="n">${Math.round(x.risk * 100)}% fail · ${x.visits} visits</span></li>`).join("") : "<li>Needs more attempts.</li>";
  $("sigs").innerHTML = s.signatures.length ? s.signatures.map(x => `<li>${x.why} <span class="n">${Math.round(x.share * 100)}%</span></li>`).join("") : "<li>No crashes recorded yet.</li>";
}

// ----------------------------------------------------------- controls
$("btn-run").onclick = () => send(!S?.running ? "run" : S.paused ? "resume" : "pause");
$("btn-interrupt").onclick = () => send("interrupt");
$("btn-gust-l").onclick = () => send("gust", -1);
$("btn-gust-r").onclick = () => send("gust", 1);
document.querySelectorAll("#speed button").forEach(b => b.onclick = () => send("set_speed", b.dataset.speed));
$("exam").onchange = e => send("exam", e.target.checked);
$("btn-snap").onclick = () => { const t = prompt("Name this snapshot", `after-${S?.stats.episodes ?? 0}`); if (t) send("snapshot", t.replace(/[^\w-]/g, "_")); };
$("btn-restore").onclick = () => { const t = $("snap-list").value; if (t && confirm(`Replace ${S.world.name}'s memory with snapshot '${t}'?`)) { send("restore", t); setTimeout(loadCurve, 800); } };
$("btn-seed").onclick = () => send("seed_from", $("seed-list").value);
$("btn-wipe").onclick = () => { if (confirm(`Erase everything ${S.world.name}'s lander has learned? Save a snapshot first if you may want it back.`)) { send("wipe"); curve = []; setTimeout(loadCurve, 800); } };
$("btn-refresh-insights").onclick = loadInsights;
function log(t) { $("log").textContent = t; }

// ---------------------------------------------- optional Reactor photoreal view
let rws = null, rTimer = null, rUrl = null;
fetch("/api/reactor").then(r => r.json()).then(s => {
  $("reactor-toggle").title = s.message;
  if (!s.available) { $("reactor").disabled = true; $("reactor-toggle").classList.add("off"); }
});
$("reactor").onchange = e => e.target.checked ? startReactor() : stopReactor();
function startReactor() {
  rws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/reactor`);
  rws.binaryType = "blob";
  const grab = document.createElement("canvas"); grab.width = 640; grab.height = 360;
  rws.onopen = () => rws.send(JSON.stringify({ world: scene.world }));
  rws.onmessage = e => {
    if (typeof e.data === "string") {
      const d = JSON.parse(e.data);
      log(`Photoreal view: ${d.reactor}${d.why ? " — " + d.why : ""}${d.limit ? ` (stops itself after ${d.limit} s)` : ""}`);
      if (d.reactor === "live" && !rTimer) rTimer = setInterval(() => {
        grab.getContext("2d").drawImage($("scene"), 0, 0, 640, 360);
        grab.toBlob(b => rws?.readyState === 1 && b && rws.send(b), "image/jpeg", 0.8);
      }, 66);
      if (["stopped", "error", "unavailable"].includes(d.reactor)) stopReactor();
      return;
    }
    if (rUrl) URL.revokeObjectURL(rUrl);
    rUrl = URL.createObjectURL(e.data);
    $("reactor-view").src = rUrl; $("reactor-view").hidden = false;
  };
  rws.onclose = () => stopReactor();
}
function stopReactor() {
  clearInterval(rTimer); rTimer = null;
  if (rws && rws.readyState <= 1) { try { rws.send(JSON.stringify({ stop: true })); } catch {} rws.close(); }
  rws = null; $("reactor").checked = false; $("reactor-view").hidden = true;
}
addEventListener("resize", () => { drawCurve(); drawBarcode(); });
connect();
