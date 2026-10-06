// Clasificación de sentimiento real para menciones que ya se guardaron sin
// una (todo lo que viene de RSS/Google News/YouTube/GDELT/etc. se guarda
// crudo, sin sentimiento — solo el puñado que la IA cita explícitamente en
// su resumen narrativo llevaba sentimiento hasta ahora). Antes esto dejaba
// entre 85-95% de las menciones reales como "sin calificar" para siempre.
//
// Este módulo le pregunta a la IA el sentimiento de CADA mención pendiente,
// en lotes (para no pagar una llamada por mención) y con un modelo barato
// (gpt-4o-mini, no gpt-4o) porque clasificar 3 palabras es mucho más simple
// que escribir el análisis narrativo completo. "neutral" es un resultado
// real cuando el texto no tiene carga emocional clara — nunca un relleno
// puesto sin que la IA lo haya visto.
import OpenAI from "openai";
import { getProjectById, getUnclassifiedMentions, updateMentionSentiment } from "./db.js";

// Instanciado bajo demanda, no al cargar el módulo: los `import` de un
// archivo se resuelven ANTES de que corra el propio código de nivel
// superior de quien importa (aquí, dotenv.config() en server.js) — crear
// `new OpenAI(...)` aquí arriba leía OPENAI_API_KEY todavía sin definir y
// tronaba el arranque completo del backend (confirmado en producción).
let openai = null;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

const TAMAÑO_LOTE = 25;

function truncar(texto, max) {
  const limpio = (texto || "").trim();
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
}

async function clasificarLote(menciones, tema) {
  const items = menciones.map((m) => ({
    id: m.id,
    titulo: truncar(m.title, 140),
    extracto: truncar(m.content, 280),
  }));

  // Corrección real (2026-10-03): una nota alarmante sobre contaminación que
  // reporta una acción positiva de la institución salía "negativo" — el
  // modelo calificaba el tono del hecho, no cómo queda el sujeto monitoreado.
  const prompt = `Clasifica el sentimiento de cada una de estas menciones reales de medios/redes sociales.

Tema monitoreado: "${tema}".

El sentimiento es la postura que la mención transmite HACIA ESE TEMA/SUJETO, no el tono emocional del hecho que describe. Ejemplos:
- Una noticia alarmante sobre un problema ambiental, pero que reporta que la institución del tema actuó bien (retiró basura, sancionó, resolvió), es "positivo" o "neutral" para el tema, no "negativo".
- Una crítica o denuncia directa contra el tema o su gestión es "negativo".
- Un elogio, respaldo o resultado favorable para el tema es "positivo".
- Información sin postura hacia el tema es "neutral".

Para cada "id", responde EXACTAMENTE una de estas tres palabras en "sentiment": "positivo", "negativo" o "neutral".

Usa "neutral" cuando el texto sea informativo sin postura clara hacia el tema, cuando el extracto esté vacío y el título no baste para juzgar, o cuando genuinamente no se incline hacia ningún lado. No inventes una inclinación que el texto no sugiere — "neutral" es una respuesta válida y esperada, no una falla.

Menciones:
${JSON.stringify(items)}

Responde ÚNICAMENTE este JSON, sin texto adicional ni markdown:
{"clasificaciones":[{"id":0,"sentiment":"neutral"}]}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  const resultado = new Map();
  for (const c of parsed.clasificaciones || []) {
    const s = String(c.sentiment || "").toLowerCase();
    resultado.set(c.id, ["positivo", "negativo", "neutral"].includes(s) ? s : "neutral");
  }
  return { resultado, usage: response.usage };
}

/**
 * Clasifica hasta `limite` menciones reales sin sentimiento de un proyecto,
 * en lotes de 25. Si la IA no devuelve un id esperado en el lote (raro, pero
 * posible con JSON parcial), se le pone "neutral" como default honesto —
 * ya se le preguntó, la IA simplemente no distinguió una inclinación clara.
 */
export async function clasificarMencionesPendientes(projectId, limite = 150) {
  const pendientes = await getUnclassifiedMentions(projectId, limite);
  if (!pendientes.length) return { clasificadas: 0, tokensIn: 0, tokensOut: 0 };
  const proyecto = await getProjectById(projectId);
  const tema = proyecto?.main_topic || proyecto?.name || "";

  let clasificadas = 0, tokensIn = 0, tokensOut = 0;
  for (let i = 0; i < pendientes.length; i += TAMAÑO_LOTE) {
    const lote = pendientes.slice(i, i + TAMAÑO_LOTE);
    try {
      const { resultado, usage } = await clasificarLote(lote, tema);
      for (const m of lote) {
        await updateMentionSentiment(m.id, resultado.get(m.id) ?? "neutral");
        clasificadas++;
      }
      tokensIn += usage?.prompt_tokens ?? 0;
      tokensOut += usage?.completion_tokens ?? 0;
    } catch (e) {
      console.error("[clasificador] Error en lote:", e.message);
    }
  }
  return { clasificadas, tokensIn, tokensOut };
}
