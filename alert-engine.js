import { getAlertRulesByProject, saveAutoAlert, getAnalysesByProject, getProjectById, getUserById, getProjectMembers } from "./db.js";
import { enviarAlertaPersonalizada, enviarAlertaReputacional } from "./mailer.js";

// Tipos de regla que el propio usuario configura ("avísame si aparece X") —
// las otras 6 (DEFAULT_RULES, abajo) son automáticas del sistema, nadie las
// configura, y son las que se ven en la tarjeta "Alertas reputacionales".
const TIPOS_REGLA_USUARIO = ["user_keyword", "user_narrative"];

// Todos los que deben enterarse de una alerta de un proyecto: el dueño +
// cualquiera agregado como project_member (editor o viewer) — no solo quien
// lo creó. Deduplicado por correo por si el dueño también quedó como member.
async function getAlertRecipients(project) {
  const vistos = new Set();
  const destinatarios = [];
  const owner = await getUserById(project.user_id);
  if (owner?.email && owner.status !== "archived") {
    vistos.add(owner.email);
    destinatarios.push({ email: owner.email, name: owner.name });
  }
  const miembros = await getProjectMembers(project.id);
  for (const m of miembros) {
    if (m.user_email && !vistos.has(m.user_email)) {
      vistos.add(m.user_email);
      destinatarios.push({ email: m.user_email, name: m.user_name });
    }
  }
  return destinatarios;
}

// ─── Severity helpers ─────────────────────────────────────────────────────────
function riskFromDelta(delta, high = 15, critical = 30) {
  if (delta >= critical) return "Crítico";
  if (delta >= high)     return "Alto";
  return "Medio";
}
function riskOrder(r) {
  return r === "Crítico" ? 1 : r === "Alto" ? 2 : r === "Medio" ? 3 : 4;
}
function maxRisk(...risks) {
  return risks.reduce((a, b) => riskOrder(a) <= riskOrder(b) ? a : b);
}

// ─── Rule evaluators ──────────────────────────────────────────────────────────

function evalNegativeSpike(rule, current, previous) {
  const cond   = rule.condition_json || {};
  const delta  = parseFloat(cond.delta  ?? 15);
  const minNeg = parseFloat(cond.min_neg ?? 40);
  const curNeg = Number(current.sentiment_neg) || 0;
  const prevNeg = previous ? (Number(previous.sentiment_neg) || 0) : 0;
  const rise = curNeg - prevNeg;

  const deltaFired  = previous && rise >= delta;
  const minNegFired = curNeg >= minNeg;

  if (deltaFired || minNegFired) {
    const risk = riskFromDelta(rise, delta, delta * 2);
    const msg = deltaFired
      ? `Sentimiento negativo subió ${rise.toFixed(0)} pts (${prevNeg.toFixed(0)}% → ${curNeg.toFixed(0)}%). Umbral configurado: +${delta} pts.`
      : `Sentimiento negativo en ${curNeg.toFixed(0)}%, superando el umbral mínimo de ${minNeg}%.`;
    return { title: "Aumento de sentimiento negativo", description: msg, risk_level: risk };
  }
  return null;
}

function evalSentimentDrop(rule, current, previous) {
  if (!previous) return null;
  const cond  = rule.condition_json || {};
  const delta = parseFloat(cond.delta ?? 20);
  const curPos  = Number(current.sentiment_pos)  || 0;
  const prevPos = Number(previous.sentiment_pos) || 0;
  const drop = prevPos - curPos;

  if (drop >= delta) {
    const risk = riskFromDelta(drop, delta, delta * 1.5);
    return {
      title: "Caída brusca del sentimiento positivo",
      description: `Sentimiento positivo cayó ${drop.toFixed(0)} pts (${prevPos.toFixed(0)}% → ${curPos.toFixed(0)}%). Umbral configurado: -${delta} pts.`,
      risk_level: risk,
    };
  }
  return null;
}

function evalCriticalKeywords(rule, current, mentions, narratives) {
  const cond     = rule.condition_json || {};
  const keywords = (cond.keywords || ["corrupción","fraude","escándalo","detención","investigación","arresto","acusación","denuncia","filtración"]);
  const texts    = [
    ...(mentions   || []).map(m => `${m.title||""} ${m.content||""}`),
    ...(narratives || []).map(n => `${n.name||""} ${n.description||""}`),
  ].map(t => t.toLowerCase());

  const found = {};
  for (const kw of keywords) {
    const kwl = kw.toLowerCase();
    const count = texts.filter(t => t.includes(kwl)).length;
    if (count > 0) found[kw] = count;
  }
  if (!Object.keys(found).length) return null;

  const top = Object.entries(found).sort((a,b) => b[1]-a[1]).slice(0,3);
  return {
    title: `Palabra${top.length > 1 ? "s" : ""} crítica${top.length > 1 ? "s" : ""} detectada${top.length > 1 ? "s" : ""}`,
    description: `Se detectaron términos de riesgo: ${top.map(([k,c]) => `"${k}" (${c} ocurrencia${c>1?"s":""})`).join(", ")}.`,
    risk_level: "Alto",
  };
}

function evalSensitiveSource(rule, amplifiers) {
  const cond    = rule.condition_json || {};
  const sources = (cond.sources || ["FGR","AMLO","Presidencia","NYT","Washington Post","Reforma","El País","BBC","Reuters","AP","Proceso","Aristegui"]);
  const amps    = amplifiers || [];

  const matched = [];
  for (const amp of amps) {
    const name = String(amp.name || "").toLowerCase();
    for (const src of sources) {
      if (name.includes(src.toLowerCase())) {
        matched.push({ id: amp.id, name: amp.name, risk: amp.risk_level, src });
        break;
      }
    }
  }
  if (!matched.length) return null;

  const topRisk = matched.reduce((a,b) => riskOrder(a.risk||"Medio") <= riskOrder(b.risk||"Medio") ? a : b);
  return {
    title: "Fuente sensible amplificando el tema",
    description: `Se detectaron ${matched.length} fuente${matched.length>1?"s":""} sensible${matched.length>1?"s":""}: ${matched.slice(0,3).map(m=>`"${m.name}"`).join(", ")}. Estas fuentes tienen alto impacto reputacional.`,
    risk_level: maxRisk(topRisk.risk || "Medio", "Medio"),
    // id real del amplificador que disparó — 2026-10-02, permite abrir el
    // modal de evidencia (ver getAlertEvidence en db.js).
    amplifierId: topRisk.id ?? null,
  };
}

function evalNarrativeGrowth(rule, narratives) {
  const cond    = rule.condition_json || {};
  const minRisk = cond.min_risk || "Alto";
  const order   = riskOrder(minRisk);
  const highs   = (narratives || []).filter(n => riskOrder(n.risk_level) <= order);

  if (!highs.length) return null;

  const top = highs[0];
  const risk = highs.some(n => n.risk_level === "Crítico") ? "Crítico" : "Alto";
  return {
    title: `${highs.length > 1 ? `${highs.length} narrativas` : "Narrativa"} de alto riesgo detectada${highs.length>1?"s":""}`,
    description: `Nueva${highs.length>1?"s":""} narrativa${highs.length>1?"s":""} de riesgo ${risk}: "${String(top.name||top.title||"—").slice(0,100)}".${highs.length>1 ? ` (+ ${highs.length-1} más)` : ""}`,
    risk_level: risk,
    narrativeId: top.id ?? null,
  };
}

function evalHighRiskAmplifier(rule, amplifiers) {
  const cond        = rule.condition_json || {};
  const minRisk     = cond.min_risk     || "Alto";
  const minMentions = parseInt(cond.min_mentions ?? 1);
  const order       = riskOrder(minRisk);

  const highs = (amplifiers || []).filter(a =>
    riskOrder(a.risk_level) <= order &&
    (Number(a.mentions_count) || 0) >= minMentions
  );
  if (!highs.length) return null;

  const top  = highs[0];
  const risk = highs.some(a => a.risk_level === "Crítico") ? "Crítico" : "Alto";
  return {
    title: `Amplificador${highs.length>1?"es":""} crítico${highs.length>1?"s":""} detectado${highs.length>1?"s":""}`,
    description: `"${top.name}" amplifica el tema con riesgo ${top.risk_level} y ${top.mentions_count} mención${top.mentions_count>1?"es":""}.${highs.length>1?` (+ ${highs.length-1} más)`:""}`,
    risk_level: risk,
    amplifierId: top.id ?? null,
  };
}

// ─── Reglas configuradas por el usuario (vigilar palabra o narrativa) ──────────
// Rango de fechas real y honesto: si el usuario configuró vigilar algo solo
// entre dos fechas, la regla no dispara fuera de esa ventana — no se "activa
// igual" solo porque encontró coincidencia.
function fueraDeRango(cond) {
  const ahora = Date.now();
  if (cond.fecha_inicio && ahora < new Date(cond.fecha_inicio).getTime()) return true;
  if (cond.fecha_fin && ahora > new Date(cond.fecha_fin + "T23:59:59").getTime()) return true;
  return false;
}

function evalUserKeyword(rule, mentions, narratives) {
  const cond = rule.condition_json || {};
  const palabra = String(cond.valor || "").trim();
  if (!palabra || fueraDeRango(cond)) return null;
  const palabraL = palabra.toLowerCase();
  const texts = [
    ...(mentions || []).map(m => `${m.title || ""} ${m.content || ""}`),
    ...(narratives || []).map(n => `${n.name || ""}`),
  ].map(t => t.toLowerCase());
  const count = texts.filter(t => t.includes(palabraL)).length;
  if (!count) return null;
  return {
    title: `Palabra vigilada detectada: "${palabra}"`,
    description: `Se detectaron ${count} mención${count > 1 ? "es" : ""} real${count > 1 ? "es" : ""} con "${palabra}".`,
    risk_level: "Medio",
  };
}

function evalUserNarrative(rule, narratives) {
  const cond = rule.condition_json || {};
  const objetivo = String(cond.valor || "").trim();
  if (!objetivo || fueraDeRango(cond)) return null;
  const objetivoL = objetivo.toLowerCase();
  const match = (narratives || []).find(n => (n.name || "").toLowerCase().includes(objetivoL));
  if (!match) return null;
  return {
    title: `Narrativa vigilada detectada: "${match.name}"`,
    description: `Apareció la narrativa que configuraste vigilar (riesgo ${match.risk_level || "sin clasificar"}, tendencia ${match.trend || "sin dato"}).`,
    risk_level: match.risk_level || "Medio",
    narrativeId: match.id ?? null,
  };
}

// ─── Rule dispatcher ──────────────────────────────────────────────────────────
function evaluate(rule, current, previous, mentions, narratives, amplifiers) {
  try {
    switch (rule.rule_type) {
      case "negative_spike":      return evalNegativeSpike(rule, current, previous);
      case "sentiment_drop":      return evalSentimentDrop(rule, current, previous);
      case "critical_keywords":   return evalCriticalKeywords(rule, current, mentions, narratives);
      case "sensitive_source":    return evalSensitiveSource(rule, amplifiers);
      case "narrative_growth":    return evalNarrativeGrowth(rule, narratives);
      case "high_risk_amplifier": return evalHighRiskAmplifier(rule, amplifiers);
      case "user_keyword":        return evalUserKeyword(rule, mentions, narratives);
      case "user_narrative":      return evalUserNarrative(rule, narratives);
      default: return null;
    }
  } catch (e) {
    console.error(`[AlertEngine] Error evaluating rule ${rule.rule_type}:`, e.message);
    return null;
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────
export async function evaluateAlertRules(projectId, analysisId, currentAnalysis, mentions, narratives, amplifiers) {
  try {
    const rules = await getAlertRulesByProject(projectId);
    if (!rules.length) return;

    // Get previous analysis for delta comparisons
    const allAnalyses = await getAnalysesByProject(projectId);
    const previous = allAnalyses.find(a => a.id !== analysisId) || null;

    let triggered = 0;
    let project = null;
    for (const rule of rules) {
      const result = evaluate(rule, currentAnalysis, previous, mentions, narratives, amplifiers);
      if (result) {
        // `rule.rule_type` real (2026-10-02) en vez de `rule.id` — antes
        // saveAutoAlert ignoraba este argumento y grababa alert_type='auto'
        // fijo para las 6 reglas de sistema, sin distinguir una de otra.
        // Ahora alert_type guarda el tipo real, lo que permite despachar la
        // evidencia correcta por tipo en getAlertEvidence.
        const saved = await saveAutoAlert(
          projectId, analysisId, rule.rule_type, result.title, result.description, result.risk_level,
          result.narrativeId ?? null, result.amplifierId ?? null,
        );
        triggered++;
        console.log(`[AlertEngine] Rule "${rule.rule_type}" fired for project ${projectId}: ${result.title}`);

        // Dos caminos para el correo, y solo cuando la alerta es nueva de
        // verdad (isNew): si sigue abierta de una corrida anterior, ya se
        // avisó una vez, no hay que repetir el correo cada vez que el cron
        // (cada 2h) o "Analizar ahora" vuelve a encontrar lo mismo.
        //  1. Regla personalizada del usuario ("avísame si aparece X") con
        //     canal="correo" elegido al crearla — se avisa siempre que dispare.
        //  2. Regla automática del sistema (las 6 de DEFAULT_RULES, lo que se
        //     ve en la tarjeta "Alertas reputacionales") — se avisa solo si
        //     es de severidad Alto o Crítico, para no saturar con las Medio.
        const canal = rule.condition_json?.canal;
        const esReglaUsuario = TIPOS_REGLA_USUARIO.includes(rule.rule_type);
        const debeAvisar = saved.isNew && (
          (esReglaUsuario && canal === "correo") ||
          (!esReglaUsuario && (result.risk_level === "Crítico" || result.risk_level === "Alto"))
        );
        if (debeAvisar) {
          try {
            project = project || await getProjectById(projectId);
            if (project) {
              const enviarFn = esReglaUsuario ? enviarAlertaPersonalizada : enviarAlertaReputacional;
              const destinatarios = await getAlertRecipients(project);
              for (const dest of destinatarios) {
                await enviarFn(dest.email, dest.name, {
                  projectName: project.name, alertTitle: result.title,
                  description: result.description, riskLevel: result.risk_level,
                });
              }
            }
          } catch (e) {
            console.error(`[AlertEngine] Error enviando correo de alerta:`, e.message);
          }
        }
      }
    }
    if (triggered) console.log(`[AlertEngine] ${triggered} alert(s) generated for project ${projectId}`);
  } catch (e) {
    console.error("[AlertEngine] Error:", e.message);
  }
}

// ─── Default rules for new projects ──────────────────────────────────────────
export const DEFAULT_RULES = [
  {
    name:           "Aumento de menciones negativas",
    rule_type:      "negative_spike",
    condition_json: { delta: 15, min_neg: 45 },
  },
  {
    name:           "Caída brusca del sentimiento",
    rule_type:      "sentiment_drop",
    condition_json: { delta: 20 },
  },
  {
    name:           "Aparición de palabras críticas",
    rule_type:      "critical_keywords",
    condition_json: { keywords: ["corrupción","fraude","escándalo","detención","investigación","arresto","acusación","denuncia","filtración","colusión","soborno","desfalco"] },
  },
  {
    name:           "Fuente sensible detectada",
    rule_type:      "sensitive_source",
    condition_json: { sources: ["FGR","AMLO","Presidencia","NYT","Washington Post","Reforma","El País","BBC","Reuters","AP","Proceso","Aristegui","CNN","Latinus"] },
  },
  {
    name:           "Crecimiento de narrativa de riesgo",
    rule_type:      "narrative_growth",
    condition_json: { min_risk: "Alto" },
  },
  {
    name:           "Amplificador de alto riesgo",
    rule_type:      "high_risk_amplifier",
    condition_json: { min_risk: "Alto", min_mentions: 1 },
  },
];
