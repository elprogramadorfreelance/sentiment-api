import pkg from "pg";
import { createHash, randomBytes } from "crypto";
import bcrypt from "bcrypt";

const { Pool } = pkg;

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const BCRYPT_ROUNDS = 12;
export const hashPassword  = (p) => bcrypt.hash(p, BCRYPT_ROUNDS);
export const verifyPassword = async (plain, stored) => {
  if (stored.startsWith("$2b$") || stored.startsWith("$2a$"))
    return bcrypt.compare(plain, stored);
  return sha256(plain) === stored; // compatibilidad cuentas antiguas
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const q  = (text, params) => pool.query(text, params);

// gpt-4o escribe las fechas de "relevant_publications"/amplificadores en
// formato día/mes/año (se le pide "Todo en español" en el prompt), pero
// `new Date("12/9/2026")` en JS lo interpreta como mes/día/año (EEUU) — un
// error real encontrado en producción: "12/9/2026" (12 de septiembre) se
// guardaba como 9 de diciembre, una fecha en el futuro para una nota que ya
// se publicó. Aquí se interpreta explícitamente como DD/MM/YYYY antes de
// intentar cualquier otro formato, y se descarta (null) cualquier fecha que
// de todas formas quede en el futuro — mejor sin fecha que con una mentira.
function safeDate(val) {
  if (!val) return null;
  const texto = String(val).trim();
  const dmy = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const d = dmy
    ? new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])))
    : new Date(texto);
  if (isNaN(d.getTime())) return null;
  // Margen de 1 día por huso horario: "hoy" real en otra zona puede caer
  // como "mañana" en UTC sin ser en verdad una fecha futura.
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
  return d;
}
// Saltos de línea dentro de un campo de texto rompen filas al exportar a
// CSV/Excel — causa comprobada, señalada también en el manual de datos de
// Luis. Se colapsan a espacio antes de guardar, nunca después.
function sanitizarTexto(val) {
  if (val === null || val === undefined) return val;
  return String(val).replace(/[\r\n]+/g, " ").trim() || null;
}
const one = async (text, params) => { const r = await pool.query(text, params); return r.rows[0] ?? null; };
const all = async (text, params) => { const r = await pool.query(text, params); return r.rows; };

// ═══════════════════════════════════════════════════════════════════════════════
// SEED on startup
// ═══════════════════════════════════════════════════════════════════════════════
const DEMO_EMAIL    = process.env.DEMO_EMAIL || "demo@sentiment.mx";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || randomBytes(16).toString("hex");

async function seed() {
  try {
    // Demo user
    await q(`
      INSERT INTO users (name, email, password_hash, role, status)
      VALUES ($1,$2,$3,'admin','active')
      ON CONFLICT (email) DO NOTHING
    `, ["Demo Sentiment", DEMO_EMAIL, sha256(DEMO_PASSWORD)]);

    // Demo projects (only if user has 0 projects)
    const user = await one(`SELECT id FROM users WHERE email=$1`, [DEMO_EMAIL]);
    if (!user) return;
    const { rows: [{ c }] } = await q(`SELECT COUNT(*) AS c FROM projects WHERE user_id=$1`, [user.id]);
    if (parseInt(c) > 0) return;

    const ins = `INSERT INTO projects (user_id,name,description,main_topic,region,language) VALUES ($1,$2,$3,$4,$5,$6)`;
    await q(ins, [user.id, "Eduardo Rivera",    "Monitoreo reputacional político.",                        "Eduardo Rivera alcalde Puebla",         "Puebla",    "es"]);
    await q(ins, [user.id, "Alejandro Armenta", "Seguimiento de conversación pública y medios de Puebla.", "Alejandro Armenta gobernador de Puebla","Puebla",    "es"]);
    await q(ins, [user.id, "Maru Campos",       "Monitoreo de riesgo reputacional y menciones nacionales.","Maru Campos ante la FGR caso CIA",      "Chihuahua", "es"]);
  } catch (e) {
    console.error("Seed error:", e.message);
  }
}
seed();

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYSES
// ═══════════════════════════════════════════════════════════════════════════════

export async function saveAnalysis(topic, data, projectId = null, groundingHash = null) {
  const r = await q(`
    INSERT INTO analyses
      (topic, risk_level, total_mentions, estimated_reach,
       sentiment_pos, sentiment_neg, sentiment_neu, response_json, project_id, grounding_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING id
  `, [
    topic,
    data.risk_level ?? null,
    data.total_mentions ?? null,
    data.estimated_reach ?? null,
    data.sentiment?.positive ?? null,
    data.sentiment?.negative ?? null,
    data.sentiment?.neutral ?? null,
    JSON.stringify(data),
    projectId,
    groundingHash,
  ]);
  return r.rows[0].id;
}

/** Análisis más reciente de un proyecto con su hash de contexto real — para decidir si vale la pena repetir la síntesis de IA. */
export async function getLatestAnalysisForProject(projectId) {
  return one(
    `SELECT id, response_json, grounding_hash, created_at FROM analyses WHERE project_id=$1 ORDER BY id DESC LIMIT 1`,
    [projectId],
  );
}

// ─── Caché de búsquedas de IA por tema ────────────────────────────────────────
// Evita re-pagar Perplexity para el mismo tema si ya se buscó hace poco —
// las noticias no cambian minuto a minuto, así que una ventana de horas no
// le cuesta frescura real al análisis.
export async function getCachedSearch(topicHash, provider, maxAgeMinutes) {
  return one(
    `SELECT response_json FROM ai_search_cache
     WHERE topic_hash=$1 AND provider=$2 AND created_at > NOW() - ($3 || ' minutes')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [topicHash, provider, maxAgeMinutes],
  );
}

export async function saveCachedSearch(topicHash, provider, responseJson) {
  await q(`INSERT INTO ai_search_cache (topic_hash, provider, response_json) VALUES ($1,$2,$3)`,
    [topicHash, provider, responseJson]);
}

// ─── Bitácora de gasto real de IA ──────────────────────────────────────────────
export async function saveUsageLog(userId, projectId, analysisId, model, inputTokens, outputTokens, estimatedCost) {
  await q(`
    INSERT INTO usage_logs (user_id, project_id, analysis_id, model, input_tokens, output_tokens, estimated_cost)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [userId ?? null, projectId ?? null, analysisId ?? null, model, inputTokens ?? null, outputTokens ?? null, estimatedCost ?? null]);
}

/**
 * Consumo real de IA por usuario — para el panel de Super Usuario. LEFT JOIN
 * para que un usuario sin ningún registro en usage_logs todavía aparezca en
 * cero, no desaparezca de la lista.
 */
export async function getUsageSummary(organizationId = null) {
  const filtroOrg = organizationId ? "AND u.organization_id=$1" : "";
  const params = organizationId ? [organizationId] : [];
  const filas = await all(`
    SELECT
      u.id, u.name, u.email, u.role, u.organization_id,
      COUNT(ul.model) AS eventos,
      COALESCE(SUM(ul.input_tokens), 0) AS tokens_entrada,
      COALESCE(SUM(ul.output_tokens), 0) AS tokens_salida,
      MAX(ul.created_at) AS ultimo_uso
    FROM users u
    LEFT JOIN usage_logs ul ON ul.user_id = u.id
    WHERE u.status='active' ${filtroOrg}
    GROUP BY u.id, u.name, u.email, u.role, u.organization_id
    ORDER BY (COALESCE(SUM(ul.input_tokens),0) + COALESCE(SUM(ul.output_tokens),0)) DESC
  `, params);
  // pg regresa COUNT/SUM como string (bigint) — se convierten aquí para que
  // el frontend reciba números reales, no texto.
  return filas.map(f => ({
    ...f,
    eventos: parseInt(f.eventos, 10),
    tokens_entrada: parseInt(f.tokens_entrada, 10),
    tokens_salida: parseInt(f.tokens_salida, 10),
  }));
}

/** Cuántos análisis corrió este proyecto en las últimas 24h — para aplicar daily_query_limit. */
export async function countAnalysesLast24h(projectId) {
  const { rows: [{ c }] } = await q(
    `SELECT COUNT(*) AS c FROM analyses WHERE project_id=$1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [projectId],
  );
  return parseInt(c);
}

export async function getHistory(limit = 50, offset = 0) {
  const rows  = await all(`SELECT id,topic,created_at,risk_level,total_mentions,estimated_reach,sentiment_pos,sentiment_neg,sentiment_neu FROM analyses ORDER BY id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  const { rows: [{ total }] } = await q(`SELECT COUNT(*) AS total FROM analyses`);
  return { total: parseInt(total), rows };
}

export async function getAnalysisById(id) {
  const row = await one(`SELECT id,topic,created_at,risk_level,total_mentions,estimated_reach,sentiment_pos,sentiment_neg,sentiment_neu,response_json FROM analyses WHERE id=$1`, [id]);
  if (!row) return null;
  try { row.response_json = JSON.parse(row.response_json); } catch {}
  return row;
}

export async function getAnalysesByProject(projectId) {
  return all(`SELECT id,topic,created_at,risk_level,total_mentions,estimated_reach,sentiment_pos,sentiment_neg,sentiment_neu FROM analyses WHERE project_id=$1 ORDER BY id DESC LIMIT 50`, [projectId]);
}

export async function getAnalysesWithJsonByProject(projectId) {
  return all(`SELECT id,topic,created_at,risk_level,total_mentions,response_json FROM analyses WHERE project_id=$1 ORDER BY id DESC LIMIT 50`, [projectId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getUserByEmail(email) {
  return one(`SELECT * FROM users WHERE email=$1 AND status='active'`, [email]);
}

export async function getOrCreateDemoUser() {
  let user = await one(`SELECT * FROM users WHERE email=$1`, [DEMO_EMAIL]);
  if (!user) {
    await q(`INSERT INTO users (name,email,password_hash,role,status) VALUES ($1,$2,$3,'admin','active') ON CONFLICT (email) DO NOTHING`,
      ["Demo Sentiment", DEMO_EMAIL, sha256(DEMO_PASSWORD)]);
    user = await one(`SELECT * FROM users WHERE email=$1`, [DEMO_EMAIL]);
  }
  return user;
}

export async function getAllOrganizations() {
  const filas = await all(`
    SELECT o.*,
      (SELECT COUNT(*) FROM users u WHERE u.organization_id=o.id AND u.status='active') AS user_count,
      (SELECT COUNT(*) FROM projects p WHERE p.organization_id=o.id AND p.status='active') AS project_count
    FROM organizations o ORDER BY o.id ASC
  `);
  // Mismo caso que getUsageSummary: pg regresa COUNT(*) como string.
  return filas.map(f => ({
    ...f,
    user_count: parseInt(f.user_count, 10),
    project_count: parseInt(f.project_count, 10),
  }));
}

export async function updateOrganization(id, data) {
  const fields = []; const values = []; let i = 1;
  if (data.name        !== undefined) { fields.push(`name=$${i++}`);         values.push(data.name); }
  if (data.plan        !== undefined) { fields.push(`plan=$${i++}`);         values.push(data.plan); }
  if (data.max_projects!== undefined) { fields.push(`max_projects=$${i++}`); values.push(data.max_projects); }
  if (!fields.length) return getOrganizationById(id);
  values.push(id);
  await q(`UPDATE organizations SET ${fields.join(',')} WHERE id=$${i}`, values);
  return getOrganizationById(id);
}

export async function createOrganization(name, plan = 'basic', maxProjects = 10) {
  const r = await q(`INSERT INTO organizations (name,plan,max_projects) VALUES ($1,$2,$3) RETURNING *`, [name, plan, maxProjects]);
  return r.rows[0];
}

export async function getOrganizationById(id) {
  return one(`SELECT * FROM organizations WHERE id=$1`, [id]);
}

export async function getOrgIdForUser(userId) {
  const u = await one(`SELECT organization_id FROM users WHERE id=$1`, [userId]);
  return u?.organization_id ?? 1;
}

// Tope real de descargas de Infografía en PDF para cuentas Demo (plan=basic)
// — pedido del cliente (correcciones-1-octubre, punto E19). Planes pagados no
// tienen tope. El conteo vive en una columna de organizations (no en
// localStorage del navegador, que se puede borrar/evadir) e incrementa de
// forma atómica en la misma consulta para no perder cuenta ante llamadas
// simultáneas.
const TOPE_DESCARGAS_INFOGRAFIA_DEMO = 3;

export async function registrarDescargaInfografia(orgId) {
  const org = await getOrganizationById(orgId);
  if (!org) return { permitido: false, restantes: 0, tope: TOPE_DESCARGAS_INFOGRAFIA_DEMO };
  if (org.plan !== 'basic') {
    return { permitido: true, restantes: null, tope: null };
  }
  const r = await q(
    `UPDATE organizations SET infografia_descargas_usadas = infografia_descargas_usadas + 1
     WHERE id=$1 AND infografia_descargas_usadas < $2
     RETURNING infografia_descargas_usadas`,
    [orgId, TOPE_DESCARGAS_INFOGRAFIA_DEMO],
  );
  if (!r.rows[0]) {
    return { permitido: false, restantes: 0, tope: TOPE_DESCARGAS_INFOGRAFIA_DEMO };
  }
  const usadas = r.rows[0].infografia_descargas_usadas;
  return { permitido: true, restantes: TOPE_DESCARGAS_INFOGRAFIA_DEMO - usadas, tope: TOPE_DESCARGAS_INFOGRAFIA_DEMO };
}

// Mismo mecanismo que registrarDescargaInfografia (contador real en
// organizations, atómico, solo plan Demo) pero para el resto de reportes PDF
// de la app (Narrativas/Sentimiento/Proyectos/Benchmarking/Análisis) — tienen
// exportación desde antes pero nunca tuvieron tope, a diferencia de
// Infografía (2026-10-02, pedido del cliente: "limita el número de descargas
// PDF que pudiera existir"). Pool COMPARTIDO entre esos 5 (no uno por cada
// uno) — un tope por reporte individual sería 5x más fricción de la que el
// cliente pidió para un control que ya es solo disuasivo en un plan Demo.
const TOPE_DESCARGAS_REPORTES_DEMO = 3;

export async function registrarDescargaReportePdf(orgId) {
  const org = await getOrganizationById(orgId);
  if (!org) return { permitido: false, restantes: 0, tope: TOPE_DESCARGAS_REPORTES_DEMO };
  if (org.plan !== 'basic') {
    return { permitido: true, restantes: null, tope: null };
  }
  const r = await q(
    `UPDATE organizations SET reportes_pdf_descargas_usadas = reportes_pdf_descargas_usadas + 1
     WHERE id=$1 AND reportes_pdf_descargas_usadas < $2
     RETURNING reportes_pdf_descargas_usadas`,
    [orgId, TOPE_DESCARGAS_REPORTES_DEMO],
  );
  if (!r.rows[0]) {
    return { permitido: false, restantes: 0, tope: TOPE_DESCARGAS_REPORTES_DEMO };
  }
  const usadas = r.rows[0].reportes_pdf_descargas_usadas;
  return { permitido: true, restantes: TOPE_DESCARGAS_REPORTES_DEMO - usadas, tope: TOPE_DESCARGAS_REPORTES_DEMO };
}

export async function createUser(data) {
  const allowed = ["admin","editor","viewer"];
  const role = allowed.includes(data.role) ? data.role : "viewer";
  const orgId = data.organization_id ?? 1;
  const hash = await hashPassword(data.password);
  const r = await q(`INSERT INTO users (name,email,password_hash,role,status,organization_id) VALUES ($1,$2,$3,$4,'active',$5) RETURNING id`,
    [data.name, data.email.trim().toLowerCase(), hash, role, orgId]);
  return getUserById(r.rows[0].id);
}

export async function getUsers(organizationId = null) {
  if (organizationId) {
    return all(`SELECT id,name,email,role,status,created_at,organization_id FROM users WHERE status='active' AND organization_id=$1 ORDER BY id ASC`, [organizationId]);
  }
  return all(`SELECT id,name,email,role,status,created_at,organization_id FROM users WHERE status='active' ORDER BY id ASC`);
}

export async function getUserById(id) {
  return one(`SELECT id,name,email,role,status,created_at,organization_id FROM users WHERE id=$1`, [id]);
}

export async function updateUserPassword(id, newPassword) {
  const hash = await hashPassword(newPassword);
  await q(`UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2`, [hash, id]);
}

// ─── Solicitudes de demo ─────────────────────────────────────────────────────
export async function saveDemoRequest(data) {
  const r = await q(
    `INSERT INTO demo_requests (nombre, apellidos, telefono, email, comentario) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.nombre, data.apellidos ?? null, data.telefono ?? null, data.email, data.comentario ?? null]
  );
  return r.rows[0];
}

// ─── Recuperar contraseña ───────────────────────────────────────────────────
// Token de un solo uso, 1h de validez. No revela si el correo existe: el
// endpoint siempre responde igual, solo el token real (si el usuario existe)
// permite completar el cambio.
export async function createPasswordResetToken(userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
  await q(`INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)`, [userId, token, expiresAt]);
  return { token, expiresAt };
}

export async function getValidResetToken(token) {
  return one(`SELECT * FROM password_reset_tokens WHERE token=$1 AND used=FALSE AND expires_at > NOW()`, [token]);
}

export async function consumeResetToken(token) {
  await q(`UPDATE password_reset_tokens SET used=TRUE WHERE token=$1`, [token]);
}

// ─── Acciones de Perfil por link mágico (cambio de correo, traspaso) ───────
// A diferencia del OTP (que autoriza y aplica el cambio en el mismo request),
// estas dos acciones necesitan un link real que expira de verdad y que, al
// darle clic, recién ahí aplica el cambio — así el texto del correo ("da clic
// para confirmar") es cierto, no una formalidad post-hoc. En tabla, no en
// memoria: un restart del backend no debe invalidar un link que el usuario
// todavía no ha revisado (puede tardar horas en abrir su correo).
export async function createPendingProfileAction(userId, action, payload, ttlHours = 24) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await q(
    `INSERT INTO pending_profile_actions (token,user_id,action,payload_json,expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [token, userId, action, JSON.stringify(payload), expiresAt],
  );
  return { token, expiresAt };
}

export async function getPendingProfileAction(token) {
  return one(
    `SELECT * FROM pending_profile_actions WHERE token=$1 AND used=FALSE AND expires_at > NOW()`,
    [token],
  );
}

export async function consumePendingProfileAction(token) {
  await q(`UPDATE pending_profile_actions SET used=TRUE WHERE token=$1`, [token]);
}

// ─── Sesión real ─────────────────────────────────────────────────────────────
// Token opaco de un solo usuario (no JWT — no hay nada que decodificar en el
// cliente, así que un token robado no revela nada). `recordar` controla la
// vigencia: 30 días si el usuario marcó "mantener sesión activa", 12h si no.
export async function createSession(userId, recordar) {
  const token = randomBytes(32).toString("hex");
  const ms = recordar ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ms);
  await q(`INSERT INTO sessions (user_id, token, expires_at) VALUES ($1,$2,$3)`, [userId, token, expiresAt]);
  return { token, expiresAt };
}

export async function getSessionUser(token) {
  const row = await one(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.organization_id, o.plan
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN organizations o ON o.id = u.organization_id
     WHERE s.token=$1 AND s.expires_at > NOW()`,
    [token],
  );
  if (!row || row.status !== "active") return null;
  return row;
}

export async function deleteSession(token) {
  await q(`DELETE FROM sessions WHERE token=$1`, [token]);
}

// ─── Bitácora de análisis ────────────────────────────────────────────────────
// Persistida en Postgres a propósito: los logs de PM2 se pierden en cada
// restart/deploy, así que un fallo de hace una semana (ej. un auto-análisis
// que nunca terminó) queda sin rastro si solo se loguea a consola. Esto
// sobrevive restarts y se puede consultar por proyecto en cualquier momento.
export async function startAnalysisRun(projectId, trigger) {
  const r = await q(
    `INSERT INTO analysis_runs (project_id, trigger, status) VALUES ($1,$2,'running') RETURNING id`,
    [projectId, trigger],
  );
  return r.rows[0].id;
}

export async function logAnalysisRunStep(runId, step, ok, detail = null, count = null, ms = null) {
  await q(
    `INSERT INTO analysis_run_steps (run_id, step, ok, detail, count, ms) VALUES ($1,$2,$3,$4,$5,$6)`,
    [runId, step, ok, detail, count, ms],
  );
}

export async function finishAnalysisRun(runId, status, errorMessage = null) {
  await q(
    `UPDATE analysis_runs SET status=$1, error_message=$2, finished_at=NOW() WHERE id=$3`,
    [status, errorMessage, runId],
  );
}

export async function getAnalysisRunsByProject(projectId, limit = 20) {
  return all(
    `SELECT * FROM analysis_runs WHERE project_id=$1 ORDER BY started_at DESC LIMIT $2`,
    [projectId, limit],
  );
}

export async function getAnalysisRunSteps(runId) {
  return all(`SELECT * FROM analysis_run_steps WHERE run_id=$1 ORDER BY created_at ASC`, [runId]);
}

export async function updateUserProfile(id, name, email) {
  const fields = []; const values = []; let i = 1;
  if (name)  { fields.push(`name=$${i++}`);  values.push(name); }
  if (email) { fields.push(`email=$${i++}`); values.push(email.trim().toLowerCase()); }
  if (!fields.length) return getUserById(id);
  fields.push(`updated_at=NOW()`);
  values.push(id);
  await q(`UPDATE users SET ${fields.join(",")} WHERE id=$${i}`, values);
  return getUserById(id);
}

export async function updateUser(id, data) {
  const allowed = ["admin","editor","viewer"];
  const fields = []; const values = [];
  let i = 1;
  if (data.name !== undefined) { fields.push(`name=$${i++}`); values.push(data.name); }
  if (data.role !== undefined && allowed.includes(data.role)) {
    if (data.role !== "admin") {
      const user = await getUserById(id);
      if (user?.role === "admin") {
        const { rows: [{ c }] } = await q(`SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'`);
        if (parseInt(c) <= 1) return { error: "No puedes cambiar el rol del único administrador activo." };
      }
    }
    fields.push(`role=$${i++}`); values.push(data.role);
  }
  if (data.status !== undefined) { fields.push(`status=$${i++}`); values.push(data.status); }
  if (!fields.length) return getUserById(id);
  fields.push(`updated_at=NOW()`);
  values.push(id);
  await q(`UPDATE users SET ${fields.join(",")} WHERE id=$${i}`, values);
  return getUserById(id);
}

export async function archiveUser(id) {
  const { rows: [{ c }] } = await q(`SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'`);
  const user = await getUserById(id);
  if (user?.role === "admin" && parseInt(c) <= 1) return { error: "No puedes archivar al único administrador activo." };
  await q(`UPDATE users SET status='archived',updated_at=NOW() WHERE id=$1`, [id]);
  return { ok: true };
}

export async function countActiveAdmins() {
  const { rows: [{ c }] } = await q(`SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'`);
  return parseInt(c);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createProject(userId, data) {
  const orgId = await getOrgIdForUser(userId);
  const r = await q(`INSERT INTO projects (user_id,name,description,main_topic,region,language,organization_id,image_url,project_type,country_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [userId, data.name, data.description ?? null, data.main_topic, data.region ?? "México", data.language ?? "es", orgId, data.image_url ?? null, data.project_type ?? null, (data.country_code ?? "MX").toUpperCase()]);
  // Sin esto, un usuario con rol "editor" (no admin/superadmin) crea el
  // proyecto pero no aparece en su propio panel — getProjectsForUser exige
  // una fila en project_members para roles que no son admin/superadmin.
  await upsertProjectMember(r.rows[0].id, userId, "editor");
  return getProjectById(r.rows[0].id);
}

export async function getProjectsByUser(userId) {
  return all(`
    SELECT p.*,
      (SELECT COUNT(*) FROM analyses a WHERE a.project_id=p.id) AS analysis_count,
      (SELECT MAX(a.created_at) FROM analyses a WHERE a.project_id=p.id) AS last_analysis_at
    FROM projects p WHERE p.user_id=$1 AND p.status IN ('active','inactive') ORDER BY p.id DESC
  `, [userId]);
}

export async function getProjectById(projectId) {
  return one(`SELECT * FROM projects WHERE id=$1`, [projectId]);
}

export async function countActiveProjectsByUser(userId) {
  const orgId = await getOrgIdForUser(userId);
  const { rows: [{ c }] } = await q(`SELECT COUNT(*) AS c FROM projects WHERE organization_id=$1 AND status='active'`, [orgId]);
  return parseInt(c);
}

export async function getOrgMaxProjects(userId) {
  const orgId = await getOrgIdForUser(userId);
  const org = await getOrganizationById(orgId);
  return org?.max_projects ?? 10;
}

export async function updateProject(projectId, data) {
  const fields = []; const values = []; let i = 1;
  if (data.name        !== undefined) { fields.push(`name=$${i++}`);        values.push(data.name); }
  if (data.description !== undefined) { fields.push(`description=$${i++}`); values.push(data.description); }
  if (data.main_topic  !== undefined) { fields.push(`main_topic=$${i++}`);  values.push(data.main_topic); }
  if (data.region      !== undefined) { fields.push(`region=$${i++}`);      values.push(data.region); }
  if (data.language    !== undefined) { fields.push(`language=$${i++}`);    values.push(data.language); }
  if (data.country_code!== undefined) { fields.push(`country_code=$${i++}`);values.push(String(data.country_code).toUpperCase()); }
  if (data.status      !== undefined) { fields.push(`status=$${i++}`);      values.push(data.status); }
  if (data.image_url   !== undefined) { fields.push(`image_url=$${i++}`);   values.push(data.image_url); }
  if (data.project_type!== undefined) { fields.push(`project_type=$${i++}`);values.push(data.project_type); }
  if (!fields.length) return getProjectById(projectId);
  fields.push(`updated_at=NOW()`);
  values.push(projectId);
  await q(`UPDATE projects SET ${fields.join(",")} WHERE id=$${i}`, values);
  return getProjectById(projectId);
}

export async function deleteProject(projectId) {
  await q(`UPDATE projects SET status='archived',updated_at=NOW() WHERE id=$1`, [projectId]);
}

// Redes conectadas por proyecto, en la MISMA consulta que ya trae
// analysis_count/last_analysis_at (mismo patrón: subquery agregada, no una
// llamada aparte por proyecto). Antes /api/projects no traía esto y el
// mapeo del lado del frontend lo dejaba fijo en `[]` (bug real reportado
// por el cliente, 2026-10-01: el Resumen IA del Dashboard decía "sin redes
// conectadas" aunque el proyecto sí tuviera Facebook/Instagram/TikTok/X
// activos de verdad — nunca se leía project_sources en esta ruta).
const SUBQUERY_REDES_CONECTADAS = `
  (SELECT COALESCE(json_agg(ps.source_type), '[]')
   FROM project_sources ps WHERE ps.project_id=p.id AND ps.is_active) AS connected_sources
`;

// Mismo patrón y misma razón que SUBQUERY_REDES_CONECTADAS, pero para
// palabras clave reales — /api/projects ya traía `analysis_count` como
// número real, pero el mapeo del lado del frontend ni siquiera lo leía
// (seguía escribiendo `analisis: 0` fijo) y las palabras clave nunca
// pasaban de envolver `main_topic` en un arreglo de 1 — bug real reportado
// por el cliente 2026-10-02: el Resumen IA decía "0 análisis, 1 palabra
// clave" para un proyecto con 165 análisis y 8 palabras clave reales.
const SUBQUERY_PALABRAS_CLAVE = `
  (SELECT COALESCE(json_agg(k.keyword), '[]')
   FROM project_keywords k WHERE k.project_id=p.id) AS real_keywords
`;

export async function getProjectsForUser(userId, role) {
  if (role === "superadmin") {
    return all(`
      SELECT p.*,
        (SELECT COUNT(*) FROM analyses a WHERE a.project_id=p.id) AS analysis_count,
        (SELECT MAX(a.created_at) FROM analyses a WHERE a.project_id=p.id) AS last_analysis_at,
        ${SUBQUERY_REDES_CONECTADAS},
        ${SUBQUERY_PALABRAS_CLAVE},
        'editor' AS user_permission
      FROM projects p WHERE p.status IN ('active','inactive') ORDER BY p.id DESC
    `);
  }
  if (role === "admin") {
    const orgId = await getOrgIdForUser(userId);
    return all(`
      SELECT p.*,
        (SELECT COUNT(*) FROM analyses a WHERE a.project_id=p.id) AS analysis_count,
        (SELECT MAX(a.created_at) FROM analyses a WHERE a.project_id=p.id) AS last_analysis_at,
        ${SUBQUERY_REDES_CONECTADAS},
        ${SUBQUERY_PALABRAS_CLAVE},
        'editor' AS user_permission
      FROM projects p WHERE p.status IN ('active','inactive') AND p.organization_id=$1 ORDER BY p.id DESC
    `, [orgId]);
  }
  return all(`
    SELECT p.*,
      (SELECT COUNT(*) FROM analyses a WHERE a.project_id=p.id) AS analysis_count,
      (SELECT MAX(a.created_at) FROM analyses a WHERE a.project_id=p.id) AS last_analysis_at,
      ${SUBQUERY_REDES_CONECTADAS},
      ${SUBQUERY_PALABRAS_CLAVE},
      pm.permission AS user_permission
    FROM projects p
    JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$1
    WHERE p.status IN ('active','inactive') ORDER BY p.id DESC
  `, [userId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// KEYWORDS & SOURCES
// ═══════════════════════════════════════════════════════════════════════════════

export async function saveProjectKeywords(projectId, keywords) {
  await q(`DELETE FROM project_keywords WHERE project_id=$1`, [projectId]);
  for (const kw of keywords) {
    await q(`INSERT INTO project_keywords (project_id,keyword,type) VALUES ($1,$2,$3)`, [projectId, kw.keyword, kw.type ?? "main"]);
  }
}

export async function getProjectKeywords(projectId) {
  return all(`SELECT * FROM project_keywords WHERE project_id=$1 ORDER BY type,keyword`, [projectId]);
}

export async function saveProjectSources(projectId, sources) {
  await q(`DELETE FROM project_sources WHERE project_id=$1`, [projectId]);
  for (const s of sources) {
    await q(`INSERT INTO project_sources (project_id,source_type,is_active) VALUES ($1,$2,true)`, [projectId, s]);
  }
}

export async function getProjectSources(projectId) {
  return all(`SELECT * FROM project_sources WHERE project_id=$1`, [projectId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MENTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// Antes insertaba cada publicación como fila nueva sin revisar si esa URL ya
// existía en el proyecto — si la IA volvía a citar el mismo artículo en un
// "Analizar ahora" posterior (normal, un tema sigue activo), quedaba
// duplicado (se encontró un caso real con 8 copias de la misma nota de
// Google News), contando su sentimiento 8 veces en vez de 1 y sesgando el %
// real. Ahora, si la URL ya existe para este proyecto (típicamente guardada
// sin sentimiento por saveMentionRaw), se enriquece esa fila con el
// sentimiento/riesgo que la IA sí clasificó en vez de duplicar — de paso,
// esto también aumenta con el tiempo cuántas menciones reales quedan
// clasificadas, sin inventar nada: solo evita perder una clasificación real
// que ya se tenía.
export async function saveMentionsFromAnalysis(projectId, analysisId, publications) {
  if (!Array.isArray(publications)) return;
  for (const pub of publications) {
    const url = pub.url || null;
    // Sin URL real, esta cita no es una publicación verificable — es solo un
    // eco de la narrativa (ya guardada aparte en saveNarrativesFromAnalysis).
    // Sin url no hay forma de deduplicar contra citas previas de la misma
    // narrativa, así que cada corrida del análisis (cada 2h) insertaba una
    // fila "mención" nueva con título truncado y sin link — acumulando
    // decenas de entradas fantasma no navegables en Menciones/Temas.
    if (!url) continue;
    // El prompt de gpt-4o pide "Positivo"/"Negativo"/"Neutral" (capitalizado);
    // el clasificador de backlog (gpt-4o-mini) guarda en minúsculas. El
    // frontend compara con === "positivo" en minúsculas — sin normalizar
    // aquí, cada mención citada por el análisis narrativo caía silenciosamente
    // en "neutro" aunque la IA sí la hubiera calificado como positiva/negativa.
    const sentiment = pub.sentiment ? String(pub.sentiment).toLowerCase() : null;
    const existente = await one(`SELECT id FROM mentions WHERE project_id=$1 AND url=$2 LIMIT 1`, [projectId, url]);

    if (existente) {
      await q(`
        UPDATE mentions SET
          sentiment = COALESCE($1, sentiment),
          risk_level = COALESCE($2, risk_level),
          reach = COALESCE($3, reach),
          reach_numeric = COALESCE(reach_numeric, $7),
          analysis_id = COALESCE(analysis_id, $4),
          raw_json = $5
        WHERE id = $6
      `, [sentiment, pub.risk ?? null, pub.estimated_reach ?? null, analysisId, JSON.stringify(pub), existente.id, reachNumerico(pub.estimated_reach)]);
      continue;
    }

    const fechaPub = safeDate(pub.date);
    const tituloPub = pub.detected_narrative ?? pub.title ?? null;
    const clasif = await clasificarMencionNueva(projectId, {
      url, source_type: pub.type ?? pub.channel ?? null, author_name: null,
      reach: pub.estimated_reach ?? null, published_at: fechaPub,
      title: tituloPub, content: pub.description ?? null,
    });

    await q(`
      INSERT INTO mentions (analysis_id,project_id,title,url,source_name,source_type,published_at,sentiment,risk_level,reach,raw_json,
                             source_type_id,reach_numeric,published_at_tz,fecha_publicacion_confiable,keyword_matched_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7::timestamp,$8,$9,$10,$11,$12,$13,$7::timestamp AT TIME ZONE 'America/Mexico_City',$14,$15)
    `, [
      analysisId, projectId,
      sanitizarTexto(tituloPub),
      url,
      sanitizarTexto(pub.source ?? null),
      pub.type ?? pub.channel ?? null,
      fechaPub,
      sentiment,
      pub.risk ?? null,
      pub.estimated_reach ?? null,
      JSON.stringify(pub),
      clasif.source_type_id, clasif.reach_numeric, clasif.fecha_publicacion_confiable,
      clasif.keyword_matched_id,
    ]);
  }
}

// LIMIT alto, no "sin límite", para no arriesgar una consulta descontrolada
// si algún día un proyecto acumula decenas de miles de menciones — pero el
// tope viejo (100) ya se quedaba corto con la cobertura real de un solo
// análisis de un tema mediático (YouTube solo ya puede traer 100+), y como
// esta es LA función que alimenta Menciones/Sentimiento/Narrativas/paneles
// en toda la app, ese corte silencioso escondía menciones reales en
// cualquier proyecto con buena cobertura — justo los que más importa mostrar completos.
// fuente_codigo/fuente_nombre/autor_canonico: campos limpios de la Fase 3/4
// (arquitectura Luis v2) — catálogo real en vez de las 511 variantes libres
// de source_type. Nulos en menciones que aún no pasaron por el backfill
// (nuevas, insertadas después de la migración); el frontend cae de vuelta a
// la heurística vieja (normalizarTipoFuente) cuando vienen nulos.
// Lee de v_menciones_enriquecidas (Fase 4/5, arquitectura Luis v2) en vez de
// repetir los mismos LEFT JOIN inline — mismo resultado exacto (verificado:
// 3,270 filas en ambos caminos para el proyecto 41 antes de este cambio),
// pero ahora sí pasa por la vista consolidada en vez de duplicarla.
export async function getMentionsByProject(projectId) {
  return all(
    `SELECT * FROM v_menciones_enriquecidas WHERE project_id=$1 ORDER BY id DESC LIMIT 2000`,
    [projectId],
  );
}

// Fase 4/5 (arquitectura Luis v2) — KPIs diarios y cambio porcentual desde
// las vistas consolidadas, no reimplementados en JS. Ambas usan fecha
// efectiva (published_at_tz confiable, o fecha de detección si no hay una
// confiable) para no perder el 25.8% de menciones sin fecha de publicación
// real — mismo criterio de respaldo que ya usa el resto del dashboard.
export async function getKpiDiarioByProject(projectId) {
  return all(`SELECT * FROM v_kpi_proyecto_dia WHERE project_id=$1 ORDER BY fecha DESC`, [projectId]);
}

export async function getCambioPorcentualByProject(projectId, diasVentana = 30) {
  return all(`SELECT * FROM v_cambio_porcentual($1) WHERE project_id=$2`, [diasVentana, projectId]);
}

/** Reemplaza la miniatura de una mención (ej. reparar un link de TikTok/Instagram ya vencido). */
export async function updateMentionThumbnail(mentionId, thumbnailUrl) {
  await q(`UPDATE mentions SET thumbnail_url=$1 WHERE id=$2`, [thumbnailUrl, mentionId]);
  return one(`SELECT id, thumbnail_url FROM mentions WHERE id=$1`, [mentionId]);
}

/** Menciones reales de un proyecto que nunca recibieron sentimiento — para el clasificador por lotes. */
export async function getUnclassifiedMentions(projectId, limit = 150) {
  return all(
    `SELECT id, title, content FROM mentions
     WHERE project_id=$1 AND (sentiment IS NULL OR trim(sentiment) = '')
     ORDER BY id DESC LIMIT $2`,
    [projectId, limit],
  );
}

export async function updateMentionSentiment(id, sentiment) {
  await q(`UPDATE mentions SET sentiment=$1 WHERE id=$2`, [sentiment, id]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// NARRATIVES
// ═══════════════════════════════════════════════════════════════════════════════

// Debe ser EXACTAMENTE la misma lista que EJES_TEMATICOS en server.js (ahí
// se le manda a gpt-4o) — duplicada aquí en vez de compartida porque db.js no
// importa server.js. Si un eje llega que no está en la lista (gpt-4o no
// siguió la instrucción al pie de la letra), cae en "Otro" en vez de crear
// una categoría nueva sin controlar — mismo criterio que el resto del código
// real (ver TOPES_PALABRAS_CLAVE): validar contra una lista fija, no confiar
// ciegamente en el texto libre del modelo.
const EJES_TEMATICOS_VÁLIDOS = new Set([
  "Legislación y políticas públicas",
  "Corrupción e irregularidades",
  "Gestión de crisis",
  "Imagen y reputación",
  "Logros y reconocimientos",
  "Críticas de oposición y prensa",
  "Seguridad y riesgo social",
  "Economía e impacto social",
  "Otro",
]);

export async function saveNarrativesFromAnalysis(projectId, analysisId, narratives) {
  if (!Array.isArray(narratives)) return;
  for (const n of narratives) {
    // Mismo bug que ya se corrigió en mentions: el prompt de gpt-4o pide
    // "Positivo"/"Negativo"/"Neutral" capitalizado, el frontend compara en
    // minúsculas — sin normalizar aquí, toda narrativa caía en "neutral".
    const sentiment = n.sentiment ? String(n.sentiment).toLowerCase() : null;
    const axis = EJES_TEMATICOS_VÁLIDOS.has(n.axis) ? n.axis : "Otro";
    await q(`
      INSERT INTO narratives (analysis_id,project_id,name,axis,sentiment,risk_level,trend,mentions_level,raw_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [analysisId, projectId, n.name, axis, sentiment, n.risk ?? null, n.trend ?? null, n.mentions ?? null, JSON.stringify(n)]);
  }
}

export async function getNarrativesByProject(projectId) {
  return all(`SELECT n.*,p.name AS project_name FROM narratives n JOIN projects p ON p.id=n.project_id WHERE n.project_id=$1 ORDER BY n.id DESC LIMIT 50`, [projectId]);
}

export async function getNarrativeById(id) {
  return one(`SELECT * FROM narratives WHERE id=$1`, [id]);
}

// Solo las menciones que la IA citó explícitamente en relevant_publications
// llevan detected_narrative en su raw_json (ver saveMentionsFromAnalysis) —
// las que solo vinieron de la ingesta en vivo (Google News, YouTube, etc.)
// nunca se asociaron a una narrativa específica y no tienen raw_json. Es
// honesto que el conteo real de "menciones de esta narrativa" sea chico.
export async function getMentionsWithRawJsonByProject(projectId) {
  return all(`SELECT * FROM mentions WHERE project_id=$1 AND raw_json IS NOT NULL ORDER BY id DESC`, [projectId]);
}

// NSS (Net Sentiment Score = %positivo - %negativo) real por narrativa —
// mismo criterio de vinculación mención↔narrativa que /api/narratives/:id/mentions
// (detected_narrative en raw_json, no una FK), y misma regla que
// calcularSentimientoPorcentual del frontend: las menciones sin sentiment
// clasificado no cuentan ni en el numerador ni en el denominador.
// Agrupa por "axis" (eje temático fijo, ver EJES_TEMATICOS en server.js), no
// por "name" (título específico y libre que gpt-4o redacta distinto en cada
// corrida) — antes agrupar por name exacto dejaba narrativas idénticas en
// espíritu ("Demagogia ambiental crítica de X", "Críticas por demagogia Y")
// como barras separadas en el gráfico de NSS por tema. El vínculo
// mención↔narrativa se sigue resolviendo por name (detected_narrative en el
// raw_json de la mención es el nombre específico, no el eje), solo el bucket
// final de agregación cambió.
function calcularNssPorNarrativa(narratives, mentions) {
  const ejePorNombre = new Map();
  for (const nar of narratives) {
    const nombre = String(nar.name || "").trim().toLowerCase();
    if (!nombre || ejePorNombre.has(nombre)) continue;
    ejePorNombre.set(nombre, String(nar.axis || "").trim() || "Otro");
  }
  const porEje = new Map();
  for (const m of mentions) {
    let pub;
    try { pub = JSON.parse(m.raw_json); } catch { continue; }
    const detectada = String(pub.detected_narrative || "").trim().toLowerCase();
    const eje = ejePorNombre.get(detectada);
    if (!eje) continue;
    const sentiment = String(m.sentiment || "").toLowerCase();
    if (!sentiment) continue;
    const entry = porEje.get(eje) ?? { eje, pos: 0, neg: 0, n: 0 };
    entry.n += 1;
    if (sentiment.includes("positiv")) entry.pos += 1;
    else if (sentiment.includes("negativ")) entry.neg += 1;
    porEje.set(eje, entry);
  }
  return Array.from(porEje.values())
    .filter((e) => e.n > 0)
    .map((e) => ({ tema: e.eje, nss: Math.round(((e.pos - e.neg) / e.n) * 1000) / 10, n: e.n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);
}

// rango: { inicio, fin } en formato YYYY-MM-DD (o null) — mismo campo de
// fecha que usa el frontend para "publicadaEn" (published_at, con created_at
// de respaldo si no hay published_at).
// Fase 5 real (arquitectura Luis v2): sin rango de fechas, lee de la vista
// consolidada v_nss_por_tema (histórico completo, sin el límite de 50
// narrativas recientes que tenía el cálculo en JS — ver
// project_migracion_vistas_luis_2026-09-30). Con rango, se mantiene el
// cálculo viejo en JS (la vista no filtra por fecha) hasta que se justifique
// parametrizarla — camino menos común, mismo resultado correcto de siempre.
export async function getNssPorNarrativaByProject(projectId, rango = null) {
  if (!rango) {
    const filas = await all(
      `SELECT tema, nss::float AS nss, n::int AS n FROM v_nss_por_tema WHERE project_id=$1 ORDER BY n DESC LIMIT 8`,
      [projectId],
    );
    return filas;
  }
  const condFecha = `AND COALESCE(published_at, created_at) >= $2 AND COALESCE(published_at, created_at) < $3::date + 1`;
  const params = [projectId, rango.inicio, rango.fin];
  const [narratives, mentions] = await Promise.all([
    getNarrativesByProject(projectId),
    all(`SELECT sentiment, raw_json FROM mentions WHERE project_id=$1 AND raw_json IS NOT NULL ${condFecha}`, params),
  ]);
  return calcularNssPorNarrativa(narratives, mentions);
}

export async function getNssPorNarrativaForUser(userId, role, rango = null) {
  const f = await _projectFilter(userId, role);
  if (!rango) {
    // Bug real (2026-09-30, encontrado en logs de producción): v_nss_por_tema
    // tiene una fila por PROYECTO por tema — al agrupar varios proyectos bajo
    // el mismo tema, "v.nss" deja de ser un solo valor (puede ser +30 en un
    // proyecto y -10 en otro para el mismo eje), y Postgres correctamente
    // rechaza seleccionarlo sin agregarlo ("column v.nss must appear in the
    // GROUP BY clause"). Promedio ponderado por volumen (v.n) en vez de un
    // valor arbitrario — matemáticamente lo correcto para combinar NSS de
    // distintos proyectos, no solo lo que hace callar el error.
    const filas = await all(
      `SELECT v.tema,
              ROUND((sum(v.nss * v.n) / NULLIF(sum(v.n), 0))::numeric, 1)::float AS nss,
              sum(v.n)::int AS n
       FROM v_nss_por_tema v JOIN projects p ON p.id=v.project_id ${f.join}
       WHERE ${f.where}
       GROUP BY v.tema ORDER BY n DESC LIMIT 8`,
    );
    return filas;
  }
  const condFecha = `AND COALESCE(m.published_at, m.created_at) >= $1 AND COALESCE(m.published_at, m.created_at) < $2::date + 1`;
  const paramsFecha = [rango.inicio, rango.fin];
  const [narratives, mentions] = await Promise.all([
    all(`SELECT n.* FROM narratives n JOIN projects p ON p.id=n.project_id ${f.join} WHERE ${f.where}`),
    all(
      `SELECT m.sentiment, m.raw_json FROM mentions m JOIN projects p ON p.id=m.project_id ${f.join} WHERE ${f.where} AND m.raw_json IS NOT NULL ${condFecha}`,
      paramsFecha,
    ),
  ]);
  return calcularNssPorNarrativa(narratives, mentions);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function saveAlertsFromAnalysis(projectId, analysisId, alerts, riskLevel) {
  if (!Array.isArray(alerts)) return;
  for (const a of alerts) {
    const title = typeof a === "string" ? a.slice(0,120) : (a.title ?? "Alerta detectada");
    const desc  = typeof a === "string" ? a : (a.description ?? null);
    await q(`INSERT INTO alerts (project_id,analysis_id,title,description,alert_type,risk_level,status) VALUES ($1,$2,$3,$4,'ai',$5,'open')`,
      [projectId, analysisId, title, desc, riskLevel ?? null]);
  }
}

// Una alerta de narrativa ("Nuevas narrativas de riesgo...") solo es
// accionable si existe evidencia real citada por la IA para ESA narrativa
// (mismo criterio exacto que /api/narratives/:id/mentions: detected_narrative
// en raw_json == nombre de la narrativa). Antes se mostraban TODAS las
// alertas de narrativa aunque la mayoría (50-77%, medido en vivo 2026-10-02)
// no tuvieran ninguna publicación citada — el clic llevaba a un modal vacío,
// "sin evidencia", confuso. Pedido explícito del cliente: "si no existe no
// las coloques" — se filtran aquí, antes de llegar al frontend, en vez de
// mostrarlas y fallar silenciosamente al hacer clic.
// Mismo tope de 30 días que /api/narratives/:id/mentions (2026-10-02) — tiene
// que coincidir EXACTO con el filtro que usa esa ruta: si este gate deja
// pasar una alerta por evidencia vieja que el modal real ya no cuenta
// (porque el modal sí está acotado a 30 días), el usuario le da clic y le
// sale "sin evidencia" — el mismo dead-end que ya se revirtió una vez hoy
// por esta exacta inconsistencia.
const DÍAS_MÁXIMOS_EVIDENCIA_NARRATIVA_GATE = 30;
async function filtrarAlertasConEvidenciaReal(alertas) {
  const proyectosConNarrativa = new Set(
    alertas.filter((a) => a.narrative_id).map((a) => a.project_id),
  );
  const corteFecha = new Date(Date.now() - DÍAS_MÁXIMOS_EVIDENCIA_NARRATIVA_GATE * 24 * 60 * 60 * 1000);
  const evidenciaPorProyecto = new Map();
  for (const projectId of proyectosConNarrativa) {
    const menciones = await getMentionsWithRawJsonByProject(projectId);
    const evidencia = new Set();
    for (const m of menciones) {
      if (!m.published_at || new Date(m.published_at) < corteFecha) continue;
      try {
        const pub = JSON.parse(m.raw_json);
        const detectada = String(pub.detected_narrative || "").trim().toLowerCase();
        if (detectada) evidencia.add(detectada);
      } catch {}
    }
    evidenciaPorProyecto.set(projectId, evidencia);
  }
  return alertas.filter((a) => {
    if (!a.narrative_id) return true;
    const nombre = String(a.narrative_name || "").trim().toLowerCase();
    return !!nombre && !!evidenciaPorProyecto.get(a.project_id)?.has(nombre);
  });
}

export async function getAlertsByProject(projectId) {
  // Mismo JOIN que getAllAlertsForUser — sin él, project_name llega null y el
  // frontend cae al fallback "Proyecto {id}" cuando hay un solo proyecto
  // seleccionado (el camino de "todos" sí traía el nombre bien). narrative_name
  // real (no solo el id) para filtrar por evidencia sin otro viaje a la BD.
  const alertas = await all(
    `SELECT a.*, p.name AS project_name, n.name AS narrative_name
     FROM alerts a JOIN projects p ON p.id=a.project_id
     LEFT JOIN narratives n ON n.id=a.narrative_id
     WHERE a.project_id=$1 ORDER BY a.id DESC LIMIT 50`,
    [projectId],
  );
  return filtrarAlertasConEvidenciaReal(alertas);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MONITORING SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

export async function saveMonitoringSettings(projectId, settings) {
  await q(`INSERT INTO monitoring_settings (project_id) VALUES ($1) ON CONFLICT (project_id) DO NOTHING`, [projectId]);
  await q(`
    UPDATE monitoring_settings SET
      main_keywords=$1, risk_keywords=$2, excluded_keywords=$3, active_sources=$4,
      risk_sensitivity=$5, region=$6, daily_query_limit=$7, user_query_limit=$8,
      daily_cost_limit=$9, language=$10, estados_mx=$11, updated_at=NOW()
    WHERE project_id=$12
  `, [
    settings.main_keywords     ? JSON.stringify(settings.main_keywords)     : null,
    settings.risk_keywords     ? JSON.stringify(settings.risk_keywords)     : null,
    settings.excluded_keywords ? JSON.stringify(settings.excluded_keywords) : null,
    settings.active_sources    ? JSON.stringify(settings.active_sources)    : null,
    settings.risk_sensitivity  ?? "Media",
    settings.region            ?? "México",
    settings.daily_query_limit ?? 20,
    settings.user_query_limit  ?? 10,
    settings.daily_cost_limit  ?? 5,
    settings.language          ?? "es",
    settings.estados_mx        ? JSON.stringify(settings.estados_mx)        : null,
    projectId,
  ]);
  return getMonitoringSettings(projectId);
}

export async function getMonitoringSettings(projectId) {
  const row = await one(`SELECT * FROM monitoring_settings WHERE project_id=$1`, [projectId]);
  if (!row) return null;
  return {
    ...row,
    main_keywords:     row.main_keywords     ? JSON.parse(row.main_keywords)     : [],
    risk_keywords:     row.risk_keywords     ? JSON.parse(row.risk_keywords)     : [],
    excluded_keywords: row.excluded_keywords ? JSON.parse(row.excluded_keywords) : [],
    active_sources:    row.active_sources    ? JSON.parse(row.active_sources)    : [],
    estados_mx:        row.estados_mx        ? JSON.parse(row.estados_mx)        : [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AMPLIFIERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function saveAmplifiers(projectId, analysisId, amplifiers, narrativeTags = []) {
  if (!Array.isArray(amplifiers) || !amplifiers.length) return 0;
  const { canonicalize, computeScores, categorize, mergeNarratives } = await import("./amplifier-engine.js");
  const seen = new Set();
  let count = 0;

  for (const amp of amplifiers) {
    const rawName = String(amp.name || "").trim();
    if (!rawName || rawName.length < 2) continue;
    const canonical = canonicalize(rawName);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);

    const scores   = computeScores(amp);
    const category = categorize(amp.role, amp.dominant_sentiment, amp.risk_level);
    const narTags  = mergeNarratives("[]", narrativeTags);

    // Try upsert by canonical_name + project_id
    const existing = await one(
      `SELECT id, mentions_count, appearances, narrative_tags, risk_level, influence_score, risk_score FROM amplifiers WHERE project_id=$1 AND canonical_name=$2`,
      [projectId, canonical]
    );

    if (existing) {
      const newMentions   = (Number(existing.mentions_count) || 0) + (Number(amp.mentions_count) || 1);
      const newAppearances = (Number(existing.appearances) || 1) + 1;
      const mergedNarr    = mergeNarratives(existing.narrative_tags, narrativeTags);
      // Keep highest risk
      const riskOrder = { "Crítico":1,"Alto":2,"Medio":3,"Bajo":4 };
      const bestRisk  = (riskOrder[amp.risk_level]||3) <= (riskOrder[existing.risk_level]||3)
        ? amp.risk_level : existing.risk_level;
      const updatedAmp  = { ...amp, mentions_count: newMentions, risk_level: bestRisk };
      const newScores   = computeScores(updatedAmp);
      await q(`
        UPDATE amplifiers SET
          mentions_count=$1, appearances=$2, last_seen_at=NOW(),
          risk_level=$3, influence_score=$4, risk_score=$5,
          narrative_tags=$6, analysis_id=$7, category=$8
        WHERE id=$9
      `, [newMentions, newAppearances, bestRisk, newScores.influence_score,
          newScores.risk_score, mergedNarr, analysisId ?? null, category, existing.id]);
    } else {
      await q(`
        INSERT INTO amplifiers
          (project_id,analysis_id,name,canonical_name,source_type,role,reach,mentions_count,
           dominant_sentiment,risk_level,narrative,url,platform,author,handle,published_at,
           post_url,raw_json,influence_score,risk_score,appearances,category,
           first_seen_at,last_seen_at,narrative_tags)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW(),NOW(),$23)
      `, [
        projectId, analysisId ?? null, rawName, canonical,
        amp.source_type ?? "Fuente",
        amp.role ?? "Amplificador informativo",
        amp.reach ?? "No estimado",
        amp.mentions_count ?? 1,
        amp.dominant_sentiment ?? "Neutral",
        amp.risk_level ?? "Medio",
        amp.narrative ?? null,
        amp.url ?? null,
        amp.platform ?? null,
        amp.author ?? null,
        amp.handle ?? null,
        safeDate(amp.published_at),
        amp.post_url ?? null,
        typeof amp.raw_json === "string" ? amp.raw_json : JSON.stringify(amp),
        scores.influence_score, scores.risk_score, 1, category, narTags,
      ]);
      count++;
    }
  }
  return count;
}

export async function getAmplifiersByProject(projectId) {
  return all(`
    SELECT * FROM amplifiers WHERE project_id=$1
    ORDER BY
      CASE category WHEN 'crítico' THEN 1 WHEN 'neutral' THEN 2 WHEN 'aliado' THEN 3 ELSE 4 END,
      influence_score DESC, risk_score DESC, mentions_count DESC
    LIMIT 200
  `, [projectId]);
}

export async function getAmplifiersStats(projectId) {
  const [counts, topInfluence, topRisk, timeline] = await Promise.all([
    all(`SELECT category, COUNT(*) AS total FROM amplifiers WHERE project_id=$1 GROUP BY category`, [projectId]),
    all(`SELECT id,name,canonical_name,platform,source_type,mentions_count,appearances,influence_score,risk_score,category,dominant_sentiment,risk_level,narrative_tags FROM amplifiers WHERE project_id=$1 ORDER BY influence_score DESC LIMIT 5`, [projectId]),
    all(`SELECT id,name,canonical_name,platform,source_type,mentions_count,appearances,influence_score,risk_score,category,dominant_sentiment,risk_level,narrative_tags FROM amplifiers WHERE project_id=$1 ORDER BY risk_score DESC LIMIT 5`, [projectId]),
    all(`
      SELECT a.id AS analysis_id, a.created_at, COUNT(amp.id) AS amp_count,
             SUM(amp.mentions_count) AS total_mentions
      FROM analyses a
      LEFT JOIN amplifiers amp ON amp.analysis_id=a.id AND amp.project_id=$1
      WHERE a.project_id=$1
      GROUP BY a.id, a.created_at ORDER BY a.created_at ASC
    `, [projectId]),
  ]);

  const byCategory = { aliado: 0, crítico: 0, neutral: 0 };
  for (const row of counts) byCategory[row.category] = parseInt(row.total);

  return { by_category: byCategory, top_influence: topInfluence, top_risk: topRisk, timeline };
}

export async function clearAmplifiersByProject(projectId) {
  await q(`DELETE FROM amplifiers WHERE project_id=$1`, [projectId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT MEMBERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getProjectMembers(projectId) {
  return all(`
    SELECT pm.id,pm.project_id,pm.user_id,pm.permission,pm.created_at,
           u.name AS user_name,u.email AS user_email,u.role AS user_role
    FROM project_members pm JOIN users u ON u.id=pm.user_id
    WHERE pm.project_id=$1 ORDER BY pm.created_at ASC
  `, [projectId]);
}

export async function upsertProjectMember(projectId, userId, permission) {
  const allowed = ["viewer","editor"];
  const perm = allowed.includes(permission) ? permission : "viewer";
  await q(`
    INSERT INTO project_members (project_id,user_id,permission) VALUES ($1,$2,$3)
    ON CONFLICT (project_id,user_id) DO UPDATE SET permission=EXCLUDED.permission
  `, [projectId, userId, perm]);
  return one(`SELECT * FROM project_members WHERE project_id=$1 AND user_id=$2`, [projectId, userId]);
}

export async function removeProjectMember(projectId, userId) {
  await q(`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, [projectId, userId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGGREGATE CROSS-PROJECT
// ═══════════════════════════════════════════════════════════════════════════════

async function _projectFilter(userId, role) {
  if (role === "superadmin") return { join: "", where: "p.status IN ('active','inactive')" };
  if (role === "admin") {
    const orgId = await getOrgIdForUser(userId);
    return { join: "", where: `p.status IN ('active','inactive') AND p.organization_id=${parseInt(orgId)}` };
  }
  return {
    join:  `JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=${parseInt(userId)}`,
    where: "p.status IN ('active','inactive')",
  };
}

export async function searchMentions(q, limit = 5) {
  const r = await pool.query(
    `SELECT m.id, m.title, m.content, m.source_name, p.name AS project_name
     FROM mentions m
     LEFT JOIN projects p ON p.id = m.project_id
     WHERE (m.title ILIKE $1 OR m.content ILIKE $1 OR m.source_name ILIKE $1)
     ORDER BY m.created_at DESC LIMIT $2`,
    [`%${q}%`, limit]
  );
  return r.rows;
}

// LIMIT alto en las 6 funciones de abajo, no "sin límite" — mismo criterio
// que getMentionsByProject (arreglado antes hoy). El bug real que esto
// arregla: el LIMIT es GLOBAL entre TODOS los proyectos del usuario/org
// combinados, no por proyecto — con un proyecto muy cubierto (900+ menciones
// reales) más otros que también recibieron una ráfaga de menciones nuevas el
// mismo día, el LIMIT viejo (500) se llenaba solo con los proyectos
// ingeridos más recientemente y el resto desaparecía por completo de "todos
// los proyectos" (mostrando "Sin datos" pese a tener datos reales) — nunca
// fue que faltaran menciones, era que no cabían en la ventana.
// Misma vista que getMentionsByProject — se mantiene el JOIN projects p
// separado (redundante con lo que ya trae la vista) porque _projectFilter
// espera ese alias exacto (p.status/p.organization_id) y es un helper
// compartido con otras funciones getAll*ForUser; no vale la pena tocarlo
// solo por esto.
export async function getAllMentionsForUser(userId, role) {
  const f = await _projectFilter(userId, role);
  return all(
    `SELECT v.* FROM v_menciones_enriquecidas v
     JOIN projects p ON p.id=v.project_id
     ${f.join} WHERE ${f.where} ORDER BY v.id DESC LIMIT 5000`,
  );
}

export async function getAllNarrativesForUser(userId, role) {
  const f = await _projectFilter(userId, role);
  return all(`SELECT n.*,p.name AS project_name FROM narratives n JOIN projects p ON p.id=n.project_id ${f.join} WHERE ${f.where} ORDER BY n.id DESC LIMIT 2000`);
}

export async function getAllAlertsForUser(userId, role) {
  const f = await _projectFilter(userId, role);
  const alertas = await all(
    `SELECT a.*, p.name AS project_name, n.name AS narrative_name
     FROM alerts a JOIN projects p ON p.id=a.project_id
     LEFT JOIN narratives n ON n.id=a.narrative_id
     ${f.join} WHERE ${f.where} ORDER BY a.id DESC LIMIT 2000`,
  );
  return filtrarAlertasConEvidenciaReal(alertas);
}

export async function getAllAmplifiersForUser(userId, role) {
  const f = await _projectFilter(userId, role);
  return all(`
    SELECT am.*,p.name AS project_name FROM amplifiers am JOIN projects p ON p.id=am.project_id ${f.join}
    WHERE ${f.where}
    ORDER BY CASE am.risk_level WHEN 'Crítico' THEN 1 WHEN 'Alto' THEN 2 WHEN 'Medio' THEN 3 WHEN 'Bajo' THEN 4 ELSE 5 END,
             am.mentions_count DESC LIMIT 3000
  `);
}

export async function getAllAnalysesForUser(userId, role) {
  const f = await _projectFilter(userId, role);
  return all(`
    SELECT a.id,a.topic,a.created_at,a.risk_level,a.total_mentions,a.estimated_reach,
           a.sentiment_pos,a.sentiment_neg,a.sentiment_neu,a.project_id,p.name AS project_name
    FROM analyses a JOIN projects p ON p.id=a.project_id ${f.join}
    WHERE ${f.where} AND a.project_id IS NOT NULL ORDER BY a.id DESC LIMIT 1000
  `);
}

// response_json trae los hashtags reales que gpt-4o generó en cada análisis
// (ver prompt: "hashtags REALES y específicos de este tema"). No hay tabla
// dedicada — se agregan aquí por frecuencia real entre análisis reales.
export async function getAnalysesJsonForUser(userId, role) {
  const f = await _projectFilter(userId, role);
  return all(`
    SELECT a.response_json, a.total_mentions FROM analyses a JOIN projects p ON p.id=a.project_id ${f.join}
    WHERE ${f.where} AND a.project_id IS NOT NULL AND a.response_json IS NOT NULL
    ORDER BY a.id DESC LIMIT 1000
  `);
}

export async function getUserProjectIds(userId, role) {
  if (role === "superadmin") {
    const rows = await all(`SELECT id FROM projects WHERE status='active'`);
    return rows.map(r => r.id);
  }
  if (role === "admin") {
    const orgId = await getOrgIdForUser(userId);
    const rows = await all(`SELECT id FROM projects WHERE status='active' AND organization_id=$1`, [orgId]);
    return rows.map(r => r.id);
  }
  const rows = await all(`SELECT project_id AS id FROM project_members WHERE user_id=$1`, [userId]);
  return rows.map(r => r.id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERT RULES
// ═══════════════════════════════════════════════════════════════════════════════

function parseRules(rows) {
  return rows.map(r => ({
    ...r,
    condition_json: typeof r.condition_json === "string"
      ? JSON.parse(r.condition_json)
      : (r.condition_json || {}),
  }));
}

export async function getAlertRulesByProject(projectId) {
  const rows = await all(`SELECT * FROM alert_rules WHERE project_id=$1 AND is_active=TRUE ORDER BY id ASC`, [projectId]);
  return parseRules(rows);
}

export async function getAllAlertRulesForProject(projectId) {
  const rows = await all(`SELECT * FROM alert_rules WHERE project_id=$1 ORDER BY id ASC`, [projectId]);
  return parseRules(rows);
}

export async function seedDefaultRules(projectId, rules) {
  const existing = await all(`SELECT rule_type FROM alert_rules WHERE project_id=$1`, [projectId]);
  const existingTypes = new Set(existing.map(r => r.rule_type));
  for (const rule of rules) {
    if (existingTypes.has(rule.rule_type)) continue;
    await q(`INSERT INTO alert_rules (project_id,name,rule_type,condition_json,is_active) VALUES ($1,$2,$3,$4,TRUE)`,
      [projectId, rule.name, rule.rule_type, JSON.stringify(rule.condition_json)]);
  }
}

export async function upsertAlertRule(projectId, ruleType, name, conditionJson, isActive = true) {
  const existing = await one(`SELECT id FROM alert_rules WHERE project_id=$1 AND rule_type=$2`, [projectId, ruleType]);
  if (existing) {
    await q(`UPDATE alert_rules SET name=$1,condition_json=$2,is_active=$3 WHERE id=$4`,
      [name, JSON.stringify(conditionJson), isActive, existing.id]);
    return one(`SELECT * FROM alert_rules WHERE id=$1`, [existing.id]);
  }
  const r = await q(`INSERT INTO alert_rules (project_id,name,rule_type,condition_json,is_active) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [projectId, name, ruleType, JSON.stringify(conditionJson), isActive]);
  return r.rows[0];
}

// ─── Reglas de alerta configuradas por el usuario (palabra/narrativa a vigilar) ─
// Misma tabla `alert_rules` que las 6 reglas automáticas del sistema — se
// distinguen por rule_type ('user_keyword'/'user_narrative' vs las fijas) y
// nunca se tocan entre sí. A diferencia de upsertAlertRule (una fila por
// project_id+rule_type), aquí SIEMPRE se inserta una fila nueva: un usuario
// puede vigilar varias palabras distintas al mismo tiempo.
const TIPOS_REGLA_USUARIO = ["user_keyword", "user_narrative"];

export async function createCustomAlertRule(projectId, ruleType, name, conditionJson) {
  const r = await q(
    `INSERT INTO alert_rules (project_id,name,rule_type,condition_json,is_active) VALUES ($1,$2,$3,$4,TRUE) RETURNING *`,
    [projectId, name, ruleType, JSON.stringify(conditionJson)],
  );
  return parseRules(r.rows)[0];
}

export async function getCustomAlertRules(projectId) {
  const rows = await all(
    `SELECT * FROM alert_rules WHERE project_id=$1 AND rule_type = ANY($2) ORDER BY id DESC`,
    [projectId, TIPOS_REGLA_USUARIO],
  );
  return parseRules(rows);
}

export async function getCustomAlertRuleById(id) {
  const rows = await all(`SELECT * FROM alert_rules WHERE id=$1 AND rule_type = ANY($2)`, [id, TIPOS_REGLA_USUARIO]);
  return parseRules(rows)[0] ?? null;
}

export async function updateCustomAlertRule(id, { name, conditionJson, isActive }) {
  await q(
    `UPDATE alert_rules SET name=$1, condition_json=$2, is_active=$3 WHERE id=$4 AND rule_type = ANY($5)`,
    [name, JSON.stringify(conditionJson), isActive, id, TIPOS_REGLA_USUARIO],
  );
  return getCustomAlertRuleById(id);
}

export async function deleteCustomAlertRule(id) {
  await q(`DELETE FROM alert_rules WHERE id=$1 AND rule_type = ANY($2)`, [id, TIPOS_REGLA_USUARIO]);
}

export async function saveAutoAlert(projectId, analysisId, ruleType, title, description, riskLevel, narrativeId = null, amplifierId = null) {
  // Evita re-crear la misma alerta en cada análisis mientras siga sin resolver:
  // antes el dedup comparaba analysis_id, que cambia en cada corrida, así que una
  // regla que sigue disparando (p. ej. el mismo amplificador top) generaba una
  // fila nueva idéntica cada vez. Ahora se deduplica por título mientras la
  // alerta previa siga abierta; al cerrarla, la regla puede volver a disparar.
  const existing = await one(
    `SELECT id FROM alerts WHERE project_id=$1 AND title=$2 AND status='open'`,
    [projectId, title]
  );
  if (existing) return { ...existing, isNew: false };
  // narrative_id/amplifier_id solo llegan con dato real cuando la regla que
  // disparó (narrative_growth, high_risk_amplifier, sensitive_source,
  // user_narrative) de verdad señala una fila concreta — el resto de reglas
  // los deja en null a propósito, no hay una fila única a la que apunten.
  // alert_type ahora guarda el rule_type real (2026-10-02) — antes quedaba
  // fijo en 'auto' para las 6 reglas de sistema, sin distinguir una de otra,
  // lo que hacía imposible despachar la evidencia correcta por tipo.
  const r = await q(`
    INSERT INTO alerts (project_id,analysis_id,title,description,alert_type,risk_level,status,narrative_id,amplifier_id)
    VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8) RETURNING id
  `, [projectId, analysisId, title, description, ruleType, riskLevel, narrativeId, amplifierId]);
  return { ...r.rows[0], isNew: true };
}

// ─── Evidencia real detrás de una alerta (2026-10-02, pedido explícito de
// Darinka: que cada alerta abra un modal con las notas reales involucradas) ──
// Una sola ruta para las 6 reglas automáticas, cada una despachada por lo que
// la propia alerta ya guarda — nunca se inventa una relación:
//  - narrative_id / amplifier_id: mismo criterio ya verificado en producción
//    (detected_narrative exacto para narrativas; match de source_name para
//    amplificadores, confirmado 93% de acierto real contra datos de proy. 40/41).
//  - sentiment_drop / negative_spike: menciones negativas del MISMO análisis
//    que disparó la alerta (analysis_id es columna real y directa — sin match
//    difuso). No existe un subconjunto de "notas que causaron la caída": se
//    muestran las notas negativas de ese ciclo, que es la evidencia honesta
//    más cercana a lo que el porcentaje agregado está describiendo.
//  - critical_keywords / user_keyword: se re-extraen las palabras exactas que
//    la propia alerta citó entre comillas en su descripción y se vuelve a
//    buscar contra las notas reales del proyecto — la evidencia es
//    exactamente lo que el texto de la alerta afirma, nada más.
// Tope real de recencia para "evidencia" de alerta (2026-10-02, encontrado
// por el cliente: "me da miedo que le piquen a una mención y resulta que esa
// mención es de hace un año"). Confirmado en vivo antes de arreglar: sin
// esto, alertas reales mostraban evidencia de hasta 2,852 días atrás (7.8
// años) — un amplificador/palabra/narrativa puede repetirse literalmente
// durante años, pero una alerta que disparó HOY no debería "explicarse" con
// contenido de hace años. 30 días: suficiente margen para explicar por qué
// algo subió/bajó recientemente, sin arrastrar historial viejo. Se exige
// published_at real (no NULL) — sin fecha confiable no se puede afirmar que
// es reciente.
const DÍAS_MÁXIMOS_EVIDENCIA_ALERTA = 30;

export async function getAlertEvidence(alertId) {
  const alerta = await one(`SELECT * FROM alerts WHERE id=$1`, [alertId]);
  if (!alerta) return null;
  const projectId = alerta.project_id;
  const corteFecha = new Date(Date.now() - DÍAS_MÁXIMOS_EVIDENCIA_ALERTA * 24 * 60 * 60 * 1000);

  if (alerta.narrative_id) {
    const narrative = await getNarrativeById(alerta.narrative_id);
    const nombreObjetivo = String(narrative?.name || "").trim().toLowerCase();
    if (!nombreObjetivo) return [];
    const candidatas = await getMentionsWithRawJsonByProject(projectId);
    return candidatas.filter((m) => {
      if (!m.published_at || new Date(m.published_at) < corteFecha) return false;
      try {
        const pub = JSON.parse(m.raw_json);
        return String(pub.detected_narrative || "").trim().toLowerCase() === nombreObjetivo;
      } catch {
        return false;
      }
    });
  }

  if (alerta.amplifier_id) {
    const amp = await one(`SELECT name, canonical_name FROM amplifiers WHERE id=$1`, [alerta.amplifier_id]);
    if (!amp) return [];
    return all(
      `SELECT * FROM mentions WHERE project_id=$1 AND (source_name ILIKE '%'||$2||'%' OR source_name ILIKE '%'||$3||'%')
       AND published_at IS NOT NULL AND published_at >= NOW() - ($4 || ' days')::interval
       ORDER BY id DESC LIMIT 50`,
      [projectId, amp.canonical_name || "", amp.name || "", String(DÍAS_MÁXIMOS_EVIDENCIA_ALERTA)],
    );
  }

  if (alerta.alert_type === "sentiment_drop" || alerta.alert_type === "negative_spike") {
    // Probado en vivo contra un caso real antes de dejarlo así: filtrar por
    // analysis_id (el ciclo exacto que disparó la alerta) daba 0 resultados
    // casi siempre — la mayoría de las menciones "negativas" de ese momento ya
    // habían sido ingeridas en un ciclo anterior, no en ese analysis_id
    // puntual, así que el candado por ciclo era más angosto que la realidad
    // que el propio % agregado describe. Igual que critical_keywords/
    // sensitive_source/high_risk_amplifier, se busca en todo el proyecto
    // (acotado a los últimos DÍAS_MÁXIMOS_EVIDENCIA_ALERTA, no todo el historial).
    // 'negativo' real (es), no 'negative' — confirmado contra datos en vivo.
    return all(
      `SELECT * FROM mentions WHERE project_id=$1 AND sentiment='negativo'
       AND published_at IS NOT NULL AND published_at >= NOW() - ($2 || ' days')::interval
       ORDER BY id DESC LIMIT 50`,
      [projectId, String(DÍAS_MÁXIMOS_EVIDENCIA_ALERTA)],
    );
  }

  if (alerta.alert_type === "critical_keywords" || alerta.alert_type === "user_keyword") {
    const palabras = [...String(alerta.description || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (!palabras.length) return [];
    const condiciones = palabras.map((_, i) => `(title ILIKE '%'||$${i + 2}||'%' OR content ILIKE '%'||$${i + 2}||'%')`).join(" OR ");
    return all(
      `SELECT * FROM mentions WHERE project_id=$1 AND (${condiciones})
       AND published_at IS NOT NULL AND published_at >= NOW() - ($${palabras.length + 2} || ' days')::interval
       ORDER BY id DESC LIMIT 50`,
      [projectId, ...palabras, String(DÍAS_MÁXIMOS_EVIDENCIA_ALERTA)],
    );
  }

  return [];
}



// ═══════════════════════════════════════════════════════════════════════════════
// RSS FEEDS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getRssFeedsByProject(projectId) {
  return all(`SELECT * FROM rss_feeds WHERE project_id=$1 AND is_active=TRUE ORDER BY id ASC`, [projectId]);
}

export async function addRssFeed(projectId, url, name) {
  const r = await q(`INSERT INTO rss_feeds (project_id,url,name) VALUES ($1,$2,$3) RETURNING *`, [projectId, url, name || null]);
  return r.rows[0];
}

export async function removeRssFeed(feedId, projectId) {
  await q(`DELETE FROM rss_feeds WHERE id=$1 AND project_id=$2`, [feedId, projectId]);
}

export async function updateFeedLastFetched(feedId, itemCount) {
  await q(`UPDATE rss_feeds SET last_fetched_at=NOW(), item_count=$1 WHERE id=$2`, [itemCount, feedId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INGESTION LOG (dedup)
// ═══════════════════════════════════════════════════════════════════════════════

// La deduplicación es POR PROYECTO. Antes era global por hash de URL: si un
// proyecto ya había guardado un video o nota, otro proyecto con el mismo tema
// (ej. dos proyectos del mismo político) nunca podía guardarlo, y el segundo
// se quedaba casi vacío aunque la fuente sí lo trajera.
// Además de ingestion_log se revisa la propia tabla mentions por URL: mientras
// el índice único viejo (url_hash solo) siga en la base, logIngestion puede
// quedarse sin registrar la fila de otro proyecto, y sin esta segunda
// comprobación esa misma mención se volvería a insertar en cada corrida.
export async function isUrlIngested(urlHash, projectId, url = null) {
  const row = await one(`SELECT id FROM ingestion_log WHERE url_hash=$1 AND project_id=$2 LIMIT 1`, [urlHash, projectId]);
  if (row) return true;
  if (url) {
    const m = await one(`SELECT id FROM mentions WHERE project_id=$1 AND url=$2 LIMIT 1`, [projectId, url]);
    return !!m;
  }
  return false;
}

// Sin destino de conflicto a propósito: funciona igual con el índice único
// viejo (url_hash) y con el nuevo (url_hash, project_id).
export async function logIngestion(urlHash, projectId, mentionId) {
  await q(`INSERT INTO ingestion_log (url_hash,project_id,mention_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [urlHash, projectId, mentionId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASIFICACIÓN EN TIEMPO REAL (arquitectura Luis v2, Fase 3 "en vivo")
// El backfill de la Fase 3 limpió el histórico UNA vez; sin esto, cada
// mención nueva volvía a llegar con las columnas limpias en NULL — la
// plataforma se hubiera visto bien el día del backfill y cada vez peor
// después. Alcance deliberadamente limitado a los proyectos 40/41 (pedido
// explícito del dueño, 2026-09-30) — los otros 44 proyectos están
// archivados y no deberían generar escritura nueva de todos modos; si algún
// día se reactivan, esta misma función solo necesita que se amplíe el Set.
// ═══════════════════════════════════════════════════════════════════════════════

const PROYECTOS_CLASIFICACION_VIVA = new Set([40, 41]);
const CODIGOS_SOURCE_TYPE_DIRECTOS = new Set(["twitter", "tiktok", "instagram", "facebook", "youtube"]);
const _cacheSourceTypeIds = new Map(); // código -> id, se llena una vez por proceso

async function resolverSourceTypeId(url, sourceTypeCrudo) {
  const u = (url || "").toLowerCase();
  let codigo = "noticia_web";
  if (u.includes("youtube.com") || u.includes("youtu.be")) codigo = "youtube";
  else if (u.includes("facebook.com")) codigo = "facebook";
  else if (u.includes("instagram.com")) codigo = "instagram";
  else if (u.includes("tiktok.com")) codigo = "tiktok";
  else if (u.includes("twitter.com") || u.includes("x.com")) codigo = "twitter";
  else {
    const st = (sourceTypeCrudo || "").trim().toLowerCase();
    if (CODIGOS_SOURCE_TYPE_DIRECTOS.has(st)) codigo = st;
  }
  if (_cacheSourceTypeIds.has(codigo)) return _cacheSourceTypeIds.get(codigo);
  const fila = await one(`SELECT id FROM source_types WHERE codigo=$1`, [codigo]);
  const id = fila?.id ?? null;
  _cacheSourceTypeIds.set(codigo, id);
  return id;
}

async function resolverAuthorId(authorName, sourceTypeId) {
  const nombre = (authorName || "").trim();
  if (!nombre || !sourceTypeId) return null;
  await q(
    `INSERT INTO authors (nombre_canonico, source_type_id, primera_vez, ultima_vez)
     VALUES ($1,$2,NOW(),NOW())
     ON CONFLICT (nombre_canonico, source_type_id) DO UPDATE SET ultima_vez = NOW()`,
    [nombre, sourceTypeId],
  );
  const fila = await one(`SELECT id FROM authors WHERE nombre_canonico=$1 AND source_type_id=$2`, [nombre, sourceTypeId]);
  return fila?.id ?? null;
}

// Caché por proceso, mismo patrón que _cacheSourceTypeIds — las keywords de
// un proyecto activo rara vez cambian a mitad de la vida del proceso PM2.
const _cacheKeywordsPorProyecto = new Map(); // projectId -> [{id, keyword}]

// Nota operativa pedida por Luis (KEYWORD_PROYECTO): guardar cuál keyword
// disparó cada mención, para poder auditar después qué keywords traen mejor
// calidad de contenido. No hay un "keyword que disparó la búsqueda" limpio
// en el pipeline actual (los fetchers buscan por topic amplio, no por
// keyword individual) — se aproxima con match de texto contra título/
// contenido, prefiriendo la keyword más larga/específica cuando varias
// coinciden. Es una aproximación razonable hacia adelante, no una garantía.
function escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Caso real (2026-10-01): keywords con "#"/"@" al inicio ("#SalomónJara",
// "#Semarnat", "@salomonj" — muy comunes, son justo las de tipo red_social/
// hashtag) NUNCA hacían match de verdad. \b exige una transición entre
// carácter de palabra y no-palabra — pero "#"/"@" son no-palabra, y lo que
// los precede en texto real (un espacio, u otro "#") TAMBIÉN es no-palabra,
// así que \b al inicio del patrón nunca se cumplía (no-palabra → no-palabra
// no es una transición). Confirmado en vivo: un post con el hashtag real
// "#salomonjara" literal en el texto no matcheaba contra la keyword
// "#SalomónJara". El límite de palabra solo tiene sentido en el lado donde
// el término SÍ termina en un carácter de palabra — se omite \b en el lado
// que empieza/termina con un símbolo, ya que ese símbolo ya actúa como
// separador natural.
function patrónPalabraCompleta(términoEscapado, términoOriginal) {
  const bordeIzq = /^\w/.test(términoOriginal) ? "\\b" : "";
  const bordeDer = /\w$/.test(términoOriginal) ? "\\b" : "";
  return new RegExp(`${bordeIzq}${términoEscapado}${bordeDer}`, "i");
}

// Caso real (2026-10-01): un mención real sobre "la Secretaría de Medio
// Ambiente anunció..." nunca se le asignó keyword_matched_id porque la
// keyword configurada se guardó sin acento ("Secretaria de Medio Ambiente")
// — texto.toLowerCase() normaliza mayúsculas pero NO acentos, así que
// "secretaria" (sin tilde) y "secretaría" (con tilde) nunca hacían match
// aunque sean la misma palabra. Quitar diacríticos de ambos lados antes de
// comparar corrige esto sin perder la whole-word boundary.
function normalizarAcentos(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

async function resolverKeywordMatchId(projectId, titulo, contenido) {
  const texto = normalizarAcentos(`${titulo || ""} ${contenido || ""}`.toLowerCase());
  if (!texto.trim()) return null;
  let keywords = _cacheKeywordsPorProyecto.get(projectId);
  if (!keywords) {
    keywords = await all(`SELECT id, keyword FROM project_keywords WHERE project_id=$1`, [projectId]);
    _cacheKeywordsPorProyecto.set(projectId, keywords);
  }
  let mejor = null;
  for (const k of keywords) {
    const kw = normalizarAcentos((k.keyword || "").trim().toLowerCase());
    if (!kw) continue;
    // Antes era texto.includes(kw) — "SEMAR" (otra dependencia real, la
    // Marina) coincidía como substring de cualquier texto que mencionara
    // "SEMARNAT" al revés, y palabras cortas como "Jara" contaban como match
    // dentro de "Victor Jara" (cantante chileno, sin relación). Con \b
    // (límite de palabra) ya no cuenta una coincidencia parcial dentro de
    // otra palabra — "semar" ya no matchea dentro de "semarnat" ni viceversa.
    const patrón = patrónPalabraCompleta(escaparRegex(kw), kw);
    if (patrón.test(texto) && (!mejor || kw.length > mejor.kw.length)) {
      mejor = { id: k.id, kw };
    }
  }
  return mejor?.id ?? null;
}

function reachNumerico(reach) {
  const limpio = (reach ?? "").toString().trim();
  return /^\d+$/.test(limpio) ? parseInt(limpio, 10) : null;
}

// "138 likes, 6 comments - semarnat_mexico on..." / "35 me gusta,105
// comentarios.Video de TikTok de..." — el scraper genérico de RSS guarda
// este texto crudo sin extraerlo. El número real ya está ahí, solo se lee.
function parseNúmeroConSufijo(texto) {
  if (!texto) return null;
  const limpio = texto.trim();
  if (limpio === "..." || limpio === "…") return null;
  const m = limpio.match(/^([\d,.]+)\s*([kKmM])?$/);
  if (!m) return null;
  let num = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  if (m[2]) num *= /m/i.test(m[2]) ? 1_000_000 : 1_000;
  return Math.round(num);
}

// Solo Instagram y TikTok: el texto de Facebook con este mismo formato
// ("SEMARNAT, Mexico City. 1,076,983 likes · 2,946 talking about this") es
// el conteo de SEGUIDORES DE LA PÁGINA, no del post — tratarlo como
// engagement real sería inventar un dato (un post no tiene "1 millón de
// interacciones" solo porque la página que lo publicó tiene esa audiencia).
// Instagram/TikTok sí usan esta forma para el post específico, verificado
// contra ejemplos reales de la base de datos.
function extraerEngagementDeTexto(url, contenido) {
  if (!contenido) return null;
  const u = (url || "").toLowerCase();
  if (u.includes("instagram.com")) {
    const m = contenido.match(/^(\.\.\.|…|[\d][\d,.]*\s*[kKmM]?)\s*likes?,\s*([\d][\d,.]*\s*[kKmM]?)\s*comments?\b/i);
    if (!m) return null;
    const likes = parseNúmeroConSufijo(m[1]) ?? 0;
    const comments = parseNúmeroConSufijo(m[2]) ?? 0;
    const total = likes + comments;
    return total > 0 ? total : null;
  }
  if (u.includes("tiktok.com")) {
    const m = contenido.match(/^([\d][\d,.]*\s*[kKmM]?)\s*(?:me gusta|likes?)\s*,\s*([\d][\d,.]*\s*[kKmM]?)?\s*(?:comentarios|comments?)?/i);
    if (!m) return null;
    const likes = parseNúmeroConSufijo(m[1]) ?? 0;
    const comments = m[2] ? (parseNúmeroConSufijo(m[2]) ?? 0) : 0;
    const total = likes + comments;
    return total > 0 ? total : null;
  }
  return null;
}

// Misma huella real que detectó el backfill: hora exacta 00:00:00/07:00:00
// es fecha de detección disfrazada de fecha de publicación (B7).
function fechaEsSospechosa(publishedAt) {
  if (!publishedAt) return null;
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return null;
  const h = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
  const esPlaceholder = (h === 0 || h === 7) && m === 0 && s === 0;
  return !esPlaceholder;
}

/** Calcula las columnas limpias para una mención nueva — null en todo si el
 * proyecto no está en el alcance de hoy (ver PROYECTOS_CLASIFICACION_VIVA). */
async function clasificarMencionNueva(projectId, { url, source_type, author_name, reach, published_at, title, content }) {
  if (!PROYECTOS_CLASIFICACION_VIVA.has(Number(projectId))) {
    return { source_type_id: null, author_id: null, reach_numeric: null, fecha_publicacion_confiable: null, keyword_matched_id: null, engagement_score_extraido: null };
  }
  const source_type_id = await resolverSourceTypeId(url, source_type);
  const author_id = await resolverAuthorId(author_name, source_type_id);
  const keyword_matched_id = await resolverKeywordMatchId(projectId, title, content);
  const engagement_score_extraido = extraerEngagementDeTexto(url, content);
  return {
    source_type_id,
    author_id,
    reach_numeric: reachNumerico(reach),
    fecha_publicacion_confiable: fechaEsSospechosa(published_at),
    engagement_score_extraido,
    keyword_matched_id,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAW MENTION SAVE (for RSS ingestion — no analysis_id yet)
// ═══════════════════════════════════════════════════════════════════════════════

export async function saveMentionRaw(projectId, analysisId, item) {
  const clasif = await clasificarMencionNueva(projectId, item);
  const r = await q(`
    INSERT INTO mentions (project_id,analysis_id,title,content,url,source_name,source_type,author_name,published_at,sentiment,risk_level,reach,raw_json,thumbnail_url,engagement_score,
                           source_type_id,author_id,reach_numeric,published_at_tz,fecha_publicacion_confiable,keyword_matched_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamp,$10,$11,$12,$13,$14,$15,$16,$17,$18,$9::timestamp AT TIME ZONE 'America/Mexico_City',$19,$20)
    RETURNING id
  `, [
    projectId, analysisId ?? null,
    sanitizarTexto(item.title ?? null), sanitizarTexto(item.content ?? null), item.url ?? null,
    sanitizarTexto(item.source_name ?? null), item.source_type ?? "rss",
    sanitizarTexto(item.author_name ?? null), item.published_at ?? null,
    item.sentiment ?? null, item.risk_level ?? null,
    item.reach ?? null, item.raw_json ?? null,
    item.thumbnail_url ?? null, item.engagement_score ?? clasif.engagement_score_extraido ?? null,
    clasif.source_type_id, clasif.author_id, clasif.reach_numeric, clasif.fecha_publicacion_confiable,
    clasif.keyword_matched_id,
  ]);
  return r.rows[0].id;
}

// ─── Get recent RSS mentions for AI context ───────────────────────────────────
export async function getRecentRssMentions(projectId, hours = 48) {
  return all(`
    SELECT title, content, source_name, published_at, url
    FROM mentions
    WHERE project_id=$1 AND source_type='rss'
      AND created_at >= NOW() - INTERVAL '${parseInt(hours)} hours'
    ORDER BY published_at DESC NULLS LAST
    LIMIT 50
  `, [projectId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPORT TICKETS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createSupportTicket({ organizationId, userId, subject, tipoError, seccion, prioridad, descripcion }) {
  const r = await q(`
    INSERT INTO support_tickets (organization_id, user_id, subject, tipo_error, seccion, prioridad, descripcion)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *
  `, [organizationId, userId, subject, tipoError ?? null, seccion ?? null, prioridad ?? "normal", descripcion]);
  return r.rows[0];
}

export async function getSupportTicketsByUser(userId) {
  return all(`SELECT * FROM support_tickets WHERE user_id=$1 ORDER BY id DESC`, [userId]);
}

export async function getSupportTicketsByOrg(organizationId) {
  return all(`SELECT * FROM support_tickets WHERE organization_id=$1 ORDER BY id DESC`, [organizationId]);
}

export async function getSupportTicketById(id) {
  return one(`SELECT * FROM support_tickets WHERE id=$1`, [id]);
}

export async function resolveSupportTicket(id, resolutionSummary) {
  const r = await q(`
    UPDATE support_tickets SET status='resuelto', resolution_summary=$1, resolved_at=NOW()
    WHERE id=$2 AND status='abierto'
    RETURNING *
  `, [resolutionSummary, id]);
  return r.rows[0] ?? null;
}
