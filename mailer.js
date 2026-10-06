// Correo real vía Brevo (API HTTP, no SMTP) — misma cuenta/API key que ya usa
// sendAlertEmail en server.js para las alertas de crisis. Antes este archivo
// dependía de SMTP_HOST/SMTP_USER/SMTP_PASS por variables de entorno que
// nunca se configuraron en producción — todo el envío de correo (OTP de
// Perfil, recuperación de contraseña, solicitudes de demo/facturación)
// fallaba en silencio. Brevo ya estaba pagado y funcionando para otra cosa;
// esto solo lo reutiliza.
//
// Las plantillas HTML reales (emails/dist/*.html) vienen de compilar
// emails/templates/*.mjml — ver emails/README.md. No se editan a mano, se
// recompilan con `npm run emails:build`.
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMAILS_DIST = path.join(__dirname, "emails", "dist");

const REMITENTE = { name: "Sentiment Unicornio", email: process.env.MAIL_FROM_EMAIL };
const SITE_URL = process.env.SITE_URL || "https://sentimentunicornio.com";
const ASSETS_URL = `${SITE_URL}/emails`;
const PRIVACY_URL = `${SITE_URL}/privacy`;
const SUPPORT_URL = `${SITE_URL}/soporte`;

function brevoConfigurado() {
  return !!process.env.BREVO_API_KEY;
}

async function enviarConBrevo({ to, cc, subject, text, html }) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": process.env.BREVO_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: REMITENTE,
      to: [{ email: to }],
      ...(cc?.length ? { cc: cc.map(email => ({ email })) } : {}),
      subject,
      textContent: text,
      htmlContent: html || `<pre style="font-family:sans-serif;white-space:pre-wrap;">${text}</pre>`,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Brevo respondió ${res.status}: ${JSON.stringify(body)}`);
  }
}

const plantillasEnCache = new Map();

/** Lee emails/dist/{nombre}.html (con cache en memoria) y sustituye {{variable}} — nunca deja un {{...}} sin reemplazar visible, usa "" si falta el dato. */
function renderPlantilla(nombre, variables) {
  let html = plantillasEnCache.get(nombre);
  if (!html) {
    html = readFileSync(path.join(EMAILS_DIST, `${nombre}.html`), "utf-8");
    plantillasEnCache.set(nombre, html);
  }
  const datos = {
    site_url: SITE_URL,
    assets_url: ASSETS_URL,
    privacy_url: PRIVACY_URL,
    support_url: SUPPORT_URL,
    ...variables,
  };
  return html.replace(/\{\{(\w+)\}\}/g, (_, clave) => {
    const valor = datos[clave];
    return valor === undefined || valor === null ? "" : String(valor);
  });
}

/** Texto plano de respaldo — algunos clientes de correo lo muestran, y es lo único que se loguea si Brevo no está configurado. */
function textoPlano(líneas) {
  return líneas.filter(Boolean).join("\n\n");
}

async function enviarPlantilla({ to, asunto, plantilla, variables, textoAlterno }) {
  const html = renderPlantilla(plantilla, { preheader: asunto, recipient_email: to, ...variables });
  if (!brevoConfigurado()) {
    console.log(`[mailer] Brevo no configurado — "${plantilla}" para ${to}: ${textoAlterno}`);
    return { enviado: false };
  }
  try {
    await enviarConBrevo({ to, subject: asunto, text: textoAlterno, html });
    return { enviado: true };
  } catch (e) {
    console.error(`[mailer] Error enviando "${plantilla}":`, e.message);
    return { enviado: false };
  }
}

function primerNombre(nombreCompleto) {
  return (nombreCompleto || "").trim().split(/\s+/)[0] || "";
}

// ─── Dispositivo / ubicación reales para el aviso post-cambio ──────────────
// No se fabrica nada: si no se puede determinar, se dice honestamente
// "Dispositivo desconocido" / "Ubicación no disponible" en vez de inventar.
export function describirDispositivo(userAgent) {
  const ua = userAgent || "";
  let so = "Dispositivo desconocido";
  // El orden importa: el user-agent de iOS incluye "like Mac OS X", así que
  // iPhone/iPad se revisan ANTES que macOS o el navegador diría "en macOS"
  // para un iPhone real.
  if (/windows/i.test(ua)) so = "Windows";
  else if (/iphone|ipad|ios/i.test(ua)) so = "iOS";
  else if (/android/i.test(ua)) so = "Android";
  else if (/mac os|macintosh/i.test(ua)) so = "macOS";
  else if (/linux/i.test(ua)) so = "Linux";

  let navegador = "";
  if (/edg\//i.test(ua)) navegador = "Edge";
  else if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) navegador = "Chrome";
  else if (/firefox\//i.test(ua)) navegador = "Firefox";
  else if (/safari\//i.test(ua) && !/chrome/i.test(ua)) navegador = "Safari";

  if (so === "Dispositivo desconocido" && !navegador) return "Dispositivo desconocido";
  return [navegador, so].filter(Boolean).join(" en ") || so;
}

/** IP real → ciudad/país vía ipwho.is (gratis, sin API key). IPs privadas/localhost o fallo de red → honesto "no disponible", nunca inventado. */
export async function ubicacionAproximada(ip) {
  const limpia = (ip || "").split(",")[0].trim().replace(/^::ffff:/, "");
  if (!limpia || limpia === "::1" || /^(127\.|10\.|192\.168\.|::1)/.test(limpia)) {
    return "Ubicación no disponible";
  }
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(limpia)}`);
    const data = await res.json();
    if (!data.success) return "Ubicación no disponible";
    return [data.city, data.region, data.country].filter(Boolean).join(", ") || "Ubicación no disponible";
  } catch {
    return "Ubicación no disponible";
  }
}

// ─── Notificación interna cuando alguien solicita una demo ─────────────────
export async function enviarNotificacionDemo(datos) {
  const destino = process.env.SUPPORT_EMAIL;
  if (!brevoConfigurado() || !destino) {
    console.log(`[mailer] Brevo/SUPPORT_EMAIL no configurado — solicitud de demo de ${datos.nombre} (${datos.email}) guardada en BD, sin notificación por correo.`);
    return { enviado: false };
  }
  const texto = `Nueva solicitud de demo:\n\nNombre: ${datos.nombre} ${datos.apellidos || ""}\nCorreo: ${datos.email}\nTeléfono: ${datos.telefono || "—"}\nComentario: ${datos.comentario || "—"}`;
  const fila = (etiqueta, valor) => `
    <tr>
      <td style="padding:8px 0;color:#7a7475;font-size:13px;width:110px;vertical-align:top;">${etiqueta}</td>
      <td style="padding:8px 0;color:#161712;font-size:14px;">${valor}</td>
    </tr>`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;">
      <div style="background:#1F3C7A;padding:20px 28px;border-radius:8px 8px 0 0;">
        <span style="color:#ffffff;font-size:16px;font-weight:700;">Unicornio</span>
      </div>
      <div style="border:1px solid #e5e5e0;border-top:none;border-radius:0 0 8px 8px;padding:24px 28px;">
        <h2 style="margin:0 0 16px;color:#161712;font-size:18px;">Nueva solicitud de demo</h2>
        <table style="width:100%;border-collapse:collapse;">
          ${fila("Nombre", `${datos.nombre} ${datos.apellidos || ""}`.trim())}
          ${fila("Correo", `<a href="mailto:${datos.email}" style="color:#0056a4;">${datos.email}</a>`)}
          ${fila("Teléfono", datos.telefono || "—")}
          ${fila("Comentario", datos.comentario || "—")}
        </table>
      </div>
    </div>`;
  try {
    await enviarConBrevo({
      to: destino,
      cc: (process.env.DEMO_CC_EMAILS || "").split(",").map((e) => e.trim()).filter(Boolean),
      subject: `Solicitud de demo — ${datos.nombre}`,
      text: texto,
      html,
    });
    return { enviado: true };
  } catch (e) {
    console.error("[mailer] Error enviando notificación de demo:", e.message);
    return { enviado: false };
  }
}

// ─── Alerta real de una regla que el propio usuario configuró vigilar ──────
// (palabra clave o narrativa). Sin plantilla de marca por ahora — es un aviso
// operativo tipo alerta, mismo espíritu que la alerta de crisis que ya existía
// (sendAlertEmail en server.js), no un correo de producto diseñado.
export async function enviarAlertaPersonalizada(destinatario, nombre, { projectName, alertTitle, description, riskLevel }) {
  const asunto = `[${riskLevel || "Alerta"}] ${projectName}: ${alertTitle}`;
  const texto = `Hola ${primerNombre(nombre)},\n\nSe activó una alerta que configuraste vigilar en "${projectName}":\n\n${alertTitle}\n${description}\n\nRevisa el detalle en ${SITE_URL}/alertas?proyecto=`;
  const html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><h2 style="color:#1F3C7A;">${alertTitle}</h2><p style="color:#4b4648;">${description}</p><p style="font-size:12px;color:#7a7475;">Proyecto: ${projectName} · Riesgo: ${riskLevel || "—"}</p><p><a href="${SITE_URL}/alertas" style="color:#0056a4;">Ver alertas</a></p></div>`;
  if (!brevoConfigurado()) {
    console.log(`[mailer] Brevo no configurado — alerta personalizada para ${destinatario}: ${alertTitle}`);
    return { enviado: false };
  }
  try {
    await enviarConBrevo({ to: destinatario, subject: asunto, text: texto, html });
    return { enviado: true };
  } catch (e) {
    console.error("[mailer] Error enviando alerta personalizada:", e.message);
    return { enviado: false };
  }
}

// ─── Alerta reputacional automática (las 6 reglas del sistema: pico negativo,
// caída de sentimiento, palabras críticas, fuente sensible, narrativa de
// riesgo, amplificador de alto riesgo) — a diferencia de enviarAlertaPersonalizada
// (regla que el propio usuario configuró vigilar), esta se dispara sola sin que
// nadie la configure, solo cuando la alerta es nueva (isNew en saveAutoAlert,
// no se repite en cada corrida del cron) y de severidad Alto/Crítico — ver
// evaluateAlertRules en alert-engine.js. Mismo estilo simple sin plantilla de
// marca, mismo criterio ya usado en enviarAlertaPersonalizada.
export async function enviarAlertaReputacional(destinatario, nombre, { projectName, alertTitle, description, riskLevel }) {
  const asunto = `[${riskLevel || "Alerta"}] ${projectName}: ${alertTitle}`;
  const texto = `Hola ${primerNombre(nombre)},\n\nSe detectó una alerta reputacional de riesgo ${riskLevel || "—"} en "${projectName}":\n\n${alertTitle}\n${description}\n\nRevisa el detalle en ${SITE_URL}/alertas`;
  const colorRiesgo = riskLevel === "Crítico" ? "#dc2626" : "#ea580c";
  const html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><p style="color:${colorRiesgo};font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Riesgo ${riskLevel || "—"}</p><h2 style="color:#1F3C7A;margin-top:4px;">${alertTitle}</h2><p style="color:#4b4648;">${description}</p><p style="font-size:12px;color:#7a7475;">Proyecto: ${projectName}</p><p><a href="${SITE_URL}/alertas" style="color:#0056a4;">Ver alertas</a></p></div>`;
  if (!brevoConfigurado()) {
    console.log(`[mailer] Brevo no configurado — alerta reputacional para ${destinatario}: ${alertTitle}`);
    return { enviado: false };
  }
  try {
    await enviarConBrevo({ to: destinatario, subject: asunto, text: texto, html });
    return { enviado: true };
  } catch (e) {
    console.error("[mailer] Error enviando alerta reputacional:", e.message);
    return { enviado: false };
  }
}

// ─── Código de verificación (OTP) para acciones sensibles de Perfil ────────
export async function enviarCodigoOtp(destinatario, nombre, codigo, motivo) {
  return enviarPlantilla({
    to: destinatario,
    asunto: "Tu código de verificación — Sentiment Unicornio",
    plantilla: "otp-codigo",
    variables: { first_name: primerNombre(nombre), codigo, motivo, expiration_minutes: "10" },
    textoAlterno: textoPlano([
      `Hola ${primerNombre(nombre)},`,
      `Tu código de verificación para ${motivo} es: ${codigo}`,
      "Vence en 10 minutos. Si no fuiste tú, ignora este correo.",
    ]),
  });
}

// ─── Notificaciones POST-cambio de Perfil (nuevas — antes no existían) ─────
// El OTP ya autorizó el cambio antes de que esto se envíe; estos correos son
// el aviso de seguridad de "esto acaba de pasar en tu cuenta", no una
// confirmación pendiente.

export async function enviarNotificacionCambioPassword(destinatario, nombre, { device, location, fecha, hora }) {
  return enviarPlantilla({
    to: destinatario,
    asunto: "Tu contraseña de Unicornio fue actualizada",
    plantilla: "modificacion-password",
    variables: {
      first_name: primerNombre(nombre),
      change_date: fecha,
      change_time: hora,
      device: device || "Dispositivo desconocido",
      location: location || "Ubicación no disponible",
      secure_account_url: `${SITE_URL}/perfil`,
    },
    textoAlterno: textoPlano([
      `Hola ${primerNombre(nombre)},`,
      `Tu contraseña se actualizó el ${fecha} a las ${hora} desde ${device || "un dispositivo desconocido"} (${location || "ubicación no disponible"}).`,
      `Si no fuiste tú: ${SITE_URL}/perfil`,
    ]),
  });
}

// Se manda al correo NUEVO (no al viejo) — el clic es lo que prueba que el
// usuario de verdad controla esa bandeja, algo que el flujo anterior (OTP al
// correo viejo) nunca verificaba. El cambio real se aplica cuando confirman,
// no antes — ver GET /api/perfil/confirmar en server.js.
export async function enviarSolicitudCambioCorreo(destinatario, nombre, { oldEmail, newEmail, confirmUrl, expirationDate }) {
  return enviarPlantilla({
    to: destinatario,
    asunto: "Confirma tu nuevo correo en Unicornio",
    plantilla: "modificacion-email",
    variables: {
      name: primerNombre(nombre),
      old_email: oldEmail,
      new_email: newEmail,
      confirm_email_url: confirmUrl,
      expiration_date: expirationDate,
    },
    textoAlterno: textoPlano([
      `Hola ${primerNombre(nombre)},`,
      `Recibimos una solicitud para cambiar tu correo de ${oldEmail} a ${newEmail}.`,
      `Confirma aquí (vence el ${expirationDate}): ${confirmUrl}`,
    ]),
  });
}

export async function enviarNotificacionEliminacionCuenta(destinatario, nombre, { requestId, fecha }) {
  return enviarPlantilla({
    to: destinatario,
    asunto: "Tu cuenta de Unicornio fue eliminada",
    plantilla: "eliminacion-cuenta",
    variables: { name: primerNombre(nombre), deletion_date: fecha, request_id: requestId },
    textoAlterno: textoPlano([
      `Hola ${primerNombre(nombre)},`,
      `Eliminamos la cuenta asociada a ${destinatario} el ${fecha}. Referencia: ${requestId}.`,
      `Si no solicitaste esto: ${SUPPORT_URL}`,
    ]),
  });
}

// Se manda al correo ACTUAL (quien traspasa) — el clic es la confirmación
// real de que sí quiere ceder la administración. El traspaso se aplica
// cuando confirma, no antes — ver GET /api/perfil/confirmar en server.js.
export async function enviarSolicitudTraspaso(destinatario, nombre, { currentEmail, newOwnerEmail, projectCount, transferUrl, expirationDate }) {
  return enviarPlantilla({
    to: destinatario,
    asunto: "Revisa la transferencia de tu cuenta",
    plantilla: "transferencia-cuenta",
    variables: {
      first_name: primerNombre(nombre),
      current_email: currentEmail,
      new_owner_email: newOwnerEmail,
      project_count: projectCount,
      transfer_url: transferUrl,
      expiration_date: expirationDate,
    },
    textoAlterno: textoPlano([
      `Hola ${primerNombre(nombre)},`,
      `Recibimos una solicitud para transferir tu cuenta (${currentEmail}) a ${newOwnerEmail}.`,
      `Confirma aquí (vence el ${expirationDate}): ${transferUrl}`,
    ]),
  });
}

// ─── Bienvenida al agregar un nuevo integrante al equipo ───────────────────
export async function enviarCorreoBienvenida(destinatario, nombre, { orgName }) {
  return enviarPlantilla({
    to: destinatario,
    asunto: "Te damos la bienvenida a Unicornio",
    plantilla: "bienvenida",
    variables: { first_name: primerNombre(nombre), project_name: orgName || "tu organización", login_url: `${SITE_URL}/login` },
    textoAlterno: textoPlano([
      `Hola ${primerNombre(nombre)},`,
      `Tu acceso a Unicornio ya está listo para ${orgName || "tu organización"}.`,
      `Entra aquí: ${SITE_URL}/login`,
    ]),
  });
}

// ─── Sistema de tickets de soporte ──────────────────────────────────────────
export async function enviarNotificacionTicketCreado(destinatario, nombre, { ticketId, ticketSubject, fecha, hora }) {
  return enviarPlantilla({
    to: destinatario,
    asunto: `Ticket #${ticketId} recibido — Sentiment Unicornio`,
    plantilla: "ticket-creado",
    variables: { first_name: primerNombre(nombre), ticket_id: ticketId, ticket_subject: ticketSubject, created_date: fecha, created_time: hora },
    textoAlterno: textoPlano([
      `Hola ${primerNombre(nombre)},`,
      `Recibimos tu solicitud de soporte. Ticket #${ticketId}: ${ticketSubject}.`,
      `Fecha: ${fecha} · ${hora}. Te responderemos a la brevedad.`,
    ]),
  });
}

// ─── Confirmación real de demo agendada (Google Calendar) ──────────────────
export async function enviarConfirmacionDemo(destinatario, nombre, { fecha, hora, timezone, meetUrl }) {
  return enviarPlantilla({
    to: destinatario,
    asunto: "Tu sesión de Unicornio ya está confirmada",
    plantilla: "link-demo",
    variables: { first_name: primerNombre(nombre), meeting_date: fecha, meeting_time: hora, timezone, meeting_url: meetUrl },
    textoAlterno: textoPlano([
      `Hola ${primerNombre(nombre)},`,
      `Tu demo quedó agendada: ${fecha} a las ${hora} (${timezone}).`,
      `Entra aquí a la hora: ${meetUrl}`,
    ]),
  });
}

export async function enviarNotificacionTicketResuelto(destinatario, nombre, { ticketId, resolutionSummary, fecha, hora }) {
  return enviarPlantilla({
    to: destinatario,
    asunto: `Ticket #${ticketId} resuelto — Sentiment Unicornio`,
    plantilla: "ticket-solucionado",
    variables: { first_name: primerNombre(nombre), ticket_id: ticketId, resolution_summary: resolutionSummary, resolved_date: fecha, resolved_time: hora },
    textoAlterno: textoPlano([
      `Hola ${primerNombre(nombre)},`,
      `Tu ticket #${ticketId} ya se resolvió: ${resolutionSummary}`,
      `Fecha: ${fecha} · ${hora}. Si sigue el problema, responde este correo.`,
    ]),
  });
}

// ─── Facturación no tiene pasarela de pago conectada todavía ───────────────
// "cambiar plan" y "cancelar" no procesan nada, solo avisan a soporte para
// que el cambio se haga manualmente. Nunca se le dice al cliente que su plan
// ya cambió.
export async function enviarSolicitudFacturacion(datos) {
  const destino = process.env.SUPPORT_EMAIL;
  const texto = `Solicitud de facturación (${datos.tipo}):\n\nOrganización: ${datos.organizacion} (id ${datos.organizationId})\nUsuario: ${datos.nombre} (${datos.email})\nPlan actual: ${datos.planActual}\nPlan deseado: ${datos.planDeseado || "—"}\nComentario: ${datos.comentario || "—"}`;
  if (!brevoConfigurado() || !destino) {
    console.log(`[mailer] Brevo/SUPPORT_EMAIL no configurado — solicitud de facturación de ${datos.email} guardada solo en log:\n${texto}`);
    return { enviado: false };
  }
  try {
    await enviarConBrevo({ to: destino, subject: `Solicitud de facturación — ${datos.organizacion} (${datos.tipo})`, text: texto });
    return { enviado: true };
  } catch (e) {
    console.error("[mailer] Error enviando solicitud de facturación:", e.message);
    return { enviado: false };
  }
}

// ─── Aviso interno: un proveedor externo se quedó sin crédito o cuota ─────────
// Va a ALERTAS_SISTEMA_EMAIL (o, si no está, a SUPPORT_EMAIL). Sin ninguno de
// los dos solo queda en el log — nunca lanza.
export async function enviarAlertaProveedor({ proveedor, status, detalle, impacto }) {
  const destino = process.env.ALERTAS_SISTEMA_EMAIL || process.env.SUPPORT_EMAIL;
  const texto = `${proveedor} está sin crédito o cuota (HTTP ${status}).\n\nQué deja de funcionar: ${impacto}\n\nRespuesta del proveedor: ${detalle}\n\nMientras no se recargue, esa fuente devuelve 0 resultados y el análisis sigue "exitoso" sin traer nada nuevo. Este aviso se repite como máximo una vez cada 12 horas por proveedor.`;
  if (!brevoConfigurado() || !destino) {
    console.error(`[mailer] ALERTA DE PROVEEDOR (sin destino configurado): ${texto}`);
    return { enviado: false };
  }
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;">
      <div style="background:#b91c1c;padding:20px 28px;border-radius:8px 8px 0 0;">
        <span style="color:#ffffff;font-size:16px;font-weight:700;">Sentiment Unicornio — aviso del sistema</span>
      </div>
      <div style="border:1px solid #e5e5e0;border-top:none;border-radius:0 0 8px 8px;padding:24px 28px;">
        <h2 style="margin:0 0 12px;color:#161712;font-size:18px;">${proveedor} sin crédito o cuota</h2>
        <p style="margin:0 0 12px;color:#161712;font-size:14px;"><strong>Qué deja de funcionar:</strong> ${impacto}</p>
        <p style="margin:0 0 12px;color:#7a7475;font-size:13px;">Respuesta del proveedor (HTTP ${status}): ${detalle.replace(/</g, "&lt;")}</p>
        <p style="margin:0;color:#161712;font-size:14px;">Mientras no se recargue, esa fuente devuelve 0 resultados y el análisis sigue marcándose como exitoso sin traer nada nuevo. Este aviso se repite como máximo una vez cada 12 horas por proveedor.</p>
      </div>
    </div>`;
  try {
    await enviarConBrevo({ to: destino, subject: `Aviso: ${proveedor} sin crédito o cuota`, text: texto, html });
    return { enviado: true };
  } catch (e) {
    console.error("[mailer] Error enviando alerta de proveedor:", e.message);
    return { enviado: false };
  }
}

export async function enviarCorreoRecuperacion(destinatario, nombre, resetUrl, expirationMinutes = 60) {
  return enviarPlantilla({
    to: destinatario,
    asunto: "Recupera tu contraseña — Sentiment Unicornio",
    plantilla: "recuperacion-password",
    variables: { reset_url: resetUrl, expiration_minutes: expirationMinutes },
    textoAlterno: textoPlano([
      `Hola ${primerNombre(nombre)},`,
      `Recibimos una solicitud para restablecer tu contraseña. Este enlace es válido por ${expirationMinutes} minutos:`,
      resetUrl,
      "Si no fuiste tú, ignora este correo.",
    ]),
  });
}
