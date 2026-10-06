// ═══════════════════════════════════════════════════════════════════════════════
// AMPLIFIER ENGINE — dedup, scoring, timeline, narrative linking
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Canonical name normalization ─────────────────────────────────────────────
export function canonicalize(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/https?:\/\/(www\.)?/, "")
    .replace(/\.(com|mx|net|org|io|tv|info)(\/.*)?$/, "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // remove accents
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Platform influence weight ─────────────────────────────────────────────────
function platformWeight(platform, sourceType) {
  const p = String(platform || sourceType || "").toLowerCase();
  if (/\btv\b|televi|canal/.test(p))          return 3.0;
  if (/radio/.test(p))                         return 2.5;
  if (/noticias|portal|diario|peri|news|web/.test(p)) return 2.0;
  if (/facebook|instagram/.test(p))            return 1.8;
  if (/\bx\b|twitter/.test(p))                return 1.5;
  if (/youtube|tiktok/.test(p))               return 1.4;
  if (/telegram|whatsapp/.test(p))            return 1.2;
  return 1.0;
}

// ─── Parse reach string to number ─────────────────────────────────────────────
function parseReach(reach) {
  if (!reach) return 0;
  const s = String(reach).toLowerCase().replace(/,/g, "");
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  if (s.includes("m")) return n * 1_000_000;
  if (s.includes("k")) return n * 1_000;
  if (s.includes("%")) return n * 100; // percentage of total → rough proxy
  return n;
}

// ─── Compute scores ────────────────────────────────────────────────────────────
export function computeScores(amp) {
  const mentions  = Math.max(1, Number(amp.mentions_count) || 1);
  const reach     = parseReach(amp.reach);
  const pWeight   = platformWeight(amp.platform, amp.source_type);

  // Influence: log scale to avoid outliers dominating
  const influence = Math.round(
    (Math.log10(reach + 1) * 10 + mentions) * pWeight * 10
  ) / 10;

  // Risk: risk_level × sentiment × log(mentions)
  const riskMap  = { "Crítico": 4, "Alto": 3, "Medio": 2, "Bajo": 1 };
  const sentMap  = { "Negativo": 2, "Mixto": 1.5, "Neutral": 1, "Positivo": 0.5 };
  const rW = riskMap[amp.risk_level]           || 2;
  const sW = sentMap[amp.dominant_sentiment]   || 1;
  const riskScore = Math.round(rW * sW * Math.log10(mentions + 1) * 10) / 10;

  return { influence_score: influence, risk_score: riskScore };
}

// ─── Determine category ────────────────────────────────────────────────────────
export function categorize(role, sentiment, riskLevel) {
  const r = String(role || "").toLowerCase();
  const s = String(sentiment || "").toLowerCase();
  if (r.includes("favorable") || s.includes("positivo")) return "aliado";
  if (r.includes("crítico") || r.includes("critico") ||
      s.includes("negativo") || riskLevel === "Crítico" || riskLevel === "Alto") return "crítico";
  return "neutral";
}

// ─── Merge narrative tags ──────────────────────────────────────────────────────
export function mergeNarratives(existing, incoming) {
  let arr = [];
  try { arr = JSON.parse(existing || "[]"); } catch {}
  if (!Array.isArray(arr)) arr = [];
  for (const n of (incoming || [])) {
    const tag = String(n).slice(0, 80);
    if (tag && !arr.includes(tag)) arr.push(tag);
  }
  return JSON.stringify(arr.slice(0, 10)); // cap at 10 tags
}
