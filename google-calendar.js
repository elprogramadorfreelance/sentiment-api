// Agendado real de demos vía Google Calendar API — encuentra el próximo
// hueco real libre en el calendario (consultando eventos reales, no un
// horario fijo inventado) y crea un evento real con un link de Google Meet
// generado por Google, no un placeholder. Requiere credenciales OAuth2 de
// un proyecto en Google Cloud Console (ver GOOGLE_CALENDAR_SETUP.md) — sin
// configurar, se reporta honestamente como no disponible, nunca se inventa
// una fecha/hora/link falsos.
import { google } from "googleapis";

const ZONA_HORARIA = "America/Mexico_City";
const HORA_INICIO = 10; // 10:00 am
const HORA_FIN = 14; // 2:00 pm — última cita empieza a la 1:30pm
const DURACION_MIN = 30;
const DIAS_A_BUSCAR = 10; // hábiles

function calendarioConfigurado() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

function getCalendarClient() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: "v3", auth: oauth2Client });
}

function esDíaHábil(fecha) {
  const día = fecha.getDay();
  return día !== 0 && día !== 6;
}

/** Genera los horarios candidatos (10:00, 10:30, ..., 13:30) para los próximos DIAS_A_BUSCAR días hábiles, empezando mañana. */
function generarCandidatos() {
  const candidatos = [];
  const hoy = new Date();
  let cursor = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1);
  let díasHábilesVistos = 0;
  while (díasHábilesVistos < DIAS_A_BUSCAR) {
    if (esDíaHábil(cursor)) {
      díasHábilesVistos++;
      for (let hora = HORA_INICIO; hora < HORA_FIN; hora += DURACION_MIN / 60) {
        const inicio = new Date(cursor);
        inicio.setHours(Math.floor(hora), (hora % 1) * 60, 0, 0);
        candidatos.push(inicio);
      }
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return candidatos;
}

function seSolapan(aInicio, aFin, bInicio, bFin) {
  return aInicio < bFin && bInicio < aFin;
}

/**
 * Busca el próximo hueco real libre (freebusy real del calendario, no
 * inventado) y crea un evento real con Meet. Devuelve null si Google no
 * está configurado o si no se pudo agendar (nunca inventa una fecha/hora).
 */
export async function agendarDemoReal(calendarId, { nombre, email, comentario }) {
  if (!calendarioConfigurado()) return null;
  try {
    const calendar = getCalendarClient();
    const candidatos = generarCandidatos();
    const desde = candidatos[0];
    const hasta = new Date(candidatos[candidatos.length - 1].getTime() + DURACION_MIN * 60_000);

    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: desde.toISOString(),
        timeMax: hasta.toISOString(),
        timeZone: ZONA_HORARIA,
        items: [{ id: calendarId }],
      },
    });
    const ocupado = fb.data.calendars?.[calendarId]?.busy ?? [];

    const slot = candidatos.find((inicio) => {
      const fin = new Date(inicio.getTime() + DURACION_MIN * 60_000);
      return !ocupado.some((b) => seSolapan(inicio, fin, new Date(b.start), new Date(b.end)));
    });
    if (!slot) return null; // agenda llena en la ventana de búsqueda — no se inventa un hueco

    const fin = new Date(slot.getTime() + DURACION_MIN * 60_000);
    const requestId = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const evento = await calendar.events.insert({
      calendarId,
      conferenceDataVersion: 1,
      sendUpdates: "all",
      requestBody: {
        summary: `Demo Sentiment Unicornio — ${nombre}`,
        description: comentario || "Solicitud de demo desde sentimentunicornio.com",
        start: { dateTime: slot.toISOString(), timeZone: ZONA_HORARIA },
        end: { dateTime: fin.toISOString(), timeZone: ZONA_HORARIA },
        attendees: [{ email }],
        conferenceData: {
          createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } },
        },
      },
    });

    const meetUrl = evento.data.hangoutLink
      || evento.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
    if (!meetUrl) return null; // Google no generó el link — no se manda un correo con un link roto

    return {
      fecha: slot.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: ZONA_HORARIA }),
      hora: slot.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit", timeZone: ZONA_HORARIA }),
      timezone: "hora del centro de México",
      meetUrl,
      eventId: evento.data.id,
    };
  } catch (e) {
    console.error("[google-calendar] Error agendando demo:", e.message);
    return null;
  }
}

export { calendarioConfigurado };
