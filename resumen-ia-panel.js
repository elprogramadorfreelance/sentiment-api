// Resumen IA del panel de proyectos: un analista lee métricas reales y escribe
// una lectura crítica. El modelo solo recibe cifras que ya calculó el sistema
// (nunca consulta la base directamente) y la respuesta se valida antes de
// devolverla. Cache en memoria por 30 min para no repetir la llamada cuando el
// panel se recarga sin cambios.
import { createHash } from "crypto";
import OpenAI from "openai";

let openai = null;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

const TTL_MS = 30 * 60 * 1000;
const cache = new Map();

const INSTRUCCIONES = `Eres un analista senior de reputación y monitoreo de medios en México. Recibes métricas REALES ya calculadas de uno o más proyectos de monitoreo. Escribe en español neutro, en tono directo.

Responde ÚNICAMENTE un JSON con esta forma: {"titular": string, "parrafo": string, "bullets": string[]}

- "titular": UNA frase con la lectura más importante. Concreta, no genérica (mal: "Conversación estable con sentimiento mixto"; bien: explica qué cambió o qué preocupa y por qué).
- "parrafo": 3 a 5 oraciones que expliquen el POR QUÉ con las cifras dadas, identifiquen el riesgo principal y el punto ciego más importante de los datos.
- "bullets": de 2 a 4 hallazgos accionables o advertencias, cada uno con al menos una cifra.

Reglas:
1. Usa SOLO cifras que aparezcan en los datos. No inventes números, fechas, causas ni nombres.
2. Si no conoces la causa de un movimiento, dilo ("los datos no muestran la causa"). No la adivines.
3. Sé crítico: si una cifra es poco confiable, dilo. Por ejemplo: muestra pequeña, alcance estimado (no medido), muchas menciones sin clasificar, o tono basado en pocas menciones. No halagues ni minimices riesgos.
4. Si una alerta o un tema aparece en los datos, puedes citarlo; no lo conviertas en conclusión sin evidencia.
5. Marca con **negritas** las cifras clave dentro de "parrafo" y "bullets".`;

function clave(datos) {
  return createHash("sha256").update(JSON.stringify(datos)).digest("hex");
}

function validar(parsed) {
  const titular = String(parsed?.titular ?? "").trim().slice(0, 240);
  const parrafo = String(parsed?.parrafo ?? "").trim().slice(0, 1400);
  const bullets = Array.isArray(parsed?.bullets)
    ? parsed.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, 4).map((b) => b.slice(0, 320))
    : [];
  if (!titular || !parrafo) throw new Error("La IA no devolvió un resumen válido.");
  return { titular, parrafo, bullets };
}

export async function generarResumenPanel(datos) {
  const llave = clave(datos);
  const guardado = cache.get(llave);
  if (guardado && Date.now() - guardado.t < TTL_MS) return guardado.valor;

  const respuesta = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    temperature: 0.3,
    messages: [
      { role: "system", content: INSTRUCCIONES },
      { role: "user", content: JSON.stringify(datos) },
    ],
    response_format: { type: "json_object" },
  });
  const valor = validar(JSON.parse(respuesta.choices[0].message.content));
  cache.set(llave, { t: Date.now(), valor });
  return valor;
}
