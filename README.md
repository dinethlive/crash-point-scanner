# Crash Point Signal Pro v3

Advanced pattern-based betting signals for Crash Point (Game 601) with latency analysis, tick leak detection, and smart risk scoring.

![Crash Point Signal Pro Interface](screenshots/crash-point-scanner-ss-1.png)

## Overview

**Crash Point Signal Pro** is a sophisticated userscript that intercepts WebSocket traffic on Melbet's Crash Point game (Game 601) to analyze network-level patterns and provide intelligent betting signals. The system is built from 6+ rounds of empirical latency data and uses multiple detection strategies to identify impending crashes before they occur.

### Supported URLs

- `https://melbet-srilanka.com/games-frame/games/601*`
- `https://*.melbet*.com/games-frame/games/601*`

---

## Features

### Network-Level Pattern Detection

The script detects six distinct network-level patterns that indicate imminent crashes:

#### P1: Micro-Delta Tick Leak

- **Trigger:** `OnProfits` arrives ≤5ms after previous event
- **Meaning:** Events are being bundled in the same server tick
- **Action:** When detected mid-flight, crash is imminent — **CASH OUT NOW**
- **Visual Indicator:** Red "P1:TICK" indicator lights up

#### P2: Consecutive OnProfits Without OnCashouts

- **Trigger:** 3+ consecutive profit events without any cashouts
- **Meaning:** Server is flushing final profit ticks before crash
- **Action:** Warning to cash out soon
- **Visual Indicator:** Orange "P2:CONSEC" indicator

#### P3: No OnCashouts At All

- **Trigger:** No cashout events during the entire round
- **Meaning:** Typically results in crash <1.7x
- **Action:** Strong warning to cash out early
- **Visual Indicator:** "NO-CO" indicator turns mild orange

#### P4: Dead Air

- **Trigger:** `OnStart` followed immediately by `OnCrash` with NO intermediate events
- **Meaning:** Instant crash (≤1.2x)
- **Action:** Identifies instant crash patterns
- **Visual Indicator:** "DEAD-AIR" indicator

#### P5: First Profit Δ ≤ 10ms

- **Trigger:** First profit event arrives extremely early (≤10ms after start)
- **Meaning:** Early bundling correlates with faster crashes
- **Action:** Risk indicator — increases crash probability
- **Visual Indicator:** "P5:EARLY" info indicator

#### P6: CrashDt ≤ 300ms

- **Trigger:** OnCrash arrives within 300ms of last event
- **Meaning:** Tight event bundling, crash arrived in same frame group

---

### Pre-Round Risk Assessment

The script performs comprehensive pre-round analysis during the betting phase:

#### Scoring System (0-100)

- **40 (Default):** Conservative baseline
- **70+:** Good bet opportunity
- **55-69:** Lean bet (slight edge)
- **40-54:** Observe (neutral)
- **25-39:** Risky (high crash probability)
- **<25:** Skip (danger zone)

#### Scoring Factors

| Factor                | Condition                     | Score Adjustment |
| --------------------- | ----------------------------- | ---------------- |
| Low Streak Reversal   | 2+ crashes <1.5x              | +12 to +60       |
| Post-High Correction  | Previous crash >5x            | -20              |
| After Instant Crash   | Previous crash ≤1.1x          | -10              |
| Very Low Average      | Avg of last 3 <1.3x           | +15              |
| Low Average           | Avg of last 3 <1.5x           | +8               |
| High Average          | Avg of last 3 >5x             | -12              |
| Alternating Pattern   | Low-High-Low or High-Low-High | +6               |
| Dead Air Frequency    | 2+ recent dead-air rounds     | -15              |
| High CrashDt Avg      | >1500ms average               | -8               |
| Tight CrashDt         | <400ms average                | +5               |
| Consecutive High Wins | 3+ crashes >3x                | -18              |

---

### Betting Advice Types

| Signal              | Color          | Meaning                                   |
| ------------------- | -------------- | ----------------------------------------- |
| ✅ **BET NOW**      | Green          | Strong buy signal (score ≥70)             |
| 🟢 **LEAN BET**     | Light Green    | Slight edge detected (score 55-69)        |
| 👀 **OBSERVE**      | Purple         | No strong signal — wait (score 40-54)     |
| ⚠ **RISKY**         | Orange         | Multiple danger signs (score 25-39)       |
| 🚫 **SKIP**         | Red            | High crash probability (score <25)        |
| 🚨 **CASH OUT NOW** | Red (flashing) | Immediate cashout required (P1 triggered) |
| ⚠ **CASH OUT SOON** | Orange         | Warning to exit soon                      |

---

## Real-Time UI Components

### Main Display Elements

| Element                | Description                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| **Multiplier**         | Live multiplier display with color coding (green=up, red=crashed, gray=waiting) |
| **Signal Box**         | Primary betting advice with animated styling                                    |
| **Risk Meter**         | Horizontal bar showing real-time crash risk level                               |
| **Score Bar**          | Visual representation of the 0-100 risk score                                   |
| **Pattern Indicators** | Six indicators showing active network patterns                                  |

### Statistics Panel

| Stat        | Description                               |
| ----------- | ----------------------------------------- |
| **Δ Last**  | Time delta of last event in milliseconds  |
| **Consec**  | Number of consecutive profit events       |
| **Low Run** | Number of consecutive low crashes (<1.5x) |
| **Rounds**  | Total rounds analyzed                     |

### History & Accuracy

- **Crash History:** Visual display of last 20 crash values (color-coded: red=low, orange=medium, green=high)
- **Accuracy Tracker:** Shows percentage of correct BET and SKIP decisions
- **Event Log:** Scrolling log of detected patterns and decisions

---

## Configuration Options

The script exposes configuration via global functions:

### Remove Script

```javascript
window.__cpsignal_destroy();
```

### Update Configuration

```javascript
window.__cpsignal_cfg("key", value);
```

#### Configurable Parameters

| Parameter            | Default | Description                        |
| -------------------- | ------- | ---------------------------------- |
| `P1_DELTA`           | 5       | Tick leak threshold (ms)           |
| `P2_CONSEC`          | 3       | Consecutive profits before warning |
| `P5_FIRST_PROFIT`    | 10      | Early bundling threshold (ms)      |
| `MIN_MULT`           | 1.1     | Minimum multiplier for signals     |
| `STREAK_LOW_THRESH`  | 1.5     | Low crash threshold                |
| `STREAK_HIGH_THRESH` | 5.0     | High crash threshold               |
| `STREAK_COUNT`       | 2       | Streak detection count             |
| `MIN_ROUNDS_FOR_BET` | 3       | Rounds needed before advising BET  |
| `BET_SCORE_THRESH`   | 70      | Score needed for BET signal        |

---

## Technical Implementation

### WebSocket Interception

The script hooks into `WebSocket` to intercept all SignalR messages:

```javascript
window.WebSocket = function (url, protocols) {
  // Intercepts crash-point WebSocket connections
  // Parses messages using the SignalR protocol
  // Triggers pattern detection on each event
};
```

### Event Types Handled

| Event            | Phase          | Action                                       |
| ---------------- | -------------- | -------------------------------------------- |
| `OnRegistration` | Start          | Initialize game state, load crash history    |
| `OnStage`        | Between Rounds | Reset round state, analyze previous round    |
| `OnBetting`      | Betting        | Calculate pre-round risk score               |
| `OnStart`        | Flying         | Start multiplier animation, begin monitoring |
| `OnProfits`      | Flying         | Check for tick leaks, consecutive profits    |
| `OnCashouts`     | Flying         | Reset consecutive counter                    |
| `OnCrash`        | End            | Update history, track accuracy               |

### Multiplier Calculation

```javascript
function calcMult(ms) {
  return Math.min((gainCoef / 1e9) * ms * ms + 1, 35);
}
```

---

## Installation

1. Install a userscript manager (Tampermonkey, Greasemonkey, or Violentmonkey)
2. Create a new userscript
3. Paste the contents of `crash-point-scanner.js`
4. Save and navigate to a supported Melbet Crash Point URL
5. The signal panel will appear in the top-right corner

---

## Usage Guidelines

### Best Practices

1. **Wait for Data:** Allow at least 3 rounds for the system to gather sufficient data before following BET signals
2. **Trust the Patterns:** P1 (tick leak) is the most reliable indicator — when it triggers, cash out immediately
3. **Use Score as Guide:** Higher scores indicate better risk/reward opportunities
4. **Watch for Streaks:** After consecutive low crashes, reversal is likely
5. **Avoid Hot Markets:** After 3+ high crashes, correction is imminent

### Default Behavior

> ⚠️ **Default: OBSERVE** — The system defaults to OBSERVE (not BET) and only advises BET when multiple positive signals converge. This conservative approach minimizes losses during uncertain conditions.

---

## Version History

| Version | Changes                                                                                       |
| ------- | --------------------------------------------------------------------------------------------- |
| 3.0     | Full rewrite with latency-informed risk scoring, six network patterns, pre-round intelligence |

---

## License

This software is proprietary and licensed under the **Crash Point Signal Pro License**. See the [LICENSE](LICENSE) file for full terms and conditions.

- **Personal Use Only** - This software is for educational and analytical purposes
- **No Commercial Use** - Commercial use, monetization, or redistribution is strictly prohibited
- **No Derivatives** - Creating derivative works is not allowed

---

## Disclaimer

This tool is for educational and analytical purposes only. Gambling involves financial risk. Use responsibly and at your own discretion. The developers assume no liability for any losses incurred while using this script.
