import OpenAI from "openai";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import { sha256, verifyPassword, hashPassword } from "./db.js";
import {
  saveAnalysis, getHistory, getAnalysisById, getAnalysesByProject,
  getUserByEmail, getOrCreateDemoUser,
  createProject, getProjectById,
  countActiveProjectsByUser, updateProject, deleteProject,
  saveProjectKeywords, getProjectKeywords,
  saveProjectSources, getProjectSources,
  saveMentionsFromAnalysis, getMentionsByProject, updateMentionThumbnail,
  getKpiDiarioByProject, getCambioPorcentualByProject,
  saveNarrativesFromAnalysis, getNarrativesByProject, getNarrativeById, getMentionsWithRawJsonByProject,
  getNssPorNarrativaByProject, getNssPorNarrativaForUser,
  getAnalysesJsonForUser,
  saveAlertsFromAnalysis, getAlertsByProject, getAlertEvidence,
  saveMonitoringSettings, getMonitoringSettings,
  createUser, getUsers, getUserById, updateUser, archiveUser,
  saveAmplifiers, getAmplifiersByProject,
  getAnalysesWithJsonByProject, clearAmplifiersByProject,
  getProjectMembers, upsertProjectMember, removeProjectMember,
  getProjectsForUser, getUserProjectIds,
  getAllMentionsForUser, getAllNarrativesForUser, getAllAlertsForUser,
  getAllAmplifiersForUser, getAllAnalysesForUser,
  getRssFeedsByProject, addRssFeed, removeRssFeed,
  getRecentRssMentions,
  isUrlIngested, logIngestion, saveMentionRaw,
  seedDefaultRules, getAllAlertRulesForProject, upsertAlertRule,
  createCustomAlertRule, getCustomAlertRules, getCustomAlertRuleById, updateCustomAlertRule, deleteCustomAlertRule,
  getAmplifiersStats,
  updateUserProfile, updateUserPassword,
  searchMentions,
  getOrgIdForUser, createOrganization, getOrganizationById, getOrgMaxProjects,
  getAllOrganizations, updateOrganization, registrarDescargaInfografia, registrarDescargaReportePdf,
  createPasswordResetToken, getValidResetToken, consumeResetToken,
  saveDemoRequest,
  createSession, getSessionUser, deleteSession,
  startAnalysisRun, logAnalysisRunStep, finishAnalysisRun,
  getAnalysisRunsByProject, getAnalysisRunSteps,
  getLatestAnalysisForProject, getCachedSearch, saveCachedSearch,
  saveUsageLog, countAnalysesLast24h, getUsageSummary,
  createSupportTicket, getSupportTicketsByUser, getSupportTicketsByOrg, getSupportTicketById, resolveSupportTicket,
  createPendingProfileAction, getPendingProfileAction, consumePendingProfileAction,
} from "./db.js";
import { ingestProject, buildRssContext, googleNewsUrl, fetchLiveNewsForTopic, fetchYouTubeForTopic, fetchGdeltForTopic, fetchWebSearchForTopic, fetchSocialWebForTopic, fetchBraveWebForTopic, fetchBraveSocialForTopic, fetchSerpApiSocialForTopic, fetchSocialCrawlForTopic, fetchHidalgoMediaForTopic, fetchTwitterForTopic, fetchPerplexityForTopic, backfillPublicationUrls, mergeGroundingIntoPublications, obtenerYResetearUsoRelevanciaIA } from "./rss-ingestor.js";
import { reportarFalloProveedor } from "./provider-health.js";
import { generateProjectPDF } from "./pdf-generator.js";
import { evaluateAlertRules, DEFAULT_RULES } from "./alert-engine.js";
import {
  enviarCorreoRecuperacion, enviarNotificacionDemo, enviarCodigoOtp, enviarSolicitudFacturacion,
  enviarNotificacionCambioPassword, enviarSolicitudCambioCorreo, enviarNotificacionEliminacionCuenta,
  enviarSolicitudTraspaso, enviarCorreoBienvenida, describirDispositivo, ubicacionAproximada,
  enviarNotificacionTicketCreado, enviarNotificacionTicketResuelto, enviarConfirmacionDemo,
} from "./mailer.js";
import { agendarDemoReal } from "./google-calendar.js";
import { clasificarMencionesPendientes } from "./sentiment-classifier.js";
import { generarResumenPanel } from "./resumen-ia-panel.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
// nginx es el único proxy delante de este proceso (1 salto) — sin esto,
// express-rate-limit rechaza cada request con ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// porque no confía en el X-Forwarded-For que nginx sí agrega correctamente.
app.set("trust proxy", 1);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
// Límite por defecto de express.json() es 100kb — insuficiente para la imagen
// de proyecto (dataURL base64, hasta ~2.7MB tras el cap de 2MB en el frontend).
app.use(express.json({ limit: "6mb" }));

// Miniaturas de TikTok/Instagram descargadas una sola vez (ver
// descargarYCachearImagen en rss-ingestor.js) — las URLs originales del CDN
// expiran en horas, estas quedan fijas en nuestro propio dominio.
app.use("/media-cache", express.static(path.join(process.cwd(), "media-cache")));

// ─── Rate limiting ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,                   // máx 10 intentos por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Demasiados intentos. Espera 15 minutos." },
});

// Búsqueda en vivo (Monitoreo → Búsqueda): las 7 fuentes son gratis/baratas,
// más generoso. El análisis con IA (gpt-4o) sí cuesta tokens reales por
// llamada — más estricto para no dejar la caja abierta a un loop de clics.
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Demasiadas búsquedas. Espera unos minutos." },
});
const searchAnalyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Demasiados análisis con IA. Espera unos minutos." },
});

// ─── Mailer ────────────────────────────────────────────────────────────────────
export async function sendAlertEmail({ to, projectName, alertTitle, riskLevel }) {
  if (!process.env.BREVO_API_KEY) return;
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": process.env.BREVO_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: "Sentiment Unicornio", email: process.env.MAIL_FROM_EMAIL },
        to: [{ email: to }],
        subject: `[${riskLevel}] Alerta en ${projectName}: ${alertTitle}`,
        htmlContent: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
            <h2 style="color:#e53e3e">⚠️ Alerta estratégica detectada</h2>
            <p><strong>Proyecto:</strong> ${projectName}</p>
            <p><strong>Alerta:</strong> ${alertTitle}</p>
            <p><strong>Nivel de riesgo:</strong> <span style="color:#e53e3e;font-weight:bold">${riskLevel}</span></p>
            <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
            <p style="font-size:12px;color:#999">Sentiment Unicornio · sentimentunicornio.com</p>
          </div>`,
      }),
    });
    const json = await res.json();
    if (!res.ok) console.error("[Brevo] Error:", json);
  } catch(e) {
    console.error("[Mailer] Error al enviar email:", e.message);
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Sentiment API funcionando correctamente",
    openai_key_loaded: Boolean(process.env.OPENAI_API_KEY),
  });
});

// ─── Mock analyze (no AI credits) ─────────────────────────────────────────────
app.post("/api/analyze", (req, res) => {
  const { topic } = req.body;
  if (!topic || topic.trim().length < 3) {
    return res.status(400).json({ ok: false, error: "Debes enviar un tema válido." });
  }
  res.json({
    ok: true,
    data: {
      topic,
      status: "prototipo local sin consumo de créditos",
      risk_level: "Alto",
      total_mentions: 128430,
      estimated_reach: "4.8M",
      sentiment: { positive: 32.8, negative: 41.6, neutral: 25.6 },
      executive_summary:
        "Esta es una respuesta simulada para validar que el dashboard puede conectarse al backend antes de consumir créditos de IA.",
    },
  });
});

// Ejes temáticos fijos — antes cada corrida (cron cada 2h) dejaba que gpt-4o
// inventara el nombre de cada narrativa libremente ("desglosa en ángulos
// concretos y diferenciados"), sin memoria entre corridas. Con el tiempo eso
// acumulaba narrativas casi idénticas con redacciones distintas ("Demagogia
// ambiental crítica de X", "Críticas por demagogia Y", "Demagogia ambiental"),
// y como el NSS por tema agrupa por el texto EXACTO del nombre, cada una
// aparecía como una barra separada en vez de una sola consolidada. La
// narrativa específica sigue existiendo en "name" (detalle real, sin perder
// riqueza) — "axis" es solo la categoría fija a la que se agrupa para el
// gráfico, así que "Demagogia ambiental crítica de X" y "Críticas por
// demagogia Y" caen bajo el mismo eje aunque su nombre siga siendo distinto.
const EJES_TEMATICOS = [
  "Legislación y políticas públicas",
  "Corrupción e irregularidades",
  "Gestión de crisis",
  "Imagen y reputación",
  "Logros y reconocimientos",
  "Críticas de oposición y prensa",
  "Seguridad y riesgo social",
  "Economía e impacto social",
  "Otro",
];

// ─── Shared: run live AI analysis ─────────────────────────────────────────────
async function runLiveAnalysis(topic, rssContext = null) {
  const hasRealData = rssContext && rssContext.length > 0;

  const contextBlock = hasRealData ? `
MENCIONES REALES RECIENTES ENCONTRADAS (datos verificados de medios):
${rssContext}

Analiza estas menciones reales como base principal de tu análisis.
` : "";

  const prompt = `
Rol: Eres un Data Analyst enfocado a mediciones de reputación digital y marketing digital. Tu tono es analítico, profesional y directo — estructurado para una lectura rápida por directivos o clientes. No te limites a leer números: acompáñalos de una interpretación breve ("demuestra un esfuerzo significativo", "indica la necesidad de vigilar la narrativa crítica"). Cuando compares cifras, prioriza el contraste (porcentajes, "más del doble", "cayó X puntos") — pero ÚNICAMENTE si ese contraste viene de datos reales que se te dieron; si no tienes un período anterior real con el que comparar, describe el período actual en términos absolutos, nunca inventes un cambio porcentual.

Analiza la conversación pública${hasRealData ? " basándote en las menciones reales proporcionadas" : " en internet"} sobre este tema:

"${topic}"
${contextBlock}
Reglas obligatorias:
- ${hasRealData ? "Basa tu análisis principalmente en las menciones reales proporcionadas arriba." : "Busca señales recientes en medios digitales, redes sociales, portales de noticias, radio local y televisión local."}
- No afirmes que el tema sea verdadero si no hay evidencia suficiente.
- Trátalo como narrativa monitoreada, conversación pública, acusación o tema en verificación.
- Si no encuentras suficiente evidencia pública, dilo de forma clara.
- Devuelve únicamente JSON válido.
- No uses bloques de código.
- Todo en español.
- "resumen_titular" y "executive_summary" sí pueden usar **negrita** (doble asterisco) alrededor de las cifras reales clave (ej. "**1,127** menciones", "**27%** positivo") — es el único uso de Markdown permitido, en ningún otro campo.

Estructura exacta de salida:

{
  "topic": "${topic}",
  "status": "",
  "risk_level": "Bajo | Medio | Alto | Crítico",
  "total_mentions": 0,
  "estimated_reach": "",
  "sentiment": {
    "positive": 0,
    "negative": 0,
    "neutral": 0
  },
  "sources_distribution": [
    {
      "source": "",
      "percentage": 0,
      "dominant_sentiment": ""
    }
  ],
  "narratives": [
    {
      "name": "",
      "axis": "",
      "mentions": "",
      "sentiment": "Positivo | Negativo | Neutral",
      "risk": "",
      "trend": ""
    }
  ],
  "relevant_publications": [
    {
      "date": "",
      "source": "",
      "channel": "",
      "detected_narrative": "",
      "type": "",
      "sentiment": "Positivo | Negativo | Neutral",
      "estimated_reach": "Local | Regional | Nacional",
      "risk": "",
      "url": ""
    }
  ],
  "alerts": [],
  "hashtags": [],
  "resumen_titular": "",
  "executive_summary": "",
  "recommendations": []
}

Criterios:
- "resumen_titular" es UN titular corto (una línea, estilo editorial) que resuma el hallazgo principal — ej. "Conversación en aumento, sentimiento mixto, riesgo reputacional bajo vigilancia." No es un título genérico del tema, es la lectura de los datos.
- "executive_summary" es el párrafo de Visión General: resume con las cifras reales (total_mentions, el desglose de sentiment, estimated_reach) qué tan fuerte es la conversación y si hay riesgo reputacional — en 3-5 oraciones, con las cifras clave en **negrita**.
- total_mentions puede ser una estimación conservadora si no hay conteo público verificable.
- estimated_reach mide ÚNICAMENTE alcance geográfico de la publicación y debe ser exactamente uno de: "Local", "Regional" o "Nacional". No uses números, porcentajes, ni niveles de intensidad (nunca "Alto"/"Medio"/"Bajo" ahí — eso es "risk", un campo aparte).
- El "sentiment" de cada narrativa y de cada publicación en relevant_publications debe ser EXACTAMENTE una de estas tres palabras: "Positivo", "Negativo" o "Neutral". No uses variantes como "Muy negativo", "negativo" en minúsculas, "Predominantemente negativo", etc.
- Los porcentajes de sentiment deben sumar 100.
- El campo "url" de cada publicación en relevant_publications debe ser el ENLACE EXACTO al artículo real, copiado tal cual de las menciones reales proporcionadas arriba (si las hay). NUNCA construyas ni adivines una URL a partir del nombre del medio (ej. jamás pongas "https://www.elsoldemexico.com.mx" o cualquier dominio raíz como si fuera el artículo). Si no tienes la URL exacta de esa nota, deja "url" como cadena vacía "" — un campo vacío es preferible a un enlace inventado que no lleva a la nota real.
- narratives debe incluir ENTRE 5 Y 8 narrativas distintas, no 2 o 3. Desglosa la conversación en ángulos concretos y diferenciados (ej. acusación específica, defensa de simpatizantes, cobertura periodística neutral, dudas sobre veracidad, comparación con otros actores, reacción de oposición, tema económico/social relacionado, reacción en medios locales vs. nacionales, etc.), no la resumas en categorías genéricas. Si las menciones reales proporcionadas no alcanzan para 5 narrativas distintas, complementa con ángulos plausibles de la conversación pública sobre el tema, dejando claro en el resumen ejecutivo que parte es inferencia razonada.
- "axis" de cada narrativa debe ser EXACTAMENTE uno de estos ejes temáticos fijos (cópialo tal cual, sin inventar variantes): ${EJES_TEMATICOS.map((e) => `"${e}"`).join(", ")}. "name" sigue siendo el ángulo específico y descriptivo de esa narrativa (esto no cambia); "axis" es solo la categoría fija a la que pertenece, para poder comparar el mismo eje a través del tiempo aunque el nombre específico cambie entre corridas. Si ninguno encaja bien, usa "Otro".
- El resumen ejecutivo debe explicar qué se encontró, qué tan fuerte parece la conversación y si hay riesgo reputacional.
- hashtags debe contener entre 3 y 8 hashtags REALES y específicos de este tema (basados en el nombre del tema, las narrativas detectadas y los actores mencionados). Nunca devuelvas hashtags de ejemplo ni de otro tema distinto al analizado. Si de verdad no encuentras hashtags usados en redes, genera hashtags razonables a partir del tema y las narrativas (ej. "${topic}" → "#${topic.replace(/\s+/g, "")}"). No lo dejes vacío.
`;

  const response = await openai.responses.create({
    model: "gpt-4o",
    tools: [{ type: "web_search" }],
    input: prompt,
  });

  const text = response.output_text;
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    // gpt-4o a veces mete saltos de línea/tabs sin escapar dentro de un
    // string del JSON (ej. dentro de executive_summary) — eso es inválido
    // y tronaba JSON.parse con "Bad control character in string literal".
    // Los caracteres de control no aportan nada al contenido real, así que
    // se reemplazan por un espacio en vez de descartar todo el análisis.
    .replace(new RegExp("[\x00-\x1F]+", "g"), " ")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // gpt-4o a veces responde con texto normal ("Lo siento, no puedo...")
    // en vez del JSON pedido — pasa sobre todo en temas políticamente
    // sensibles. Sin este catch, el error de JSON.parse ("Unexpected
    // token...") no decía nada sobre la causa real; ahora queda el
    // principio de la respuesta real en el log para poder diagnosticarlo.
    console.error(`[GPT] Respuesta no-JSON para "${topic}":`, cleaned.slice(0, 300));
    throw new Error(
      `La IA no devolvió un análisis estructurado para este tema (posible rechazo de contenido). Intenta de nuevo — respuesta real: "${cleaned.slice(0, 150)}"`,
    );
  }

  if (!Array.isArray(parsed.hashtags) || parsed.hashtags.length === 0) {
    parsed.hashtags = deriveHashtagsFallback(topic, parsed.narratives);
  }

  parsed._usage = {
    model: "gpt-4o",
    input_tokens: response.usage?.input_tokens ?? null,
    output_tokens: response.usage?.output_tokens ?? null,
  };

  return parsed;
}

// ─── Respaldo determinístico de hashtags cuando la IA los deja vacíos ─────────
function toHashtag(text) {
  const words = String(text || "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  const tag = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return tag ? `#${tag}` : null;
}

function deriveHashtagsFallback(topic, narratives = []) {
  const stopwords = new Set(["de", "la", "el", "los", "las", "en", "y", "del", "con", "para", "por", "un", "una", "al"]);
  const tags = new Set();

  const topicTag = toHashtag(topic);
  if (topicTag) tags.add(topicTag);

  for (const w of String(topic || "").split(/\s+/)) {
    if (tags.size >= 4) break;
    if (stopwords.has(w.toLowerCase()) || w.length < 3) continue;
    const t = toHashtag(w);
    if (t) tags.add(t);
  }

  for (const n of (narratives || [])) {
    if (tags.size >= 8) break;
    const t = toHashtag(n?.name);
    if (t) tags.add(t);
  }

  return Array.from(tags).slice(0, 8);
}

// ─── Amplifier extractor ──────────────────────────────────────────────────────
function extractAmplifiersFromAnalysis(data) {
  const results = [];
  const globalSeen = new Set();

  function detectPlatform(url, channelHint, nameHint) {
    const u = String(url || "").toLowerCase();
    if (u.includes("twitter.com") || u.includes("x.com"))     return "X";
    if (u.includes("facebook.com"))                            return "Facebook";
    if (u.includes("instagram.com"))                           return "Instagram";
    if (u.includes("tiktok.com"))                              return "TikTok";
    if (u.includes("youtube.com") || u.includes("youtu.be"))   return "YouTube";
    if (u.includes("linkedin.com"))                            return "LinkedIn";
    if (u.includes("telegram.me") || u.includes("t.me"))       return "Telegram";
    if (u.match(/^https?:\/\//))                               return "Noticias/Web";
    const c = String(channelHint || "").toLowerCase();
    if (/twitter|^x$/.test(c))                return "X";
    if (/facebook/.test(c))                   return "Facebook";
    if (/instagram/.test(c))                  return "Instagram";
    if (/tiktok/.test(c))                     return "TikTok";
    if (/youtube/.test(c))                    return "YouTube";
    if (/linkedin/.test(c))                   return "LinkedIn";
    if (/telegram/.test(c))                   return "Telegram";
    if (/radio/i.test(c))                     return "Radio";
    if (/tv|televi/i.test(c))                 return "TV";
    if (/web|digital|portal|noticias/.test(c)) return "Noticias/Web";
    const n = String(nameHint || "").toLowerCase();
    if (n.startsWith("@"))                    return "X";
    if (/radio/i.test(n))                     return "Radio";
    if (/\btv\b|televi/i.test(n))             return "TV";
    if (/noticias|portal|diario|periódico|periodico/.test(n)) return "Noticias/Web";
    return null;
  }

  function detectHandle(text) {
    const m = String(text || "").match(/@[\w]{2,}/);
    return m ? m[0] : null;
  }

  function stType(name) {
    const s = String(name || "").toLowerCase();
    if (/radio|tv\b|televi|canal\s*\d|noticias|diario|peri[oó]dico|news|portal|medios|semanal|semanario|reporte|informe/.test(s)) return "Medio";
    if (/twitter|x\.com|facebook|instagram|tiktok|youtube|twitch|@/.test(s)) return "Cuenta social";
    if (/congreso|gobierno|secretar|municipio|ayuntamiento|comisi[oó]n|instituto|ministerio|procurad|fiscalía|fgr|senado/.test(s)) return "Institución";
    if (/periodista|reportero|corresponsal|columnista|dr\.|lic\.|ing\.|mtro\./.test(s)) return "Actor / periodista";
    return "Fuente";
  }

  function mapRole(sentiment, risk) {
    const s = String(sentiment || "").toLowerCase();
    const r = String(risk || "").toLowerCase();
    if (s.includes("negativo") || r.includes("alto") || r.includes("crítico")) return "Amplificador crítico";
    if (s.includes("positivo")) return "Amplificador favorable";
    return "Amplificador informativo";
  }

  function mapRisk(sentiment, explicit) {
    if (explicit) return explicit;
    const s = String(sentiment || "").toLowerCase();
    if (s.includes("negativo")) return "Alto";
    if (s.includes("positivo")) return "Bajo";
    return "Medio";
  }

  function add(name, opts = {}) {
    const key = String(name || "").trim().toLowerCase();
    if (!key || key.length < 2 || globalSeen.has(key)) return null;
    globalSeen.add(key);
    const entry = {
      name:               String(name).trim(),
      source_type:        opts.source_type ?? stType(name),
      role:               opts.role ?? mapRole(opts.dominant_sentiment, opts.risk_level),
      reach:              opts.reach ?? "No estimado",
      mentions_count:     opts.mentions_count ?? 1,
      dominant_sentiment: opts.dominant_sentiment ?? "Neutral",
      risk_level:         mapRisk(opts.dominant_sentiment, opts.risk_level),
      narrative:          opts.narrative ?? null,
      url:                opts.url ?? null,
      platform:           opts.platform ?? null,
      author:             opts.author ?? null,
      handle:             opts.handle ?? null,
      published_at:       opts.published_at ?? null,
      post_url:           opts.post_url ?? null,
      raw_json:           opts.raw_json ?? JSON.stringify(opts),
    };
    results.push(entry);
    return entry;
  }

  for (const s of (data.sources_distribution || [])) {
    if (!s.source) continue;
    const platform = detectPlatform(null, s.channel ?? s.type, s.source);
    const handle   = detectHandle(s.source);
    add(s.source, {
      source_type:        stType(s.source),
      dominant_sentiment: s.dominant_sentiment,
      reach:              s.percentage != null ? `${s.percentage}% del total` : "No estimado",
      mentions_count:     Math.max(1, Math.round((parseFloat(s.percentage) || 1) * 10)),
      platform, author: s.source, handle,
      raw_json: JSON.stringify(s),
    });
  }

  const pubCounts = {};
  for (const p of (data.relevant_publications || [])) {
    const src = (p.source || p.channel || "").trim();
    if (!src) continue;
    const key = src.toLowerCase();
    pubCounts[key] = (pubCounts[key] || 0) + 1;
    const platform   = detectPlatform(p.url, p.channel ?? p.type, src);
    const handle     = detectHandle(src) ?? detectHandle(p.author);
    const existing   = results.find(r => r.name.toLowerCase() === key);
    if (existing) {
      existing.mentions_count = (existing.mentions_count || 1) + 1;
      if (!existing.narrative   && p.detected_narrative) existing.narrative   = p.detected_narrative;
      if (!existing.platform    && platform)              existing.platform    = platform;
      if (!existing.post_url    && p.url)                 existing.post_url    = p.url;
      if (!existing.published_at && p.date)               existing.published_at = p.date;
      if (!existing.handle      && handle)                existing.handle      = handle;
      if (!existing.author      && p.author)              existing.author      = p.author;
    } else {
      add(src, {
        dominant_sentiment: p.sentiment, risk_level: p.risk,
        reach: p.estimated_reach, mentions_count: pubCounts[key],
        narrative: p.detected_narrative, url: p.url, platform,
        author: p.author ?? src, handle,
        published_at: p.date ?? p.published_at ?? null,
        post_url: p.url ?? null, raw_json: JSON.stringify(p),
      });
    }
  }

  for (const fbKey of ["top_sources", "media_sources", "sources", "risk_sources"]) {
    const arr = data[fbKey];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const name = typeof item === "string" ? item : (item.name || item.source || item.media || "");
      if (!name) continue;
      const platform = detectPlatform(item.url, item.channel ?? item.type, name);
      const handle   = detectHandle(name) ?? detectHandle(item.author);
      add(name, typeof item === "object" ? {
        dominant_sentiment: item.sentiment, risk_level: item.risk,
        reach: item.reach ?? item.estimated_reach, platform,
        author: item.author ?? name, handle,
        published_at: item.date ?? item.published_at ?? null,
        post_url: item.url ?? null, raw_json: JSON.stringify(item),
      } : { platform });
    }
  }

  const summary = String(data.executive_summary || "");
  if (summary.length > 20) {
    const pattern = /\b(E-Consulta|Municipios Puebla|Municipios MX|Milenio|El Sol de Puebla|Imagen Radio|Heraldo de México|Reforma|El Universal|La Jornada|Proceso|Expansión|Animal Político|SDP Noticias|Político\.mx|La Silla Rota|Sin Embargo|Reporte Índigo|ChangeX|Aristegui Noticias|Infobae México|El Financiero|El Economista|Forbes México|Excélsior)\b/gi;
    const found = [...new Set((summary.match(pattern) || []).map(m => m.trim()))];
    for (const m of found) {
      add(m, { source_type: "Medio", platform: "Noticias/Web", author: m, raw_json: JSON.stringify({ source: "executive_summary" }) });
    }
  }

  return results;
}

// ─── Live analyze ─────────────────────────────────────────────────────────────
app.post("/api/analyze-live", async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic || topic.trim().length < 3) {
      return res.status(400).json({ ok: false, error: "Debes enviar un tema válido." });
    }
    const [liveNews, liveVideos, liveArchive, liveWeb, liveHidalgo, liveTwitter, livePerplexity] = await Promise.all([
      fetchLiveNewsForTopic(topic.trim()),
      fetchYouTubeForTopic(topic.trim()),
      fetchGdeltForTopic(topic.trim()),
      fetchWebSearchForTopic(topic.trim()),
      fetchHidalgoMediaForTopic(topic.trim()),
      fetchTwitterForTopic(topic.trim()),
      fetchPerplexityForTopic(topic.trim()),
    ]);
    const grounding = [...liveNews, ...liveVideos, ...liveArchive, ...liveWeb, ...liveHidalgo, ...liveTwitter, ...livePerplexity];
    const rssContext = buildRssContext(grounding);
    const data = await runLiveAnalysis(topic.trim(), rssContext);
    backfillPublicationUrls(data, grounding);
    mergeGroundingIntoPublications(data, grounding);
    try {
      const savedId = await saveAnalysis(topic.trim(), data);
      data._id = savedId;
    } catch (dbErr) {
      console.error("Error al guardar en DB:", dbErr.message);
    }
    res.json({ ok: true, data });
  } catch (error) {
    console.error("Error en /api/analyze-live:", error);
    res.status(500).json({ ok: false, error: "No se pudo completar el análisis live.", detail: error.message });
  }
});

// ─── History ──────────────────────────────────────────────────────────────────
app.get("/api/history", async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const { total, rows } = await getHistory(limit, offset);
  res.json({ ok: true, total, limit, offset, data: rows });
});

app.get("/api/history/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "ID inválido." });
  const row = await getAnalysisById(id);
  if (!row) return res.status(404).json({ ok: false, error: "Análisis no encontrado." });
  res.json({ ok: true, data: row });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.put("/api/auth/profile", async (req, res) => {
  if (!req.body) return res.status(400).json({ ok: false, message: "Body requerido." });
  const { user_id, name, email } = req.body;
  if (!user_id) return res.status(400).json({ ok: false, message: "user_id requerido." });
  try {
    const updated = await updateUserProfile(parseInt(user_id), name, email);
    res.json({ ok: true, data: updated });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.put("/api/auth/password", async (req, res) => {
  const { user_id, current_password, new_password } = req.body;
  if (!user_id || !current_password || !new_password)
    return res.status(400).json({ ok: false, message: "Todos los campos son requeridos." });
  if (new_password.length < 6)
    return res.status(400).json({ ok: false, message: "La contraseña debe tener al menos 6 caracteres." });
  const user = await getUserById(parseInt(user_id));
  if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
  const full = await getUserByEmail(user.email);
  if (!full || !(await verifyPassword(current_password, full.password_hash)))
    return res.status(401).json({ ok: false, message: "Contraseña actual incorrecta." });
  await updateUserPassword(parseInt(user_id), new_password);
  res.json({ ok: true, message: "Contraseña actualizada correctamente." });
});

// ─── Perfil: verificación por código (OTP) para acciones sensibles ────────────
// En memoria, no en BD: son códigos de 10 minutos, un reinicio del proceso
// (deploy) los invalida y el usuario simplemente vuelve a pedir uno — no
// justifica una tabla nueva. Limitado a un proceso PM2 (confirmado, no cluster).
const otpEnMemoria = new Map(); // user_id -> { codigo, motivo, expiresAt }
const tokensCambioEnMemoria = new Map(); // token -> { userId, motivo, expiresAt }
const OTP_TTL_MS = 10 * 60 * 1000;
const TOKEN_CAMBIO_TTL_MS = 5 * 60 * 1000;

function generarOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

app.post("/api/perfil/otp/enviar", loginLimiter, async (req, res) => {
  const userId = parseInt(req.body.user_id);
  const motivo = req.body.motivo || "verificar tu identidad";
  if (!userId) return res.status(400).json({ ok: false, message: "user_id requerido." });
  const user = await getUserById(userId);
  if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
  const codigo = generarOtp();
  otpEnMemoria.set(userId, { codigo, motivo, expiresAt: Date.now() + OTP_TTL_MS });
  const { enviado } = await enviarCodigoOtp(user.email, user.name, codigo, motivo);
  res.json({ ok: true, data: { enviado, message: enviado ? "Código enviado a tu correo." : "SMTP no configurado — revisa el log del servidor." } });
});

// Verificar el código no basta por sí solo para autorizar el cambio: emite un
// token de cambio de un solo uso (5 min) que las acciones sensibles de abajo
// exigen — así ningún endpoint sensible confía en "ya se llamó a verificar"
// implícitamente, cada uno valida su propio token.
app.post("/api/perfil/otp/verificar", async (req, res) => {
  const userId = parseInt(req.body.user_id);
  const codigo = String(req.body.codigo || "");
  const guardado = otpEnMemoria.get(userId);
  if (!guardado || guardado.expiresAt < Date.now())
    return res.status(400).json({ ok: false, message: "Código vencido, solicita uno nuevo." });
  if (guardado.codigo !== codigo)
    return res.status(400).json({ ok: false, message: "Código incorrecto." });
  otpEnMemoria.delete(userId);
  const tokenCambio = randomToken();
  tokensCambioEnMemoria.set(tokenCambio, { userId, motivo: guardado.motivo, expiresAt: Date.now() + TOKEN_CAMBIO_TTL_MS });
  res.json({ ok: true, data: { tokenCambio } });
});

function randomToken() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

function consumirTokenCambio(userId, token) {
  const guardado = tokensCambioEnMemoria.get(token);
  if (!guardado || guardado.expiresAt < Date.now() || guardado.userId !== userId) return false;
  tokensCambioEnMemoria.delete(token);
  return true;
}

// Cambio de correo: exige el token de cambio emitido por /otp/verificar.
// Cambio de correo por link mágico: NO aplica el cambio aquí — solo crea la
// solicitud pendiente (24h) y manda el correo real de confirmación al correo
// NUEVO (el clic prueba que el usuario sí lo controla, algo que el OTP al
// correo viejo nunca verificaba). El cambio real se aplica en
// GET /api/perfil/confirmar cuando el usuario da clic.
app.post("/api/perfil/correo/solicitar", async (req, res) => {
  const userId = parseInt(req.body.user_id);
  const nuevoCorreo = (req.body.nuevo_correo || "").trim().toLowerCase();
  if (!userId || !nuevoCorreo) return res.status(400).json({ ok: false, message: "Datos incompletos." });
  const existente = await getUserByEmail(nuevoCorreo);
  if (existente && existente.id !== userId)
    return res.status(409).json({ ok: false, message: "Ese correo ya está en uso." });
  const user = await getUserById(userId);
  if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
  const { token, expiresAt } = await createPendingProfileAction(userId, "change_email", { newEmail: nuevoCorreo, oldEmail: user.email }, 24);
  res.json({ ok: true, message: `Te mandamos un correo a ${nuevoCorreo} para confirmar el cambio.` });
  const confirmUrl = `${SITE_URL}/api/perfil/confirmar?token=${token}`;
  const expirationDate = expiresAt.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
  enviarSolicitudCambioCorreo(nuevoCorreo, user.name, { oldEmail: user.email, newEmail: nuevoCorreo, confirmUrl, expirationDate })
    .catch((e) => console.error("[perfil] Error enviando solicitud de cambio de correo:", e.message));
});

// Cambio de contraseña vía perfil: exige token de cambio (código enviado al
// correo real del usuario) en vez de la contraseña actual — más fuerte que
// /api/auth/password para este flujo, porque no depende de que quien esté en
// la sesión recuerde la contraseña vieja, solo de tener acceso al correo.
app.post("/api/perfil/password", async (req, res) => {
  const userId = parseInt(req.body.user_id);
  const nuevaPassword = req.body.nueva_password || "";
  if (!userId || !consumirTokenCambio(userId, req.body.token_cambio))
    return res.status(403).json({ ok: false, message: "Verificación inválida o vencida. Solicita un nuevo código." });
  if (nuevaPassword.length < 6)
    return res.status(400).json({ ok: false, message: "La contraseña debe tener al menos 6 caracteres." });
  const user = await getUserById(userId);
  await updateUserPassword(userId, nuevaPassword);
  res.json({ ok: true, message: "Contraseña actualizada correctamente." });
  if (user) {
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
    const hora = ahora.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" });
    const device = describirDispositivo(req.headers["user-agent"]);
    ubicacionAproximada(req.ip)
      .then((location) => enviarNotificacionCambioPassword(user.email, user.name, { device, location, fecha, hora }))
      .catch((e) => console.error("[perfil] Error avisando cambio de contraseña:", e.message));
  }
});

// Eliminar cuenta = archivar (no se borra el historial de menciones/análisis
// del proyecto, solo se desactiva el acceso). Bloqueado si es el único admin
// activo de su organización — misma regla real que ya usa /api/users/:id.
// Exige token de cambio: una acción irreversible no puede depender solo de
// una petición HTTP sin verificación reciente.
app.delete("/api/perfil", async (req, res) => {
  const userId = parseInt(req.body.user_id);
  if (!userId || !consumirTokenCambio(userId, req.body.token_cambio))
    return res.status(403).json({ ok: false, message: "Verificación inválida o vencida. Solicita un nuevo código." });
  const antes = await getUserById(userId);
  const result = await archiveUser(userId);
  if (result?.error) return res.status(400).json({ ok: false, message: result.error });
  await deleteSession(String(req.body.token || "")).catch(() => {});
  res.json({ ok: true });
  if (antes) {
    const fecha = new Date().toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
    const requestId = `DEL-${userId}-${Date.now().toString(36).toUpperCase()}`;
    enviarNotificacionEliminacionCuenta(antes.email, antes.name, { requestId, fecha })
      .catch((e) => console.error("[perfil] Error avisando eliminación de cuenta:", e.message));
  }
});

// Traspasar cuenta = el destinatario (ya existente, misma organización) pasa
// a admin; quien traspasa pasa a editor. No crea usuarios nuevos ni mueve
// nada entre organizaciones — solo redistribuye el rol de admin dentro de la
// misma org, que es lo único que "dueño de la cuenta" significa hoy en el
// modelo de datos real (no hay un campo de "owner" separado).
// Por link mágico, igual que el cambio de correo: NO traspasa aquí, solo
// crea la solicitud pendiente (24h) y manda el correo real de confirmación
// al correo ACTUAL (quien traspasa) — el clic es la confirmación real de que
// sí quiere ceder la administración. El traspaso real ocurre en
// GET /api/perfil/confirmar.
app.post("/api/perfil/traspasar/solicitar", async (req, res) => {
  const userId = parseInt(req.body.user_id);
  const correoDestino = (req.body.correo_destino || "").trim().toLowerCase();
  if (!userId || !correoDestino) return res.status(400).json({ ok: false, message: "Datos incompletos." });
  const actual = await getUserById(userId);
  if (!actual) return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
  if (actual.role !== "admin") return res.status(403).json({ ok: false, message: "Solo un administrador puede traspasar la cuenta." });
  const destino = await getUserByEmail(correoDestino);
  if (!destino || destino.organization_id !== actual.organization_id)
    return res.status(404).json({ ok: false, message: "No existe ese correo dentro de tu organización." });
  const projectCount = await countActiveProjectsByUser(userId);
  const { token, expiresAt } = await createPendingProfileAction(userId, "transfer_account", { newOwnerEmail: destino.email, projectCount }, 24);
  res.json({ ok: true, message: `Te mandamos un correo a ${actual.email} para confirmar el traspaso.` });
  const transferUrl = `${SITE_URL}/api/perfil/confirmar?token=${token}`;
  const expirationDate = expiresAt.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
  enviarSolicitudTraspaso(actual.email, actual.name, { currentEmail: actual.email, newOwnerEmail: destino.email, projectCount, transferUrl, expirationDate })
    .catch((e) => console.error("[perfil] Error enviando solicitud de traspaso:", e.message));
});

// Página mínima, con la misma paleta de marca, que confirma o rechaza un
// link mágico de Perfil (cambio de correo / traspaso). GET porque es lo que
// el cliente de correo abre al dar clic — no puede ser un POST.
function paginaConfirmacion(ok, mensaje) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Unicornio</title>
<style>body{font-family:Inter,Arial,sans-serif;background:#F5F5F5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:8px;padding:40px;max-width:440px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h1{font-size:20px;color:${ok ? "#1F3C7A" : "#DC2626"};margin:0 0 12px}
p{color:#4b4648;font-size:15px;line-height:1.5}
a{color:#0056A4;text-decoration:none;font-weight:700}</style></head>
<body><div class="card"><h1>${ok ? "Listo" : "No se pudo completar"}</h1><p>${mensaje}</p><p><a href="${SITE_URL}/perfil">Ir a mi cuenta</a></p></div></body></html>`;
}

app.get("/api/perfil/confirmar", async (req, res) => {
  const token = String(req.query.token || "");
  const pendiente = await getPendingProfileAction(token);
  if (!pendiente) {
    return res.status(400).send(paginaConfirmacion(false, "Este enlace no es válido o ya venció. Solicita el cambio de nuevo desde tu perfil."));
  }
  await consumePendingProfileAction(token);
  try {
    if (pendiente.action === "change_email") {
      const { newEmail, oldEmail } = pendiente.payload_json;
      const existente = await getUserByEmail(newEmail);
      if (existente && existente.id !== pendiente.user_id) {
        return res.status(409).send(paginaConfirmacion(false, "Ese correo quedó en uso por otra cuenta mientras tanto."));
      }
      await updateUserProfile(pendiente.user_id, undefined, newEmail);
      return res.send(paginaConfirmacion(true, `Tu correo ahora es ${newEmail}. Ya puedes cerrar esta pestaña.`));
    }
    if (pendiente.action === "transfer_account") {
      const { newOwnerEmail } = pendiente.payload_json;
      const destino = await getUserByEmail(newOwnerEmail);
      if (!destino) {
        return res.status(404).send(paginaConfirmacion(false, "No se encontró la cuenta destino. Contacta a soporte."));
      }
      await updateUser(destino.id, { role: "admin" });
      await updateUser(pendiente.user_id, { role: "editor" });
      return res.send(paginaConfirmacion(true, `Listo. La cuenta ahora pertenece a ${destino.email}.`));
    }
    return res.status(400).send(paginaConfirmacion(false, "Acción desconocida."));
  } catch (e) {
    console.error("[perfil/confirmar] Error aplicando la acción:", e.message);
    return res.status(500).send(paginaConfirmacion(false, "Ocurrió un error aplicando el cambio. Contacta a soporte."));
  }
});

// ─── Solicitudes de demo ───────────────────────────────────────────────────────
app.post("/api/demo-requests", async (req, res) => {
  const { nombre, apellidos, telefono, email, comentario } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ ok: false, message: "El nombre es requerido." });
  if (!email?.trim()) return res.status(400).json({ ok: false, message: "El correo es requerido." });
  try {
    const solicitud = await saveDemoRequest({ nombre, apellidos, telefono, email, comentario });
    enviarNotificacionDemo(solicitud).catch((e) => console.error("Error notificando solicitud de demo:", e));
    res.status(201).json({ ok: true, message: "Solicitud recibida. Nos pondremos en contacto contigo pronto." });

    // Agendado automático real (Google Calendar) — si no está configurado,
    // agendarDemoReal regresa null y aquí no pasa nada más (el aviso a
    // soporte de arriba ya cubre el caso "alguien pidió demo").
    const calendarId = process.env.GOOGLE_DEMO_CALENDAR_ID;
    if (calendarId) {
      agendarDemoReal(calendarId, { nombre, email, comentario })
        .then((cita) => {
          if (!cita) return;
          return enviarConfirmacionDemo(email, nombre, cita);
        })
        .catch((e) => console.error("[demo] Error agendando/avisando demo real:", e.message));
    }
  } catch (e) {
    console.error("Error en /api/demo-requests:", e);
    res.status(500).json({ ok: false, message: "No se pudo registrar la solicitud." });
  }
});

// ─── Recuperar contraseña ─────────────────────────────────────────────────────
const SITE_URL = process.env.SITE_URL || "https://sentimentunicornio.com";

app.post("/api/auth/forgot-password", loginLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ ok: false, message: "Correo requerido." });
  // Respuesta genérica siempre — no revela si el correo existe o no.
  const generic = { ok: true, message: "Si el correo existe en nuestro sistema, te enviamos instrucciones para recuperar tu contraseña." };
  try {
    const user = await getUserByEmail(email.trim().toLowerCase());
    if (!user) return res.json(generic);
    const { token } = await createPasswordResetToken(user.id);
    const resetUrl = `${SITE_URL}/recuperar-password?token=${token}`;
    await enviarCorreoRecuperacion(user.email, user.name, resetUrl, 60);
  } catch (e) {
    console.error("Error en /api/auth/forgot-password:", e);
  }
  res.json(generic);
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) return res.status(400).json({ ok: false, message: "Token y nueva contraseña requeridos." });
  if (new_password.length < 8) return res.status(400).json({ ok: false, message: "La contraseña debe tener al menos 8 caracteres." });
  const row = await getValidResetToken(token);
  if (!row) return res.status(400).json({ ok: false, message: "El enlace no es válido o ya expiró. Solicita uno nuevo." });
  await updateUserPassword(row.user_id, new_password);
  await consumeResetToken(token);
  res.json({ ok: true, message: "Contraseña actualizada. Ya puedes iniciar sesión." });
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const { email, password, recordar } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, message: "Email y contraseña requeridos." });
  const user = await getUserByEmail(email.trim().toLowerCase());
  const valid = user && await verifyPassword(password, user.password_hash);
  if (!valid) return res.status(401).json({ ok: false, message: "Credenciales inválidas." });
  if (user.status !== "active") return res.status(403).json({ ok: false, message: "Esta cuenta está desactivada." });
  // Migrar a bcrypt si aún usa sha256
  if (!user.password_hash.startsWith("$2b$") && !user.password_hash.startsWith("$2a$")) {
    updateUserPassword(user.id, password).catch(() => {});
  }
  const { token, expiresAt } = await createSession(user.id, !!recordar);
  res.json({
    ok: true,
    data: {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, organization_id: user.organization_id },
      token,
      expires_at: expiresAt,
    },
  });
});

// Login real con Google — el frontend ya intercambió el código OAuth2 con
// Google y verificó `email_verified:true` antes de llamar aquí (ver
// app/api/auth/google/callback en Next.js). Este endpoint NO crea cuentas
// nuevas: solo abre sesión si el correo YA es un usuario real invitado por un
// admin — evita que cualquiera con cuenta de Google se auto-registre en el
// sistema de un cliente real.
app.post("/api/auth/google", loginLimiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ ok: false, message: "Correo requerido." });
  const user = await getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ ok: false, message: "Esta cuenta de Google no está registrada. Pide a tu administrador que te agregue primero." });
  }
  if (user.status !== "active") return res.status(403).json({ ok: false, message: "Esta cuenta está desactivada." });
  const { token, expiresAt } = await createSession(user.id, true);
  res.json({
    ok: true,
    data: {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, organization_id: user.organization_id },
      token,
      expires_at: expiresAt,
    },
  });
});

// Resuelve un token de sesión a su usuario real — lo llama el frontend Next.js
// desde el servidor (Route Handler / middleware) en cada request, nunca desde
// el navegador directamente.
app.get("/api/auth/session", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ ok: false, message: "Sin token." });
  const user = await getSessionUser(String(token));
  if (!user) return res.status(401).json({ ok: false, message: "Sesión inválida o vencida." });
  res.json({ ok: true, data: user });
});

app.post("/api/auth/logout", async (req, res) => {
  const { token } = req.body || {};
  if (token) await deleteSession(String(token));
  res.json({ ok: true });
});

// ─── Projects ─────────────────────────────────────────────────────────────────
app.get("/api/projects", async (req, res) => {
  const userId = parseInt(req.query.user_id);
  const role   = req.query.role;
  if (userId && role) {
    const projects = await getProjectsForUser(userId, role);
    const maxP = await getOrgMaxProjects(userId);
    return res.json({ ok: true, data: projects, max_projects: maxP });
  }
  const demo = await getOrCreateDemoUser();
  const projects = await getProjectsForUser(demo.id, "admin");
  const maxP = await getOrgMaxProjects(demo.id);
  res.json({ ok: true, data: projects, max_projects: maxP });
});

app.post("/api/projects", async (req, res) => {
  const userId = parseInt(req.body.user_id) || (await getOrCreateDemoUser()).id;
  const active = await countActiveProjectsByUser(userId);
  const maxP   = await getOrgMaxProjects(userId);
  if (active >= maxP) return res.status(400).json({ ok: false, message: `Límite alcanzado: máximo ${maxP} proyectos activos.` });
  const { name, description, main_topic, region, language, image_url, project_type, country_code } = req.body;
  if (!name || !main_topic) return res.status(400).json({ ok: false, message: "Nombre y tema principal requeridos." });
  const project = await createProject(userId, { name, description, main_topic, region, language, image_url, project_type, country_code });
  await seedDefaultRules(project.id, DEFAULT_RULES);
  res.status(201).json({ ok: true, data: project });

  // Auto-análisis en segundo plano — dentro de este mismo proceso Express
  // (no un fetch de vuelta desde Next.js a sí mismo), así sobrevive aunque
  // el request que creó el proyecto ya haya terminado. Ver runProjectAnalysisPipeline.
  runProjectAnalysisPipeline(project.id, null, "auto_create").catch((e) => {
    console.error(`[auto-analyze] proyecto ${project.id} (${project.name}):`, e.message);
  });
});

app.get("/api/projects/:id", async (req, res) => {
  const project = await getProjectById(parseInt(req.params.id));
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  res.json({ ok: true, data: project });
});

app.put("/api/projects/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const project = await getProjectById(id);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  const updated = await updateProject(id, req.body);
  res.json({ ok: true, data: updated });
});

app.delete("/api/projects/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const project = await getProjectById(id);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  await deleteProject(id);
  res.json({ ok: true, message: "Proyecto archivado." });
});

// ─── Project sub-resources ────────────────────────────────────────────────────
// Incluye response_json (el análisis completo que escribió la IA: resumen
// ejecutivo, recomendaciones, narrativas) — nada en el frontend consumía este
// endpoint todavía, así que no hay riesgo de romper un uso existente que
// esperara la forma ligera.
app.get("/api/projects/:id/analyses", async (req, res) => {
  res.json({ ok: true, data: await getAnalysesWithJsonByProject(parseInt(req.params.id)) });
});

app.get("/api/projects/:id/mentions", async (req, res) => {
  res.json({ ok: true, data: await getMentionsByProject(parseInt(req.params.id)) });
});

// Fase 4/5 (arquitectura Luis v2) — expone v_kpi_proyecto_dia/v_cambio_porcentual
// directamente. Nuevo, todavía sin consumidor en el frontend (esa migración
// widget por widget es un trabajo aparte, ver project-migracion-vistas-luis).
app.get("/api/projects/:id/kpi-diario", async (req, res) => {
  res.json({ ok: true, data: await getKpiDiarioByProject(parseInt(req.params.id)) });
});

app.get("/api/projects/:id/cambio-porcentual", async (req, res) => {
  const dias = parseInt(req.query.dias) || 30;
  res.json({ ok: true, data: await getCambioPorcentualByProject(parseInt(req.params.id), dias) });
});

// Reparar la miniatura de una mención puntual (ej. link de TikTok/Instagram
// ya vencido) — pensado para el backfill de menciones viejas y para
// reintentos manuales, no para el flujo normal de ingesta.
app.put("/api/mentions/:id/thumbnail", async (req, res) => {
  const { thumbnail_url } = req.body;
  if (!thumbnail_url) return res.status(400).json({ ok: false, message: "thumbnail_url requerido." });
  const data = await updateMentionThumbnail(parseInt(req.params.id), thumbnail_url);
  res.json({ ok: true, data });
});

app.get("/api/projects/:id/narratives", async (req, res) => {
  res.json({ ok: true, data: await getNarrativesByProject(parseInt(req.params.id)) });
});

app.get("/api/projects/:id/nss-por-narrativa", async (req, res) => {
  const { inicio, fin } = req.query;
  const rango = inicio && fin ? { inicio, fin } : null;
  res.json({ ok: true, data: await getNssPorNarrativaByProject(parseInt(req.params.id), rango) });
});

// ─── Menciones reales detrás de una narrativa ─────────────────────────────
// Solo las menciones que la IA citó explícitamente en relevant_publications
// llevan detected_narrative (ver saveMentionsFromAnalysis) — las que solo
// vinieron de la ingesta en vivo no se asociaron a ninguna narrativa
// específica. Un conteo chico o en cero es honesto, no un error.
// Acotado a los últimos 30 días (2026-10-02, mismo pedido que
// getAlertEvidence en db.js): sin esto, un "detected_narrative" exacto podía
// coincidir con una mención de años atrás (el mismo título de narrativa
// puede repetirse) y mostrarse como si fuera evidencia actual.
const DÍAS_MÁXIMOS_EVIDENCIA_NARRATIVA = 30;
app.get("/api/narratives/:id/mentions", async (req, res) => {
  const narrativeId = parseInt(req.params.id);
  const narrative = await getNarrativeById(narrativeId);
  if (!narrative) return res.status(404).json({ ok: false, message: "Narrativa no encontrada." });

  const corteFecha = new Date(Date.now() - DÍAS_MÁXIMOS_EVIDENCIA_NARRATIVA * 24 * 60 * 60 * 1000);
  const candidatas = await getMentionsWithRawJsonByProject(narrative.project_id);
  const nombreObjetivo = String(narrative.name || "").trim().toLowerCase();
  const menciones = candidatas.filter((m) => {
    if (!m.published_at || new Date(m.published_at) < corteFecha) return false;
    try {
      const pub = JSON.parse(m.raw_json);
      const detectada = String(pub.detected_narrative || "").trim().toLowerCase();
      return detectada && detectada === nombreObjetivo;
    } catch {
      return false;
    }
  });

  res.json({ ok: true, data: { narrative, mentions: menciones } });
});

// ─── Hashtags reales por frecuencia entre análisis ─────────────────────────
// gpt-4o ya genera hashtags reales y específicos en cada análisis (ver
// prompt) — no hay tabla dedicada, se agregan aquí desde response_json. Se
// pondera por el total_mentions real de cada análisis (no +1 por aparición):
// casi nunca dos análisis distintos repiten el mismo hashtag exacto, así que
// contar apariciones dejaba a todos con el mismo valor mínimo y el mismo
// tamaño en la nube — el volumen real de menciones detrás de cada uno sí
// varía y es el dato honesto para el tamaño relativo.
function agregarHashtagsDesdeAnalisis(filas) {
  const conteo = new Map();
  for (const fila of filas) {
    let data;
    try { data = JSON.parse(fila.response_json); } catch { continue; }
    if (!Array.isArray(data.hashtags)) continue;
    const peso = Number(fila.total_mentions) > 0 ? Number(fila.total_mentions) : 1;
    for (const tag of data.hashtags) {
      const limpio = String(tag || "").trim();
      if (!limpio) continue;
      conteo.set(limpio, (conteo.get(limpio) ?? 0) + peso);
    }
  }
  // Antes topaba en 15 — con varios análisis reales acumulados por proyecto
  // (cada uno trae 3-8 hashtags reales de gpt-4o) hay bastantes más
  // distintos que eso, se estaban quedando fuera sin necesidad.
  return Array.from(conteo.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([hashtag, total]) => ({ hashtag, total }));
}

app.get("/api/projects/:id/hashtags", async (req, res) => {
  const filas = await getAnalysesWithJsonByProject(parseInt(req.params.id));
  res.json({ ok: true, data: agregarHashtagsDesdeAnalisis(filas) });
});

app.get("/api/all-hashtags", async (req, res) => {
  const u = await resolveUser(req.query);
  const filas = await getAnalysesJsonForUser(u.userId, u.role);
  res.json({ ok: true, data: agregarHashtagsDesdeAnalisis(filas) });
});

// Menciones reales detrás de un hashtag: el hashtag es un dato a nivel de
// análisis, no de publicación (ver agregarHashtagsDesdeAnalisis), así que la
// evidencia real posible es "las menciones que vinieron del mismo análisis
// que generó ese hashtag" — no existe un vínculo publicación-por-hashtag más
// fino que ese en los datos que devuelve gpt-4o.
app.get("/api/projects/:id/hashtags/:tag/mentions", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const tagBuscado = decodeURIComponent(req.params.tag).trim().toLowerCase().replace(/^#/, "");
  const [analisis, menciones] = await Promise.all([
    getAnalysesWithJsonByProject(projectId),
    getMentionsWithRawJsonByProject(projectId),
  ]);
  const idsAnalisis = new Set();
  for (const fila of analisis) {
    let data;
    try { data = JSON.parse(fila.response_json); } catch { continue; }
    if (!Array.isArray(data.hashtags)) continue;
    const coincide = data.hashtags.some(
      (tag) => String(tag || "").trim().toLowerCase().replace(/^#/, "") === tagBuscado,
    );
    if (coincide) idsAnalisis.add(fila.id);
  }
  const coincidentes = menciones.filter((m) => idsAnalisis.has(m.analysis_id));
  res.json({ ok: true, data: coincidentes });
});

app.get("/api/projects/:id/alerts", async (req, res) => {
  res.json({ ok: true, data: await getAlertsByProject(parseInt(req.params.id)) });
});

// Notas reales detrás de cualquiera de las 6 alertas automáticas (2026-10-02,
// pedido de Darinka) — el despacho por tipo vive en getAlertEvidence (db.js).
app.get("/api/alerts/:id/evidencia", async (req, res) => {
  const alertId = parseInt(req.params.id);
  const mentions = await getAlertEvidence(alertId);
  if (mentions === null) return res.status(404).json({ ok: false, message: "Alerta no encontrada." });
  res.json({ ok: true, data: { mentions } });
});

app.get("/api/projects/:id/amplifiers", async (req, res) => {
  res.json({ ok: true, data: await getAmplifiersByProject(parseInt(req.params.id)) });
});

app.get("/api/projects/:id/settings", async (req, res) => {
  res.json({ ok: true, data: await getMonitoringSettings(parseInt(req.params.id)) });
});

app.post("/api/projects/:id/settings", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  const settings = await saveMonitoringSettings(projectId, req.body);
  res.json({ ok: true, data: settings });
});

// ─── Project analyze ──────────────────────────────────────────────────────────
// Extraído a función nombrada para poder llamarlo desde dos lugares sin pasar
// por HTTP: (a) el endpoint manual de abajo, y (b) el auto-análisis al crear
// un proyecto (ver /api/projects POST). Antes ese auto-análisis se disparaba
// desde el frontend Next.js con un `fetch` sin esperar la respuesta — un
// patrón frágil: si el contexto de esa request de Next.js se cierra antes de
// que el fetch termine, la llamada se pierde sin ningún error visible en
// ningún lado. Llamar esta función directamente, dentro del mismo proceso
// Express que ya vive corriendo indefinidamente, elimina ese riesgo por
// completo. Cada paso queda en `analysis_runs`/`analysis_run_steps`
// (Postgres, sobrevive restarts) — así un fallo se puede diagnosticar
// después aunque los logs de PM2 ya se hayan perdido.
async function runProjectAnalysisPipeline(projectId, topicOverride, trigger) {
  const runId = await startAnalysisRun(projectId, trigger);
  try {
    const project = await getProjectById(projectId);
    if (!project) throw new Error("Proyecto no encontrado.");
    const topic = (topicOverride || project.main_topic || "").trim();
    if (!topic || topic.length < 3) throw new Error("Tema inválido.");

    // Límite diario — la columna existe en monitoring_settings desde hace
    // tiempo pero nunca se leía. Si el proyecto no tiene fila propia todavía,
    // se usa el default real de la columna (20), no "sin límite".
    const settings = await getMonitoringSettings(projectId);
    const limiteDiario = settings?.daily_query_limit ?? 20;
    const corridasHoy = await countAnalysesLast24h(projectId);
    if (corridasHoy >= limiteDiario) {
      throw new Error(`Límite diario de análisis alcanzado para este proyecto (${limiteDiario}/día). Intenta de nuevo mañana.`);
    }

    await logAnalysisRunStep(runId, "start", true, `tema: "${topic}" (${corridasHoy}/${limiteDiario} análisis hoy)`);

    // 1. Ingest RSS first (silent — errors don't block analysis)
    let ingestStats = null;
    try {
      const t0 = Date.now();
      ingestStats = await ingestProject(projectId, project.country_code || "MX");
      await logAnalysisRunStep(runId, "rss_ingest", true, JSON.stringify(ingestStats), ingestStats?.saved ?? 0, Date.now() - t0);
    } catch (e) {
      await logAnalysisRunStep(runId, "rss_ingest", false, e.message);
    }

    // 2. Get recent RSS-ingested mentions for AI context
    let groundingItems = [];
    try {
      const recentMentions = await getRecentRssMentions(projectId, 48);
      if (recentMentions.length > 0) groundingItems.push(...recentMentions);
    } catch (e) {
      await logAnalysisRunStep(runId, "rss_context", false, e.message);
    }

    // 2b. SIEMPRE complementar con búsquedas en vivo (Google News, YouTube, GDELT,
    // Web Search, medios de Hidalgo) — no solo cuando la ingesta RSS está vacía.
    // Antes esto se saltaba en cuanto había una sola mención ingerida (el auto-feed
    // de Google News casi siempre deja al menos una), lo que dejaba fuentes reales
    // como YouTube completamente sin usar aunque sí tuvieran resultados relevantes.
    const paisProyecto = (project.country_code || "MX").toUpperCase();
    const idiomaProyecto = project.language || "es";

    // Bug real encontrado en vivo: el proyecto tenía 4 palabras clave reales
    // configuradas (ej. "Donald Trump", "@realdonaldtrump", "@potus",
    // "President of the USA") pero SOLO se buscaba con `topic`
    // (project.main_topic) — las otras 3 quedaban guardadas y visibles en la
    // config, pero nunca se usaban para buscar nada. Para Brave/Twitter (que
    // sí soportan "OR" en su sintaxis de búsqueda, igual que Google) se arma
    // una consulta ampliada con todos los alias reales del proyecto — GDELT y
    // Google News se quedan con `topic` solo porque su sintaxis exige frase
    // exacta entre comillas y un OR ahí rompería la búsqueda.
    // Orden por tipo real: "nombre"/"red_social" primero, "busqueda" al
    // final — esta es la categoría de términos institucionales sueltos (ej.
    // "GPO", "CAMe") que causó el caso real de SEMARNAT, así que cuando
    // topicYoutube/construirTopicBrave recortan a un puñado de alias (por
    // los límites reales de esas APIs, ver abajo), prefieren nombres y redes
    // — mucho menos propensos a chocar con contenido ajeno — antes que
    // términos de búsqueda genéricos.
    const PRIORIDAD_TIPO_ALIAS = { nombre: 0, red_social: 1, busqueda: 2 };
    const keywordsProyectoCrudo = (await getProjectKeywords(projectId))
      .filter(k => (k.keyword || "").trim() && k.keyword.trim().toLowerCase() !== topic.toLowerCase());
    const aliasProyecto = keywordsProyectoCrudo
      .sort((a, b) => (PRIORIDAD_TIPO_ALIAS[a.type] ?? 1) - (PRIORIDAD_TIPO_ALIAS[b.type] ?? 1))
      .map(k => k.keyword.trim());
    // Para instagram/search/hashtag (SocialCrawl) — pide el hashtag exacto,
    // no un topic de texto libre. La primera keyword tipo "busqueda" que
    // empiece con # (ver formulario de creación de proyecto, categoría
    // "busqueda" es donde vive esto) — sin # configurado, este motor
    // simplemente no corre para ese proyecto en vez de inventar uno.
    const hashtagInstagramProyecto = keywordsProyectoCrudo
      .find(k => k.type === "busqueda" && k.keyword.trim().startsWith("#"))
      ?.keyword.trim().replace(/^#/, "");
    // Para instagram/profile/posts/full — handles reales tipo "red_social".
    // No todos sirven (ej. "@SEMARNAT_mx" resultó ser su cuenta de X, no de
    // Instagram — probado en vivo, no asumido); cada uno se valida solo al
    // llamarlo (404 → simplemente no aporta nada, sin romper el resto).
    const handlesInstagramProyecto = keywordsProyectoCrudo
      .filter(k => k.type === "red_social")
      .map(k => k.keyword.trim().replace(/^@/, ""));
    // Entre paréntesis: fetchBraveSocialForTopic le pega "site:facebook.com"
    // etc. al final, y sin agrupar el OR quedaría ambiguo sobre a qué término
    // aplica el filtro de sitio.
    const topicAmplio = aliasProyecto.length
      ? `(${topic} OR ${aliasProyecto.map(a => a.includes(" ") ? `"${a}"` : a).join(" OR ")})`
      : topic;

    // YouTube NO soporta la palabra "OR" como operador — según la
    // documentación real (developers.google.com/youtube/v3/docs/search/list)
    // solo reconoce "|" para "o" y "-" para excluir. `topicAmplio` de arriba
    // (pensado para Brave/Google, que sí soportan "OR") le llegaba tal cual a
    // YouTube, que lo trataba como puro texto libre — con muchas palabras
    // clave eso se volvía una bolsa de palabras sin relación real entre sí, y
    // bastaba con que UNA palabra clave corta/ambigua apareciera en cualquier
    // video (aunque no tuviera nada que ver con el proyecto) para que
    // YouTube lo trajera por "relevancia". Caso real que destapó esto:
    // proyecto de SEMARNAT con la palabra clave "GPO" (Gas y Petroquímica de
    // Occidente) trayendo videos del juego de Roblox "Grand Piece Online"
    // (también conocido como GPO), sin relación alguna.
    //
    // El primer intento (mandar CADA alias junto con el tema, unidos por "|"
    // real) se probó en vivo contra la API real y reveló algo no documentado
    // por Google: el número de resultados cae a 0 según crece el número de
    // ramas del "|", sin importar qué tan reales/específicos sean los
    // términos — medido con el proyecto real de SEMARNAT (37 palabras
    // clave): 2 ramas ≈ 4,700 resultados, 4 ramas ≈ 66, 8+ ramas = 0 SIEMPRE.
    // Mandar las 37 completas dejaba la búsqueda de YouTube en cero videos,
    // peor que el bug original. Por eso aquí se manda como máximo el tema
    // principal + 2 alias reales — el techo real medido como estable — y se
    // priorizan los que no son solo una variante de hashtag/mención (esos
    // aportan poco a una búsqueda de video real). El resto de las palabras
    // clave del proyecto se sigue usando completo en Brave/SerpApi/Google
    // News/GDELT, que sí soportan un OR real de muchos términos sin este
    // límite.
    const LÍMITE_ALIAS_YOUTUBE = 2;
    const aliasYoutube = aliasProyecto
      .filter(a => !/^[@#]/.test(a))
      .slice(0, LÍMITE_ALIAS_YOUTUBE);
    const topicYoutube = aliasYoutube.length
      ? [topic, ...aliasYoutube.map(a => `${topic} ${a}`)].join("|")
      : topic;

    // X valida en serio la sintaxis de "@handle" en su query — un usuario
    // real de Twitter mide 1-15 caracteres, solo letras/números/guion bajo.
    // Un alias como "@ClaudiaSheinbaumPardo" (21 caracteres) no es un handle
    // real, y X no lo ignora ni lo trata como texto: rechaza la búsqueda
    // COMPLETA con 400, tirando también los alias buenos. Aquí cada "@algo"
    // que no cumpla la regla real se manda como frase de texto en vez de
    // username — sigue siendo una señal de búsqueda real, solo que no como
    // mención de cuenta.
    const aliasTwitterSeguro = (a) => {
      const m = a.match(/^@([A-Za-z0-9_]{1,15})$/);
      if (m) return `@${m[1]}`;
      const texto = a.replace(/^@/, "");
      return texto.includes(" ") ? `"${texto}"` : texto;
    };
    const topicAmplioTwitter = aliasProyecto.length
      ? `(${topic} OR ${aliasProyecto.map(aliasTwitterSeguro).join(" OR ")})`
      : topic;

    // Brave SÍ soporta "OR" como operador real (a diferencia de YouTube),
    // pero valida un límite duro y real de 75 palabras en el parámetro `q`
    // — confirmado en vivo: con las 37 palabras clave de un proyecto real
    // (SEMARNAT), `topicAmplio` llegaba a 99 palabras y Brave la rechazaba
    // COMPLETA con 422 "Search query must be at most 75 words", dejando
    // esta fuente en 0 para el proyecto entero, en silencio (el error solo
    // queda en el log de PM2, nunca visible en la app — parecía que
    // simplemente "no había nada en redes/web"). SerpApi/Google Custom
    // Search sí toleran la cadena completa sin problema (probado en vivo
    // contra la API real), así que solo Brave necesita su propia versión
    // recortada — las demás fuentes se quedan con `topicAmplio` completo.
    function construirTopicBrave(temaBase, alias) {
      if (!alias.length) return temaBase;
      // Margen bajo el límite real de 75: fetchBraveSocialForTopic le
      // agrega "site:facebook.com" (o instagram/tiktok) al final.
      const MÁXIMO_PALABRAS = 65;
      const incluidos = [];
      for (const a of alias) {
        const prueba = `(${temaBase} OR ${[...incluidos, a].map(x => x.includes(" ") ? `"${x}"` : x).join(" OR ")})`;
        if (prueba.split(/\s+/).length > MÁXIMO_PALABRAS) break;
        incluidos.push(a);
      }
      return incluidos.length
        ? `(${temaBase} OR ${incluidos.map(a => a.includes(" ") ? `"${a}"` : a).join(" OR ")})`
        : temaBase;
    }
    const topicBrave = construirTopicBrave(topic, aliasProyecto);

    const fuentesEnVivo = [
      ["google_news",  () => fetchLiveNewsForTopic(topic, 15, paisProyecto, aliasProyecto)],
      // youtube pide el máximo real de la API (maxResults tope 50 — el costo
      // de cuota es por llamada, no por resultado, así que no cuesta más);
      // web_search/social_web piden el máximo real que ya respeta fetchBrave
      // (Math.min(limit,20)). Antes estaban en 10 fijo sin importar qué tan
      // mediático fuera el tema — un proyecto tan cubierto como el de un
      // presidente terminaba con el mismo puñado de videos que uno local.
      // términosReales = [topic limpio, ...aliasProyecto] (2026-10-02, cierre
      // de brecha final) — topicYoutube es un string compuesto con "|" que
      // nunca aparece literal en un video real, así que no sirve para el
      // match; se manda el nombre limpio + alias reales aparte.
      ["youtube",      () => fetchYouTubeForTopic(topicYoutube, 100, paisProyecto, idiomaProyecto, [topic, ...aliasProyecto])],
      // `aliasProyecto` (2026-10-02, pedido explícito del cliente): estos 5
      // motores nunca tuvieron el filtro de relevancia-IA que ya protege a
      // los sociales — mismo criterio, misma lista de términos reales.
      ["gdelt",        () => fetchGdeltForTopic(topic, 75, 90, aliasProyecto)],
      ["web_search",   () => fetchBraveWebForTopic(topicBrave, 20, paisProyecto, idiomaProyecto, aliasProyecto)],
      ["social_web",   () => fetchBraveSocialForTopic(topicBrave, 20, paisProyecto, idiomaProyecto, aliasProyecto)],
      // Segundo motor independiente para Facebook/Instagram/TikTok (Google
      // real vía SerpApi) — Brave y Google no indexan lo mismo, correrlos
      // juntos encuentra más que cualquiera de los dos solo.
      ["social_serpapi", () => fetchSerpApiSocialForTopic(topicAmplio, 20, paisProyecto, idiomaProyecto, aliasProyecto)],
      // Tercer motor: scraping directo de la búsqueda interna de
      // Instagram/TikTok (SocialCrawl) — encuentra posts que ningún buscador
      // tenía indexado, con fecha/vistas/likes reales. Usa `topic` solo (no
      // `topicAmplio` con el OR entre paréntesis) — el buscador interno de
      // estas plataformas no soporta "OR" como operador real (mismo
      // problema ya documentado en YouTube/Brave), así que mandarle un
      // string con OR literal lo trataba como búsqueda difusa de palabras
      // sueltas, parte de por qué "SEMAR" (Marina) colaba para un proyecto
      // de "SEMARNAT". `aliasProyecto` sigue aportando — ya no para ampliar
      // la búsqueda, sino como lista de términos reales aceptables para el
      // filtro de relevancia que ahora aplica fetchSocialCrawlForTopic.
      ["social_scrawl", () => fetchSocialCrawlForTopic(topic, hashtagInstagramProyecto, handlesInstagramProyecto, aliasProyecto)],
      ["twitter",      () => fetchTwitterForTopic(topicAmplioTwitter, 20, idiomaProyecto, aliasProyecto)],
      ["perplexity",   () => fetchPerplexityForTopic(topic, 10, aliasProyecto)],
    ];
    // Medios de Hidalgo solo aplican a proyectos mexicanos — para otros países
    // sería contenido irrelevante mezclado como si fuera fuente real del tema.
    if (paisProyecto === "MX") {
      fuentesEnVivo.push(["hidalgo", () => fetchHidalgoMediaForTopic(topic, 20, aliasProyecto)]);
    }
    const resultados = await Promise.allSettled(fuentesEnVivo.map(([, fn]) => fn()));
    for (let i = 0; i < resultados.length; i++) {
      const [nombre] = fuentesEnVivo[i];
      const r = resultados[i];
      if (r.status === "fulfilled") {
        groundingItems.push(...r.value);
        await logAnalysisRunStep(runId, `fuente_${nombre}`, true, null, r.value.length);
      } else {
        await logAnalysisRunStep(runId, `fuente_${nombre}`, false, String(r.reason?.message || r.reason));
      }
    }

    // Dedup por URL antes de construir el contexto para la IA.
    const seenUrls = new Set();
    groundingItems = groundingItems.filter(m => {
      if (!m.url) return true;
      if (seenUrls.has(m.url)) return false;
      seenUrls.add(m.url);
      return true;
    });
    await logAnalysisRunStep(runId, "grounding_total", true, null, groundingItems.length);

    // Gasto real de la segunda pasada de relevancia-IA (filtrarRelevanciaIA
    // en rss-ingestor.js, 2026-10-01) corrida dentro de social_web/
    // social_serpapi/social_scrawl de arriba — se registra igual que el
    // clasificador de sentimiento, mismo patrón, misma tabla real.
    const usoRelevanciaIA = obtenerYResetearUsoRelevanciaIA();
    if (usoRelevanciaIA.tokensIn > 0) {
      await saveUsageLog(project.user_id, projectId, null, "gpt-4o-mini", usoRelevanciaIA.tokensIn, usoRelevanciaIA.tokensOut, null);
      await logAnalysisRunStep(
        runId, "relevancia_ia", true,
        `tokens_in=${usoRelevanciaIA.tokensIn}, tokens_out=${usoRelevanciaIA.tokensOut}`,
      );
    }

    // 2c. Guardar CADA mención real encontrada como registro propio (no solo las
    // pocas que la IA decida citar en su resumen). Antes, todo lo que YouTube/GDELT/
    // Web Search/Hidalgo encontraban se usaba únicamente como contexto del prompt y
    // se descartaba si la IA no lo mencionaba explícitamente — por eso el volumen de
    // "menciones"/"fuentes" se quedaba atado a cuántas líneas escribía el modelo,
    // no a cuántas menciones reales existían. Awario y herramientas similares listan
    // cada mención real; aquí replicamos eso guardándolas todas, deduplicadas por URL.
    // Va ANTES de clasificar_sentimiento (2d) a propósito: en el primer análisis
    // de un proyecto nuevo no había nada guardado todavía cuando el clasificador
    // corría antes que esto, así que solo quedaban con sentimiento las pocas
    // menciones que la síntesis de gpt-4o citaba directamente (ej. 6 de 62) — el
    // resto se quedaba "sin calificar" hasta una segunda corrida manual.
    let guardadas = 0, yaExistian = 0, errores = 0;
    for (const item of groundingItems) {
      if (!item.url) continue;
      try {
        const hash = sha256(item.url);
        if (await isUrlIngested(hash, projectId, item.url)) { yaExistian++; continue; }
        const mentionId = await saveMentionRaw(projectId, null, item);
        await logIngestion(hash, projectId, mentionId);
        guardadas++;
      } catch (e) {
        errores++;
      }
    }
    await logAnalysisRunStep(runId, "guardar_menciones", errores === 0, `${errores} errores, ${yaExistian} ya existían`, guardadas);

    // 2d. Clasificar sentimiento real de menciones pendientes (de esta
    // corrida Y de corridas anteriores del mismo proyecto — limpia backlog
    // acumulado, no solo lo nuevo de hoy). Lote con gpt-4o-mini, mucho más
    // barato que la síntesis narrativa completa. Corre siempre, incluso si
    // más abajo se reusa la síntesis anterior, porque atiende un problema
    // real distinto (menciones sin sentimiento), no la síntesis en sí.
    try {
      const t2 = Date.now();
      const clasificacion = await clasificarMencionesPendientes(projectId, 150);
      await logAnalysisRunStep(
        runId, "clasificar_sentimiento", true,
        `tokens_in=${clasificacion.tokensIn}, tokens_out=${clasificacion.tokensOut}`,
        clasificacion.clasificadas, Date.now() - t2,
      );
      if (clasificacion.tokensIn > 0) {
        await saveUsageLog(project.user_id, projectId, null, "gpt-4o-mini", clasificacion.tokensIn, clasificacion.tokensOut, null);
      }
    } catch (e) {
      await logAnalysisRunStep(runId, "clasificar_sentimiento", false, e.message);
    }

    // 2c-skip. Si el conjunto de menciones reales (deduplicado) es idéntico al
    // de la última corrida de este proyecto en las últimas REUSE_WINDOW_MIN,
    // no hay nada nuevo que analizar — se reusa esa síntesis en vez de volver
    // a pagar gpt-4o + web_search. Esto es lo más caro del pipeline, y lo más
    // fácil de re-pagar sin necesidad si alguien le da "Analizar ahora" dos
    // veces seguidas o el auto-análisis se dispara sobre un tema que no ha
    // cambiado en horas.
    const REUSE_WINDOW_MIN = 360; // 6h
    const groundingHash = sha256(
      groundingItems.map(m => m.url || "").filter(Boolean).sort().join("|"),
    );
    const análisisAnterior = await getLatestAnalysisForProject(projectId);
    const puedeReusar =
      análisisAnterior?.grounding_hash != null &&
      análisisAnterior.grounding_hash === groundingHash &&
      (Date.now() - new Date(análisisAnterior.created_at).getTime()) < REUSE_WINDOW_MIN * 60_000;

    if (puedeReusar) {
      await logAnalysisRunStep(
        runId, "ia_sintesis_reusada", true,
        `mismo contexto que el análisis #${análisisAnterior.id} (hace menos de ${REUSE_WINDOW_MIN / 60}h) — sin llamar a gpt-4o`,
      );
      await finishAnalysisRun(runId, "success");
      return JSON.parse(análisisAnterior.response_json);
    }

    const rssContext = groundingItems.length ? buildRssContext(groundingItems) : null;

    // 3. Run AI analysis (with real data if available)
    const t1 = Date.now();
    const data = await runLiveAnalysis(topic, rssContext);
    await logAnalysisRunStep(
      runId, "ia_sintesis", true,
      `has_real_data=${!!rssContext}, tokens_in=${data._usage?.input_tokens ?? "?"}, tokens_out=${data._usage?.output_tokens ?? "?"}`,
      null, Date.now() - t1,
    );
    data._has_real_data = !!rssContext;
    data._ingest_stats  = ingestStats;
    backfillPublicationUrls(data, groundingItems);
    // Nota: aquí NO se usa mergeGroundingIntoPublications — este endpoint ya
    // guarda cada mención real directamente en la tabla mentions (paso 2c) con
    // analysis_id null; fusionarlas también en data.relevant_publications
    // duplicaría filas al pasar por saveMentionsFromAnalysis más abajo. El
    // conteo completo real ya vive en la base de datos (ver /mentions).

    // 4. Save everything
    let savedId = null;
    let savedMentions = [], savedNarratives = [], savedAmplifiers = [];
    try {
      savedId = await saveAnalysis(topic, data, projectId, groundingHash);
      data._id = savedId;
      data.project_id = projectId;
      await saveMentionsFromAnalysis(projectId, savedId, data.relevant_publications);
      await saveNarrativesFromAnalysis(projectId, savedId, data.narratives);
      await saveAlertsFromAnalysis(projectId, savedId, data.alerts, data.risk_level);
      const ampData = extractAmplifiersFromAnalysis(data);
      const narrativeTags = (data.narratives || []).map(n => n.name || n.titulo || "").filter(Boolean);
      await saveAmplifiers(projectId, savedId, ampData, narrativeTags);
      // Fetch saved data for alert engine
      savedMentions    = await getMentionsByProject(projectId);
      savedNarratives  = await getNarrativesByProject(projectId);
      savedAmplifiers  = await getAmplifiersByProject(projectId);
      await logAnalysisRunStep(runId, "guardar_analisis", true, `analysis_id=${savedId}`);
      if (data._usage?.input_tokens != null) {
        await saveUsageLog(project.user_id, projectId, savedId, data._usage.model, data._usage.input_tokens, data._usage.output_tokens, null);
      }
    } catch (dbErr) {
      await logAnalysisRunStep(runId, "guardar_analisis", false, dbErr.message);
    }

    // 5. Evaluate alert rules
    if (savedId) {
      const currentAnalysis = { ...data, id: savedId, sentiment_pos: data.sentiment?.positive, sentiment_neg: data.sentiment?.negative, sentiment_neu: data.sentiment?.neutral };
      await evaluateAlertRules(projectId, savedId, currentAnalysis, savedMentions, savedNarratives, savedAmplifiers);
    }

    await finishAnalysisRun(runId, "success");
    return data;
  } catch (error) {
    await finishAnalysisRun(runId, "error", error.message);
    // OpenAI responde 429 con "no credits remaining" / insufficient_quota
    // cuando se acaba el saldo; el mensaje del SDK trae ese texto.
    if (/no credits remaining|insufficient_quota|exceeded your current quota/i.test(String(error.message))) {
      await reportarFalloProveedor("OpenAI", 429, error.message);
    }
    throw error;
  }
}

app.post("/api/projects/:id/analyze", async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    // req.body puede venir undefined si la llamada no trae Content-Type:
    // application/json (confirmado real en logs de producción: "Cannot read
    // properties of undefined (reading 'topic')") — no cuesta nada ser
    // defensivo aquí, el endpoint ya trata topic=undefined como "usa el
    // topic real del proyecto" más abajo en el pipeline.
    const data = await runProjectAnalysisPipeline(projectId, req.body?.topic, "manual");
    res.json({ ok: true, data });
  } catch (error) {
    console.error("Error en /api/projects/:id/analyze:", error);
    res.status(500).json({ ok: false, error: "No se pudo completar el análisis.", detail: error.message });
  }
});

// Estado del análisis más reciente de un proyecto — versión ligera de
// analysis-runs, pensada para que el frontend muestre "todavía recolectando
// información" mientras el pipeline corre en segundo plano tras crear un
// proyecto o darle "Analizar ahora".
app.get("/api/projects/:id/analysis-status", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const recientes = await getAnalysisRunsByProject(projectId, 10);
  const ultimo = recientes[0];
  if (!ultimo) return res.json({ ok: true, data: { estado: "sin_datos" } });
  if (ultimo.status === "running") {
    const segundos = Math.max(0, Math.floor((Date.now() - new Date(ultimo.started_at).getTime()) / 1000));
    // Un análisis real tarda 1-2 minutos. Si sigue "running" después de 8,
    // casi seguro el proceso murió a medias (ej. un restart/crash del
    // backend) y nunca llamó finishAnalysisRun — decirle al usuario "vuelve
    // en unos minutos" en ese caso sería mentirle; se reporta como estancado.
    if (segundos > 480) {
      return res.json({ ok: true, data: { estado: "estancado", iniciadoHaceSegundos: segundos } });
    }
    return res.json({ ok: true, data: { estado: "en_progreso", iniciadoHaceSegundos: segundos } });
  }
  // El más reciente EXITOSO, no necesariamente `ultimo` — si el intento de
  // hoy falló (créditos/cuota agotados, ver provider-health.js), seguir
  // mostrando la última actualización real que sí se completó es más
  // honesto que ocultarla junto con el error.
  const últimoÉxito = recientes.find(r => r.status === "success");
  const completadoEn = últimoÉxito ? (últimoÉxito.finished_at || últimoÉxito.started_at) : null;
  if (ultimo.status === "error") {
    return res.json({ ok: true, data: { estado: "error", error: ultimo.error_message, completadoEn } });
  }
  res.json({ ok: true, data: { estado: "completo", completadoEn } });
});

// Bitácora de análisis por proyecto — para diagnosticar sin depender de los
// logs de PM2 (se pierden en cada restart/deploy).
app.get("/api/projects/:id/analysis-runs", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const runs = await getAnalysisRunsByProject(projectId);
  const conPasos = await Promise.all(runs.map(async (run) => ({
    ...run,
    steps: await getAnalysisRunSteps(run.id),
  })));
  res.json({ ok: true, data: conPasos });
});

// Clasifica el backlog de menciones reales sin sentimiento de un proyecto,
// sin re-correr todo el pipeline (RSS, fuentes vivas, gpt-4o). Pensado para
// aplicar el clasificador a menciones que ya existían antes de que el paso
// "clasificar_sentimiento" se agregara al pipeline normal.
app.post("/api/projects/:id/classify-backlog", async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
    const limite = parseInt(req.body?.limite) || 500;
    const resultado = await clasificarMencionesPendientes(projectId, limite);
    if (resultado.tokensIn > 0) {
      await saveUsageLog(project.user_id, projectId, null, "gpt-4o-mini", resultado.tokensIn, resultado.tokensOut, null);
    }
    res.json({ ok: true, data: resultado });
  } catch (error) {
    console.error("Error en /api/projects/:id/classify-backlog:", error);
    res.status(500).json({ ok: false, error: "No se pudo clasificar el backlog.", detail: error.message });
  }
});

// ─── Alert Rules ──────────────────────────────────────────────────────────────
app.get("/api/projects/:id/alert-rules", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  // Seed default rules if none exist
  const rules = await getAllAlertRulesForProject(projectId);
  if (!rules.length) await seedDefaultRules(projectId, DEFAULT_RULES);
  res.json({ ok: true, data: await getAllAlertRulesForProject(projectId) });
});

app.put("/api/projects/:id/alert-rules/:type", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const ruleType  = req.params.type;
  const { name, condition_json, is_active } = req.body;
  const rule = await upsertAlertRule(projectId, ruleType, name, condition_json, is_active ?? true);
  res.json({ ok: true, data: rule });
});

app.post("/api/projects/:id/alert-rules/seed", async (req, res) => {
  const projectId = parseInt(req.params.id);
  await seedDefaultRules(projectId, DEFAULT_RULES);
  res.json({ ok: true, data: await getAllAlertRulesForProject(projectId) });
});

// Reglas de alerta configuradas por el propio usuario — "avísame si aparece
// esta palabra o narrativa", cada una con su propio canal de entrega y rango
// de fechas (todo real, guardado en condition_json de la misma tabla
// alert_rules). Distinto de las 6 reglas automáticas de arriba: el usuario
// puede tener varias reglas del mismo tipo (varias palabras vigiladas a la
// vez), así que aquí SIEMPRE se crea una fila nueva, nunca se actualiza una
// existente por tipo.
const TIPOS_VALIDOS = { keyword: "user_keyword", narrativa: "user_narrative" };
const CANALES_REALES = ["correo"]; // telegram/push no están implementados todavía

app.get("/api/projects/:id/alert-rules/custom", async (req, res) => {
  const projectId = parseInt(req.params.id);
  res.json({ ok: true, data: await getCustomAlertRules(projectId) });
});

app.post("/api/projects/:id/alert-rules/custom", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const { tipo, valor, canal, fecha_inicio, fecha_fin } = req.body;
  const ruleType = TIPOS_VALIDOS[tipo];
  if (!ruleType || !String(valor || "").trim())
    return res.status(400).json({ ok: false, message: "Indica qué vigilar (palabra o narrativa)." });
  if (canal && !CANALES_REALES.includes(canal))
    return res.status(400).json({ ok: false, message: `Canal "${canal}" no disponible todavía. Por ahora solo: ${CANALES_REALES.join(", ")}.` });
  const nombre = tipo === "keyword" ? `Vigilar palabra: "${valor}"` : `Vigilar narrativa: "${valor}"`;
  const rule = await createCustomAlertRule(projectId, ruleType, nombre, {
    valor: String(valor).trim(),
    canal: canal || "correo",
    fecha_inicio: fecha_inicio || null,
    fecha_fin: fecha_fin || null,
  });
  res.status(201).json({ ok: true, data: rule });
});

app.put("/api/projects/:id/alert-rules/custom/:ruleId", async (req, res) => {
  const ruleId = parseInt(req.params.ruleId);
  const existente = await getCustomAlertRuleById(ruleId);
  if (!existente) return res.status(404).json({ ok: false, message: "Regla no encontrada." });
  const { valor, canal, fecha_inicio, fecha_fin, is_active } = req.body;
  if (canal && !CANALES_REALES.includes(canal))
    return res.status(400).json({ ok: false, message: `Canal "${canal}" no disponible todavía.` });
  const cond = existente.condition_json || {};
  const nuevoValor = valor !== undefined ? String(valor).trim() : cond.valor;
  const nombre = existente.rule_type === "user_keyword" ? `Vigilar palabra: "${nuevoValor}"` : `Vigilar narrativa: "${nuevoValor}"`;
  const rule = await updateCustomAlertRule(ruleId, {
    name: nombre,
    conditionJson: {
      valor: nuevoValor,
      canal: canal || cond.canal || "correo",
      fecha_inicio: fecha_inicio !== undefined ? fecha_inicio : cond.fecha_inicio,
      fecha_fin: fecha_fin !== undefined ? fecha_fin : cond.fecha_fin,
    },
    isActive: is_active ?? existente.is_active,
  });
  res.json({ ok: true, data: rule });
});

app.delete("/api/projects/:id/alert-rules/custom/:ruleId", async (req, res) => {
  const ruleId = parseInt(req.params.ruleId);
  const existente = await getCustomAlertRuleById(ruleId);
  if (!existente) return res.status(404).json({ ok: false, message: "Regla no encontrada." });
  await deleteCustomAlertRule(ruleId);
  res.json({ ok: true });
});

// ─── RSS Feeds ────────────────────────────────────────────────────────────────
app.get("/api/projects/:id/feeds", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  const feeds = await getRssFeedsByProject(projectId);

  // Also show auto-generated Google News URLs from keywords
  const keywords = await getProjectKeywords(projectId);
  const autoFeeds = keywords.slice(0, 3).map(kw => ({
    id: null, auto: true,
    url: googleNewsUrl(kw.keyword),
    name: `Google News: ${kw.keyword}`,
  }));

  res.json({ ok: true, data: feeds, auto_feeds: autoFeeds });
});

app.post("/api/projects/:id/feeds", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ ok: false, message: "URL requerida." });
  const feed = await addRssFeed(projectId, url, name);
  res.status(201).json({ ok: true, data: feed });
});

app.delete("/api/projects/:id/feeds/:fid", async (req, res) => {
  await removeRssFeed(parseInt(req.params.fid), parseInt(req.params.id));
  res.json({ ok: true, message: "Feed eliminado." });
});

// ─── Project keywords (alimentan los feeds automáticos de Google News) ────────
app.get("/api/projects/:id/keywords", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  res.json({ ok: true, data: await getProjectKeywords(projectId) });
});

// Tres categorías reales (2026-09-29, pedido del dueño tras el caso real de
// SEMARNAT con 37 palabras clave sueltas — ver project_youtube_query_fix):
// "nombre" (nombre completo y alias del funcionario), "red_social"
// (usernames), "busqueda" (términos institucionales/de contexto — la
// categoría de más riesgo de traer contenido ajeno, así que es la que más se
// limita). Tope real por categoría, reforzado aquí además de en el
// formulario — si alguien pega el body a mano no debe poder saltárselo.
const TOPES_PALABRAS_CLAVE = { nombre: 5, red_social: 6, busqueda: 5 };
const TIPOS_PALABRA_CLAVE_VÁLIDOS = new Set(Object.keys(TOPES_PALABRAS_CLAVE));
// Largo mínimo solo para "busqueda" (2026-10-02) — mismo guardado ya en el
// formulario (LARGO_MÍNIMO_BUSQUEDA), reforzado aquí por si alguien pega el
// body a mano. Es la categoría que alimenta directo las consultas de texto
// libre (YouTube/noticias/redes) y la misma clase de término que causó el
// incidente real de SEMARNAT ("GPO", 3 letras, colisionó con Roblox).
const LARGO_MÍNIMO_BUSQUEDA = 4;

// Resumen IA del panel (2026-10-03): el cliente manda métricas ya calculadas;
// aquí solo se redacta la lectura. Si falla, el frontend conserva su texto base.
app.post("/api/ai/resumen-proyectos", async (req, res) => {
  const datos = req.body;
  if (!datos || typeof datos !== "object" || !Array.isArray(datos.metricas)) {
    return res.status(400).json({ ok: false, message: "Métricas inválidas." });
  }
  try {
    res.json({ ok: true, data: await generarResumenPanel(datos) });
  } catch (e) {
    console.error("[resumen-ia] Error:", e.message);
    res.status(502).json({ ok: false, message: "No se pudo generar el resumen." });
  }
});

app.post("/api/projects/:id/keywords", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  const { keywords } = req.body;
  if (!Array.isArray(keywords)) return res.status(400).json({ ok: false, message: "keywords debe ser un arreglo." });

  // Compatibilidad: el deploy de frontend/backend no es atómico (ver
  // project-deploy-process) — mientras el frontend viejo siga corriendo,
  // puede seguir mandando un arreglo plano de texto en vez de {keyword,type}.
  const normalizadas = keywords
    .map(k => (typeof k === "string" ? { keyword: k, type: "nombre" } : k))
    .map(k => ({ keyword: String(k?.keyword ?? "").trim(), type: String(k?.type ?? "nombre") }))
    .filter(k => k.keyword);

  for (const k of normalizadas) {
    if (!TIPOS_PALABRA_CLAVE_VÁLIDOS.has(k.type)) {
      return res.status(400).json({ ok: false, message: `Tipo de palabra clave inválido: ${k.type}` });
    }
    if (k.type === "busqueda" && k.keyword.length < LARGO_MÍNIMO_BUSQUEDA) {
      return res.status(400).json({ ok: false, message: `"${k.keyword}" es muy corto para "busqueda" (mínimo ${LARGO_MÍNIMO_BUSQUEDA} caracteres) — los términos cortos chocan con temas ajenos.` });
    }
  }
  for (const [tipo, tope] of Object.entries(TOPES_PALABRAS_CLAVE)) {
    const cantidad = normalizadas.filter(k => k.type === tipo).length;
    if (cantidad > tope) {
      return res.status(400).json({ ok: false, message: `Máximo ${tope} palabras clave de tipo "${tipo}" (llegaron ${cantidad}).` });
    }
  }

  await saveProjectKeywords(projectId, normalizadas);
  res.json({ ok: true, data: await getProjectKeywords(projectId) });
});

// ─── Project sources (redes seleccionadas al crear el proyecto) ───────────────
// Nota: hoy solo se persisten. El pipeline de análisis (/analyze) todavía
// busca en las mismas 7 fuentes para todos los proyectos sin filtrar por
// esto — no hay integración real a Facebook/Instagram/TikTok todavía, solo
// X/Twitter tiene fetcher propio (fetchTwitterForTopic).
app.get("/api/projects/:id/sources", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  res.json({ ok: true, data: await getProjectSources(projectId) });
});

app.post("/api/projects/:id/sources", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  const { sources } = req.body;
  if (!Array.isArray(sources)) return res.status(400).json({ ok: false, message: "sources debe ser un arreglo de texto." });
  await saveProjectSources(projectId, sources.map(String));
  res.json({ ok: true, data: await getProjectSources(projectId) });
});

// ─── Manual ingestion trigger ─────────────────────────────────────────────────
app.post("/api/projects/:id/ingest", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  try {
    const stats = await ingestProject(projectId, project.country_code || "MX");
    res.json({ ok: true, data: stats });
  } catch (e) {
    console.error("[RSS] Manual ingest error:", e.message);
    res.status(500).json({ ok: false, message: "Error en ingesta.", detail: e.message });
  }
});

// ─── Amplifiers stats ─────────────────────────────────────────────────────────
app.get("/api/projects/:id/amplifiers/stats", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  try {
    const stats = await getAmplifiersStats(projectId);
    res.json({ ok: true, data: stats });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ─── Amplifiers rebuild (with dedup + scoring) ────────────────────────────────
app.post("/api/projects/:id/amplifiers/rebuild", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  try {
    const analyses = await getAnalysesWithJsonByProject(projectId);
    await clearAmplifiersByProject(projectId);
    let total = 0;
    for (const a of analyses) {
      let parsed;
      try { parsed = typeof a.response_json === "string" ? JSON.parse(a.response_json) : a.response_json; } catch { continue; }
      const amps = extractAmplifiersFromAnalysis(parsed);
      // Extract narrative names from this analysis to tag amplifiers
      const narrativeTags = (parsed.narratives || []).map(n => n.name || n.titulo || "").filter(Boolean);
      total += await saveAmplifiers(projectId, a.id, amps, narrativeTags);
    }
    const stats = await getAmplifiersStats(projectId);
    res.json({ ok: true, message: "Amplificadores reconstruidos con dedup y scoring.", count: total, stats });
  } catch (e) {
    console.error("Error rebuild amplifiers:", e.message);
    res.status(500).json({ ok: false, message: "No se pudieron reconstruir los amplificadores." });
  }
});

// ─── Users ────────────────────────────────────────────────────────────────────
app.get("/api/users", async (req, res) => {
  const u = await resolveUser(req.query);
  const orgId = u.role === "superadmin" ? null : await getOrgIdForUser(u.userId);
  res.json({ ok: true, data: await getUsers(orgId) });
});

// Consumo real de IA (tokens) por usuario — panel de Super Usuario. Mismo
// criterio que /api/users: superadmin ve todas las organizaciones, el resto
// solo la suya.
app.get("/api/usage", async (req, res) => {
  const u = await resolveUser(req.query);
  const orgId = u.role === "superadmin" ? null : await getOrgIdForUser(u.userId);
  res.json({ ok: true, data: await getUsageSummary(orgId) });
});

app.post("/api/users", async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ ok: false, message: "Nombre, email y contraseña requeridos." });
  try {
    const u = await resolveUser(req.query);
    const orgId = await getOrgIdForUser(u.userId);
    const user = await createUser({ name, email, password, role, organization_id: orgId });
    res.status(201).json({ ok: true, data: user });
    const org = await getOrganizationById(orgId);
    enviarCorreoBienvenida(user.email, user.name, { orgName: org?.name })
      .catch((e) => console.error("[users] Error enviando correo de bienvenida:", e.message));
  } catch (e) {
    if (e.message?.includes("unique") || e.message?.includes("duplicate")) {
      return res.status(400).json({ ok: false, message: "Ese email ya está registrado." });
    }
    res.status(500).json({ ok: false, message: "No se pudo crear el usuario." });
  }
});

app.put("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const user = await getUserById(id);
  if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
  const result = await updateUser(id, req.body);
  if (result?.error) return res.status(400).json({ ok: false, message: result.error });
  res.json({ ok: true, data: result });
});

app.delete("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const user = await getUserById(id);
  if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
  const result = await archiveUser(id);
  if (result?.error) return res.status(400).json({ ok: false, message: result.error });
  res.json({ ok: true, message: "Usuario archivado." });
});

// ─── Project members ──────────────────────────────────────────────────────────
app.get("/api/projects/:id/members", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  res.json({ ok: true, data: await getProjectMembers(projectId) });
});

app.post("/api/projects/:id/members", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  const { user_id, permission } = req.body;
  if (!user_id) return res.status(400).json({ ok: false, message: "user_id requerido." });
  const member = await upsertProjectMember(projectId, parseInt(user_id), permission || "viewer");
  res.json({ ok: true, data: member });
});

app.delete("/api/projects/:id/members/:uid", async (req, res) => {
  await removeProjectMember(parseInt(req.params.id), parseInt(req.params.uid));
  res.json({ ok: true, message: "Acceso removido." });
});

// ─── Aggregate cross-project ──────────────────────────────────────────────────
async function resolveUser(query) {
  const userId = parseInt(query.user_id);
  const role   = query.role;
  if (userId && role) return { userId, role };
  const demo = await getOrCreateDemoUser();
  return { userId: demo.id, role: "admin" };
}

// ─── Email alerts ─────────────────────────────────────────────────────────────
app.post("/api/alerts/send-email", async (req, res) => {
  const { to, projectName, alertTitle, riskLevel } = req.body;
  if (!to || !projectName || !alertTitle) return res.status(400).json({ ok: false, message: "Faltan campos." });
  await sendAlertEmail({ to, projectName, alertTitle, riskLevel: riskLevel || "Alto" });
  res.json({ ok: true, message: "Email enviado." });
});

// ─── Facturación ──────────────────────────────────────────────────────────────
// No hay pasarela de pago conectada (ni Stripe ni Mercado Pago) — se muestra el
// plan/límite real de la organización, y "cambiar plan"/"cancelar" generan una
// solicitud real por correo a soporte en vez de simular un cobro exitoso.
app.get("/api/facturacion", async (req, res) => {
  const userId = parseInt(req.query.user_id);
  if (!userId) return res.status(400).json({ ok: false, message: "user_id requerido." });
  const user = await getUserById(userId);
  if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
  const org = await getOrganizationById(user.organization_id);
  const proyectosActivos = await countActiveProjectsByUser(userId);
  res.json({
    ok: true,
    data: {
      organizacion: org?.name ?? "—",
      plan: org?.plan ?? "basic",
      max_proyectos: org?.max_projects ?? 5,
      proyectos_activos: proyectosActivos,
    },
  });
});

app.post("/api/facturacion/solicitud", async (req, res) => {
  const userId = parseInt(req.body.user_id);
  const { tipo, plan_deseado, comentario } = req.body;
  if (!userId || !["cambiar_plan", "cancelar"].includes(tipo))
    return res.status(400).json({ ok: false, message: "Datos incompletos." });
  const user = await getUserById(userId);
  if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
  const org = await getOrganizationById(user.organization_id);
  const { enviado } = await enviarSolicitudFacturacion({
    tipo,
    organizacion: org?.name ?? "—",
    organizationId: user.organization_id,
    nombre: user.name,
    email: user.email,
    planActual: org?.plan ?? "basic",
    planDeseado: plan_deseado,
    comentario,
  });
  res.json({
    ok: true,
    data: { enviado },
    message: "Recibimos tu solicitud, nuestro equipo se pondrá en contacto contigo para completarla.",
  });
});

// ─── Soporte: tickets reales ────────────────────────────────────────────────
// Folio real: TCK-{id de la fila}, no un UUID aparte — el id ya es único y
// secuencial, no hace falta inventar otro identificador.
app.post("/api/soporte/tickets", async (req, res) => {
  const userId = parseInt(req.body.user_id);
  const { tipo_error, seccion, prioridad, descripcion } = req.body;
  if (!userId || !descripcion || descripcion.trim().length < 20)
    return res.status(400).json({ ok: false, message: "Descripción requerida (mínimo 20 caracteres)." });
  const user = await getUserById(userId);
  if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
  const subject = [tipo_error, seccion].filter(Boolean).join(" — ") || "Reporte de soporte";
  const ticket = await createSupportTicket({
    organizationId: user.organization_id, userId, subject,
    tipoError: tipo_error, seccion, prioridad, descripcion,
  });
  const ticketId = `TCK-${ticket.id}`;
  res.status(201).json({ ok: true, data: { ...ticket, ticket_id: ticketId } });
  const creado = new Date(ticket.created_at);
  const fecha = creado.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
  const hora = creado.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" });
  enviarNotificacionTicketCreado(user.email, user.name, { ticketId, ticketSubject: subject, fecha, hora })
    .catch((e) => console.error("[soporte] Error avisando ticket creado:", e.message));
});

app.get("/api/soporte/tickets", async (req, res) => {
  const userId = parseInt(req.query.user_id);
  if (!userId) return res.status(400).json({ ok: false, message: "user_id requerido." });
  const tickets = await getSupportTicketsByUser(userId);
  res.json({ ok: true, data: tickets.map((t) => ({ ...t, ticket_id: `TCK-${t.id}` })) });
});

// Vista de admin: todos los tickets de la organización (para resolverlos),
// no solo los propios.
app.get("/api/soporte/tickets/admin", async (req, res) => {
  const resolverId = parseInt(req.query.resolver_id);
  const resolver = resolverId ? await getUserById(resolverId) : null;
  if (!resolver || resolver.role !== "admin")
    return res.status(403).json({ ok: false, message: "Solo un administrador puede ver todos los tickets." });
  const tickets = await getSupportTicketsByOrg(resolver.organization_id);
  res.json({ ok: true, data: tickets.map((t) => ({ ...t, ticket_id: `TCK-${t.id}` })) });
});

// Resolver un ticket exige rol admin de quien lo resuelve — mismo criterio
// que ya usa /api/perfil/traspasar, no una llave separada.
app.post("/api/soporte/tickets/:id/resolver", async (req, res) => {
  const resolverId = parseInt(req.body.resolver_id);
  const resolver = resolverId ? await getUserById(resolverId) : null;
  if (!resolver || resolver.role !== "admin")
    return res.status(403).json({ ok: false, message: "Solo un administrador puede resolver tickets." });
  const id = parseInt(req.params.id);
  const { resolution_summary } = req.body;
  if (!resolution_summary || resolution_summary.trim().length < 5)
    return res.status(400).json({ ok: false, message: "Resumen de solución requerido." });
  const ticket = await getSupportTicketById(id);
  if (!ticket) return res.status(404).json({ ok: false, message: "Ticket no encontrado." });
  if (ticket.status === "resuelto") return res.status(409).json({ ok: false, message: "Ese ticket ya estaba resuelto." });
  const actualizado = await resolveSupportTicket(id, resolution_summary);
  const user = await getUserById(ticket.user_id);
  res.json({ ok: true, data: { ...actualizado, ticket_id: `TCK-${actualizado.id}` } });
  if (user) {
    const resuelto = new Date(actualizado.resolved_at);
    const fecha = resuelto.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
    const hora = resuelto.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" });
    enviarNotificacionTicketResuelto(user.email, user.name, {
      ticketId: `TCK-${actualizado.id}`, resolutionSummary: resolution_summary, fecha, hora,
    }).catch((e) => console.error("[soporte] Error avisando ticket resuelto:", e.message));
  }
});

// ─── Organizations ────────────────────────────────────────────────────────────
app.get("/api/organizations", async (req, res) => {
  try { res.json({ ok: true, data: await getAllOrganizations() }); }
  catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.put("/api/organizations/:id", async (req, res) => {
  try {
    const org = await updateOrganization(parseInt(req.params.id), req.body || {});
    res.json({ ok: true, data: org });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/organizations/:id/users", async (req, res) => {
  const orgId = parseInt(req.params.id);
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ ok: false, message: "Nombre, email y contraseña requeridos." });
  try {
    const user = await createUser({ name, email, password, role: role || "admin", organization_id: orgId });
    res.status(201).json({ ok: true, data: user });
    const org = await getOrganizationById(orgId);
    enviarCorreoBienvenida(user.email, user.name, { orgName: org?.name })
      .catch((e) => console.error("[organizations] Error enviando correo de bienvenida:", e.message));
  } catch(e) {
    if (e.message?.includes("unique") || e.message?.includes("duplicate"))
      return res.status(400).json({ ok: false, message: "Ese email ya está registrado." });
    res.status(500).json({ ok: false, message: "No se pudo crear el usuario." });
  }
});

app.get("/api/organizations/:id", async (req, res) => {
  const org = await getOrganizationById(parseInt(req.params.id));
  if (!org) return res.status(404).json({ ok: false, message: "Organización no encontrada." });
  res.json({ ok: true, data: org });
});

app.post("/api/organizations", async (req, res) => {
  const { name, plan, max_projects } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, message: "Nombre requerido." });
  try {
    const org = await createOrganization(name, plan || "basic", max_projects || 10);
    res.status(201).json({ ok: true, data: org });
  } catch (e) {
    res.status(500).json({ ok: false, message: "No se pudo crear la organización." });
  }
});

// Tope real de descargas de Infografía en PDF para cuentas Demo (plan=basic)
// — correcciones-1-octubre, punto E19. El conteo vive en la organización
// (no en el navegador) para que no se pueda evadir borrando localStorage.
app.post("/api/organizations/:id/infografia-descarga", async (req, res) => {
  const orgId = parseInt(req.params.id);
  if (!Number.isInteger(orgId)) return res.status(400).json({ ok: false, message: "Organización inválida." });
  try {
    const resultado = await registrarDescargaInfografia(orgId);
    res.json({ ok: true, data: resultado });
  } catch (e) {
    res.status(500).json({ ok: false, message: "No se pudo registrar la descarga." });
  }
});

// Mismo tope pero para el resto de reportes PDF (Narrativas/Sentimiento/
// Proyectos/Benchmarking/Análisis) — 2026-10-02, ver registrarDescargaReportePdf.
app.post("/api/organizations/:id/reporte-descarga", async (req, res) => {
  const orgId = parseInt(req.params.id);
  if (!Number.isInteger(orgId)) return res.status(400).json({ ok: false, message: "Organización inválida." });
  try {
    const resultado = await registrarDescargaReportePdf(orgId);
    res.json({ ok: true, data: resultado });
  } catch (e) {
    res.status(500).json({ ok: false, message: "No se pudo registrar la descarga." });
  }
});

app.get("/api/all-mentions",   async (req, res) => { const u = await resolveUser(req.query); res.json({ ok: true, data: await getAllMentionsForUser(u.userId, u.role) }); });
app.get("/api/all-narratives", async (req, res) => { const u = await resolveUser(req.query); res.json({ ok: true, data: await getAllNarrativesForUser(u.userId, u.role) }); });
app.get("/api/all-alerts",     async (req, res) => { const u = await resolveUser(req.query); res.json({ ok: true, data: await getAllAlertsForUser(u.userId, u.role) }); });
app.get("/api/all-amplifiers", async (req, res) => { const u = await resolveUser(req.query); res.json({ ok: true, data: await getAllAmplifiersForUser(u.userId, u.role) }); });
app.get("/api/all-nss-por-narrativa", async (req, res) => {
  const u = await resolveUser(req.query);
  const { inicio, fin } = req.query;
  const rango = inicio && fin ? { inicio, fin } : null;
  res.json({ ok: true, data: await getNssPorNarrativaForUser(u.userId, u.role, rango) });
});
app.get("/api/all-analyses",   async (req, res) => { const u = await resolveUser(req.query); res.json({ ok: true, data: await getAllAnalysesForUser(u.userId, u.role) }); });

// ─── Búsqueda en vivo (Monitoreo → Búsqueda) ───────────────────────────────────
// Reutiliza las mismas 7 fuentes reales que ya usa el pipeline de análisis de
// proyectos (rss-ingestor.js) — nada inventado: si una fuente falla, se omite
// (Promise.allSettled), nunca se rellena con datos falsos. No requiere un
// proyecto: busca el tema tal cual lo escribió el usuario.
app.post("/api/search-live", searchLimiter, async (req, res) => {
  const topic = String(req.body.query || "").trim();
  if (topic.length < 2) return res.status(400).json({ ok: false, message: "Escribe qué quieres buscar." });
  try {
    const fuentesEnVivo = [
      ["google_news",  fetchLiveNewsForTopic],
      ["youtube",      fetchYouTubeForTopic],
      ["gdelt",        fetchGdeltForTopic],
      ["web_search",   fetchBraveWebForTopic],
      ["social_web",   fetchBraveSocialForTopic],
      ["hidalgo",      fetchHidalgoMediaForTopic],
      ["twitter",      fetchTwitterForTopic],
      ["perplexity",   fetchPerplexityForTopic],
    ];
    const resultados = await Promise.allSettled(fuentesEnVivo.map(([, fn]) => fn(topic)));
    let items = [];
    for (const r of resultados) {
      if (r.status === "fulfilled") items.push(...r.value);
    }
    // Solo resultados con link real y navegable — algunas fuentes (ej. Google
    // News RSS) a veces no traen url, y una tarjeta de búsqueda sin link no
    // sirve de nada.
    const seen = new Set();
    items = items.filter((m) => {
      if (!m.url) return false;
      if (seen.has(m.url)) return false;
      seen.add(m.url);
      return true;
    });
    items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    res.json({ ok: true, data: { query: topic, items, total: items.length } });
  } catch (e) {
    console.error("Error en /api/search-live:", e);
    res.status(500).json({ ok: false, message: "No se pudo completar la búsqueda." });
  }
});

// Análisis IA real de los resultados de una búsqueda en vivo — mismo motor
// (runLiveAnalysis, gpt-4o) que ya usa el análisis de proyectos, sobre las
// menciones reales que /api/search-live acaba de encontrar. Sin proyecto, sin
// guardar en BD (es exploratorio, no monitoreo continuo) — solo se registra el
// gasto real de tokens.
app.post("/api/search-live/analizar", searchAnalyzeLimiter, async (req, res) => {
  const topic = String(req.body.query || "").trim();
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!topic || !items.length) return res.status(400).json({ ok: false, message: "Faltan resultados reales para analizar." });
  try {
    const rssContext = buildRssContext(items);
    const data = await runLiveAnalysis(topic, rssContext);
    if (data._usage) {
      await saveUsageLog(req.body.user_id ?? null, null, null, "gpt-4o", data._usage.input_tokens, data._usage.output_tokens, null);
    }
    res.json({ ok: true, data });
  } catch (e) {
    console.error("Error en /api/search-live/analizar:", e);
    res.status(500).json({ ok: false, message: "No se pudo analizar la conversación." });
  }
});

// ─── Global search ────────────────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 5, 20);
  if (!q) return res.json({ ok: true, data: [] });
  try {
    const data = await searchMentions(q, limit);
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: true, data: [] });
  }
});

// ─── PDF export ───────────────────────────────────────────────────────────────
app.get("/api/projects/:id/report.pdf", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = await getProjectById(projectId);
  if (!project) return res.status(404).json({ ok: false, message: "Proyecto no encontrado." });
  try {
    const [analyses, narratives, alerts, mentions, amplifiers] = await Promise.all([
      getAnalysesByProject(projectId),
      getNarrativesByProject(projectId),
      getAlertsByProject(projectId),
      getMentionsByProject(projectId),
      getAmplifiersByProject(projectId),
    ]);
    // Fetch response_json for latest analysis
    if (analyses.length) {
      const full = await getAnalysisById(analyses[0].id);
      if (full) analyses[0].response_json = full.response_json;
    }
    const filename = `reporte-${project.name.replace(/[^a-z0-9]/gi,"_").toLowerCase()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    generateProjectPDF(project, analyses, narratives, alerts, mentions, amplifiers, res);
  } catch (e) {
    console.error("PDF error:", e.message);
    res.status(500).json({ ok: false, message: "No se pudo generar el PDF.", detail: e.message });
  }
});

// ─── Ingest all active projects ──────────────────────────────────────────────
app.post("/api/ingest-all", async (req, res) => {
  try {
    const projects = await getProjectsForUser((await getOrCreateDemoUser()).id, "admin");
    const results = [];
    for (const p of projects) {
      try {
        const stats = await ingestProject(p.id, p.country_code || "MX");
        results.push({ project_id: p.id, name: p.name, ...stats });
      } catch (e) {
        results.push({ project_id: p.id, name: p.name, error: e.message });
      }
    }
    res.json({ ok: true, data: results });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get("/api/stats", async (req, res) => {
  const userId = parseInt(req.query.user_id);
  const role   = req.query.role;
  const projects = (userId && role)
    ? await getProjectsForUser(userId, role)
    : await getProjectsForUser((await getOrCreateDemoUser()).id, "admin");
  let totalAlerts = 0;
  for (const p of projects) {
    const alerts = await getAlertsByProject(p.id);
    totalAlerts += alerts.filter(a => a.status === "open").length;
  }
  res.json({ ok: true, data: { total_alerts: totalAlerts } });
});

// ─── Dashboard stats (all KPIs in one call) ───────────────────────────────────
app.get("/api/dashboard-stats", async (req, res) => {
  try {
    const u = await resolveUser(req.query);
    const [projects, mentions, analyses, alerts, narratives, amplifiers] = await Promise.all([
      getProjectsForUser(u.userId, u.role),
      getAllMentionsForUser(u.userId, u.role),
      getAllAnalysesForUser(u.userId, u.role),
      getAllAlertsForUser(u.userId, u.role),
      getAllNarrativesForUser(u.userId, u.role),
      getAllAmplifiersForUser(u.userId, u.role),
    ]);

    const avgPos = analyses.length ? Math.round(analyses.reduce((s,a)=>s+(Number(a.sentiment_pos)||0),0)/analyses.length) : 0;
    const avgNeg = analyses.length ? Math.round(analyses.reduce((s,a)=>s+(Number(a.sentiment_neg)||0),0)/analyses.length) : 0;
    const avgNeu = Math.max(0, 100 - avgPos - avgNeg);

    const riskLevels = analyses.map(a=>a.risk_level).filter(Boolean);
    const domRisk = riskLevels.length
      ? riskLevels.sort((a,b)=>riskLevels.filter(v=>v===b).length-riskLevels.filter(v=>v===a).length)[0]
      : null;

    const critAlerts = alerts.filter(a=>a.risk_level==='Crítico'||a.risk_level==='Alto');
    const openAlerts = alerts.filter(a=>a.status==='open');

    // Platform distribution from amplifiers
    const platformMap = {};
    for (const amp of amplifiers) {
      const p = amp.platform || amp.source_type || 'Otros';
      platformMap[p] = (platformMap[p]||0) + (Number(amp.mentions_count)||1);
    }
    const totalPlatMentions = Object.values(platformMap).reduce((s,v)=>s+v,0)||1;
    const platformDist = Object.entries(platformMap)
      .sort((a,b)=>b[1]-a[1]).slice(0,7)
      .map(([name,count])=>({ name, count, pct: Math.round(count/totalPlatMentions*100) }));

    // Top amplifiers
    const topAmplifiers = [...amplifiers]
      .sort((a,b)=>(parseFloat(b.influence_score)||0)-(parseFloat(a.influence_score)||0))
      .slice(0,5)
      .map(a=>({ name:a.name, category:a.category, risk_level:a.risk_level, mentions_count:a.mentions_count, platform:a.platform }));

    res.json({ ok: true, data: {
      projects_count:  projects.length,
      mentions_count:  mentions.length,
      analyses_count:  analyses.length,
      alerts_count:    openAlerts.length,
      crit_alerts:     critAlerts.length,
      narratives_count: narratives.length,
      amplifiers_count: amplifiers.length,
      sentiment: { pos: avgPos, neg: avgNeg, neu: avgNeu },
      dominant_risk:   domRisk,
      latest_analysis: analyses[0] || null,
      platform_dist:   platformDist,
      top_amplifiers:  topAmplifiers,
    }});
  } catch(e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Corrida automática cada 2 horas sobre todos los proyectos activos — antes
// el único análisis real era el disparado al crear el proyecto (una vez) o
// con "Analizar ahora" (manual), así que la historia real acumulada
// dependía de cuántas veces alguien hiciera clic. Con 12 corridas/día por
// proyecto y el tope diario real de 20 (daily_query_limit, ver
// runProjectAnalysisPipeline) queda margen para seguir usando "Analizar
// ahora" manualmente sin toparse con el límite. Secuencial con pausa entre
// proyectos (no en paralelo) para no golpear las APIs externas (X/Brave/
// YouTube) todas al mismo tiempo.
// Apagado por defecto (2026-09-26, pedido del dueño): cada corrida llama a todas
// las fuentes de pago y con ~15 proyectos costaba cientos de dólares al mes.
// Los análisis siguen funcionando a mano ("Analizar ahora") y al crear un
// proyecto. Para reactivar el cron: CRON_ANALISIS=on en el .env del backend y
// reiniciar sentimentunicornio-api.
const CRON_ANALISIS_ACTIVO = process.env.CRON_ANALISIS === "on";
if (!CRON_ANALISIS_ACTIVO) {
  console.log("[cron] análisis automático APAGADO (define CRON_ANALISIS=on para activarlo)");
}
// Lista blanca opcional (2026-09-29, pedido del dueño): con varios proyectos
// reales en `active` que ya no se quieren re-analizar automáticamente (siguen
// visibles y funcionando para sus dueños vía "Analizar ahora" — solo se
// apaga el gasto recurrente del cron), CRON_PROYECTOS="40,41" limita qué IDs
// entran a la corrida cada 2h sin tocar el status del resto. Vacío/sin
// definir = todos los proyectos activos, como antes.
const CRON_PROYECTOS_PERMITIDOS = (process.env.CRON_PROYECTOS || "")
  .split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
cron.schedule("0 */2 * * *", async () => {
  if (!CRON_ANALISIS_ACTIVO) return;
  console.log("[cron] iniciando corrida automática de análisis");
  let projectIds = [];
  try {
    projectIds = await getUserProjectIds(null, "superadmin");
  } catch (e) {
    console.error("[cron] no se pudo obtener la lista de proyectos activos:", e.message);
    return;
  }
  if (CRON_PROYECTOS_PERMITIDOS.length) {
    projectIds = projectIds.filter(id => CRON_PROYECTOS_PERMITIDOS.includes(id));
  }
  for (const projectId of projectIds) {
    try {
      await runProjectAnalysisPipeline(projectId, null, "cron");
      console.log(`[cron] proyecto ${projectId}: análisis completado`);
    } catch (e) {
      console.error(`[cron] proyecto ${projectId}:`, e.message);
    }
    await sleep(15_000);
  }
  console.log("[cron] corrida automática terminada");
});

app.listen(PORT, () => {
  console.log(`Sentiment API corriendo en http://localhost:${PORT}`);
});
