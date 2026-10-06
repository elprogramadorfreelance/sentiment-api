// Aviso por correo cuando un proveedor externo se queda sin crédito o cuota.
// Antes estos errores se tragaban (la fuente devolvía [] y el análisis anotaba
// "0 resultados, ok"), así que nadie se enteraba de que X, SocialCrawl, Brave,
// SerpApi, YouTube u OpenAI llevaban días sin traer nada.
import { createHash } from "crypto";
import { getCachedSearch, saveCachedSearch } from "./db.js";
import { enviarAlertaProveedor } from "./mailer.js";

// Un solo aviso por proveedor dentro de esta ventana (persistido en
// ai_search_cache, sobrevive a los reinicios de PM2).
const COOLDOWN_MIN = parseInt(process.env.ALERTA_PROVEEDOR_COOLDOWN_MIN || "720");

const IMPACTO = {
  "OpenAI": "Análisis con IA, resúmenes y clasificación de sentimiento de todos los proyectos.",
  "YouTube": "Videos de YouTube (cuota diaria de la API; se restablece sola cada día).",
  "X (Twitter)": "Menciones de X en todos los proyectos.",
  "SocialCrawl": "Publicaciones de Instagram y TikTok en todos los proyectos.",
  "Brave": "Búsqueda web y contenido de Facebook, Instagram y TikTok indexado por Brave.",
  "SerpApi": "Contenido de Facebook, Instagram y TikTok indexado por Google.",
  "Perplexity": "Búsqueda con IA y fuentes citadas.",
};

/** ¿El error de un proveedor es de crédito/cuota agotada (y no un fallo puntual)? */
export function esErrorDeCredito(status, cuerpo) {
  const s = Number(status);
  if (s === 402) return true;
  const t = String(cuerpo || "").toLowerCase();
  if (s === 429 || s === 403) {
    return /quota|credit|insufficient|billing|balance|exceeded|plan|run out|out of searches|limit/.test(t);
  }
  return /no credits remaining|insufficient_quota|credits depleted/.test(t);
}

/**
 * Nunca lanza: reportar un problema no puede romper el análisis que lo detectó.
 * No hace nada si el error no es de crédito/cuota o si ya se avisó hace poco.
 */
export async function reportarFalloProveedor(proveedor, status, cuerpo) {
  try {
    if (!esErrorDeCredito(status, cuerpo)) return;
    const hash = createHash("sha256").update(`alerta-proveedor:${proveedor}`).digest("hex");
    const previo = await getCachedSearch(hash, "alerta_proveedor", COOLDOWN_MIN);
    if (previo) return;
    // Se marca ANTES de enviar: así varias llamadas simultáneas del mismo
    // análisis no mandan el mismo correo varias veces.
    await saveCachedSearch(hash, "alerta_proveedor", JSON.stringify({ proveedor, status, en: new Date().toISOString() }));
    const detalle = String(cuerpo || "").replace(/\s+/g, " ").slice(0, 400);
    await enviarAlertaProveedor({
      proveedor,
      status,
      detalle,
      impacto: IMPACTO[proveedor] || "Una de las fuentes de datos.",
    });
  } catch (e) {
    console.error("[provider-health] No se pudo registrar/avisar el fallo de", proveedor, e.message);
  }
}
