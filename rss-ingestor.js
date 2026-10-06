import Parser from "rss-parser";
import OpenAI from "openai";
import { createHash } from "crypto";
import fs from "fs/promises";
import nodePath from "path";
import {
  getRssFeedsByProject, updateFeedLastFetched,
  logIngestion, isUrlIngested,
  saveMentionRaw, getProjectKeywords,
  getCachedSearch, saveCachedSearch,
} from "./db.js";
import { reportarFalloProveedor } from "./provider-health.js";

function hashTema(topic) {
  return createHash("sha256").update(topic.trim().toLowerCase()).digest("hex");
}

const parser = new Parser({
  timeout: 10000,
  headers: { "User-Agent": "SentimentUnicornio/1.0 RSS Reader" },
  customFields: { item: ["media:content", "dc:creator", "content:encoded"] },
});

// ─── Catálogo real de locales por país ─────────────────────────────────────
// Los 8 países que ya ofrece el formulario de creación de proyecto
// (formulario-nuevo-proyecto.tsx) — antes de esto, TODO el pipeline de
// búsqueda en vivo (Google News, YouTube, Custom Search, Twitter) estaba fijo
// a México sin importar qué país eligiera el usuario. `hl`/`ceid` son los
// locales reales que usa Google News para cada uno, no una concatenación
// genérica (México/Argentina/Colombia/Chile/Perú comparten es-419 en Google
// News; España usa es-ES; Brasil usa pt-419).
const LOCALES_PAIS = {
  MX: { newsHl: "es-419", newsCeid: "MX:es-419", gl: "mx" },
  US: { newsHl: "en-US",  newsCeid: "US:en",     gl: "us" },
  ES: { newsHl: "es-ES",  newsCeid: "ES:es",     gl: "es" },
  AR: { newsHl: "es-419", newsCeid: "AR:es-419", gl: "ar" },
  CO: { newsHl: "es-419", newsCeid: "CO:es-419", gl: "co" },
  CL: { newsHl: "es-419", newsCeid: "CL:es-419", gl: "cl" },
  PE: { newsHl: "es-419", newsCeid: "PE:es-419", gl: "pe" },
  BR: { newsHl: "pt-419", newsCeid: "BR:pt-419", gl: "br" },
};

function localePaís(countryCode) {
  return LOCALES_PAIS[String(countryCode || "").toUpperCase()] || LOCALES_PAIS.MX;
}

// ─── Google News RSS auto-URL from keyword ────────────────────────────────────
export function googleNewsUrl(keyword, countryCode = "MX") {
  const q = encodeURIComponent(keyword);
  const { newsHl, newsCeid, gl } = localePaís(countryCode);
  return `https://news.google.com/rss/search?q=${q}&hl=${newsHl}&gl=${gl.toUpperCase()}&ceid=${newsCeid}`;
}

// ─── Normalize an RSS item → mentions row ────────────────────────────────────
// `feedName` para los feeds auto-generados de Google News es nuestra propia
// etiqueta interna ("Google News: <keyword>"), NO el medio real — guardarla
// tal cual como fuente hacía que TODAS las menciones de Google News salieran
// con ese texto en vez del periódico/sitio real que las publicó. Google News
// antepone "Titular - Fuente" al título de cada item; de ahí se saca el medio
// real (misma lógica que ya usaba fetchLiveNewsForTopic más abajo).
function normalizeItem(item, feedName, feedUrl) {
  const url   = item.link || item.guid || "";
  const title = item.title || "";
  const content = item.contentSnippet || item["content:encoded"] || item.content || "";
  const author  = item.creator || item["dc:creator"] || item.author || null;
  const pubDate = item.pubDate || item.isoDate || null;

  const esGoogleNews = /^Google News:/.test(feedName || "") || /news\.google\.com/.test(feedUrl || "");
  let sourceName = null;
  if (esGoogleNews) {
    const partes = title.split(" - ");
    sourceName = partes.length > 1 ? partes.pop().trim() : null;
  } else {
    sourceName = feedName;
  }
  if (!sourceName) {
    try {
      const u = new URL(url);
      sourceName = u.hostname.replace(/^www\./, "");
    } catch {
      sourceName = feedName;
    }
  }

  return {
    url,
    title:        title.slice(0, 500),
    content:      content.slice(0, 2000),
    source_name:  sourceName,
    source_type:  "rss",
    author_name:  author,
    published_at: pubDate ? new Date(pubDate) : null,
    sentiment:    null,
    risk_level:   null,
    reach:        null,
    raw_json:     JSON.stringify({ title, url, author, pubDate, feedUrl }),
  };
}

// ─── Hash a URL for dedup ─────────────────────────────────────────────────────
function hashUrl(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 64);
}

// ─── Fetch one feed, return normalized new items ──────────────────────────────
async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return parsed.items.map(item => normalizeItem(item, feed.name || parsed.title, feed.url));
  } catch (e) {
    console.error(`[RSS] Error fetching ${feed.url}:`, e.message);
    return [];
  }
}

// Mismo criterio de prioridad que PRIORIDAD_TIPO_ALIAS en server.js — un
// nombre propio ("Salomón Jara") da resultados mucho más precisos en Google
// News que un hashtag genérico que en realidad es el nombre de una CIUDAD
// ("#OaxacaDeJuárez") o un lema de temporada ("#PrimaveraOaxaqueña"). Antes
// se tomaban las primeras 3 keywords por orden alfabético de `type` —
// "busqueda" (hashtags) le ganaba a "nombre" en el alfabeto, así que CASI
// SIEMPRE se ingería con los hashtags más genéricos del proyecto en vez del
// nombre específico (bug real reportado por el cliente, 2026-10-01: noticias
// de "Christian Bale"/conciertos del Mundial colándose en el proyecto de
// Salomón Jara — rastreado hasta este mismo mecanismo).
const PRIORIDAD_TIPO_KEYWORD = { nombre: 0, red_social: 1, busqueda: 2 };
function ordenarPorPrioridad(keywords) {
  return [...keywords].sort(
    (a, b) => (PRIORIDAD_TIPO_KEYWORD[a.type] ?? 1) - (PRIORIDAD_TIPO_KEYWORD[b.type] ?? 1),
  );
}

// ─── Main ingestion function for a project ───────────────────────────────────
export async function ingestProject(projectId, countryCode = "MX") {
  const results = { fetched: 0, saved: 0, skipped: 0, feeds: 0, errors: [] };

  // Get configured feeds
  let feeds = await getRssFeedsByProject(projectId);
  const keywordsProyecto = await getProjectKeywords(projectId);
  const términosReales = keywordsProyecto.map(k => k.keyword).filter(Boolean);

  // Auto-add Google News feeds from project keywords if no feeds configured
  if (!feeds.length) {
    const keywordsPriorizadas = ordenarPorPrioridad(keywordsProyecto);
    feeds = keywordsPriorizadas.slice(0, 3).map(kw => ({
      id: null,
      project_id: projectId,
      url: googleNewsUrl(kw.keyword, countryCode),
      name: `Google News: ${kw.keyword}`,
    }));
  }

  results.feeds = feeds.length;

  for (const feed of feeds) {
    const crudos = await fetchFeed(feed);
    results.fetched += crudos.length;
    // Filtro de relevancia real (2026-10-01) — el mismo que ya protege a los
    // motores sociales (esRelevante): ingestProject nunca había tenido
    // ninguno, así que un hashtag/feed genérico podía colar lo que fuera con
    // tal de que Google News lo devolviera para esa consulta.
    const items = crudos.filter(item => esRelevante(item, términosReales));
    results.skipped += crudos.length - items.length;

    for (const item of items) {
      if (!item.url) { results.skipped++; continue; }

      const hash = hashUrl(item.url);
      const already = await isUrlIngested(hash, projectId, item.url);
      if (already) { results.skipped++; continue; }

      try {
        const mentionId = await saveMentionRaw(projectId, null, item);
        await logIngestion(hash, projectId, mentionId);
        results.saved++;
      } catch (e) {
        results.errors.push(e.message);
        results.skipped++;
      }
    }

    if (feed.id) await updateFeedLastFetched(feed.id, items.length);
  }

  return results;
}

// ─── Búsqueda de noticias en vivo para un tema libre (sin proyecto guardado) ──
// `términosReales` (2026-10-02, cierre de brecha final): era uno de los 2
// únicos motores sin ningún filtro de relevancia-IA. Aquí `topic` siempre es
// el nombre limpio real (main_topic), nunca un string compuesto, así que
// participa directo en el match — igual que GDELT/Perplexity/Hidalgo.
export async function fetchLiveNewsForTopic(topic, limit = 15, countryCode = "MX", términosReales = []) {
  try {
    const parsed = await parser.parseURL(googleNewsUrl(topic, countryCode));
    const items = (parsed.items || []).slice(0, limit).map(item => {
      const title = item.title || "";
      // Google News antepone "Titular - Fuente" al final del título
      const parts = title.split(" - ");
      const sourceName = parts.length > 1 ? parts.pop().trim() : "Google News";
      return {
        title,
        content: item.contentSnippet || item["content:encoded"] || item.content || "",
        source_name: sourceName,
        published_at: item.pubDate || item.isoDate || null,
      };
    });
    const términosAceptables = [topic, ...términosReales].filter(Boolean);
    const sobreviven = items.filter((item) => esRelevante(item, términosAceptables));
    return filtrarRelevanciaIA(sobreviven, topic);
  } catch (e) {
    console.error("[RSS] Error en búsqueda live de:", topic, e.message);
    return [];
  }
}

// ─── Búsqueda de videos en YouTube para un tema libre ──────────────────────────
// search.list tiene un tope real de 50 resultados POR LLAMADA (lo impone
// Google, no nosotros) — para temas muy mediáticos (ej. un presidente) eso se
// sentía como "solo hay 50 videos reales de este tema" cuando en realidad
// solo pedíamos una página. Aquí se pagina con pageToken hasta `limit` o
// hasta 3 páginas (150 videos), lo que llegue primero — cada página cuesta
// otras 100 unidades de cuota, así que no se pagina sin límite.
const YOUTUBE_MAX_PAGINAS = 3;
// Cuota real de Google: 10,000 unidades/día gratis, ~100-200 por proyecto
// analizado (1-2 páginas). Con ~12+ proyectos reales corriendo cada 2h (cron),
// la demanda real supera la cuota gratuita bastante antes de que termine el
// día — confirmado en vivo: "Quota exceeded for quota metric 'Search Queries'
// ... per day" en la mitad de las corridas de un proyecto real (Salomón Jara
// Cruz, id 46). Mismo patrón de caché por tema que ya usa Perplexity: si el
// mismo tema (mismo país/idioma) se volvió a pedir hace menos de
// YOUTUBE_CACHE_MIN, se reusa la respuesta real en vez de gastar cuota de
// nuevo — 4h cubre 2 corridas de cron por cada llamada real, cortando el
// gasto a la mitad sin perder frescura real (los videos de ayer siguen
// siendo reales hoy).
const YOUTUBE_CACHE_MIN = parseInt(process.env.YOUTUBE_CACHE_MIN || "240");
// `order=relevance` rankea por qué tan relevante es el video para el término
// de búsqueda — NUNCA por fecha, así que un video de hace años pero muy
// "relevante" por palabras clave entra igual que uno de ayer. Caso real
// (correcciones-1-octubre, punto C10): 3 videos de 2011-2013 ("The Wanted",
// "Dover", una canción infantil) colaron en proyectos reales por este
// mecanismo — se borraron a mano en su momento sin arreglar la causa. A
// diferencia de Instagram/Facebook (donde Brave genuinamente no tiene forma
// de dar una fecha), la propia API de YouTube SÍ soporta acotar por fecha
// (`publishedAfter`, RFC 3339) — 120 días da margen holgado sobre la ventana
// máxima real que ofrece la UI (90 días, ver DIAS_PERIODO en Infografía) sin
// arriesgar cortar cobertura legítima todavía vigente.
const YOUTUBE_DIAS_MAXIMOS = 120;
// `términosReales` (2026-10-02, cierre de brecha final: YouTube era uno de
// los 2 únicos motores sin ningún filtro de relevancia-IA — y es EXACTAMENTE
// el motor implicado en el incidente original de SEMARNAT ("GPO" → Roblox).
// `topic` aquí puede ser topicYoutube, un string compuesto con "|" (ver
// server.js) que nunca aparece literal en un video real — por eso el
// pipeline real manda términosReales=[topic limpio, ...aliasProyecto] y eso
// es lo que se usa para el match, no el parámetro `topic`. La ruta de
// búsqueda libre (/api/search-live) no manda términosReales, así que cae al
// único término real que sí tiene: el texto libre que escribió el usuario.
export async function fetchYouTubeForTopic(topic, limit = 10, countryCode = "MX", language = "es", términosReales = []) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  const topicHash = hashTema(`${topic}|${countryCode}|${language}`);
  const cached = await getCachedSearch(topicHash, "youtube", YOUTUBE_CACHE_MIN);
  if (cached) {
    try { return JSON.parse(cached.response_json).slice(0, limit); } catch {}
  }

  let resultados = [];
  let pageToken = "";
  let páginas = 0;
  try {
    do {
      const restante = limit - resultados.length;
      if (restante <= 0) break;
      const maxResults = Math.min(restante, 50);
      const publishedAfter = new Date(Date.now() - YOUTUBE_DIAS_MAXIMOS * 24 * 60 * 60 * 1000).toISOString();
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=relevance&publishedAfter=${encodeURIComponent(publishedAfter)}&maxResults=${maxResults}&relevanceLanguage=${encodeURIComponent(language)}&regionCode=${encodeURIComponent(String(countryCode).toUpperCase())}&q=${encodeURIComponent(topic)}&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) {
        const cuerpo = await res.text();
        console.error("[YouTube] Error HTTP:", res.status, cuerpo);
        await reportarFalloProveedor("YouTube", res.status, cuerpo);
        break;
      }
      const json = await res.json();
      resultados.push(...(json.items || []).map(item => ({
        title: item.snippet?.title || "",
        content: item.snippet?.description || "",
        source_name: item.snippet?.channelTitle || "YouTube",
        published_at: item.snippet?.publishedAt || null,
        url: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : null,
        _videoId: item.id?.videoId || null,
      })));
      pageToken = json.nextPageToken || "";
      páginas++;
    } while (pageToken && páginas < YOUTUBE_MAX_PAGINAS && resultados.length < limit);

    // search.list (arriba) nunca trae vistas reales — es un endpoint distinto
    // a propósito en la API de YouTube. Sin esto, `reach` quedaba null en el
    // 100% de las menciones de YouTube (0 de 711 reales medidas, confirmado
    // en producción) aunque el dato es público y gratis de pedir. videos.list
    // con part=statistics sí las trae, hasta 50 ids por llamada (misma cuota
    // que una sola búsqueda), así que se piden todas juntas en una sola
    // llamada extra por tanda de resultados.
    const idsConVideo = resultados.filter(r => r._videoId).map(r => r._videoId);
    if (idsConVideo.length > 0) {
      try {
        const vistasPorId = new Map();
        // videos.list acepta máximo 50 ids por llamada (igual que search.list
        // resultados por página) — se pide en tandas cuando limit > 50.
        for (let i = 0; i < idsConVideo.length; i += 50) {
          const tanda = idsConVideo.slice(i, i + 50);
          const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${tanda.join(",")}&key=${apiKey}`;
          const statsRes = await fetch(statsUrl);
          if (!statsRes.ok) continue;
          const statsJson = await statsRes.json();
          for (const v of statsJson.items || []) {
            vistasPorId.set(v.id, v.statistics?.viewCount ?? null);
          }
        }
        for (const r of resultados) {
          const vistas = r._videoId ? vistasPorId.get(r._videoId) : null;
          if (vistas != null) r.reach = String(vistas);
        }
      } catch (e) {
        console.error("[YouTube] Error pidiendo estadísticas:", e.message);
      }
    }
    for (const r of resultados) delete r._videoId;

    const términosAceptables = términosReales.length ? términosReales : [topic];
    const sobreviven = resultados.filter((item) => esRelevante(item, términosAceptables));
    resultados = await filtrarRelevanciaIA(sobreviven, términosAceptables[0]);

    if (resultados.length > 0) {
      saveCachedSearch(topicHash, "youtube", JSON.stringify(resultados)).catch(() => {});
    }
  } catch (e) {
    console.error("[YouTube] Error en búsqueda de:", topic, e.message);
  }
  return resultados;
}

// ─── Búsqueda de tweets recientes en X / Twitter para un tema libre ──────────
// Requiere TWITTER_BEARER_TOKEN (auth solo-app, plan de pago por consumo).
// search/recent solo cubre los últimos 7 días y exige max_results entre 10-100.
// `términosReales` (2026-10-02, mismo pedido que GDELT/Perplexity) — X
// garantiza recencia real (search/recent solo cubre 7 días), pero eso no
// protege contra un tuit que solo menciona el término de pasada, sin
// relación real con el tema — mismo riesgo de colisión de palabras que ya
// se confirmó real en otros motores (ej. "Salomon" la marca vs. "Salomón
// Jara" la persona).
export async function fetchTwitterForTopic(topic, limit = 20, language = "es", términosReales = []) {
  const token = process.env.TWITTER_BEARER_TOKEN;
  if (!token) return [];
  try {
    const query = `${topic} lang:${language} -is:retweet`;
    const maxResults = Math.min(Math.max(limit, 10), 100);
    const url = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${maxResults}&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,name`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const cuerpo = await res.text();
      console.error("[Twitter] Error HTTP:", res.status, cuerpo);
      await reportarFalloProveedor("X (Twitter)", res.status, cuerpo);
      return [];
    }
    const json = await res.json();
    const users = new Map((json.includes?.users || []).map(u => [u.id, u]));
    const tweets = (json.data || []).map(tw => {
      const user = users.get(tw.author_id);
      const username = user?.username || null;
      // La API real de X sí trae interacciones reales (like/retweet/reply/quote
      // count) en public_metrics — antes se pedían pero nunca se guardaban:
      // "reach" se llenaba con impression_count (o like_count como respaldo
      // ambiguo, mezclando alcance con interacción), y engagement_score se
      // dejaba sin mandar, así que saveMentionRaw lo guardaba NULL para cada
      // tweet real. Facebook/Instagram-vía-buscador nunca van a tener este
      // dato (no lo expone ningún buscador), pero X sí lo tenía disponible y
      // se estaba tirando.
      const métricas = tw.public_metrics || {};
      const interacciones =
        (métricas.like_count ?? 0) +
        (métricas.retweet_count ?? 0) +
        (métricas.reply_count ?? 0) +
        (métricas.quote_count ?? 0);
      return {
        title: (tw.text || "").slice(0, 120),
        content: tw.text || "",
        source_name: username ? `@${username}` : "X / Twitter",
        source_type: "twitter",
        author_name: user?.name || null,
        published_at: tw.created_at || null,
        reach: métricas.impression_count ?? null,
        engagement_score: interacciones > 0 ? interacciones : null,
        url: username ? `https://x.com/${username}/status/${tw.id}` : null,
      };
    });
    const términosAceptables = [topic, ...términosReales].filter(Boolean);
    const sobreviven = tweets.filter((item) => esRelevante(item, términosAceptables));
    return filtrarRelevanciaIA(sobreviven, topic);
  } catch (e) {
    console.error("[Twitter] Error en búsqueda de:", topic, e.message);
    return [];
  }
}

// ─── Búsqueda con IA + web en vivo vía Perplexity (Sonar) ─────────────────────
// Requiere PERPLEXITY_API_KEY. Devuelve las fuentes reales citadas por el
// modelo (search_results si están disponibles, si no cae a citations).
// Cachea la respuesta cruda por tema normalizado durante PERPLEXITY_CACHE_MIN
// (default 4h) — si "Analizar ahora" se repite para el mismo tema dentro de
// esa ventana, se reusa en vez de volver a pagar la llamada. Las noticias no
// cambian minuto a minuto, así que la ventana no le cuesta frescura real.
const PERPLEXITY_CACHE_MIN = parseInt(process.env.PERPLEXITY_CACHE_MIN || "240");

// `términosReales` (2026-10-02, mismo pedido que GDELT) — Perplexity ya le
// pide a la IA "fuentes reales y recientes" en el propio prompt, pero eso no
// es un filtro verificable, es solo una instrucción que el modelo puede
// seguir mal — el segundo filtro aquí sí lo es.
export async function fetchPerplexityForTopic(topic, limit = 10, términosReales = []) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];

  const topicHash = hashTema(topic);
  const cached = await getCachedSearch(topicHash, "perplexity", PERPLEXITY_CACHE_MIN);
  if (cached) {
    try { return JSON.parse(cached.response_json).slice(0, limit); } catch {}
  }

  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "Eres un asistente de monitoreo de medios en México. Responde en español citando únicamente fuentes reales y recientes." },
          { role: "user", content: `Menciones, noticias y opinión pública recientes sobre: ${topic}. Resume brevemente qué se dice y en qué medios.` },
        ],
      }),
    });
    if (!res.ok) {
      const cuerpo = await res.text();
      console.error("[Perplexity] Error HTTP:", res.status, cuerpo);
      await reportarFalloProveedor("Perplexity", res.status, cuerpo);
      return [];
    }
    const json = await res.json();
    const results = json.search_results?.length
      ? json.search_results
      : (json.citations || []).map(url => ({ url }));

    const mapeadas = results.slice(0, limit).map(r => {
      let sourceName = "Perplexity";
      try { sourceName = new URL(r.url).hostname.replace(/^www\./, ""); } catch {}
      return {
        title: r.title || `Mención relacionada con "${topic}"`,
        content: r.snippet || "",
        source_name: sourceName,
        source_type: "web",
        published_at: r.date || null,
        url: r.url || null,
      };
    }).filter(r => r.url);

    const términosAceptables = [topic, ...términosReales].filter(Boolean);
    const sobreviven = mapeadas.filter((item) => esRelevante(item, términosAceptables));
    const relevantes = await filtrarRelevanciaIA(sobreviven, topic);

    saveCachedSearch(topicHash, "perplexity", JSON.stringify(relevantes)).catch(() => {});
    return relevantes;
  } catch (e) {
    console.error("[Perplexity] Error en búsqueda de:", topic, e.message);
    return [];
  }
}

// ─── Búsqueda de archivo histórico de noticias en GDELT (sin clave) ───────────
// HTTP, no HTTPS: desde este servidor el puerto 443 hacia la IP de GDELT se
// cae por timeout de red (confirmado con curl), pero el 80 responde bien con
// la misma API real — sin credenciales de por medio, así que no hay riesgo de
// seguridad en usar HTTP aquí. Si GDELT algún día arregla su TLS o cambia de
// IP, esto puede volver a https.
// `términosReales` (2026-10-02, pedido explícito del cliente): GDELT nunca
// tuvo el filtro de relevancia que ya protege a los motores sociales desde
// el caso real de Instagram/"Christian Bale" — mismo riesgo de fondo (una
// búsqueda de texto trae lo que su propio ranking considera "parecido", no
// necesariamente relacionado de verdad), nunca confirmado como bug real
// aquí pero tampoco auditado hasta ahora.
export async function fetchGdeltForTopic(topic, limit = 75, days = 90, términosReales = []) {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "");
    const url = `http://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${topic}"`)}&mode=artlist&format=json&maxrecords=${limit}&startdatetime=${fmt(start)}&enddatetime=${fmt(end)}&sort=hybridrel`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[GDELT] Error HTTP:", res.status);
      return [];
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return []; } // GDELT devuelve texto plano si hay rate-limit
    const items = (json.articles || []).slice(0, limit).map(a => {
      const seen = String(a.seendate || "");
      const iso = seen.length === 15
        ? `${seen.slice(0,4)}-${seen.slice(4,6)}-${seen.slice(6,8)}T${seen.slice(9,11)}:${seen.slice(11,13)}:${seen.slice(13,15)}Z`
        : null;
      return {
        title: a.title || "",
        content: "",
        source_name: a.domain || "GDELT",
        published_at: iso,
        url: a.url || null,
      };
    });
    const términosAceptables = [topic, ...términosReales].filter(Boolean);
    const sobreviven = items.filter((item) => esRelevante(item, términosAceptables));
    return filtrarRelevanciaIA(sobreviven, topic);
  } catch (e) {
    console.error("[GDELT] Error en búsqueda de:", topic, e.message);
    return [];
  }
}

// ─── Directorio de medios reales de Hidalgo (portales, TV, radio con web) ─────
// Sirve para CUALQUIER proyecto/tema analizado, no es exclusivo de un político.
// Fuente: directorio de medios de Hidalgo proporcionado por el cliente (URLs
// oficiales confirmadas). Medios sin URL oficial confirmada (Hidalgo Hoy
// Noticias, Agenda Hidalguense, Hidalgo en Línea, La Comadre, Radio Crystal,
// etc.) se omiten para no inventar dominios.
const HIDALGO_MEDIA_DOMAINS = [
  // Medios propios / afiliados (prioridad máxima)
  "elmundomx.com",                // El Mundo México
  "mundoejecutivocdmx.com",       // Mundo Ejecutivo CDMX
  "elmundopueblo.com",            // El Mundo Pueblo
  "laopiniondehidalgo.com.mx",    // La Opinión de Hidalgo
  "grupohoymexico.com",           // Grupo Hoy México (Hidalgo Hoy Noticias)
  // Portales e impresos (dominios verificados por el cliente, jul-2026)
  "criteriohidalgo.com",          // Criterio Hidalgo
  "hidalgo.quadratin.com.mx",     // Quadratín Hidalgo
  "oem.com.mx",                   // El Sol de Hidalgo (red OEM)
  "agendahidalguense.com",        // Agenda Hidalguense
  "newshidalgo.com.mx",           // News Hidalgo
  "subrayado.com.mx",             // Subrayado Hidalgo
  "hidalgoenlinea.com.mx",        // Hidalgo en Línea
  "plazajuarez.mx",               // Plaza Juárez
  "independientedehidalgo.com.mx",// El Independiente de Hidalgo
  "cronicahidalgo.com",           // La Crónica de Hoy en Hidalgo
  "sintesis.com.mx",              // Síntesis Hidalgo
  "puntoporpuntonoticias.mx",     // Punto por Punto
  "lasillarota.com",              // La Silla Rota Hidalgo (/hidalgo)
  // Televisión
  "radioytelevision.hidalgo.gob.mx", // RTVH (TV y radio del estado)
  "tvazteca.com",                 // TV Azteca Hidalgo / Azteca Uno
  "televisa.com",                 // Televisa Pachuca
  "imagentv.com",                 // Imagen Televisión
  "uaeh.edu.mx",                  // SUMA TV / Radio UAEH
  "canalcatorce.tv",              // SPR — Canal Catorce
  "tvcablehidalguense.com",       // TV Cable Hidalguense
  // Radio
  "nqradio.com",                  // NQ Radio 640 AM
  "lacomadre.mx",                 // La Comadre Pachuca 104.5
  "mixfm.mx",                     // Mix 92.5 FM
  "tulancingo.ultralaradio.mx",   // Ultra 102.9 Tulancingo
  "radiocrystal.mx",              // Radio Crystal Pachuca
  "kebuenahidalgo.com.mx",        // Ke Buena Hidalgo
  "lamejor.com.mx",               // La Mejor (cadena nacional)
  "planetaradio.mx",              // Planeta 104.9
  "los40.com.mx",                 // Los 40 Pachuca (cadena nacional)
  "wradio.com.mx",                // W Radio Pachuca (cadena nacional)
  "exafm.com",                    // Exa FM Pachuca (cadena nacional)
  "e-radio.edu.mx",               // Radio Educación (cadena nacional)
  "ecos.inpi.gob.mx",             // La Voz del Pueblo Hñähñu
];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function fetchHidalgoMediaForTopic(topic, limit = 20, términosReales = []) {
  const groups = chunk(HIDALGO_MEDIA_DOMAINS, 5);
  try {
    const grouped = await Promise.all(groups.map(async (domains) => {
      const siteFilter = domains.map(d => `site:${d}`).join(" OR ");
      const query = `${topic} (${siteFilter})`;
      try {
        const parsed = await parser.parseURL(googleNewsUrl(query));
        return (parsed.items || []).map(item => {
          const title = item.title || "";
          const parts = title.split(" - ");
          const sourceName = parts.length > 1 ? parts.pop().trim() : "Medios de Hidalgo";
          return {
            title,
            content: item.contentSnippet || item["content:encoded"] || item.content || "",
            source_name: sourceName,
            published_at: item.pubDate || item.isoDate || null,
            url: item.link || item.guid || null,
          };
        });
      } catch {
        return [];
      }
    }));

    const seen = new Set();
    const merged = [];
    for (const item of grouped.flat()) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      merged.push(item);
    }
    const términosAceptables = [topic, ...términosReales].filter(Boolean);
    const sobreviven = merged.slice(0, limit).filter((item) => esRelevante(item, términosAceptables));
    return filtrarRelevanciaIA(sobreviven, topic);
  } catch (e) {
    console.error("[HidalgoMedia] Error en búsqueda de:", topic, e.message);
    return [];
  }
}

// ─── Búsqueda web general vía Google Custom Search (blogs, foros, etc.) ──────
export async function fetchWebSearchForTopic(topic, limit = 10, countryCode = "MX", language = "es") {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx) return [];
  try {
    const { gl } = localePaís(countryCode);
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(topic)}&num=${Math.min(limit, 10)}&gl=${gl}&hl=${encodeURIComponent(language)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[WebSearch] Error HTTP:", res.status, await res.text());
      return [];
    }
    const json = await res.json();
    return (json.items || []).map(item => ({
      title: item.title || "",
      content: item.snippet || "",
      source_name: item.displayLink || "Web",
      published_at: null,
      url: item.link || null,
    }));
  } catch (e) {
    console.error("[WebSearch] Error en búsqueda de:", topic, e.message);
    return [];
  }
}

// ─── Facebook/Instagram vía Google Custom Search ─────────────────────────────
// Meta no ofrece una API pública para buscar menciones propias en todo
// Facebook/Instagram (a diferencia de X) — solo deja leer páginas que el
// propio cliente conecte y autorice. Lo que sí es real: contenido público de
// esas plataformas que Google ya indexó. Instagram lo indexa muy poco (Meta
// bloquea el rastreo de posts individuales), así que esta fuente
// típicamente trae más Facebook que Instagram — eso es honesto, no un bug.
export async function fetchSocialWebForTopic(topic, limit = 10, countryCode = "MX", language = "es") {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx) return [];
  try {
    const { gl } = localePaís(countryCode);
    const q = `${topic} (site:facebook.com OR site:instagram.com)`;
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(q)}&num=${Math.min(limit, 10)}&gl=${gl}&hl=${encodeURIComponent(language)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[SocialWeb] Error HTTP:", res.status, await res.text());
      return [];
    }
    const json = await res.json();
    return (json.items || []).map(item => ({
      title: item.title || "",
      content: item.snippet || "",
      source_name: item.displayLink || "Web",
      published_at: null,
      url: item.link || null,
    }));
  } catch (e) {
    console.error("[SocialWeb] Error en búsqueda de:", topic, e.message);
    return [];
  }
}

// ─── Búsqueda web general vía Brave Search ───────────────────────────────────
// Reemplaza a fetchWebSearchForTopic (Google Custom Search) como fuente real
// de "Búsqueda web": ese buscador de Google quedó restringido a solo 2 sitios
// de Hidalgo (lajornadahidalgo.com, adn40.mx) — inútil para proyectos de otros
// países — y además su API JSON seguía dando 403 pese a tener todo bien
// configurado (facturación activa, API habilitada, key correcta). Brave sí
// busca en toda la web de verdad, sin esa restricción.
// Brave resalta los términos de búsqueda con <strong> dentro de title/description.
function limpiarHtml(texto) {
  return String(texto || "").replace(/<\/?[a-z][^>]*>/gi, "");
}

// Instagram/Facebook devuelven esta descripción genérica de "inicia sesión"
// a CUALQUIER visitante sin cuenta — incluido el propio rastreador de Brave,
// que entonces indexa el post con ese texto de relleno en vez del contenido
// real. Caso real (2026-10-02): un post real de Alicia Bárcena de hace 67
// semanas coló en el proyecto de SEMARNAT por esta vía — Brave no da ninguna
// fecha para resultados de Instagram (confirmado contra la API real: age/
// page_age/date vienen todos ausentes), así que un post así de viejo es
// indistinguible de uno reciente. Sin contenido real ni fecha, no hay forma
// honesta de verificar nada sobre el post — se descarta en vez de arriesgar
// mostrar contenido potencialmente desactualizado como si fuera actual.
const DESCRIPCIONES_MURO_LOGIN = [
  "create an account or log in to instagram",
  "crea una cuenta o inicia sesión en instagram",
  "log in to facebook",
  "inicia sesión en facebook",
];
function esMuroDeLogin(texto) {
  const t = String(texto || "").toLowerCase();
  return DESCRIPCIONES_MURO_LOGIN.some((patrón) => t.includes(patrón));
}

async function fetchBrave(query, limit, countryCode, language) {
  const token = process.env.BRAVE_SEARCH_API_KEY;
  if (!token) return [];
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&country=${encodeURIComponent(countryCode)}&search_lang=${encodeURIComponent(language)}&count=${Math.min(limit, 20)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": token },
    });
    if (!res.ok) {
      const cuerpo = await res.text();
      console.error("[Brave] Error HTTP:", res.status, cuerpo);
      await reportarFalloProveedor("Brave", res.status, cuerpo);
      return [];
    }
    const json = await res.json();
    return (json.web?.results || [])
      .filter(item => !esMuroDeLogin(item.description))
      .map(item => {
        let dominio = "Web";
        try { dominio = new URL(item.url).hostname; } catch {}
        return {
          title: limpiarHtml(item.title),
          content: limpiarHtml(item.description),
          source_name: dominio,
          published_at: item.age && !isNaN(Date.parse(item.age)) ? item.age : null,
          url: item.url || null,
        };
      });
  } catch (e) {
    console.error("[Brave] Error en búsqueda de:", query, e.message);
    return [];
  }
}

// `términosReales` (2026-10-02, mismo pedido que GDELT/Perplexity/Twitter)
// — a diferencia de fetchBraveSocialForTopic (restringido a site:facebook/
// instagram/tiktok, ya con este filtro), esta es la búsqueda web ABIERTA —
// el riesgo de colisión de palabras es si acaso mayor aquí, nunca tuvo el
// filtro hasta ahora.
export async function fetchBraveWebForTopic(topic, limit = 10, countryCode = "MX", language = "es", términosReales = []) {
  const items = await fetchBrave(topic, limit, countryCode, language);
  const términosAceptables = [topic, ...términosReales].filter(Boolean);
  const sobreviven = items.filter((item) => esRelevante(item, términosAceptables));
  return filtrarRelevanciaIA(sobreviven, topic);
}

// Mismo criterio que fetchSocialWebForTopic (Google): contenido público de
// Facebook/Instagram/TikTok que Brave ya indexó — ninguna de las tres tiene
// una API oficial para buscar menciones propias en toda la plataforma (la de
// TikTok es solo para investigación académica aprobada).
// Antes esto era UNA sola búsqueda con "site:facebook.com OR site:instagram.com
// OR site:tiktok.com" — Facebook (mejor indexado) le ganaba el espacio a
// Instagram en el ranking de Brave, dejando a Instagram con solo su página de
// perfil/bio en vez de publicaciones reales. Separado en 3 búsquedas
// independientes, Instagram sí trae posts/reels reales (confirmado: sin la
// competencia de Facebook, Brave devuelve URLs /p/ y /reel/ reales, no solo
// perfiles) — cuesta 3 llamadas a la API en vez de 1, pero es la única forma
// de que las tres plataformas tengan representación real.
// `términosReales` (2026-10-01): caso real reportado por el cliente — un
// reel de Instagram sobre un perro perdido ("Vicentito") colando en el
// proyecto de SEMARNAT/Alicia Bárcena. Causa real: para una búsqueda tan
// restringida como "site:instagram.com", Brave tiene pocos resultados
// exactos de verdad y rellena el resto con contenido indexado que su propio
// ranking considera "parecido" (no literal basura, pero sin relación real
// con el tema) — mismo problema de fondo que ya se arregló en
// fetchSocialCrawlForTopic (ver esRelevante), nunca extendido a Brave. Se
// filtra igual: exige que el texto real mencione al menos un término real
// del proyecto antes de aceptar el resultado.
export async function fetchBraveSocialForTopic(topic, limit = 10, countryCode = "MX", language = "es", términosReales = []) {
  const porRed = Math.max(5, Math.ceil(limit / 3));
  const [facebook, instagram, tiktok] = await Promise.all([
    fetchBrave(`${topic} site:facebook.com`, porRed, countryCode, language),
    fetchBrave(`${topic} site:instagram.com`, porRed, countryCode, language),
    fetchBrave(`${topic} site:tiktok.com`, porRed, countryCode, language),
  ]);
  const términosAceptables = [topic, ...términosReales].filter(Boolean);
  const sobreviven = [...facebook, ...instagram, ...tiktok].filter((item) => esRelevante(item, términosAceptables));
  return filtrarRelevanciaIA(sobreviven, topic);
}

// Google a veces muestra en "displayed_link" una cifra real de interacción
// para posts de Facebook muy compartidos, p.ej. "Más de 6.5 k reacciones ·
// hace 4 días" — es la ÚNICA señal de engagement real que este camino puede
// dar (SerpApi/Google no expone likes/comentarios/compartidos por separado,
// solo este texto libre, y no todos los resultados lo traen). Se parsea de
// forma best-effort; si no hay match, reach queda null como antes.
function parseReaccionesDeDisplayedLink(displayedLink) {
  if (!displayedLink || typeof displayedLink !== "string") return null;
  const conSufijo = displayedLink.match(/([\d]+(?:[.,]\d+)?)\s*([kKmM])\s*(reacciones|me gusta|vistas|views|reactions)/);
  if (conSufijo) {
    const numero = parseFloat(conSufijo[1].replace(",", "."));
    const multiplicador = /m/i.test(conSufijo[2]) ? 1_000_000 : 1_000;
    return Math.round(numero * multiplicador);
  }
  const sinSufijo = displayedLink.match(/([\d][\d.,]*\d|\d)\s*(reacciones|me gusta|vistas|views|reactions)/i);
  if (sinSufijo) {
    const limpio = sinSufijo[1].replace(/[.,]/g, "");
    const numero = parseInt(limpio, 10);
    return Number.isFinite(numero) ? numero : null;
  }
  return null;
}

// ─── Facebook/Instagram/TikTok vía SerpApi (Google real) ─────────────────────
// Segundo motor independiente de fetchBraveSocialForTopic — mismo principio
// (nadie tiene API oficial de búsqueda para las tres plataformas), pero
// consultando el índice real de Google en vez del de Brave, que a veces
// encuentra contenido que Brave no tiene indexado. Google envuelve algunos
// resultados (sobre todo de Instagram) en un link de tracking "/goto?url=..."
// que no es la URL real y no se puede resolver sin un navegador headless —
// se descartan esos en vez de guardar una URL falsa/rota.
async function fetchSerpApi(query, limit, countryCode, language) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return [];
  try {
    const params = new URLSearchParams({
      engine: "google",
      q: query,
      gl: (countryCode || "MX").toLowerCase(),
      hl: language || "es",
      num: String(Math.min(limit, 20)),
      api_key: apiKey,
    });
    const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
    if (!res.ok) {
      const cuerpo = await res.text();
      console.error("[SerpApi] Error HTTP:", res.status, cuerpo);
      await reportarFalloProveedor("SerpApi", res.status, cuerpo);
      return [];
    }
    const json = await res.json();
    if (json.error) {
      console.error("[SerpApi] Error:", json.error);
      await reportarFalloProveedor("SerpApi", 429, String(json.error));
      return [];
    }
    return (json.organic_results || [])
      .filter(item => typeof item.link === "string" && item.link.startsWith("http"))
      .filter(item => !esMuroDeLogin(item.snippet))
      .map(item => {
        let dominio = "Web";
        try { dominio = new URL(item.link).hostname; } catch {}
        return {
          title: item.title || "",
          content: item.snippet || "",
          source_name: dominio,
          published_at: null,
          url: item.link,
          reach: parseReaccionesDeDisplayedLink(item.displayed_link),
        };
      });
  } catch (e) {
    console.error("[SerpApi] Error en búsqueda de:", query, e.message);
    return [];
  }
}

// Facebook es la ÚNICA vía real para esa plataforma — no existe SocialCrawl
// para Facebook (sin API pública de búsqueda orgánica de posts, confirmado:
// solo Ad Library/Marketplace/Eventos), así que depende 100% de lo que
// Google ya indexó vía este site:facebook.com. Instagram/TikTok SÍ tienen
// una vía mejor (SocialCrawl, scraping directo de la plataforma con
// engagement real) — antes se repartía el cupo de resultados parejo entre
// las 3 redes, dejándole a Facebook el mismo cupo chico que a las otras dos
// que ya están cubiertas por otro lado. Caso real que destapó esto
// (2026-09-30): un video de Facebook con 14,500 likes/4,400 compartidos
// sobre Salomón Jara, YA indexado por Google, nunca entraba porque el cupo
// de Facebook (≈7 de 20) se llenaba con resultados menos relevantes antes
// de llegar a ese. Ahora Facebook se lleva la mayor parte del presupuesto.
// `términosReales` (2026-10-01): mismo arreglo real que fetchBraveSocialForTopic
// — site:instagram.com/site:tiktok.com/site:facebook.com son búsquedas tan
// restringidas que el buscador (aquí Google vía SerpApi) a veces rellena con
// contenido indexado sin relación real con el tema en vez de dejar pocos
// resultados. Se exige que el texto real mencione al menos un término real
// del proyecto.
export async function fetchSerpApiSocialForTopic(topic, limit = 10, countryCode = "MX", language = "es", términosReales = []) {
  const cupoFacebook = Math.max(10, limit);
  const cupoOtros = Math.max(3, Math.ceil(limit / 5));
  const [facebook, instagram, tiktok] = await Promise.all([
    fetchSerpApi(`${topic} site:facebook.com`, cupoFacebook, countryCode, language),
    fetchSerpApi(`${topic} site:instagram.com`, cupoOtros, countryCode, language),
    fetchSerpApi(`${topic} site:tiktok.com`, cupoOtros, countryCode, language),
  ]);
  const términosAceptables = [topic, ...términosReales].filter(Boolean);
  const sobreviven = [...facebook, ...instagram, ...tiktok].filter((item) => esRelevante(item, términosAceptables));
  return filtrarRelevanciaIA(sobreviven, topic);
}

// ─── Instagram/TikTok/Facebook vía SocialCrawl (scraping directo de la plataforma) ────
// A diferencia de Brave/SerpApi (que leen lo que un buscador ya indexó),
// SocialCrawl consulta directo la búsqueda interna de cada plataforma — trae
// posts reales con fecha y engagement que ningún buscador tenía indexado.
// CORRECCIÓN (2026-09-30): el comentario anterior decía que Facebook no tenía
// ningún endpoint de búsqueda de posts orgánicos "ni aquí" — eso era falso o
// quedó desactualizado. GET /v1/facebook/search/posts SÍ existe y trae, por
// post: likes/comments/shares reales, desglose de reacciones (like/love/
// haha/care...), autor y fecha real de publicación — verificado en vivo
// contra la API real, no contra la documentación. `shares` viene null en la
// práctica (Facebook dejó de exponer ese conteo hace tiempo, no es un bug
// nuestro). Se filtra a publicaciones de los últimos 7 días — a diferencia
// de Instagram/TikTok, una búsqueda de Facebook por nombre trae de forma
// rutinaria contenido de meses atrás que infla el histórico sin aportar
// nada a "qué está pasando ahora" (pedido explícito del usuario).
// Nombres de campo alineados con saveMentionRaw (source_name/published_at,
// no source/date) — antes no coincidían, así que estas menciones SÍ se
// guardaban pero quedaban con source_name null, published_at null y
// source_type cayendo al default "rss", indistinguibles del resto de RSS.
// thumbnail_url/engagement_score (views+likes reales) tampoco se leían de la
// respuesta aunque la API real sí los trae — se perdían sin usarse.
// author_name tampoco se leía — sin esto, resolverAuthorId (clasificación en
// vivo de proyectos 40/41) recibía siempre null y nunca creaba autores reales
// para contenido de SocialCrawl.
// TikTok e Instagram firman sus URLs de miniatura con vencimiento de pocas
// horas (x-expires) — si guardamos el link tal cual, la imagen se rompe sola
// (403) al poco rato aunque el análisis siga fresco. Se descarga una sola vez
// y se sirve desde nuestro propio dominio (ver app.use("/media-cache", ...)
// en server.js), así la miniatura sobrevive para siempre sin depender del CDN
// original.
const MEDIA_CACHE_DIR = nodePath.join(process.cwd(), "media-cache");

export async function descargarYCachearImagen(url) {
  if (!url) return null;
  try {
    const hash = createHash("sha256").update(url).digest("hex");
    const archivo = `${hash}.jpg`;
    const rutaLocal = nodePath.join(MEDIA_CACHE_DIR, archivo);
    try {
      await fs.access(rutaLocal);
      return `/media-cache/${archivo}`;
    } catch {}
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(MEDIA_CACHE_DIR, { recursive: true });
    await fs.writeFile(rutaLocal, buffer);
    return `/media-cache/${archivo}`;
  } catch (e) {
    console.error("[media-cache] Error descargando imagen:", e.message);
    return null;
  }
}

async function fetchSocialCrawl(path, params, plataforma) {
  const apiKey = process.env.SOCIALCRAWL_API_KEY;
  if (!apiKey) return [];
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`https://www.socialcrawl.dev/v1/${path}?${qs}`, {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) {
      const cuerpo = await res.text();
      console.error("[SocialCrawl] Error HTTP:", res.status, cuerpo);
      await reportarFalloProveedor("SocialCrawl", res.status, cuerpo);
      return [];
    }
    const json = await res.json();
    if (!json.success) {
      console.error("[SocialCrawl] Error:", json);
      return [];
    }
    return Promise.all((json.data?.items || []).map(item => mapearItemSocialCrawl(item, plataforma)));
  } catch (e) {
    console.error("[SocialCrawl] Error en búsqueda:", path, e.message);
    return [];
  }
}

// thumbnail_url vive dentro de post.content, y views/likes/comments/shares
// dentro de post.engagement — no al nivel de post directo (confirmado
// contra la respuesta real de la API, no supuesto por el nombre del
// campo). shares suele venir null para Facebook/Twitter (la plataforma
// dejó de exponer ese conteo públicamente) pero SÍ viene real en
// instagram/profile/posts/full (verificado en vivo 2026-09-30) — mismo
// mapeo sirve para ambos casos sin cambios.
async function mapearItemSocialCrawl(item, plataforma) {
  const post = item.post || {};
  const views = Number(post.engagement?.views) || 0;
  const likes = Number(post.engagement?.likes) || 0;
  const comments = Number(post.engagement?.comments) || 0;
  const shares = Number(post.engagement?.shares) || 0;
  const interacciones = views + likes + comments + shares;
  const thumbOriginal = post.content?.thumbnail_url || null;
  const thumbCacheado = await descargarYCachearImagen(thumbOriginal);
  return {
    title: (post.content?.text || "").slice(0, 120),
    content: post.content?.text || "",
    source_name: post.author?.username || post.author?.display_name || "SocialCrawl",
    author_name: post.author?.display_name || post.author?.username || null,
    source_type: plataforma,
    published_at: post.published_at || null,
    url: post.url || null,
    thumbnail_url: thumbCacheado || thumbOriginal,
    engagement_score: interacciones > 0 ? interacciones : null,
  };
}

// Paginado real vía next_cursor — probado en vivo (2026-09-30): 4 páginas de
// "facebook/search/posts" trajeron 16 posts únicos (5+6+4+1) contra 5 de una
// sola llamada — la página 1 sola deja contenido real sin tocar. Rendimiento
// decreciente después de la página 3 (dejó de aportar casi nada), así que se
// para ahí en vez de seguir gastando créditos por resultados marginales.
const MÁXIMO_PÁGINAS_FACEBOOK = 3;

async function fetchFacebookConPaginación(query) {
  const apiKey = process.env.SOCIALCRAWL_API_KEY;
  if (!apiKey) return [];
  const todos = [];
  let cursor = null;
  for (let página = 1; página <= MÁXIMO_PÁGINAS_FACEBOOK; página++) {
    const params = { query, ...(cursor ? { cursor: JSON.stringify(cursor) } : {}) };
    const qs = new URLSearchParams(params).toString();
    try {
      const res = await fetch(`https://www.socialcrawl.dev/v1/facebook/search/posts?${qs}`, {
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) {
        const cuerpo = await res.text();
        console.error("[SocialCrawl] Error HTTP (facebook paginado):", res.status, cuerpo);
        await reportarFalloProveedor("SocialCrawl", res.status, cuerpo);
        break;
      }
      const json = await res.json();
      if (!json.success) break;
      const items = await Promise.all((json.data?.items || []).map(item => mapearItemSocialCrawl(item, "facebook")));
      todos.push(...items);
      cursor = json.data?.next_cursor || null;
      if (!cursor) break;
    } catch (e) {
      console.error("[SocialCrawl] Error en facebook paginado:", e.message);
      break;
    }
  }
  return todos;
}

// hashtagInstagram/handlesInstagram: opcionales, derivados de las keywords
// reales del proyecto (ver server.js) — sin ellos, estos 2 motores nuevos
// simplemente no corren para ese proyecto en vez de inventar un hashtag o
// handle que no se configuró.
// Ajuste real pedido tras el caso SEMAR/SEMARNAT (cuenta de la Marina
// trackeada para un proyecto de la Secretaría de Medio Ambiente, por
// coincidencia parcial de texto en el propio buscador interno de
// TikTok/Instagram/Facebook — no es un bug nuestro de matching, es que esas
// plataformas hacen búsqueda difusa y a veces regresan contenido con
// relación parcial/nula). Antes se aceptaba CUALQUIER resultado que la
// plataforma regresara para el tema buscado, sin verificar que el texto
// real del post/cuenta mencionara alguno de los términos reales del
// proyecto. Ahora se exige al menos un término real (palabra completa,
// insensible a mayúsculas) en título+contenido+autor/cuenta antes de
// aceptar el resultado — igual de estricto que resolverKeywordMatchId en
// db.js, aplicado aquí en el descubrimiento en vez de solo en la
// atribución posterior.
function escaparRegexSocial(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Mismo arreglo real que resolverKeywordMatchId en db.js (2026-10-01): una
// mención real de "la Secretaría de Medio Ambiente anunció..." no pasaba el
// filtro porque la keyword configurada no lleva tilde ("Secretaria de Medio
// Ambiente") — toLowerCase() no quita acentos, así que nunca hacían match
// aunque sea la misma palabra. Se normaliza quitando diacríticos de ambos
// lados antes de comparar.
function normalizarAcentosSocial(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Mismo arreglo real que patrónPalabraCompleta en db.js (2026-10-01):
// keywords con "#"/"@" al inicio ("#SalomónJara", "#Semarnat", "@salomonj")
// nunca hacían match de verdad — \b no se cumple entre dos caracteres
// no-palabra (el símbolo y el espacio/inicio que lo precede en texto real).
// Se omite \b en el lado que empieza/termina con un símbolo, que ya actúa
// como separador natural por sí mismo.
function patrónPalabraCompletaSocial(términoEscapado, términoOriginal) {
  const bordeIzq = /^\w/.test(términoOriginal) ? "\\b" : "";
  const bordeDer = /\w$/.test(términoOriginal) ? "\\b" : "";
  return new RegExp(`${bordeIzq}${términoEscapado}${bordeDer}`, "i");
}

function esRelevante(item, términosReales) {
  if (!términosReales || términosReales.length === 0) return true;
  const texto = normalizarAcentosSocial(
    `${item.title || ""} ${item.content || ""} ${item.source_name || ""} ${item.author_name || ""}`.toLowerCase(),
  );
  return términosReales.some((término) => {
    const limpio = normalizarAcentosSocial((término || "").trim().toLowerCase());
    if (!limpio) return false;
    return patrónPalabraCompletaSocial(escaparRegexSocial(limpio), limpio).test(texto);
  });
}

// ─── Segunda pasada de relevancia, con IA (2026-10-01) ─────────────────────
// esRelevante (arriba) resuelve "la palabra real NO aparece para nada" (el
// caso más común y más barato de detectar). Pero hay un caso real que esa
// regla NO atrapa: la palabra SÍ aparece, pero de pasada — un hashtag de
// relleno entre varios no relacionados ("#Sheinbaum #Gas #Semarnat" en un
// reel de una feria local), o una cita incidental de un código/norma (una
// foto de un árbol en Arizona citando "NOM-059-SEMARNAT" como dato
// taxonómico). Dos casos reales confirmados, 2026-10-01, en el proyecto de
// SEMARNAT. Distinguir "es el tema real" de "aparece de pasada" requiere
// entender el texto, no solo buscar la palabra — de ahí esta segunda pasada
// con gpt-4o-mini (barato, mismo modelo que ya usa el clasificador de
// sentimiento) ÚNICAMENTE sobre lo que ya sobrevivió el filtro barato de
// arriba, para no pagar IA por el volumen que esRelevante ya descarta gratis.
// Instanciado bajo demanda, no al cargar el módulo — mismo motivo que
// sentiment-classifier.js: los imports se resuelven antes que
// dotenv.config() en server.js, así que crear el cliente aquí arriba
// leería OPENAI_API_KEY todavía sin definir y tronaría el arranque.
let openaiRelevancia = null;
function getOpenAIRelevancia() {
  if (!openaiRelevancia) openaiRelevancia = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiRelevancia;
}

const TAMAÑO_LOTE_RELEVANCIA = 25;

function truncarRelevancia(texto, max) {
  const limpio = (texto || "").trim();
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
}

async function filtrarRelevanciaLoteIA(lote, topic) {
  const items = lote.map((item, i) => ({
    id: i,
    titulo: truncarRelevancia(item.title, 140),
    extracto: truncarRelevancia(item.content, 280),
  }));

  const prompt = `Para cada una de estas publicaciones reales de redes sociales, di si el tema REAL de la publicación es "${topic}" — no solo si la palabra aparece en algún lado.

Responde "relevante": false cuando "${topic}" solo aparece de pasada y el tema real es otra cosa — ejemplos reales: un hashtag de relleno entre varios no relacionados ("#OtroTema #MasTemas #${topic}" en un post sobre algo distinto), una cita incidental de un código/norma/nombre oficial sin relación con la actualidad del tema, o el término compartido por otra persona/entidad distinta.

Responde "relevante": true cuando la publicación de verdad trata sobre "${topic}" (aunque sea un comentario breve, una opinión, o solo mencionado vía hashtag si ese hashtag ES el tema del post).

Publicaciones:
${JSON.stringify(items)}

Responde ÚNICAMENTE este JSON, sin texto adicional ni markdown:
{"relevancia":[{"id":0,"relevante":true}]}`;

  const response = await getOpenAIRelevancia().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  const resultado = new Map();
  for (const r of parsed.relevancia || []) {
    resultado.set(r.id, r.relevante !== false);
  }
  return { resultado, usage: response.usage };
}

// Acumulador real de tokens gastados en relevancia-IA durante la corrida
// actual — las funciones fetchXForTopic deben seguir devolviendo un arreglo
// plano (así las usa server.js, mezclándolas directo en groundingItems), así
// que el gasto real se registra aquí en vez de cambiar su forma de retorno.
// server.js lo lee con obtenerYResetearUsoRelevanciaIA() después de juntar
// todas las fuentes, y lo guarda en usage_logs igual que ya hace con el
// clasificador de sentimiento (mismo patrón, misma tabla real).
let _usoRelevanciaIA = { tokensIn: 0, tokensOut: 0 };
export function obtenerYResetearUsoRelevanciaIA() {
  const uso = _usoRelevanciaIA;
  _usoRelevanciaIA = { tokensIn: 0, tokensOut: 0 };
  return uso;
}

/**
 * Filtra `items` (ya pasados por esRelevante) dejando solo los que gpt-4o-mini
 * juzga genuinamente sobre `topic`. Fail-open a propósito: si la IA falla (red,
 * cuota, parseo) o no devuelve un id esperado, ese item se CONSERVA — nunca se
 * pierde contenido real por una falla técnica de esta segunda pasada opcional.
 */
export async function filtrarRelevanciaIA(items, topic) {
  if (!items.length) return items;
  const conservados = [];
  for (let i = 0; i < items.length; i += TAMAÑO_LOTE_RELEVANCIA) {
    const lote = items.slice(i, i + TAMAÑO_LOTE_RELEVANCIA);
    try {
      const { resultado, usage } = await filtrarRelevanciaLoteIA(lote, topic);
      lote.forEach((item, j) => {
        if (resultado.get(j) !== false) conservados.push(item);
      });
      _usoRelevanciaIA.tokensIn += usage?.prompt_tokens ?? 0;
      _usoRelevanciaIA.tokensOut += usage?.completion_tokens ?? 0;
    } catch (e) {
      console.error("[relevancia-ia] Error en lote, se conserva sin filtrar:", e.message);
      conservados.push(...lote);
    }
  }
  return conservados;
}

export async function fetchSocialCrawlForTopic(topic, hashtagInstagram = null, handlesInstagram = [], términosReales = []) {
  const [reels, tiktok, tiktokTop, facebook, hashtag, perfiles] = await Promise.all([
    fetchSocialCrawl("instagram/search/reels", { query: topic }, "instagram"),
    fetchSocialCrawl("tiktok/search", { query: topic }, "tiktok"),
    // Segundo motor de TikTok — no es un simple resultado "ordenado distinto"
    // del mismo set: probado en vivo (2026-09-30), trae ~8 de 30 videos que
    // tiktok/search no encuentra (y viceversa). El dedup por URL en server.js
    // ya se encarga de no guardar el solape dos veces.
    fetchSocialCrawl("tiktok/search/top", { query: topic }, "tiktok"),
    // Paginado (hasta 3 páginas) — antes una sola llamada, ver
    // fetchFacebookConPaginación para la evidencia real de cuánto se dejaba
    // sin tocar.
    fetchFacebookConPaginación(topic),
    // Motor nuevo (2026-09-30): instagram/search/hashtag encuentra posts
    // normales (no solo reels) — probado en vivo con 0% de solape contra
    // instagram/search/reels para el mismo tema (28 de 28 resultados eran
    // nuevos). Cuesta 5cr vs 1cr de los demás, justificado por el hallazgo.
    hashtagInstagram
      ? fetchSocialCrawl("instagram/search/hashtag", { hashtag: hashtagInstagram }, "instagram")
      : Promise.resolve([]),
    // Motor nuevo (2026-09-30): instagram/profile/posts/full — garantiza
    // capturar las publicaciones de la cuenta oficial del proyecto aunque no
    // aparezcan en ninguna búsqueda por tema, y es la única fuente de
    // "shares" reales de Instagram que se ha encontrado en toda la
    // integración. No todo handle configurado es necesariamente de
    // Instagram (verificado en vivo: @SEMARNAT_mx es su cuenta de X, no de
    // Instagram, y da 404 aquí) — se prueba cada uno, los que no existen
    // simplemente no aportan nada sin romper el resto.
    Promise.all(
      handlesInstagram.map(handle => fetchSocialCrawl("instagram/profile/posts/full", { handle }, "instagram")),
    ).then(listas => listas.flat()),
  ]);

  // Facebook, a diferencia de IG/TikTok, trae rutinariamente posts de meses
  // atrás en una búsqueda por nombre — se descarta lo viejo (>7 días) para
  // no inflar el histórico con contenido que ya no representa "qué está
  // pasando ahora" (pedido explícito del usuario, 2026-09-30).
  const haceSieteDias = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const facebookReciente = facebook.filter(item => {
    if (!item.published_at) return true;
    const t = new Date(item.published_at).getTime();
    return Number.isNaN(t) || t >= haceSieteDias;
  });

  // El filtro de relevancia aplica solo a resultados de BÚSQUEDA por tema
  // (reels/tiktok/facebook/hashtag) — perfiles viene de pedir directamente
  // los posts de una cuenta YA CONFIGURADA por el proyecto
  // (instagram/profile/posts/full), así que es relevante por definición
  // aunque un post puntual no repita el nombre en su texto.
  const términosAceptables = [topic, ...términosReales].filter(Boolean);
  const sobrevivenFiltroBarato = [...reels, ...tiktok, ...tiktokTop, ...facebookReciente, ...hashtag]
    .filter(item => item.url)
    .filter(item => esRelevante(item, términosAceptables));
  const resultadosBúsqueda = await filtrarRelevanciaIA(sobrevivenFiltroBarato, topic);
  return [...resultadosBúsqueda, ...perfiles.filter(item => item.url)];
}

// ─── Build context string from recent RSS mentions for AI prompt ──────────────
export function buildRssContext(mentions) {
  if (!mentions.length) return null;
  const lines = mentions.slice(0, 30).map((m, i) => {
    const date = m.published_at ? new Date(m.published_at).toLocaleDateString("es-MX") : "—";
    return `[${i + 1}] ${date} | ${m.source_name || "Fuente"} | ${m.title || m.content?.slice(0, 100) || "—"}`;
  });
  return lines.join("\n");
}

// ─── Rellenar URLs reales en relevant_publications usando los datos de las    ──
// búsquedas en vivo (el modelo cita la fuente por nombre, pero no siempre       ──
// incluye la URL real aunque nosotros ya la teníamos).                         ──
// Detecta URLs "adivinadas" por el modelo: solo el dominio raíz del medio
// (ej. "https://www.elsoldemexico.com.mx"), sin ruta a un artículo real.
function isBareHomepageUrl(url) {
  try {
    const u = new URL(url);
    return (u.pathname === "" || u.pathname === "/") && !u.search;
  } catch {
    return false;
  }
}

export function backfillPublicationUrls(data, groundingItems = []) {
  if (!data?.relevant_publications?.length) return data;
  const bySource = new Map();
  for (const item of groundingItems) {
    if (!item.url || !item.source_name) continue;
    const key = item.source_name.toLowerCase().trim();
    if (!bySource.has(key)) bySource.set(key, item.url);
  }
  data.relevant_publications = data.relevant_publications.map(p => {
    const hasRealUrl = p.url && !isBareHomepageUrl(p.url);
    if (hasRealUrl) return p;
    const key = String(p.source || "").toLowerCase().trim();
    const matched = bySource.get(key);
    if (matched) return { ...p, url: matched };
    // Sin URL real disponible: mejor vacío y honesto que un enlace inventado.
    return p.url ? { ...p, url: "" } : p;
  });
  return data;
}

// ─── Fusionar TODAS las menciones reales encontradas con lo que la IA escribió ─
// La IA solo describe unas cuantas publicaciones "representativas" en su resumen;
// todo lo demás que sí encontramos en las fuentes reales (YouTube, GDELT, Google
// News, Web Search, Hidalgo) se perdía porque nunca se agregaba a la respuesta.
// Esto añade cada mención real no citada por la IA como su propia fila, y
// recalcula fuentes/total a partir del conjunto completo (no solo lo que el
// modelo decidió resumir) — usado por /api/analyze-live, que no tiene proyecto
// ni base de datos donde persistir las menciones extra.
export function mergeGroundingIntoPublications(data, groundingItems = []) {
  if (!data) return data;
  const existingUrls = new Set((data.relevant_publications || []).map(p => p.url).filter(Boolean));

  const extras = [];
  for (const item of groundingItems) {
    if (!item.url || existingUrls.has(item.url)) continue;
    existingUrls.add(item.url);
    extras.push({
      date: item.published_at ? new Date(item.published_at).toLocaleDateString("es-MX") : "",
      source: item.source_name || "Fuente",
      channel: "Web",
      detected_narrative: item.title || "Mención relacionada",
      type: "Mención",
      sentiment: "Neutral",
      estimated_reach: "Regional",
      risk: "Bajo",
      url: item.url,
    });
  }

  data.relevant_publications = [...(data.relevant_publications || []), ...extras];

  // Fuentes reales a partir de TODAS las publicaciones (IA + reales agregadas).
  const counts = {};
  for (const p of data.relevant_publications) {
    const key = String(p.source || "Fuente").trim();
    counts[key] = (counts[key] || 0) + 1;
  }
  const total = data.relevant_publications.length || 1;
  data.sources_distribution = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([source, count]) => ({
      source,
      percentage: Math.round((count / total) * 100),
      dominant_sentiment: data.relevant_publications.find(p => p.source === source)?.sentiment || "Neutral",
    }));

  data.total_mentions = Math.max(Number(data.total_mentions) || 0, data.relevant_publications.length);

  return data;
}
