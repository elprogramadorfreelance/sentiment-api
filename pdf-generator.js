import PDFDocument from "pdfkit";

// ─── Colors ───────────────────────────────────────────────────────────────────
const C = {
  primary:   "#4F46E5",
  danger:    "#EF4444",
  warning:   "#F59E0B",
  success:   "#10B981",
  info:      "#3B82F6",
  dark:      "#111827",
  gray:      "#6B7280",
  lightgray: "#F3F4F6",
  border:    "#E5E7EB",
  white:     "#FFFFFF",
};

function rColor(r) {
  if (r === "Crítico" || r === "Alto") return C.danger;
  if (r === "Medio") return C.warning;
  if (r === "Bajo") return C.success;
  return C.info;
}
function sColor(s) {
  if (s === "Positivo") return C.success;
  if (s === "Negativo") return C.danger;
  if (s === "Mixto")    return C.warning;
  return C.info;
}

// ─── Layout helpers ───────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return [r,g,b];
}

function fillColor(doc, hex) { doc.fillColor(hexToRgb(hex)); }
function strokeColor(doc, hex) { doc.strokeColor(hexToRgb(hex)); }

function sectionTitle(doc, text, y) {
  doc.y = y ?? doc.y;
  fillColor(doc, C.primary);
  doc.rect(doc.page.margins.left, doc.y, 3, 14).fill();
  fillColor(doc, C.dark);
  doc.font("Helvetica-Bold").fontSize(11)
     .text(text, doc.page.margins.left + 10, doc.y - 1, { lineBreak: false });
  doc.moveDown(0.8);
  strokeColor(doc, C.border);
  doc.moveTo(doc.page.margins.left, doc.y)
     .lineTo(doc.page.width - doc.page.margins.right, doc.y)
     .lineWidth(0.5).stroke();
  doc.moveDown(0.5);
}

function badge(doc, text, color, x, y) {
  const w = doc.font("Helvetica-Bold").fontSize(8).widthOfString(text) + 12;
  const rgb = hexToRgb(color);
  doc.roundedRect(x, y - 1, w, 14, 3)
     .fillAndStroke([rgb[0],rgb[1],rgb[2],0.15], [rgb[0],rgb[1],rgb[2],0.4]);
  fillColor(doc, color);
  doc.font("Helvetica-Bold").fontSize(8).text(text, x + 6, y + 1, { lineBreak: false });
  return w;
}

function bar(doc, x, y, w, pct, color) {
  strokeColor(doc, C.border);
  doc.roundedRect(x, y, w, 8, 2).fillAndStroke(hexToRgb(C.lightgray), hexToRgb(C.border));
  if (pct > 0) {
    fillColor(doc, color);
    doc.roundedRect(x, y, Math.max(4, w * pct / 100), 8, 2).fill();
  }
}

function checkNewPage(doc, needed = 60) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

// ─── Main generator ───────────────────────────────────────────────────────────
export function generateProjectPDF(project, analyses, narratives, alerts, mentions, amplifiers, stream) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title:   `Reporte — ${project.name}`,
      Author:  "Sentiment Unicornio",
      Subject: "Reporte ejecutivo de monitoreo reputacional",
    },
  });

  doc.pipe(stream);

  const W = doc.page.width - 100; // usable width
  const latest = analyses[0] || {};
  const avgPos = analyses.length ? Math.round(analyses.reduce((s,a)=>s+(Number(a.sentiment_pos)||0),0)/analyses.length) : 0;
  const avgNeg = analyses.length ? Math.round(analyses.reduce((s,a)=>s+(Number(a.sentiment_neg)||0),0)/analyses.length) : 0;
  const avgNeu = Math.max(0, 100 - avgPos - avgNeg);
  const critAlerts = alerts.filter(a => a.risk_level==="Crítico"||a.risk_level==="Alto");
  const period = analyses.length
    ? `${new Date(analyses[analyses.length-1].created_at).toLocaleDateString("es-MX")} — ${new Date(analyses[0].created_at).toLocaleDateString("es-MX")}`
    : new Date().toLocaleDateString("es-MX");

  // ══════════════════════════════════════════════════════════════════════
  // PORTADA
  // ══════════════════════════════════════════════════════════════════════
  fillColor(doc, C.primary);
  doc.rect(0, 0, doc.page.width, 180).fill();

  fillColor(doc, C.white);
  doc.font("Helvetica-Bold").fontSize(9).text("SENTIMENT UNICORNIO", 50, 40, { characterSpacing: 2 });

  fillColor(doc, C.white);
  doc.font("Helvetica-Bold").fontSize(28)
     .text(project.name, 50, 65, { width: W, lineBreak: true });

  fillColor(doc, "#C7D2FE");
  doc.font("Helvetica").fontSize(11)
     .text("Reporte ejecutivo de monitoreo reputacional", 50, doc.y + 4);

  fillColor(doc, C.white);
  doc.font("Helvetica").fontSize(9)
     .text(`Periodo: ${period}`, 50, doc.y + 6)
     .text(`Generado: ${new Date().toLocaleDateString("es-MX", { weekday:"long", year:"numeric", month:"long", day:"numeric" })}`, { continued: false });

  doc.y = 200;

  // KPI row
  const kpis = [
    { label: "Análisis", value: analyses.length, color: C.primary },
    { label: "Menciones", value: mentions.length, color: C.info },
    { label: "Alertas críticas", value: critAlerts.length, color: C.danger },
    { label: "Narrativas", value: narratives.length, color: C.warning },
  ];
  const kpiW = (W - 30) / 4;
  kpis.forEach((k, i) => {
    const x = 50 + i * (kpiW + 10);
    strokeColor(doc, C.border);
    fillColor(doc, C.white);
    doc.roundedRect(x, doc.y, kpiW, 56, 4).fillAndStroke();
    fillColor(doc, k.color);
    doc.font("Helvetica-Bold").fontSize(22).text(String(k.value), x + 10, doc.y + 8, { width: kpiW - 20, align: "center" });
    fillColor(doc, C.gray);
    doc.font("Helvetica").fontSize(8).text(k.label, x + 5, doc.y + 34, { width: kpiW - 10, align: "center" });
  });

  doc.y += 72;

  // Risk badge
  if (latest.risk_level) {
    fillColor(doc, C.dark);
    doc.font("Helvetica").fontSize(9).text("Nivel de riesgo actual: ", 50, doc.y, { continued: true });
    badge(doc, latest.risk_level, rColor(latest.risk_level), doc.x, doc.y - 1);
    doc.moveDown(1.5);
  }

  // ══════════════════════════════════════════════════════════════════════
  // SÍNTESIS EJECUTIVA
  // ══════════════════════════════════════════════════════════════════════
  checkNewPage(doc, 100);
  sectionTitle(doc, "Síntesis ejecutiva");

  if (project.description) {
    fillColor(doc, C.gray);
    doc.font("Helvetica-Oblique").fontSize(9)
       .text(project.description, { width: W, lineBreak: true });
    doc.moveDown(0.5);
  }

  // Try to get executive summary from latest analysis JSON
  let execSummary = null;
  try {
    const json = typeof latest.response_json === "string"
      ? JSON.parse(latest.response_json) : latest.response_json;
    execSummary = json?.executive_summary || json?.resumen_ejecutivo || null;
  } catch {}

  if (execSummary) {
    fillColor(doc, C.dark);
    doc.font("Helvetica").fontSize(9.5)
       .text(execSummary, { width: W, lineBreak: true, align: "justify" });
  } else {
    fillColor(doc, C.gray);
    doc.font("Helvetica").fontSize(9).text("Sin resumen ejecutivo disponible para el periodo seleccionado.");
  }
  doc.moveDown(1);

  // ══════════════════════════════════════════════════════════════════════
  // SENTIMIENTO GLOBAL
  // ══════════════════════════════════════════════════════════════════════
  checkNewPage(doc, 80);
  sectionTitle(doc, "Sentimiento global");

  const sentRows = [
    { label: "Positivo", pct: avgPos, color: C.success },
    { label: "Negativo", pct: avgNeg, color: C.danger },
    { label: "Neutral",  pct: avgNeu, color: C.info },
  ];
  sentRows.forEach(s => {
    fillColor(doc, C.dark);
    doc.font("Helvetica").fontSize(9).text(s.label, 50, doc.y, { width: 60, lineBreak: false });
    bar(doc, 120, doc.y + 1, W - 90, s.pct, s.color);
    fillColor(doc, s.color);
    doc.font("Helvetica-Bold").fontSize(9).text(`${s.pct}%`, 120 + W - 90 + 8, doc.y - 7, { lineBreak: false });
    doc.moveDown(0.9);
  });
  doc.moveDown(0.5);

  // ══════════════════════════════════════════════════════════════════════
  // NARRATIVAS DOMINANTES
  // ══════════════════════════════════════════════════════════════════════
  if (narratives.length) {
    checkNewPage(doc, 80);
    sectionTitle(doc, `Narrativas dominantes (${Math.min(narratives.length, 8)} de ${narratives.length})`);

    narratives.slice(0, 8).forEach((n, i) => {
      checkNewPage(doc, 40);
      const y0 = doc.y;
      fillColor(doc, C.lightgray);
      doc.roundedRect(50, y0, W, 34, 3).fill();

      fillColor(doc, C.dark);
      doc.font("Helvetica-Bold").fontSize(9)
         .text(`${i+1}. ${n.name || n.title || "—"}`, 60, y0 + 6, { width: W - 120, lineBreak: false });

      const sx = 50 + W - 110;
      badge(doc, n.sentiment || "Neutral", sColor(n.sentiment), sx, y0 + 5);
      badge(doc, n.risk_level || "—", rColor(n.risk_level), sx + 62, y0 + 5);

      if (n.description) {
        fillColor(doc, C.gray);
        doc.font("Helvetica").fontSize(8)
           .text(String(n.description).slice(0, 120), 60, y0 + 20, { width: W - 70, lineBreak: false });
      }
      doc.y = y0 + 38;
    });
    doc.moveDown(0.5);
  }

  // ══════════════════════════════════════════════════════════════════════
  // TOP AMPLIFICADORES
  // ══════════════════════════════════════════════════════════════════════
  if (amplifiers.length) {
    checkNewPage(doc, 80);
    const allies   = amplifiers.filter(a => a.role === "Amplificador favorable").slice(0, 4);
    const critics  = amplifiers.filter(a => a.role === "Amplificador crítico").slice(0, 4);
    const rest     = amplifiers.filter(a => a.role !== "Amplificador favorable" && a.role !== "Amplificador crítico").slice(0, 4);
    const topAmps  = [...critics, ...allies, ...rest].slice(0, 8);

    sectionTitle(doc, `Amplificadores clave (${Math.min(amplifiers.length, 8)} de ${amplifiers.length})`);

    // Header row
    const cols = [180, 80, 80, 80, W - 420];
    const headers = ["Fuente", "Plataforma", "Menciones", "Sentimiento", "Rol"];
    fillColor(doc, C.lightgray);
    doc.rect(50, doc.y, W, 16).fill();
    fillColor(doc, C.gray);
    doc.font("Helvetica-Bold").fontSize(7.5);
    let cx = 56;
    headers.forEach((h, i) => {
      doc.text(h, cx, doc.y + 3, { width: cols[i], lineBreak: false });
      cx += cols[i];
    });
    doc.y += 18;

    topAmps.forEach((a, i) => {
      checkNewPage(doc, 20);
      if (i % 2 === 0) {
        fillColor(doc, "#FAFAFA");
        doc.rect(50, doc.y, W, 16).fill();
      }
      fillColor(doc, C.dark);
      doc.font("Helvetica").fontSize(8);
      cx = 56;
      const cells = [
        String(a.name||"—").slice(0,28),
        String(a.platform||a.source_type||"—").slice(0,12),
        String(a.mentions_count||1),
        String(a.dominant_sentiment||a.sentiment||"—").slice(0,10),
        String(a.role||"—").slice(0,22),
      ];
      cells.forEach((cell, ci) => {
        if (ci === 3) fillColor(doc, sColor(cell));
        else if (ci === 4) fillColor(doc, rColor(a.risk_level));
        else fillColor(doc, C.dark);
        doc.text(cell, cx, doc.y + 4, { width: cols[ci], lineBreak: false });
        cx += cols[ci];
      });
      doc.y += 17;
    });
    doc.moveDown(0.5);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ALERTAS Y RIESGOS
  // ══════════════════════════════════════════════════════════════════════
  if (alerts.length) {
    checkNewPage(doc, 80);
    sectionTitle(doc, `Alertas y riesgos (${Math.min(alerts.length, 8)} de ${alerts.length})`);

    alerts.slice(0, 8).forEach(a => {
      checkNewPage(doc, 30);
      const y0 = doc.y;
      const rc = rColor(a.risk_level);
      fillColor(doc, rc);
      doc.rect(50, y0, 3, 24).fill();
      fillColor(doc, C.dark);
      doc.font("Helvetica-Bold").fontSize(8.5)
         .text(String(a.title||"Alerta").slice(0,80), 60, y0 + 3, { width: W - 80, lineBreak: false });
      badge(doc, a.risk_level||"—", rc, 50 + W - 60, y0 + 2);
      if (a.description) {
        fillColor(doc, C.gray);
        doc.font("Helvetica").fontSize(8)
           .text(String(a.description).slice(0,130), 60, y0 + 14, { width: W - 80, lineBreak: false });
      }
      doc.y = y0 + 28;
    });
    doc.moveDown(0.5);
  }

  // ══════════════════════════════════════════════════════════════════════
  // RECOMENDACIONES
  // ══════════════════════════════════════════════════════════════════════
  let recs = [];
  try {
    const json = typeof latest.response_json === "string"
      ? JSON.parse(latest.response_json) : latest.response_json;
    recs = json?.recommendations || json?.recomendaciones || json?.acciones || [];
  } catch {}

  if (recs.length) {
    checkNewPage(doc, 80);
    sectionTitle(doc, "Recomendaciones estratégicas");
    recs.slice(0, 6).forEach((r, i) => {
      checkNewPage(doc, 25);
      const text = typeof r === "string" ? r : (r.text || r.accion || r.recommendation || JSON.stringify(r));
      fillColor(doc, C.primary);
      doc.circle(57, doc.y + 4, 4).fill();
      fillColor(doc, C.white);
      doc.font("Helvetica-Bold").fontSize(7).text(String(i+1), 54.5, doc.y + 1, { lineBreak: false });
      fillColor(doc, C.dark);
      doc.font("Helvetica").fontSize(9)
         .text(String(text).slice(0, 200), 68, doc.y - 5, { width: W - 20, lineBreak: true });
      doc.moveDown(0.3);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // FOOTER on every page (bufferPages must be true)
  // ══════════════════════════════════════════════════════════════════════
  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(range.start + i);
    fillColor(doc, C.border);
    doc.rect(50, doc.page.height - 40, W, 0.5).fill();
    fillColor(doc, C.gray);
    doc.font("Helvetica").fontSize(7.5)
       .text("Sentiment Unicornio — Confidencial", 50, doc.page.height - 32, { width: W/2, lineBreak: false });
    doc.text(`Página ${i+1} de ${totalPages}`, 50, doc.page.height - 32, { width: W, align: "right", lineBreak: false });
  }

  doc.flushPages();
  doc.end();
}
