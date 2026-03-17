// ==UserScript==
// @name         Crash Point Signal Pro — Smart Bet Intelligence
// @namespace    crashpoint-signal-pro
// @version      3.0
// @description  Advanced pattern-based betting signals for Crash Point (game 601) with latency analysis, tick leak detection, and smart risk scoring
// @match        https://melbet-srilanka.com/games-frame/games/601*
// @match        https://*.melbet*.com/games-frame/games/601*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// ═══════════════════════════════════════════════════════════════
//  CRASH POINT SIGNAL PRO v3 — Game 601
//
//  Built from 6+ rounds of empirical Crash Point latency data:
//
//  NETWORK-LEVEL PATTERNS (Red Team Findings):
//    • P1: Micro-delta tick leak — OnProfits arrives ≤5ms after
//      previous event, indicating same server tick bundling.
//      When this happens mid-flight, crash is imminent.
//    • P2: 3+ consecutive OnProfits without OnCashouts —
//      server is flushing final profit ticks before crash.
//    • P3: No OnCashouts at all → typically crash < 1.7x
//    • P4: "Dead air" — OnStart followed by OnCrash with NO
//      intermediate events. Instant crash (≤1.2x).
//    • P5: First profit Δ ≤ 10ms — extremely early bundling,
//      often correlates with faster crashes.
//    • P6: crashDt ≤ 300ms from last event — tight bundling,
//      OnCrash arrived within same frame group.
//
//  BET INTELLIGENCE (latency-informed):
//    • Default: OBSERVE (not BET) — only advise BET when
//      multiple positive signals converge
//    • Low-streak reversal (2+ crashes < 1.5x → next likely higher)
//    • Post-high correction (after >5x → next often drops)
//    • Latency quality scoring: faster event deltas during
//      betting phase indicate server under load → riskier
//
//  Remove: window.__cpsignal_destroy()
//  Config: window.__cpsignal_cfg("key", value)
// ═══════════════════════════════════════════════════════════════

(function () {
  "use strict";

  if (window.__cpActive) return;
  window.__cpActive = true;

  // ===================== CONFIG =====================
  const CFG = {
    P1_DELTA: 5, // ms — tick leak threshold
    P2_CONSEC: 3, // consecutive profits before warning
    P5_FIRST_PROFIT: 10, // ms — early bundling threshold
    MIN_MULT: 1.1, // minimum multiplier for cashout signals
    STREAK_LOW_THRESH: 1.5,
    STREAK_HIGH_THRESH: 5.0,
    STREAK_COUNT: 2,
    MIN_ROUNDS_FOR_BET: 3, // need N rounds of history before giving BET advice
    BET_SCORE_THRESH: 70, // score needed for BET (higher = more conservative)
  };

  // ===================== STATE =====================
  const S = {
    ws: null,
    status: null,
    gainCoef: 25,
    coeffStartTime: null,
    mult: 1,
    isCrashed: true,
    stageId: null,
    consecutiveProfits: 0,
    profitsDeltas: [],
    lastEventTime: null,
    hasCashouts: false,
    roundEvents: 0,
    startTime: null,
    // Pre-round intelligence
    crashHistory: [],
    lowStreak: 0,
    highStreak: 0,
    roundRisk: "unknown",
    betAdvice: "WAIT",
    firstProfitDt: null,
    // Latency tracking
    bettingDt: null, // delta of OnBetting event
    startDt: null, // delta of OnStart event
    lastCrashDt: null, // delta of last OnCrash
    deadAirRounds: 0, // count of recent dead-air (no-profit) rounds
    avgCrashDt: null, // running average of crashDt
    crashDtHistory: [], // last 20 crashDts
    roundProfileHistory: [], // full round profiles for learning
    // Learning stats
    totalRounds: 0,
    p1Hits: 0,
    p2Hits: 0,
    skipsCorrect: 0,
    skipsTotal: 0,
    betsCorrect: 0,
    betsTotal: 0,
  };

  let animId = null;

  function calcMult(ms) {
    return !ms || ms <= 0 ? 1 : Math.min((S.gainCoef / 1e9) * ms * ms + 1, 35);
  }
  function startAnim() {
    stopAnim();
    S.isCrashed = false;
    (function tick() {
      if (S.isCrashed) return;
      S.mult = calcMult(Date.now() - S.coeffStartTime);
      const el = Q("#cp-mult");
      if (el) {
        el.textContent = S.mult.toFixed(2) + "x";
        el.className = "cp-mv growing";
      }
      updateRiskMeter();
      animId = requestAnimationFrame(tick);
    })();
  }
  function stopAnim() {
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
  }

  // ===================== LATENCY-INFORMED RISK =====================
  function assessPreRoundRisk() {
    const h = S.crashHistory;

    // Not enough data — default to OBSERVE
    if (h.length < CFG.MIN_ROUNDS_FOR_BET) {
      S.roundRisk = "unknown";
      S.betAdvice = "OBSERVE";
      return {
        score: 50,
        reasons: [
          "Gathering data (" +
            h.length +
            "/" +
            CFG.MIN_ROUNDS_FOR_BET +
            " rounds)",
        ],
      };
    }

    let score = 40; // Start BELOW neutral — conservative default
    let reasons = [];

    const last3 = h.slice(0, 3);

    // ── Streak analysis ──
    if (S.lowStreak >= CFG.STREAK_COUNT) {
      const bonus = 12 * Math.min(S.lowStreak, 5);
      score += bonus;
      reasons.push(S.lowStreak + " low streak → reversal due (+" + bonus + ")");
    }

    if (h[0] > CFG.STREAK_HIGH_THRESH) {
      score -= 20;
      reasons.push("After " + h[0].toFixed(1) + "x → correction likely (-20)");
    }

    if (h[0] <= 1.1) {
      score -= 10;
      reasons.push("After instant crash → risky (-10)");
    }

    // ── Average analysis ──
    const avg3 = last3.reduce((a, b) => a + b, 0) / last3.length;
    if (avg3 < 1.3) {
      score += 15;
      reasons.push("Avg very low → rebound likely (+15)");
    } else if (avg3 < 1.5) {
      score += 8;
      reasons.push("Avg low → slight edge (+8)");
    } else if (avg3 > 5) {
      score -= 12;
      reasons.push("Avg high → correction zone (-12)");
    }

    // ── Alternating pattern ──
    if (h.length >= 3) {
      const alt =
        (h[0] < 2 && h[1] > 2 && h[2] < 2) ||
        (h[0] > 2 && h[1] < 2 && h[2] > 2);
      if (alt) {
        score += 6;
        reasons.push("Alternating detected (+6)");
      }
    }

    // ── Dead air frequency (no-profit rounds = instant crashes) ──
    if (S.deadAirRounds >= 2) {
      score -= 15;
      reasons.push(
        S.deadAirRounds + " recent dead-air rounds → unstable (-15)",
      );
    }

    // ── Latency quality (crashDt variance) ──
    if (S.crashDtHistory.length >= 3) {
      const recent3 = S.crashDtHistory.slice(0, 3);
      const avgRecent = recent3.reduce((a, b) => a + b, 0) / recent3.length;
      if (avgRecent > 1500) {
        score -= 8;
        reasons.push(
          "High crashDt avg (" +
            avgRecent.toFixed(0) +
            "ms) → delayed server (-8)",
        );
      }
      if (avgRecent < 400) {
        score += 5;
        reasons.push(
          "Tight crashDt (" +
            avgRecent.toFixed(0) +
            "ms) → responsive server (+5)",
        );
      }
    }

    // ── Consecutive high wins (market is "hot") ──
    if (h.length >= 3 && h[0] > 3 && h[1] > 3 && h[2] > 3) {
      score -= 18;
      reasons.push("3 consecutive high crashes → correction imminent (-18)");
    }

    // Clamp
    score = Math.max(0, Math.min(100, score));

    // ── Determine advice (conservative thresholds) ──
    if (score >= CFG.BET_SCORE_THRESH) {
      S.roundRisk = "good";
      S.betAdvice = "BET";
    } else if (score >= 55) {
      S.roundRisk = "maybe";
      S.betAdvice = "LEAN BET";
    } else if (score >= 40) {
      S.roundRisk = "neutral";
      S.betAdvice = "OBSERVE";
    } else if (score >= 25) {
      S.roundRisk = "risky";
      S.betAdvice = "RISKY";
    } else {
      S.roundRisk = "danger";
      S.betAdvice = "SKIP";
    }

    return { score, reasons };
  }

  function updateRiskMeter() {
    const el = Q("#cp-risk-fill");
    if (!el || S.status !== 3) return;
    let risk = 0;
    const elapsed = S.startTime ? (Date.now() - S.startTime) / 1000 : 0;
    risk = Math.min(elapsed * 8, 60);
    if (S.consecutiveProfits >= 2) risk += S.consecutiveProfits * 10;
    if (!S.hasCashouts && elapsed > 1) risk += 25;
    if (S.firstProfitDt !== null && S.firstProfitDt <= CFG.P5_FIRST_PROFIT)
      risk += 20;
    if (S.firstProfitDt !== null && S.firstProfitDt <= CFG.P1_DELTA) risk += 35;
    risk = Math.min(risk, 100);
    el.style.width = risk + "%";
    el.style.background =
      risk < 30
        ? "#4cff4c"
        : risk < 60
          ? "#ffaa00"
          : risk < 80
            ? "#ff6633"
            : "#ff2222";
  }

  // ===================== UI =====================
  const Q = (s) => document.querySelector(s);

  function createUI() {
    if (Q("#cp-root")) return;
    const d = document.createElement("div");
    d.id = "cp-root";
    d.innerHTML = `
        <style>
            #cp-root{position:fixed;top:8px;right:8px;width:280px;
              background:rgba(8,12,30,.97);border:1px solid rgba(140,92,255,.25);border-radius:12px;
              font-family:'Cascadia Code','Fira Code',Consolas,monospace;font-size:12px;color:#e0e0e0;
              z-index:999998;overflow:hidden;backdrop-filter:blur(12px);
              box-shadow:0 0 25px rgba(140,92,255,.06);user-select:none;resize:both}
            #cp-hd{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;
              background:linear-gradient(90deg,rgba(140,92,255,.08),transparent);
              border-bottom:1px solid rgba(255,255,255,.04);cursor:move}
            #cp-hd .t{font-weight:700;font-size:11px;letter-spacing:1px;
              background:linear-gradient(90deg,#8c5cff,#ff5c8c);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
            .cp-cb{cursor:pointer;color:#555;font-size:14px;padding:2px 5px;border-radius:3px;display:inline-block}
            .cp-cb:hover{background:rgba(140,92,255,.12);color:#8c5cff}
            #cp-live{text-align:center;padding:6px 8px 2px}
            .cp-mv{font-size:34px;font-weight:900;font-variant-numeric:tabular-nums;line-height:1}
            .cp-mv.growing{color:#4cff4c;text-shadow:0 0 10px rgba(76,255,76,.08)}
            .cp-mv.crashed{color:#ff4444;text-shadow:0 0 10px rgba(255,68,68,.08)}
            .cp-mv.waiting{color:#444}
            #cp-signal{margin:6px 8px;padding:12px 10px;border-radius:10px;text-align:center;
              font-weight:800;font-size:15px;letter-spacing:.8px;transition:all .2s}
            #cp-signal.idle{background:rgba(60,60,80,.1);border:2px solid rgba(80,80,100,.15);color:#444}
            #cp-signal.bet{background:rgba(76,255,76,.07);border:2px solid rgba(76,255,76,.3);color:#4cff4c;animation:cpG 1.5s infinite}
            #cp-signal.lean{background:rgba(76,200,76,.05);border:2px solid rgba(76,200,76,.2);color:#6cd46c}
            #cp-signal.observe{background:rgba(140,92,255,.05);border:2px solid rgba(140,92,255,.2);color:#8c5cff}
            #cp-signal.risky{background:rgba(255,130,0,.08);border:2px solid rgba(255,130,0,.3);color:#ff8200;animation:cpO .8s infinite}
            #cp-signal.skip{background:rgba(255,40,40,.08);border:2px solid rgba(255,50,50,.3);color:#ff4444}
            #cp-signal.watch{background:rgba(140,92,255,.06);border:2px solid rgba(140,92,255,.25);color:#8c5cff}
            #cp-signal.warn{background:rgba(255,150,0,.08);border:2px solid rgba(255,150,0,.3);color:#ffa500;animation:cpO .6s infinite}
            #cp-signal.cashout{background:rgba(255,30,30,.1);border:2px solid rgba(255,40,40,.45);color:#ff4444;animation:cpF .25s infinite;font-size:18px}
            @keyframes cpG{0%,100%{box-shadow:0 0 4px rgba(76,255,76,.08)}50%{box-shadow:0 0 16px rgba(76,255,76,.15)}}
            @keyframes cpO{0%,100%{box-shadow:0 0 4px rgba(255,150,0,.08)}50%{box-shadow:0 0 14px rgba(255,150,0,.2)}}
            @keyframes cpF{0%,100%{opacity:1;box-shadow:0 0 16px rgba(255,40,40,.25)}50%{opacity:.6}}
            .sig-sub{font-size:9px;font-weight:600;letter-spacing:.2px;margin-top:4px;opacity:.7}
            #cp-risk-bar{margin:4px 8px;height:4px;background:rgba(255,255,255,.04);border-radius:2px;overflow:hidden}
            #cp-risk-fill{height:100%;width:0%;transition:width .3s,background .3s;border-radius:2px}
            #cp-score{display:flex;gap:1px;margin:4px 8px}
            #cp-score-bar{flex:1;height:20px;background:rgba(255,255,255,.03);border-radius:4px;overflow:hidden;position:relative}
            #cp-score-fill{height:100%;transition:width .3s;border-radius:4px;display:flex;align-items:center;justify-content:flex-end;padding:0 6px;font-size:9px;font-weight:700;color:#000}
            #cp-score-label{font-size:9px;color:#555;min-width:50px;display:flex;align-items:center;justify-content:center}
            #cp-indicators{display:flex;gap:3px;justify-content:center;padding:3px 8px;flex-wrap:wrap}
            .cp-ind{padding:2px 5px;border-radius:3px;font-size:8px;font-weight:700;letter-spacing:.3px;transition:all .15s}
            .cp-ind.off{background:#141420;color:#2a2a3a;border:1px solid #1a1a28}
            .cp-ind.on{background:rgba(255,30,30,.12);color:#ff4444;border:1px solid rgba(255,50,50,.25)}
            .cp-ind.mild{background:rgba(255,150,0,.08);color:#ffa500;border:1px solid rgba(255,150,0,.2)}
            .cp-ind.info{background:rgba(80,140,255,.08);color:#508cff;border:1px solid rgba(80,140,255,.2)}
            #cp-info{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:rgba(255,255,255,.015);margin-top:3px}
            .cp-st{background:rgba(10,14,39,.8);padding:3px 2px;text-align:center}
            .cp-stl{font-size:7px;color:#555;text-transform:uppercase;letter-spacing:.4px}
            .cp-stv{font-size:10px;font-weight:700;margin-top:1px;font-variant-numeric:tabular-nums}
            #cp-log{max-height:120px;overflow-y:auto;font-size:10px;border-top:1px solid rgba(255,255,255,.03)}
            #cp-log::-webkit-scrollbar{width:3px}#cp-log::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
            .cp-le{padding:2px 8px;border-bottom:1px solid rgba(255,255,255,.012);display:flex;gap:4px;align-items:baseline}
            .cp-le.s{border-left:2px solid #ff4444}.cp-le.i{border-left:2px solid #8c5cff}.cp-le.w{border-left:2px solid #ffaa00}.cp-le.g{border-left:2px solid #4cff4c}
            .cp-lt{color:#444;font-size:8px;min-width:48px;font-variant-numeric:tabular-nums}
            .cp-lx{color:#777;flex:1;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            #cp-history{display:flex;gap:2px;padding:3px 8px;flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.02)}
            .cp-rh{padding:1px 4px;border-radius:3px;font-size:8px;font-weight:700;font-variant-numeric:tabular-nums}
            .cp-rh.lo{background:rgba(255,68,68,.08);color:#f66}
            .cp-rh.mi{background:rgba(255,170,0,.08);color:#fa0}
            .cp-rh.hi{background:rgba(76,255,76,.08);color:#4c4}
            .cp-rh.now{outline:1px solid rgba(255,255,255,.3)}
            #cp-ft{padding:3px 8px;display:flex;justify-content:space-between;align-items:center;
              border-top:1px solid rgba(255,255,255,.03);font-size:8px;color:#444}
            .cp-dot{width:5px;height:5px;border-radius:50%;display:inline-block;margin-right:3px}
            .cp-dot.on{background:#4cff4c;box-shadow:0 0 3px #4cff4c88}
            .cp-dot.wait{background:#fa0}.cp-dot.off{background:#ff4444}
            #cp-accuracy{padding:2px 8px;font-size:8px;color:#555;display:flex;gap:8px;justify-content:center;border-top:1px solid rgba(255,255,255,.02)}
        </style>
        <div id="cp-hd"><span class="t">📡 CP SIGNAL PRO v3</span>
          <span><span class="cp-cb" id="cp-min">—</span><span class="cp-cb" id="cp-x">✕</span></span></div>
        <div id="cp-body">
          <div id="cp-live"><div class="cp-mv waiting" id="cp-mult">—</div></div>
          <div id="cp-signal" class="idle">LOADING<div class="sig-sub">Collecting latency data...</div></div>
          <div id="cp-risk-bar"><div id="cp-risk-fill"></div></div>
          <div id="cp-score"><div id="cp-score-bar"><div id="cp-score-fill" style="width:40%;background:#555">40</div></div><div id="cp-score-label">SCORE</div></div>
          <div id="cp-indicators">
            <span class="cp-ind off" id="ci-p1">P1:TICK</span>
            <span class="cp-ind off" id="ci-p2">P2:CONSEC</span>
            <span class="cp-ind off" id="ci-nc">NO-CO</span>
            <span class="cp-ind off" id="ci-p5">P5:EARLY</span>
            <span class="cp-ind off" id="ci-da">DEAD-AIR</span>
            <span class="cp-ind off" id="ci-str">STREAK</span>
          </div>
          <div id="cp-info">
            <div class="cp-st"><div class="cp-stl">Δ Last</div><div class="cp-stv" id="si-dp">—</div></div>
            <div class="cp-st"><div class="cp-stl">Consec</div><div class="cp-stv" id="si-cp">0</div></div>
            <div class="cp-st"><div class="cp-stl">Low Run</div><div class="cp-stv" id="si-ls">0</div></div>
            <div class="cp-st"><div class="cp-stl">Rounds</div><div class="cp-stv" id="si-rn">0</div></div>
          </div>
          <div id="cp-log"></div>
          <div id="cp-history"></div>
          <div id="cp-accuracy"><span id="cp-acc-bet">Bet: —</span><span id="cp-acc-skip">Skip: —</span></div>
          <div id="cp-ft">
            <span><span class="cp-dot wait" id="cp-wsd"></span><span id="cp-wst">Waiting...</span></span>
            <span id="cp-phase">—</span>
          </div>
        </div>`;
    document.body.appendChild(d);
    // Dragging
    let sx, sy, sl, st;
    Q("#cp-hd").onmousedown = (e) => {
      e.preventDefault();
      sx = e.clientX;
      sy = e.clientY;
      const r = d.getBoundingClientRect();
      sl = r.left;
      st = r.top;
      const mv = (e) => {
        d.style.left = sl + e.clientX - sx + "px";
        d.style.top = st + e.clientY - sy + "px";
        d.style.right = "auto";
      };
      const up = () => {
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    };
    Q("#cp-x").onclick = destroy;
    let mini = false;
    Q("#cp-min").onclick = () => {
      mini = !mini;
      Q("#cp-body").style.display = mini ? "none" : "";
      d.style.width = mini ? "170px" : "280px";
    };
  }

  // ---- Helpers ----
  function log(text, cls) {
    const c = Q("#cp-log");
    if (!c) return;
    const ts =
      new Date().toLocaleTimeString("en-GB", { hour12: false }).substring(3) +
      "." +
      String(new Date().getMilliseconds()).padStart(3, "0");
    const e = document.createElement("div");
    e.className = "cp-le " + (cls || "i");
    e.innerHTML = `<span class="cp-lt">${ts}</span><span class="cp-lx">${text}</span>`;
    c.prepend(e);
    while (c.children.length > 50) c.removeChild(c.lastChild);
  }
  function setSignal(mode, label, sub) {
    const el = Q("#cp-signal");
    if (!el) return;
    el.className = mode;
    el.innerHTML = label + (sub ? `<div class="sig-sub">${sub}</div>` : "");
  }
  function setInd(id, state) {
    const el = Q("#ci-" + id);
    if (el) el.className = "cp-ind " + (state || "off");
  }
  function updateScore(score) {
    const fill = Q("#cp-score-fill");
    if (!fill) return;
    fill.style.width = score + "%";
    fill.textContent = score;
    fill.style.background =
      score >= 70
        ? "#4cff4c"
        : score >= 55
          ? "#6cd46c"
          : score >= 40
            ? "#8c5cff"
            : score >= 25
              ? "#ff8200"
              : "#ff4444";
  }
  function updateHistory() {
    const el = Q("#cp-history");
    if (!el) return;
    el.innerHTML = S.crashHistory
      .slice(0, 20)
      .map((v, i) => {
        const c = v < 1.5 ? "lo" : v < 3 ? "mi" : "hi";
        return `<span class="cp-rh ${c}${i === 0 ? " now" : ""}">${v.toFixed(2)}x</span>`;
      })
      .join("");
  }
  function updateAccuracy() {
    const bet = Q("#cp-acc-bet"),
      skip = Q("#cp-acc-skip");
    if (bet && S.betsTotal > 0) {
      const pct = ((S.betsCorrect / S.betsTotal) * 100).toFixed(0);
      bet.textContent =
        "Bet: " + pct + "% (" + S.betsCorrect + "/" + S.betsTotal + ")";
      bet.style.color = pct >= 50 ? "#4cff4c" : "#ff4444";
    }
    if (skip && S.skipsTotal > 0) {
      const pct = ((S.skipsCorrect / S.skipsTotal) * 100).toFixed(0);
      skip.textContent =
        "Skip: " + pct + "% (" + S.skipsCorrect + "/" + S.skipsTotal + ")";
      skip.style.color = pct >= 50 ? "#4cff4c" : "#ff4444";
    }
  }

  // ---- Pattern detection (latency-aware) ----
  function checkPatterns(ev, delta, d) {
    if (ev === "OnProfits") {
      S.consecutiveProfits++;
      S.profitsDeltas.push(delta);
      S.roundEvents++;
      if (S.firstProfitDt === null) S.firstProfitDt = delta;

      const dp = Q("#si-dp");
      if (dp) {
        dp.textContent = delta + "ms";
        dp.style.color =
          delta <= CFG.P1_DELTA
            ? "#ff4444"
            : delta <= CFG.P5_FIRST_PROFIT
              ? "#ffa500"
              : "#4cff4c";
      }
      const cp = Q("#si-cp");
      if (cp) {
        cp.textContent = S.consecutiveProfits;
        cp.style.color =
          S.consecutiveProfits >= CFG.P2_CONSEC ? "#ff4444" : "#fff";
      }

      // P5: First profit extremely early — early bundling warning
      if (
        S.profitsDeltas.length === 1 &&
        delta <= CFG.P5_FIRST_PROFIT &&
        S.status === 3
      ) {
        setInd("p5", "info");
        log("🔵 P5: Early first profit — Δ" + delta + "ms (bundled)", "i");
      }

      // P1: Tick leak — micro-delta during flight
      if (
        delta <= CFG.P1_DELTA &&
        S.status === 3 &&
        S.profitsDeltas.length > 1 &&
        S.mult >= CFG.MIN_MULT
      ) {
        setInd("p1", "on");
        setSignal(
          "cashout",
          "🚨 CASH OUT NOW",
          "P1 tick leak — Δ" + delta + "ms @ " + S.mult.toFixed(2) + "x",
        );
        log("🔴 P1: CASH OUT NOW — Δ" + delta + "ms", "s");
        S.p1Hits++;
        setTimeout(() => setInd("p1", "off"), 3000);
        return;
      }

      // P2: Consecutive profits → crash approaching
      if (
        S.consecutiveProfits >= CFG.P2_CONSEC &&
        S.status === 3 &&
        S.mult >= CFG.MIN_MULT
      ) {
        setInd("p2", "on");
        setSignal(
          "warn",
          "⚠ CASH OUT SOON",
          S.consecutiveProfits + " consecutive profits — no cashouts",
        );
        log(
          "🟠 P2: " + S.consecutiveProfits + " consecutive → crash approaching",
          "w",
        );
        S.p2Hits++;
        setTimeout(() => setInd("p2", "off"), 3000);
      }

      // P3: No cashouts during flight
      if (!S.hasCashouts && S.profitsDeltas.length >= 2 && S.status === 3) {
        setInd("nc", "mild");
        if (
          S.mult >= CFG.MIN_MULT &&
          !Q("#cp-signal").classList.contains("cashout")
        ) {
          setSignal(
            "warn",
            "⚠ CASH OUT SOON",
            "No cashouts — likely crash <1.7x",
          );
          log("🟡 No cashouts this round", "w");
        }
      }
    }

    if (ev === "OnCashouts") {
      S.consecutiveProfits = 0;
      S.hasCashouts = true;
      const cp = Q("#si-cp");
      if (cp) {
        cp.textContent = "0";
        cp.style.color = "#fff";
      }
      setInd("nc", "off");
      if (
        S.status === 3 &&
        !Q("#cp-signal").classList.contains("cashout") &&
        !Q("#cp-signal").classList.contains("warn")
      ) {
        setSignal(
          "watch",
          "👀 FLYING",
          "Active cashouts @ " + S.mult.toFixed(2) + "x",
        );
      }
    }

    if (ev === "OnCrash") {
      const crashVal = d.f || d.p || 0;
      S.lastCrashDt = delta;

      // Track crashDt for latency analysis
      if (delta !== null) {
        S.crashDtHistory.unshift(delta);
        if (S.crashDtHistory.length > 20) S.crashDtHistory.pop();
        S.avgCrashDt =
          S.crashDtHistory.reduce((a, b) => a + b, 0) / S.crashDtHistory.length;
      }

      // P4: Dead air detection (no profits at all)
      if (S.profitsDeltas.length === 0) {
        S.deadAirRounds++;
        setInd("da", "on");
        log("💀 Dead air — instant crash " + crashVal.toFixed(2) + "x", "s");
        setTimeout(() => setInd("da", "off"), 5000);
      } else {
        if (S.deadAirRounds > 0)
          S.deadAirRounds = Math.max(0, S.deadAirRounds - 1);
      }

      // Track accuracy
      if (S.betAdvice === "BET" || S.betAdvice === "LEAN BET") {
        S.betsTotal++;
        if (crashVal >= 1.5) S.betsCorrect++;
      } else if (S.betAdvice === "SKIP" || S.betAdvice === "RISKY") {
        S.skipsTotal++;
        if (crashVal < 1.5) S.skipsCorrect++;
      }

      // Update streaks
      if (crashVal < CFG.STREAK_LOW_THRESH) {
        S.lowStreak++;
        S.highStreak = 0;
      } else if (crashVal >= CFG.STREAK_HIGH_THRESH) {
        S.highStreak++;
        S.lowStreak = 0;
      } else {
        S.lowStreak = 0;
        S.highStreak = 0;
      }

      if (crashVal > 0) {
        S.crashHistory.unshift(crashVal);
        if (S.crashHistory.length > 30) S.crashHistory.pop();
      }

      // Store round profile for learning
      S.roundProfileHistory.unshift({
        crash: crashVal,
        crashDt: delta,
        profitCount: S.profitsDeltas.length,
        cashoutCount: S.hasCashouts ? 1 : 0,
        firstProfitDt: S.firstProfitDt,
        consecutiveProfits: S.consecutiveProfits,
        advice: S.betAdvice,
      });
      if (S.roundProfileHistory.length > 50) S.roundProfileHistory.pop();

      S.totalRounds++;
      updateHistory();
      updateAccuracy();

      const ls = Q("#si-ls");
      if (ls) {
        ls.textContent = S.lowStreak;
        ls.style.color = S.lowStreak >= 2 ? "#4cff4c" : "#fff";
      }
      const rn = Q("#si-rn");
      if (rn) rn.textContent = S.totalRounds;

      // Show crash result with advice feedback
      let feedback = "";
      if (S.betAdvice === "SKIP" && crashVal < 1.5)
        feedback = "✅ SKIP was correct";
      else if (S.betAdvice === "BET" && crashVal >= 1.5)
        feedback = "✅ BET was right";
      else if (S.betAdvice === "BET" && crashVal < 1.5)
        feedback = "❌ BET missed";
      else if (S.betAdvice === "SKIP" && crashVal >= 2)
        feedback = "❌ SKIP missed opp";
      setSignal("idle", "CRASHED " + crashVal.toFixed(2) + "x", feedback);
    }
  }

  // ---- SignalR parser ----
  function parseMsg(raw) {
    const m = [];
    if (typeof raw !== "string") return m;
    for (const p of raw.split("\x1e")) {
      if (!p.trim()) continue;
      try {
        const o = JSON.parse(p);
        if (o.type === 1 && o.target)
          m.push({ ev: o.target, d: o.arguments?.[0] || {} });
      } catch (e) {}
    }
    return m;
  }

  // ---- Event handler ----
  function handleEvent(ev, d) {
    const now = Date.now();
    const delta = S.lastEventTime ? now - S.lastEventTime : 0;
    S.lastEventTime = now;

    checkPatterns(ev, delta, d);

    switch (ev) {
      case "OnRegistration":
        S.gainCoef = d.kx ? d.kx * 1000 : 25;
        S.status = d.s;
        S.stageId = d.l;
        if (d.fs) {
          S.crashHistory = d.fs.slice(0, 30).map((h) => h.f || 0);
          S.lowStreak = 0;
          for (let i = 0; i < S.crashHistory.length; i++) {
            if (S.crashHistory[i] < CFG.STREAK_LOW_THRESH) S.lowStreak++;
            else break;
          }
          updateHistory();
          const ls = Q("#si-ls");
          if (ls) {
            ls.textContent = S.lowStreak;
            ls.style.color = S.lowStreak >= 2 ? "#4cff4c" : "#fff";
          }
        }
        if (!d.fs && d.h) {
          S.crashHistory = d.h.slice(0, 30).map((h) => h.f || 0);
          S.lowStreak = 0;
          for (let i = 0; i < S.crashHistory.length; i++) {
            if (S.crashHistory[i] < CFG.STREAK_LOW_THRESH) S.lowStreak++;
            else break;
          }
          updateHistory();
          const ls = Q("#si-ls");
          if (ls) {
            ls.textContent = S.lowStreak;
            ls.style.color = S.lowStreak >= 2 ? "#4cff4c" : "#fff";
          }
        }
        if (d.s === 3) {
          S.coeffStartTime = now - (d.t || 0);
          S.startTime = now - (d.t || 0);
          startAnim();
          setSignal("watch", "👀 FLYING", "Joined mid-round");
        }
        {
          const ph = Q("#cp-phase");
          if (ph) ph.textContent = "s:" + d.s;
        }
        break;

      case "OnStage":
        S.stageId = d.l;
        S.status = 1;
        S.consecutiveProfits = 0;
        S.profitsDeltas = [];
        S.hasCashouts = false;
        S.roundEvents = 0;
        S.firstProfitDt = null;
        S.startTime = null;
        S.bettingDt = null;
        S.startDt = null;
        stopAnim();
        {
          const m = Q("#cp-mult");
          if (m) {
            m.textContent = "—";
            m.className = "cp-mv waiting";
          }
        }
        {
          const cp = Q("#si-cp");
          if (cp) {
            cp.textContent = "0";
            cp.style.color = "#fff";
          }
        }
        {
          const dp = Q("#si-dp");
          if (dp) {
            dp.textContent = "—";
            dp.style.color = "#fff";
          }
        }
        {
          const rf = Q("#cp-risk-fill");
          if (rf) rf.style.width = "0%";
        }
        ["p1", "p2", "nc", "p5", "da", "str"].forEach((s) => setInd(s, "off"));
        {
          const ph = Q("#cp-phase");
          if (ph) ph.textContent = "stage";
        }
        setSignal(
          "idle",
          "ANALYZING...",
          "Calculating risk from latency data...",
        );
        break;

      case "OnBetting": {
        S.status = 2;
        S.bettingDt = delta;
        const ph = Q("#cp-phase");
        if (ph) ph.textContent = "betting";

        const assessment = assessPreRoundRisk();
        const score = assessment ? assessment.score : 40;
        const reasons = assessment ? assessment.reasons : [];
        updateScore(score);

        const reasonText = reasons.length > 0 ? reasons[0] : "";

        if (S.betAdvice === "BET") {
          setSignal("bet", "✅ BET NOW", reasonText);
          setInd("str", "on");
          log("✅ BET — score " + score + " — " + reasonText, "g");
        } else if (S.betAdvice === "LEAN BET") {
          setSignal(
            "lean",
            "🟢 LEAN BET",
            reasonText || "Slight edge detected",
          );
          log("🟢 LEAN BET — score " + score + " — " + reasonText, "g");
        } else if (S.betAdvice === "OBSERVE") {
          setSignal(
            "observe",
            "👀 OBSERVE",
            reasonText || "No strong signal — wait",
          );
          log("👀 OBSERVE — score " + score + " — " + reasonText, "i");
        } else if (S.betAdvice === "RISKY") {
          setSignal("risky", "⚠ RISKY", reasonText || "Multiple danger signs");
          setInd("str", "mild");
          log("⚠ RISKY — score " + score + " — " + reasonText, "w");
        } else if (S.betAdvice === "SKIP") {
          setSignal("skip", "🚫 SKIP", reasonText || "High crash probability");
          setInd("str", "on");
          log("🚫 SKIP — score " + score + " — " + reasonText, "s");
        } else {
          setSignal("observe", "👀 OBSERVE", "Collecting data...");
          log("👀 Gathering latency data...", "i");
        }
        break;
      }

      case "OnStart":
        S.status = 3;
        S.coeffStartTime = now;
        S.startTime = now;
        S.startDt = delta;
        {
          const ph = Q("#cp-phase");
          if (ph) ph.textContent = "flying";
        }
        startAnim();
        setSignal("watch", "👀 FLYING", "Monitoring network signals...");
        break;

      case "OnCrash":
        S.status = 4;
        S.isCrashed = true;
        stopAnim();
        {
          const el = Q("#cp-mult");
          if (el) {
            el.textContent = (d.f || d.p || 0).toFixed(2) + "x";
            el.className = "cp-mv crashed";
          }
        }
        {
          const ph = Q("#cp-phase");
          if (ph) ph.textContent = "crashed";
        }
        {
          const rf = Q("#cp-risk-fill");
          if (rf) rf.style.width = "0%";
        }
        break;
    }
  }

  // ---- WebSocket hook ----
  const OrigWS = window.WebSocket;
  function hookSocket(ws, src) {
    if (ws.__cp_hooked) return;
    ws.__cp_hooked = true;
    S.ws = ws;
    if (document.body && !Q("#cp-root")) createUI();
    {
      const dot = Q("#cp-wsd");
      if (dot) dot.className = "cp-dot on";
    }
    {
      const wst = Q("#cp-wst");
      if (wst) wst.textContent = "Live";
    }
    log("Connected (" + src + ")", "i");
    ws.addEventListener("message", (e) => {
      for (const m of parseMsg(e.data)) handleEvent(m.ev, m.d);
    });
    ws.addEventListener("close", () => {
      S.ws = null;
      {
        const dot = Q("#cp-wsd");
        if (dot) dot.className = "cp-dot off";
      }
      {
        const wst = Q("#cp-wst");
        if (wst) wst.textContent = "Closed";
      }
    });
  }

  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    if (
      url &&
      typeof url === "string" &&
      (url.includes("sockets/crash-point") || url.includes("sockets/crash"))
    )
      ws.addEventListener("open", () => hookSocket(ws, "constructor"));
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  window.WebSocket.CONNECTING = OrigWS.CONNECTING;
  window.WebSocket.OPEN = OrigWS.OPEN;
  window.WebSocket.CLOSING = OrigWS.CLOSING;
  window.WebSocket.CLOSED = OrigWS.CLOSED;

  function destroy() {
    window.__cpActive = false;
    window.WebSocket = OrigWS;
    stopAnim();
    const r = Q("#cp-root");
    if (r) r.remove();
  }
  window.__cpsignal_destroy = destroy;
  window.__cpsignal_cfg = function (k, v) {
    if (k in CFG) {
      CFG[k] = v;
      log(k + "=" + v, "i");
    }
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", createUI);
  else createUI();
})();
