import { readFileSync, writeFileSync, mkdirSync } from "fs";

// ─── Data Loading ───

interface Row { wp: number; session: number; date: string; kommentar: string; }

const lines = readFileSync("./data/kommentare.jsonl", "utf-8").trim().split("\n");
const raw: Row[] = lines.map((l) => JSON.parse(l));
console.log(`Loaded ${raw.length} kommentars`);

// ─── Per-Session Aggregation ───

interface Session {
  wp: number;
  session: number;
  date: string;
  year: number;
  beifall: number;
  anhaltender_beifall: number;
  zurufe: number;
  heiterkeit: number;
  lachen: number;
  widerspruch: number;
  unruhe: number;
  zwischenruf_person: number;
  total: number;
  mood_ratio: number;
  intensity_ratio: number;
  gruene_govt: boolean;
  afd_present: boolean;
}

const sessionMap = new Map<string, Session>();

for (const r of raw) {
  const key = `${r.wp}/${r.session}`;
  if (!sessionMap.has(key)) {
    const year = r.date ? parseInt(r.date.substring(0, 4)) : 0;
    const grueneGovt = [14, 15, 20].includes(r.wp);
    const afdPresent = r.wp >= 19;
    sessionMap.set(key, {
      wp: r.wp, session: r.session, date: r.date, year,
      beifall: 0, anhaltender_beifall: 0, zurufe: 0, heiterkeit: 0,
      lachen: 0, widerspruch: 0, unruhe: 0, zwischenruf_person: 0,
      total: 0, mood_ratio: 0, intensity_ratio: 0,
      gruene_govt: grueneGovt, afd_present: afdPresent,
    });
  }

  const s = sessionMap.get(key)!;
  const k = r.kommentar.toLowerCase();
  s.total++;

  if (/^[\(]?(anhaltender|langanhaltender|lebhafter|stürmischer)\s+beifall/i.test(r.kommentar)) {
    s.anhaltender_beifall++;
    s.beifall++;
  } else if (k.includes("beifall")) {
    s.beifall++;
  } else if (/^[\(]?(zuruf|zurufe)\b/i.test(r.kommentar)) {
    s.zurufe++;
  } else if (k.includes("heiterkeit")) {
    s.heiterkeit++;
  } else if (k.includes("lachen") || k.includes("gelächter")) {
    s.lachen++;
  } else if (k.includes("widerspruch")) {
    s.widerspruch++;
  } else if (k.includes("unruhe")) {
    s.unruhe++;
  } else {
    s.zwischenruf_person++;
    s.zurufe++; // count named interjections as zurufe too
  }
}

const sessions = [...sessionMap.values()]
  .filter((s) => s.date && s.year > 0)
  .sort((a, b) => a.date.localeCompare(b.date) || a.session - b.session);

// Compute derived measures
for (const s of sessions) {
  const denom_mood = s.zurufe + s.widerspruch;
  s.mood_ratio = denom_mood > 0 ? (s.heiterkeit + s.lachen) / denom_mood : 0;
  s.intensity_ratio = s.beifall > 0 ? s.anhaltender_beifall / s.beifall : 0;
}

console.log(`${sessions.length} sessions aggregated`);

// ─── Statistics Utilities ───

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// Normal CDF approximation (Abramowitz & Stegun)
function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function pFromZ(z: number): number {
  return 2 * (1 - normalCDF(Math.abs(z)));
}

// ─── OLS with Newey-West Standard Errors ───

interface OLSResult {
  coefficients: number[];
  se: number[];
  t: number[];
  p: number[];
  labels: string[];
  r2: number;
  n: number;
}

function ols(Y: number[], X: number[][], labels: string[]): OLSResult {
  const n = Y.length;
  const k = X[0].length;

  // X'X
  const XtX: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < k; j++)
      for (let l = 0; l < k; l++)
        XtX[j][l] += X[i][j] * X[i][l];

  // Invert X'X (Gauss-Jordan for small matrices)
  const aug: number[][] = XtX.map((row, i) => [...row, ...Array(k).fill(0).map((_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < k; i++) {
    let maxRow = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(aug[r][i]) > Math.abs(aug[maxRow][i])) maxRow = r;
    [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];
    const pivot = aug[i][i];
    for (let j = 0; j < 2 * k; j++) aug[i][j] /= pivot;
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const factor = aug[r][i];
      for (let j = 0; j < 2 * k; j++) aug[r][j] -= factor * aug[i][j];
    }
  }
  const XtXinv = aug.map((row) => row.slice(k));

  // X'Y
  const XtY = Array(k).fill(0);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < k; j++)
      XtY[j] += X[i][j] * Y[i];

  // β = (X'X)^-1 X'Y
  const beta = Array(k).fill(0);
  for (let j = 0; j < k; j++)
    for (let l = 0; l < k; l++)
      beta[j] += XtXinv[j][l] * XtY[l];

  // Residuals
  const resid = Y.map((y, i) => y - X[i].reduce((s, x, j) => s + x * beta[j], 0));

  // R²
  const yMean = mean(Y);
  const ssTot = Y.reduce((s, y) => s + (y - yMean) ** 2, 0);
  const ssRes = resid.reduce((s, e) => s + e ** 2, 0);
  const r2 = 1 - ssRes / ssTot;

  // Newey-West (HAC) standard errors
  const maxLag = Math.floor(4 * Math.pow(n / 100, 2 / 9));
  const meat: number[][] = Array.from({ length: k }, () => Array(k).fill(0));

  // Lag 0
  for (let i = 0; i < n; i++)
    for (let j = 0; j < k; j++)
      for (let l = 0; l < k; l++)
        meat[j][l] += resid[i] * X[i][j] * resid[i] * X[i][l];

  // Lags 1..maxLag (Bartlett kernel)
  for (let lag = 1; lag <= maxLag; lag++) {
    const w = 1 - lag / (maxLag + 1);
    for (let i = lag; i < n; i++)
      for (let j = 0; j < k; j++)
        for (let l = 0; l < k; l++) {
          const cross = resid[i] * X[i][j] * resid[i - lag] * X[i - lag][l];
          meat[j][l] += w * cross;
          meat[l][j] += w * cross;
        }
  }

  // Sandwich: (X'X)^-1 * meat * (X'X)^-1
  const tmp: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++)
      for (let l = 0; l < k; l++)
        tmp[i][j] += XtXinv[i][l] * meat[l][j];

  const sandwich: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++)
      for (let l = 0; l < k; l++)
        sandwich[i][j] += tmp[i][l] * XtXinv[l][j];

  const se = Array(k).fill(0).map((_, i) => Math.sqrt(Math.max(0, sandwich[i][i])));
  const tStats = beta.map((b, i) => se[i] > 0 ? b / se[i] : 0);
  const pVals = tStats.map(pFromZ);

  return { coefficients: beta, se, t: tStats, p: pVals, labels, r2, n };
}

// ─── Segmented Regression ───

interface SegmentedResult {
  hypothesis: string;
  outcome: string;
  breakpoint_date: string;
  n: number;
  pre_mean: number;
  post_mean: number;
  pct_change: number;
  level_change: number; // β2
  level_change_se: number;
  level_change_ci: [number, number];
  level_change_p: number;
  slope_change: number; // β3
  slope_change_se: number;
  slope_change_p: number;
  r2: number;
  permutation_p: number;
  effect_meaningful: boolean;
  min_meaningful_pct: number;
}

function segmentedRegression(
  data: Session[],
  outcome: (s: Session) => number,
  breakIdx: number,
  hypothesis: string,
  outcomeName: string,
  breakDate: string,
  minMeaningfulPct: number,
): SegmentedResult {
  const Y = data.map(outcome);
  const X = data.map((_, i) => [
    1,            // intercept
    i,            // time trend
    i >= breakIdx ? 1 : 0,  // intervention
    i >= breakIdx ? i - breakIdx : 0,  // time after
  ]);

  const result = ols(Y, X, ["intercept", "time", "intervention", "time_after"]);

  const preMean = mean(Y.slice(0, breakIdx));
  const postMean = mean(Y.slice(breakIdx));
  const pctChange = preMean !== 0 ? ((postMean - preMean) / Math.abs(preMean)) * 100 : 0;

  // Permutation test for β2
  const actualB2 = Math.abs(result.coefficients[2]);
  let permCount = 0;
  const nPerm = minMeaningfulPct > 0 ? 1000 : 0; // skip for placebo tests
  const Ycopy = [...Y];

  for (let p = 0; p < nPerm; p++) {
    // Shuffle the intervention assignment by picking a random breakpoint
    const randBreak = Math.floor(Math.random() * (data.length - 20)) + 10;
    const Xperm = data.map((_, i) => [
      1, i,
      i >= randBreak ? 1 : 0,
      i >= randBreak ? i - randBreak : 0,
    ]);
    const permResult = ols(Ycopy, Xperm, ["", "", "", ""]);
    if (Math.abs(permResult.coefficients[2]) >= actualB2) permCount++;
  }
  const permP = (permCount + 1) / (nPerm + 1);

  return {
    hypothesis,
    outcome: outcomeName,
    breakpoint_date: breakDate,
    n: data.length,
    pre_mean: preMean,
    post_mean: postMean,
    pct_change: pctChange,
    level_change: result.coefficients[2],
    level_change_se: result.se[2],
    level_change_ci: [
      result.coefficients[2] - 1.96 * result.se[2],
      result.coefficients[2] + 1.96 * result.se[2],
    ],
    level_change_p: result.p[2],
    slope_change: result.coefficients[3],
    slope_change_se: result.se[3],
    slope_change_p: result.p[3],
    r2: result.r2,
    permutation_p: permP,
    effect_meaningful: Math.abs(pctChange) >= minMeaningfulPct,
    min_meaningful_pct: minMeaningfulPct,
  };
}

// ─── Group Comparison (Welch t-test + Mann-Whitney U) ───

interface GroupResult {
  hypothesis: string;
  outcome: string;
  group_a_label: string;
  group_b_label: string;
  group_a_n: number;
  group_b_n: number;
  group_a_mean: number;
  group_b_mean: number;
  diff: number;
  pct_diff: number;
  cohens_d: number;
  welch_t: number;
  welch_p: number;
  mannwhitney_p: number;
  effect_meaningful: boolean;
  min_meaningful_pct: number;
}

function welchTest(a: number[], b: number[]): { t: number; p: number } {
  const ma = mean(a), mb = mean(b);
  const va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(va / a.length + vb / b.length);
  const t = (ma - mb) / se;
  return { t, p: pFromZ(t) };
}

function mannWhitneyU(a: number[], b: number[]): number {
  // Compute U statistic and normal approximation for large samples
  let U = 0;
  for (const x of a)
    for (const y of b)
      U += x > y ? 1 : x === y ? 0.5 : 0;

  const n1 = a.length, n2 = b.length;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const z = (U - mu) / sigma;
  return pFromZ(z);
}

function groupComparison(
  a: number[], b: number[],
  aLabel: string, bLabel: string,
  hypothesis: string, outcomeName: string,
  minMeaningfulPct: number,
): GroupResult {
  const ma = mean(a), mb = mean(b);
  const diff = ma - mb;
  const pooledSd = Math.sqrt(
    ((a.length - 1) * std(a) ** 2 + (b.length - 1) * std(b) ** 2) / (a.length + b.length - 2)
  );
  const cohensD = pooledSd > 0 ? diff / pooledSd : 0;
  const pctDiff = mb !== 0 ? ((ma - mb) / Math.abs(mb)) * 100 : 0;

  const welch = welchTest(a, b);
  const mwP = mannWhitneyU(a, b);

  return {
    hypothesis, outcome: outcomeName,
    group_a_label: aLabel, group_b_label: bLabel,
    group_a_n: a.length, group_b_n: b.length,
    group_a_mean: ma, group_b_mean: mb,
    diff, pct_diff: pctDiff, cohens_d: cohensD,
    welch_t: welch.t, welch_p: welch.p,
    mannwhitney_p: mwP,
    effect_meaningful: Math.abs(pctDiff) >= minMeaningfulPct,
    min_meaningful_pct: minMeaningfulPct,
  };
}

// ─── Run Analyses ───

console.log("\n=== Running Preregistered Analyses ===\n");

// Find AfD breakpoint index
const afdBreakIdx = sessions.findIndex((s) => s.wp >= 19);
console.log(`AfD breakpoint: session ${afdBreakIdx} (${sessions[afdBreakIdx]?.date})`);

// H1: Zurufe increase after AfD
const h1 = segmentedRegression(sessions, (s) => s.zurufe, afdBreakIdx, "H1", "zurufe", sessions[afdBreakIdx].date, 20);
console.log(`H1 (Zurufe after AfD): ${h1.pct_change.toFixed(1)}% change, p=${h1.level_change_p.toFixed(6)}, perm_p=${h1.permutation_p.toFixed(4)}`);

// H2: Widerspruch increases after AfD
const h2 = segmentedRegression(sessions, (s) => s.widerspruch, afdBreakIdx, "H2", "widerspruch", sessions[afdBreakIdx].date, 20);
console.log(`H2 (Widerspruch after AfD): ${h2.pct_change.toFixed(1)}% change, p=${h2.level_change_p.toFixed(6)}, perm_p=${h2.permutation_p.toFixed(4)}`);

// H3: Mood ratio decreases after AfD
const h3 = segmentedRegression(sessions, (s) => s.mood_ratio, afdBreakIdx, "H3", "mood_ratio", sessions[afdBreakIdx].date, 15);
console.log(`H3 (Mood ratio after AfD): ${h3.pct_change.toFixed(1)}% change, p=${h3.level_change_p.toFixed(6)}, perm_p=${h3.permutation_p.toFixed(4)}`);

// H4: Heiterkeit decreases after AfD
const h4 = segmentedRegression(sessions, (s) => s.heiterkeit, afdBreakIdx, "H4", "heiterkeit", sessions[afdBreakIdx].date, 15);
console.log(`H4 (Heiterkeit after AfD): ${h4.pct_change.toFixed(1)}% change, p=${h4.level_change_p.toFixed(6)}, perm_p=${h4.permutation_p.toFixed(4)}`);

// H5: Heiterkeit higher when Grüne in government (pre-AfD)
const preAfdSessions = sessions.filter((s) => s.wp <= 17);
const grueneGovt = preAfdSessions.filter((s) => [14, 15].includes(s.wp)).map((s) => s.heiterkeit);
const grueneOpp = preAfdSessions.filter((s) => [16, 17].includes(s.wp)).map((s) => s.heiterkeit);
const h5 = groupComparison(grueneGovt, grueneOpp, "Grüne in govt (WP14-15)", "Grüne in opp (WP16-17)", "H5", "heiterkeit", 15);
console.log(`H5 (Heiterkeit, Grüne govt vs opp): d=${h5.cohens_d.toFixed(3)}, p=${h5.welch_p.toFixed(6)}`);

// H6: Mood ratio higher when Grüne in government (pre-AfD)
const grueneGovtMood = preAfdSessions.filter((s) => [14, 15].includes(s.wp)).map((s) => s.mood_ratio);
const grueneOppMood = preAfdSessions.filter((s) => [16, 17].includes(s.wp)).map((s) => s.mood_ratio);
const h6 = groupComparison(grueneGovtMood, grueneOppMood, "Grüne in govt (WP14-15)", "Grüne in opp (WP16-17)", "H6", "mood_ratio", 15);
console.log(`H6 (Mood ratio, Grüne govt vs opp): d=${h6.cohens_d.toFixed(3)}, p=${h6.welch_p.toFixed(6)}`);

// H7: Intensity ratio declines over WP15-18 (smartphone adoption)
const smartphoneSessions = sessions.filter((s) => s.wp >= 15 && s.wp <= 18);
const smartphoneBreakIdx = smartphoneSessions.findIndex((s) => s.wp >= 17);
const h7 = segmentedRegression(smartphoneSessions, (s) => s.intensity_ratio, smartphoneBreakIdx, "H7", "intensity_ratio", smartphoneSessions[smartphoneBreakIdx]?.date || "", 10);
console.log(`H7 (Intensity ratio, smartphone): ${h7.pct_change.toFixed(1)}% change, p=${h7.level_change_p.toFixed(6)}, perm_p=${h7.permutation_p.toFixed(4)}`);

// H8: Total noise stays flat while intensity declines
const h8noise = segmentedRegression(smartphoneSessions, (s) => s.total, smartphoneBreakIdx, "H8-noise", "noise_total", smartphoneSessions[smartphoneBreakIdx]?.date || "", 10);
console.log(`H8 (Total noise, smartphone): ${h8noise.pct_change.toFixed(1)}% change, p=${h8noise.level_change_p.toFixed(6)}`);

// ─── Placebo Tests ───

console.log("\n=== Placebo Tests (AfD hypotheses at false breakpoints) ===");

const placebos: { offset: number; h1_p: number; h3_p: number }[] = [];
for (const wpBreak of [15, 16, 17, 20]) {
  const idx = sessions.findIndex((s) => s.wp >= wpBreak);
  if (idx < 10 || idx > sessions.length - 10) continue;
  const p1 = segmentedRegression(sessions, (s) => s.zurufe, idx, "", "", "", 0);
  const p3 = segmentedRegression(sessions, (s) => s.mood_ratio, idx, "", "", "", 0);
  console.log(`  Placebo WP${wpBreak}: H1 pct=${p1.pct_change.toFixed(1)}%, p=${p1.level_change_p.toFixed(4)} | H3 pct=${p3.pct_change.toFixed(1)}%, p=${p3.level_change_p.toFixed(4)}`);
  placebos.push({ offset: wpBreak, h1_p: p1.level_change_p, h3_p: p3.level_change_p });
}

// ─── Per-Year Summary for Viz ───

const yearMap = new Map<number, { sessions: number; beifall: number; zurufe: number; heiterkeit: number; lachen: number; widerspruch: number; unruhe: number; total: number; mood_sum: number; intensity_sum: number }>();
for (const s of sessions) {
  if (!yearMap.has(s.year)) yearMap.set(s.year, { sessions: 0, beifall: 0, zurufe: 0, heiterkeit: 0, lachen: 0, widerspruch: 0, unruhe: 0, total: 0, mood_sum: 0, intensity_sum: 0 });
  const y = yearMap.get(s.year)!;
  y.sessions++;
  y.beifall += s.beifall;
  y.zurufe += s.zurufe;
  y.heiterkeit += s.heiterkeit;
  y.lachen += s.lachen;
  y.widerspruch += s.widerspruch;
  y.unruhe += s.unruhe;
  y.total += s.total;
  y.mood_sum += s.mood_ratio;
  y.intensity_sum += s.intensity_ratio;
}

const yearSummary = [...yearMap.entries()]
  .filter(([y]) => y >= 1998)
  .sort(([a], [b]) => a - b)
  .map(([year, d]) => ({
    year,
    sessions: d.sessions,
    beifall_per_session: d.beifall / d.sessions,
    zurufe_per_session: d.zurufe / d.sessions,
    heiterkeit_per_session: d.heiterkeit / d.sessions,
    lachen_per_session: d.lachen / d.sessions,
    widerspruch_per_session: d.widerspruch / d.sessions,
    total_per_session: d.total / d.sessions,
    mood_ratio_mean: d.mood_sum / d.sessions,
    intensity_ratio_mean: d.intensity_sum / d.sessions,
  }));

// ─── Output ───

mkdirSync("./data", { recursive: true });

const output = {
  meta: {
    total_kommentars: raw.length,
    total_sessions: sessions.length,
    date_range: [sessions[0].date, sessions[sessions.length - 1].date],
    wahlperioden: [...new Set(sessions.map((s) => s.wp))].sort(),
    generated: new Date().toISOString(),
  },
  hypotheses: {
    afd: { h1, h2, h3, h4 },
    gruene: { h5, h6 },
    smartphone: { h7, h8: h8noise },
  },
  placebos,
  year_summary: yearSummary,
  bonferroni_alpha: 0.05 / 8,
};

writeFileSync("./data/results.json", JSON.stringify(output, null, 2));

// Also output session-level data for the viz (compact)
const sessionData = sessions.map((s) => ({
  d: s.date,
  wp: s.wp,
  s: s.session,
  b: s.beifall,
  z: s.zurufe,
  h: s.heiterkeit,
  l: s.lachen,
  w: s.widerspruch,
  t: s.total,
  mr: Math.round(s.mood_ratio * 1000) / 1000,
  ir: Math.round(s.intensity_ratio * 10000) / 10000,
}));
writeFileSync("./data/sessions.json", JSON.stringify(sessionData));

console.log("\n=== Output written ===");
console.log(`  data/results.json (${(JSON.stringify(output).length / 1024).toFixed(0)} KB)`);
console.log(`  data/sessions.json (${(JSON.stringify(sessionData).length / 1024).toFixed(0)} KB)`);

// ─── Summary Table ───

console.log("\n=== RESULTS SUMMARY ===\n");
console.log("Hypothesis | Outcome | Change | p-value | Perm. p | Meaningful?");
console.log("-----------|---------|--------|---------|---------|----------");
for (const [label, r] of [["H1", h1], ["H2", h2], ["H3", h3], ["H4", h4], ["H7", h7], ["H8", h8noise]] as [string, SegmentedResult][]) {
  console.log(`${label.padEnd(11)}| ${r.outcome.padEnd(8)}| ${(r.pct_change > 0 ? "+" : "") + r.pct_change.toFixed(1) + "%"}${" ".repeat(Math.max(0, 5 - r.pct_change.toFixed(1).length))}| ${r.level_change_p < 0.001 ? "<0.001 " : r.level_change_p.toFixed(4).padEnd(8)}| ${r.permutation_p < 0.001 ? "<0.001 " : r.permutation_p.toFixed(4).padEnd(8)}| ${r.effect_meaningful ? "YES" : "no"}`);
}
console.log("");
for (const [label, r] of [["H5", h5], ["H6", h6]] as [string, GroupResult][]) {
  console.log(`${label.padEnd(11)}| ${r.outcome.padEnd(8)}| d=${r.cohens_d > 0 ? "+" : ""}${r.cohens_d.toFixed(3)}${" ".repeat(Math.max(0, 2))}| ${r.welch_p < 0.001 ? "<0.001 " : r.welch_p.toFixed(4).padEnd(8)}| MW:${r.mannwhitney_p < 0.001 ? "<.001 " : r.mannwhitney_p.toFixed(3).padEnd(6)}| ${r.effect_meaningful ? "YES" : "no"}`);
}
