import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import type { Event, FusionRow, FusionTestMeta, ResultRow, Test } from "./types.js";
import type { LapByLapRow } from "./results.js";
import { HEADERS_DIR } from "./storage.js";
import { formatMs } from "./timeUtils.js";

interface PenaltyFlags {
  time: boolean;
  position: boolean;
  comment: boolean;
}

function penaltyFlags(rows: ResultRow[]): PenaltyFlags {
  return {
    time: rows.some((r) => (r.timePenaltyMs || 0) > 0),
    position: rows.some((r) => (r.positionPenalty || 0) > 0),
    comment: rows.some((r) => Boolean((r.comment || "").trim())),
  };
}

function esc(v: string): string {
  return `"${(v || "").replace(/"/g, '""')}"`;
}

function penaltyHeaders(flags: PenaltyFlags): string[] {
  const h: string[] = [];
  if (flags.time) h.push("Pen. tiempo");
  if (flags.position) h.push("Pen. pos");
  if (flags.comment) h.push("Comentario");
  return h;
}

function penaltyCells(r: ResultRow, flags: PenaltyFlags): (string | number)[] {
  const cells: (string | number)[] = [];
  if (flags.time) cells.push(r.timePenaltyMs ? formatMs(r.timePenaltyMs) : "");
  if (flags.position) cells.push(r.positionPenalty ? r.positionPenalty : "");
  if (flags.comment) cells.push(r.comment || "");
  return cells;
}

function hasLapResults(rows: ResultRow[]): boolean {
  return rows.some((r) => r.laps != null && r.laps > 0);
}

function lapsCell(r: ResultRow): string {
  if (r.laps == null) return "";
  return r.expectedLaps != null ? `${r.laps}/${r.expectedLaps}` : String(r.laps);
}

function timeHeaders(flags: PenaltyFlags): string[] {
  if (flags.time) return ["Tiempo sin pen.", "Tiempo con pen."];
  return ["Tiempo"];
}

function timeCells(r: ResultRow, flags: PenaltyFlags): string[] {
  if (flags.time) {
    return [r.rawTimeFormatted || r.timeFormatted, r.timeFormatted];
  }
  return [r.timeFormatted];
}

const TRAYECTO_HEADERS = ["1er trayecto", "2do trayecto", "3er trayecto"];

/** Sector keys in appearance order + display headers (1er / 2do trayecto…). */
function collectSegmentColumns(rows: ResultRow[]): { key: string; header: string }[] {
  const seen = new Set<string>();
  const cols: { key: string; header: string }[] = [];
  for (const r of rows) {
    for (const s of r.segments || []) {
      const key = `${s.from}→${s.to}`;
      if (!seen.has(key)) {
        seen.add(key);
        cols.push({
          key,
          header: TRAYECTO_HEADERS[cols.length] || key,
        });
      }
    }
  }
  return cols;
}

function segmentTime(r: ResultRow, key: string): string {
  const seg = (r.segments || []).find((s) => `${s.from}→${s.to}` === key);
  return seg ? seg.timeFormatted : "—";
}

function baseHeaders(
  withLaps: boolean,
  flags: PenaltyFlags,
  segmentCols: { key: string; header: string }[]
): string[] {
  const h = ["Pos", "N°", "Nombre", "Categoría", "Liga"];
  if (withLaps) h.push("Vueltas");
  for (const c of segmentCols) h.push(c.header);
  h.push(...timeHeaders(flags), "Salida", "Segmento");
  return h;
}

function baseCells(
  r: ResultRow,
  withLaps: boolean,
  flags: PenaltyFlags,
  segmentCols: { key: string; header: string }[]
): (string | number)[] {
  const cells: (string | number)[] = [
    r.position,
    r.number,
    r.name,
    r.category || "—",
    r.league || "—",
  ];
  if (withLaps) cells.push(lapsCell(r));
  for (const c of segmentCols) cells.push(segmentTime(r, c.key));
  cells.push(...timeCells(r, flags), r.partName || "—", r.segmentLabel);
  return cells;
}

export function resultsToCsv(rows: ResultRow[], title: string): string {
  const flags = penaltyFlags(rows);
  const withLaps = hasLapResults(rows);
  const segmentCols = collectSegmentColumns(rows);
  const headers = [...baseHeaders(withLaps, flags, segmentCols), ...penaltyHeaders(flags)];
  const lines = [`# ${title}`, headers.join(",")];
  for (const r of rows) {
    if (r.incomplete) continue;
    const cells = [
      ...baseCells(r, withLaps, flags, segmentCols).map((c) =>
        typeof c === "string" ? esc(c) : c
      ),
      ...penaltyCells(r, flags).map((c) => (typeof c === "string" ? esc(c) : c)),
    ];
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

export async function resultsToExcel(
  rows: ResultRow[],
  title: string,
  eventName: string
): Promise<Buffer> {
  const flags = penaltyFlags(rows);
  const withLaps = hasLapResults(rows);
  const segmentCols = collectSegmentColumns(rows);
  const penHeaders = penaltyHeaders(flags);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Minerva Timing";
  const ws = wb.addWorksheet("Resultados");

  const headers = [...baseHeaders(withLaps, flags, segmentCols), ...penHeaders];
  const colCount = headers.length;
  ws.mergeCells(1, 1, 1, colCount);
  ws.getCell("A1").value = eventName;
  ws.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF1A1A1A" } };

  ws.mergeCells(2, 1, 2, colCount);
  ws.getCell("A2").value = title;
  ws.getCell("A2").font = { size: 12, color: { argb: "FF444444" } };

  const headerRow = ws.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B3D2E" } };
    cell.alignment = { horizontal: "center" };
  });

  for (const r of rows) {
    if (r.incomplete) continue;
    ws.addRow([...baseCells(r, withLaps, flags, segmentCols), ...penaltyCells(r, flags)]);
  }

  const timeWidths = flags.time ? [{ width: 14 }, { width: 14 }] : [{ width: 14 }];
  const segWidths = segmentCols.map(() => ({ width: 14 }));
  const penWidths = [
    ...(flags.time ? [{ width: 12 }] : []),
    ...(flags.position ? [{ width: 10 }] : []),
    ...(flags.comment ? [{ width: 36 }] : []),
  ];
  ws.columns = [
    { width: 6 },
    { width: 10 },
    { width: 28 },
    { width: 22 },
    { width: 16 },
    ...(withLaps ? [{ width: 10 }] : []),
    ...segWidths,
    ...timeWidths,
    { width: 14 },
    { width: 22 },
    ...penWidths,
  ];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function findHeaderImage(eventId: string): string | null {
  for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".gif"]) {
    const p = path.join(HEADERS_DIR, `${eventId}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

type PdfCol = { label: string; w: number; value: (r: ResultRow) => string };

function buildPdfColumns(
  flags: PenaltyFlags,
  pageWidth: number,
  withLaps: boolean,
  segmentCols: { key: string; header: string }[] = []
): PdfCol[] {
  const cols: PdfCol[] = [
    { label: "Pos", w: 36, value: (r) => String(r.position) },
    { label: "N°", w: 40, value: (r) => r.number },
    { label: "Nombre", w: segmentCols.length > 0 ? 110 : 130, value: (r) => r.name || "—" },
    { label: "Categoría", w: segmentCols.length > 0 ? 72 : 90, value: (r) => r.category || "—" },
    { label: "Liga", w: 58, value: (r) => r.league || "—" },
  ];
  if (withLaps) {
    cols.push({ label: "Vueltas", w: 48, value: (r) => lapsCell(r) || "—" });
  }
  for (const seg of segmentCols) {
    cols.push({
      label: seg.header,
      w: 62,
      value: (r) => segmentTime(r, seg.key),
    });
  }
  if (flags.time) {
    cols.push(
      {
        label: "Tiempo sin pen.",
        w: 62,
        value: (r) => r.rawTimeFormatted || r.timeFormatted,
      },
      {
        label: "Tiempo con pen.",
        w: 62,
        value: (r) => r.timeFormatted,
      }
    );
  } else {
    cols.push({
      label: segmentCols.length > 0 ? "Total" : "Tiempo",
      w: 64,
      value: (r) => r.timeFormatted,
    });
  }
  cols.push({ label: "Salida", w: 64, value: (r) => r.partName || "—" });

  if (flags.time) {
    cols.push({
      label: "Pen. tiempo",
      w: 58,
      value: (r) => (r.timePenaltyMs ? formatMs(r.timePenaltyMs) : "—"),
    });
  }
  if (flags.position) {
    cols.push({
      label: "Pen. pos",
      w: 42,
      value: (r) => (r.positionPenalty ? `+${r.positionPenalty}` : "—"),
    });
  }
  if (flags.comment) {
    cols.push({
      label: "Comentario",
      w: 120,
      value: (r) => r.comment || "",
    });
  }

  const total = cols.reduce((s, c) => s + c.w, 0);
  const scale = pageWidth / total;
  return cols.map((c) => ({ ...c, w: c.w * scale }));
}

/** Draw text without PDFKit auto-creating pages */
function pdfText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  opts: PDFKit.Mixins.TextOptions = {}
) {
  doc.text(text, x, y, { lineBreak: false, ...opts });
}

const PDF_ROW_PAD = 6;
const PDF_MIN_ROW_H = 14;
const PDF_MAX_CELL_LINES = 3;

function pdfWrappedHeight(
  doc: PDFKit.PDFDocument,
  text: string,
  colWidth: number,
  fontSize: number,
  font: string
): number {
  doc.font(font).fontSize(fontSize);
  const innerW = Math.max(colWidth - 4, 8);
  return doc.heightOfString(text || "—", { width: innerW });
}

function pdfDrawCell(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  colWidth: number
) {
  const prevY = doc.y;
  const innerW = Math.max(colWidth - 4, 8);
  doc.text(text || "—", x, y + 2, { width: innerW, lineBreak: false });
  doc.y = prevY;
}

function computePdfRowLayout<T>(
  doc: PDFKit.PDFDocument,
  cols: { w: number; value: (r: T) => string }[],
  row: T,
  baseFontSize: number,
  font: string
): { fontSize: number; rowH: number } {
  let fontSize = baseFontSize;
  let rowH = PDF_MIN_ROW_H;

  for (let attempt = 0; attempt < 5; attempt++) {
    let maxH = 0;
    for (const c of cols) {
      maxH = Math.max(maxH, pdfWrappedHeight(doc, c.value(row), c.w, fontSize, font));
    }
    rowH = Math.max(PDF_MIN_ROW_H, maxH) + PDF_ROW_PAD;
    const lineLimit = fontSize * 1.35 * PDF_MAX_CELL_LINES;
    if (maxH <= lineLimit || fontSize <= 6) break;
    fontSize -= 0.5;
  }

  return { fontSize, rowH };
}

export async function resultsToPdf(
  rows: ResultRow[],
  title: string,
  event: Event,
  test?: Test | null
): Promise<Buffer> {
  // Incomplete times (solo A o solo B) stay in the app UI but never in the PDF
  const exportRows = rows.filter((r) => !r.incomplete);
  return new Promise((resolve, reject) => {
    const flags = penaltyFlags(exportRows);
    const segmentCols = collectSegmentColumns(exportRows);
    const hasPenaltyCols = flags.time || flags.position || flags.comment;
    const useLandscape = hasPenaltyCols || segmentCols.length > 0;
    const FOOTER_H = 40;

    const doc = new PDFDocument({
      size: "A4",
      layout: useLandscape ? "landscape" : "portrait",
      // Bottom margin reserves footer zone so table text never auto-paginates into empty pages
      margins: { top: 36, bottom: FOOTER_H + 8, left: 36, right: 36 },
      bufferPages: true,
      info: { Title: title, Author: "Minerva Timing" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const pageWidth = doc.page.width - left - doc.page.margins.right;
    const contentBottom = () => doc.page.height - doc.page.margins.bottom;
    let y = doc.page.margins.top;

    const headerPath = event.headerImage
      ? path.isAbsolute(event.headerImage)
        ? event.headerImage
        : path.join(HEADERS_DIR, path.basename(event.headerImage))
      : findHeaderImage(event.id);

    if (headerPath && fs.existsSync(headerPath)) {
      try {
        doc.image(headerPath, left, y, {
          fit: [pageWidth, 70],
          align: "center",
        });
        y += 80;
      } catch {
        // ignore
      }
    }

    doc.fillColor("#0B3D2E").fontSize(18).font("Helvetica-Bold");
    pdfText(doc, event.name, left, y, { width: pageWidth, align: "center", lineBreak: true });
    y = doc.y + 4;

    doc.fillColor("#555555").fontSize(11).font("Helvetica");
    pdfText(doc, title, left, y, { width: pageWidth, align: "center", lineBreak: true });
    y = doc.y + 2;

    if (event.date || event.location) {
      doc.fillColor("#777777").fontSize(9);
      pdfText(doc, [event.date, event.location].filter(Boolean).join(" · "), left, y, {
        width: pageWidth,
        align: "center",
        lineBreak: true,
      });
      y = doc.y + 2;
    }

    if (test?.showDescriptionInPdf && test.description?.trim()) {
      y += 6;
      doc.fillColor("#333333").fontSize(9).font("Helvetica");
      pdfText(doc, test.description.trim(), left, y, {
        width: pageWidth,
        align: "center",
        lineBreak: true,
      });
      y = doc.y + 2;
    }

    y += 10;
    doc
      .moveTo(left, y)
      .lineTo(left + pageWidth, y)
      .strokeColor("#0B3D2E")
      .lineWidth(1.5)
      .stroke();
    y += 10;

    const withLaps = hasLapResults(exportRows);
    const cols = buildPdfColumns(flags, pageWidth, withLaps, segmentCols);
    const fontSize = useLandscape ? 8 : 9;
    const tableHeaderH = 18;

    const drawTableHeader = (yy: number) => {
      doc.rect(left, yy, pageWidth, tableHeaderH).fill("#0B3D2E");
      let x = left + 4;
      doc.fillColor("#FFFFFF").fontSize(fontSize).font("Helvetica-Bold");
      for (const c of cols) {
        pdfText(doc, c.label, x, yy + 5, { width: c.w - 4 });
        x += c.w;
      }
      return yy + tableHeaderH + 2;
    };

    y = drawTableHeader(y);

    const drawFooterOnCurrentPage = (pageLabel: number) => {
      const prevBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 28;
      doc
        .moveTo(left, fy - 8)
        .lineTo(left + pageWidth, fy - 8)
        .strokeColor("#CCCCCC")
        .lineWidth(0.5)
        .stroke();
      doc.fillColor("#888888").fontSize(8).font("Helvetica");
      pdfText(doc, event.footerText || "Minerva Timing", left, fy, {
        width: pageWidth * 0.7,
        align: "left",
      });
      pdfText(doc, `Pág. ${pageLabel}`, left, fy, {
        width: pageWidth,
        align: "right",
      });
      doc.page.margins.bottom = prevBottom;
    };

    doc.font("Helvetica").fontSize(fontSize);
    for (let i = 0; i < exportRows.length; i++) {
      const r = exportRows[i];
      const rowFont = r.position <= 3 ? "Helvetica-Bold" : "Helvetica";
      const { fontSize: rowFontSize, rowH } = computePdfRowLayout(
        doc,
        cols,
        r,
        fontSize,
        rowFont
      );

      if (y + rowH > contentBottom()) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawTableHeader(y);
      }

      if (i % 2 === 0) {
        doc.rect(left, y - 1, pageWidth, rowH).fill("#F3F7F5");
      }

      let x = left + 4;
      doc.fillColor("#1A1A1A").font(rowFont).fontSize(rowFontSize);

      for (const c of cols) {
        pdfDrawCell(doc, c.value(r), x, y, c.w);
        x += c.w;
      }
      y += rowH;
    }

    // Footers only on pages that were actually used
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawFooterOnCurrentPage(i + 1);
    }

    doc.end();
  });
}

type LapPdfCol = { label: string; w: number; value: (r: LapByLapRow) => string };

export async function lapByLapToPdf(
  rows: LapByLapRow[],
  maxLaps: number,
  title: string,
  event: Event,
  test?: Test | null
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const FOOTER_H = 40;
    const useLandscape = maxLaps > 4;

    const doc = new PDFDocument({
      size: "A4",
      layout: useLandscape ? "landscape" : "portrait",
      margins: { top: 36, bottom: FOOTER_H + 8, left: 36, right: 36 },
      bufferPages: true,
      info: { Title: title, Author: "Minerva Timing" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const pageWidth = doc.page.width - left - doc.page.margins.right;
    const contentBottom = () => doc.page.height - doc.page.margins.bottom;
    let y = doc.page.margins.top;

    const headerPath = event.headerImage
      ? path.isAbsolute(event.headerImage)
        ? event.headerImage
        : path.join(HEADERS_DIR, path.basename(event.headerImage))
      : findHeaderImage(event.id);

    if (headerPath && fs.existsSync(headerPath)) {
      try {
        doc.image(headerPath, left, y, { fit: [pageWidth, 70], align: "center" });
        y += 80;
      } catch {
        // ignore
      }
    }

    doc.fillColor("#0B3D2E").fontSize(18).font("Helvetica-Bold");
    pdfText(doc, event.name, left, y, { width: pageWidth, align: "center", lineBreak: true });
    y = doc.y + 4;

    doc.fillColor("#555555").fontSize(11).font("Helvetica");
    pdfText(doc, title, left, y, { width: pageWidth, align: "center", lineBreak: true });
    y = doc.y + 2;

    if (event.date || event.location) {
      doc.fillColor("#777777").fontSize(9);
      pdfText(doc, [event.date, event.location].filter(Boolean).join(" · "), left, y, {
        width: pageWidth,
        align: "center",
        lineBreak: true,
      });
      y = doc.y + 2;
    }

    if (test?.showDescriptionInPdf && test.description?.trim()) {
      y += 6;
      doc.fillColor("#333333").fontSize(9).font("Helvetica");
      pdfText(doc, test.description.trim(), left, y, {
        width: pageWidth,
        align: "center",
        lineBreak: true,
      });
      y = doc.y + 2;
    }

    y += 10;
    doc.moveTo(left, y).lineTo(left + pageWidth, y).strokeColor("#0B3D2E").lineWidth(1.5).stroke();
    y += 10;

    const cols: LapPdfCol[] = [
      { label: "Pos", w: 28, value: (r) => String(r.position) },
      { label: "N°", w: 36, value: (r) => r.number },
      { label: "Nombre", w: 100, value: (r) => r.name || "—" },
    ];
    for (let i = 1; i <= maxLaps; i++) {
      cols.push({
        label: `V${i}`,
        w: 52,
        value: (r) => r.lapTimesFormatted[i - 1] || "—",
      });
    }
    cols.push({
      label: "Vueltas",
      w: 44,
      value: (r) =>
        r.expectedLaps != null ? `${r.lapsCompleted}/${r.expectedLaps}` : String(r.lapsCompleted),
    });
    cols.push({ label: "Total", w: 56, value: (r) => r.totalTimeFormatted });

    const totalW = cols.reduce((s, c) => s + c.w, 0);
    const scale = pageWidth / totalW;
    const scaledCols = cols.map((c) => ({ ...c, w: c.w * scale }));

    const fontSize = useLandscape ? 7.5 : 8;
    const tableHeaderH = 18;

    const drawTableHeader = (yy: number) => {
      doc.rect(left, yy, pageWidth, tableHeaderH).fill("#0B3D2E");
      let x = left + 3;
      doc.fillColor("#FFFFFF").fontSize(fontSize).font("Helvetica-Bold");
      for (const c of scaledCols) {
        pdfText(doc, c.label, x, yy + 5, { width: c.w - 4 });
        x += c.w;
      }
      return yy + tableHeaderH + 2;
    };

    y = drawTableHeader(y);

    const drawFooterOnCurrentPage = (pageLabel: number) => {
      const prevBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 28;
      doc
        .moveTo(left, fy - 8)
        .lineTo(left + pageWidth, fy - 8)
        .strokeColor("#CCCCCC")
        .lineWidth(0.5)
        .stroke();
      doc.fillColor("#888888").fontSize(8).font("Helvetica");
      pdfText(doc, event.footerText || "Minerva Timing", left, fy, {
        width: pageWidth * 0.7,
        align: "left",
      });
      pdfText(doc, `Pág. ${pageLabel}`, left, fy, { width: pageWidth, align: "right" });
      doc.page.margins.bottom = prevBottom;
    };

    doc.font("Helvetica").fontSize(fontSize);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowFont = r.position <= 3 ? "Helvetica-Bold" : "Helvetica";
      const { fontSize: rowFontSize, rowH } = computePdfRowLayout(
        doc,
        scaledCols,
        r,
        fontSize,
        rowFont
      );

      if (y + rowH > contentBottom()) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawTableHeader(y);
      }

      if (i % 2 === 0) {
        doc.rect(left, y - 1, pageWidth, rowH).fill("#F3F7F5");
      }

      let x = left + 3;
      doc.fillColor("#1A1A1A").font(rowFont).fontSize(rowFontSize);

      for (const c of scaledCols) {
        pdfDrawCell(doc, c.value(r), x, y, c.w);
        x += c.w;
      }
      y += rowH;
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawFooterOnCurrentPage(i + 1);
    }

    doc.end();
  });
}

function pdfStackedCellHeight(
  doc: PDFKit.PDFDocument,
  top: string,
  bottom: string,
  colWidth: number,
  topSize: number,
  bottomSize: number
): number {
  const innerW = Math.max(colWidth - 4, 8);
  doc.fontSize(topSize);
  const h1 = doc.heightOfString(top || "—", { width: innerW });
  if (!bottom) return h1;
  doc.fontSize(bottomSize);
  return h1 + 2 + doc.heightOfString(bottom, { width: innerW });
}

function pdfDrawStackedCell(
  doc: PDFKit.PDFDocument,
  top: string,
  bottom: string,
  x: number,
  y: number,
  colWidth: number,
  topSize: number,
  bottomSize: number
) {
  const prevY = doc.y;
  const innerW = Math.max(colWidth - 4, 8);
  doc.fontSize(topSize).text(top || "—", x, y + 2, { width: innerW, lineBreak: false });
  if (bottom) {
    doc.fillColor("#555555")
      .fontSize(bottomSize)
      .text(bottom, x, y + 2 + topSize + 1, { width: innerW, lineBreak: false });
    doc.fillColor("#1A1A1A");
  }
  doc.y = prevY;
}

type LapHoursLapCol = { index: number; w: number };

export async function lapByLapWithHoursToPdf(
  rows: LapByLapRow[],
  maxLaps: number,
  title: string,
  event: Event,
  test?: Test | null
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const FOOTER_H = 40;

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: { top: 32, bottom: FOOTER_H + 8, left: 28, right: 28 },
      bufferPages: true,
      info: { Title: title, Author: "Minerva Timing" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const pageWidth = doc.page.width - left - doc.page.margins.right;
    const contentBottom = () => doc.page.height - doc.page.margins.bottom;
    let y = doc.page.margins.top;

    const headerPath = event.headerImage
      ? path.isAbsolute(event.headerImage)
        ? event.headerImage
        : path.join(HEADERS_DIR, path.basename(event.headerImage))
      : findHeaderImage(event.id);

    if (headerPath && fs.existsSync(headerPath)) {
      try {
        doc.image(headerPath, left, y, { fit: [pageWidth, 60], align: "center" });
        y += 68;
      } catch {
        // ignore
      }
    }

    doc.fillColor("#0B3D2E").fontSize(16).font("Helvetica-Bold");
    pdfText(doc, event.name, left, y, { width: pageWidth, align: "center", lineBreak: true });
    y = doc.y + 3;

    doc.fillColor("#555555").fontSize(10).font("Helvetica");
    pdfText(doc, title, left, y, { width: pageWidth, align: "center", lineBreak: true });
    y = doc.y + 2;

    if (event.date || event.location) {
      doc.fillColor("#777777").fontSize(8);
      pdfText(doc, [event.date, event.location].filter(Boolean).join(" · "), left, y, {
        width: pageWidth,
        align: "center",
        lineBreak: true,
      });
      y = doc.y + 2;
    }

    y += 8;
    doc.moveTo(left, y).lineTo(left + pageWidth, y).strokeColor("#0B3D2E").lineWidth(1.5).stroke();
    y += 8;

    const fixedBase = [
      { label: "Pos", w: 24 },
      { label: "N°", w: 30 },
      { label: "Nombre", w: 88 },
    ];
    const lapBaseW = 62;
    const tailBase = [
      { label: "Vueltas", w: 38 },
      { label: "Total", w: 48 },
    ];
    const lapCols: LapHoursLapCol[] = Array.from({ length: maxLaps }, (_, i) => ({
      index: i,
      w: lapBaseW,
    }));

    const totalW =
      fixedBase.reduce((s, c) => s + c.w, 0) +
      lapCols.reduce((s, c) => s + c.w, 0) +
      tailBase.reduce((s, c) => s + c.w, 0);
    const scale = pageWidth / totalW;

    const fixedCols = fixedBase.map((c) => ({ ...c, w: c.w * scale }));
    const scaledLapCols = lapCols.map((c) => ({ ...c, w: c.w * scale }));
    const tailCols = tailBase.map((c) => ({ ...c, w: c.w * scale }));

    const fontSize = 7;
    const clockFontSize = 6;
    const tableHeaderH = 24;

    const drawTableHeader = (yy: number) => {
      doc.rect(left, yy, pageWidth, tableHeaderH).fill("#0B3D2E");
      let x = left + 2;
      doc.fillColor("#FFFFFF").fontSize(fontSize).font("Helvetica-Bold");

      for (const c of fixedCols) {
        pdfText(doc, c.label, x, yy + 8, { width: c.w - 3 });
        x += c.w;
      }
      for (const c of scaledLapCols) {
        pdfText(doc, `V${c.index + 1}`, x, yy + 3, { width: c.w - 3 });
        doc.font("Helvetica").fontSize(clockFontSize);
        pdfText(doc, "T / Hora", x, yy + 13, { width: c.w - 3 });
        doc.font("Helvetica-Bold").fontSize(fontSize);
        x += c.w;
      }
      for (const c of tailCols) {
        pdfText(doc, c.label, x, yy + 8, { width: c.w - 3 });
        x += c.w;
      }
      return yy + tableHeaderH + 2;
    };

    y = drawTableHeader(y);

    const drawFooterOnCurrentPage = (pageLabel: number) => {
      const prevBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 28;
      doc
        .moveTo(left, fy - 8)
        .lineTo(left + pageWidth, fy - 8)
        .strokeColor("#CCCCCC")
        .lineWidth(0.5)
        .stroke();
      doc.fillColor("#888888").fontSize(8).font("Helvetica");
      pdfText(doc, event.footerText || "Minerva Timing", left, fy, {
        width: pageWidth * 0.7,
        align: "left",
      });
      pdfText(doc, `Pág. ${pageLabel}`, left, fy, { width: pageWidth, align: "right" });
      doc.page.margins.bottom = prevBottom;
    };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowFont = r.position <= 3 ? "Helvetica-Bold" : "Helvetica";

      let maxH = PDF_MIN_ROW_H - PDF_ROW_PAD;
      doc.font(rowFont);
      for (const c of fixedCols) {
        const val =
          c.label === "Pos"
            ? String(r.position)
            : c.label === "N°"
              ? r.number
              : r.name || "—";
        maxH = Math.max(maxH, pdfWrappedHeight(doc, val, c.w, fontSize, rowFont));
      }
      for (const c of scaledLapCols) {
        maxH = Math.max(
          maxH,
          pdfStackedCellHeight(
            doc,
            r.lapTimesFormatted[c.index] || "—",
            r.lapClockTimesFormatted[c.index] || "",
            c.w,
            fontSize,
            clockFontSize
          )
        );
      }
      const vueltasVal =
        r.expectedLaps != null ? `${r.lapsCompleted}/${r.expectedLaps}` : String(r.lapsCompleted);
      maxH = Math.max(maxH, pdfWrappedHeight(doc, vueltasVal, tailCols[0].w, fontSize, rowFont));
      maxH = Math.max(maxH, pdfWrappedHeight(doc, r.totalTimeFormatted, tailCols[1].w, fontSize, rowFont));

      const rowH = Math.max(PDF_MIN_ROW_H, maxH) + PDF_ROW_PAD;

      if (y + rowH > contentBottom()) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawTableHeader(y);
      }

      if (i % 2 === 0) {
        doc.rect(left, y - 1, pageWidth, rowH).fill("#F3F7F5");
      }

      let x = left + 2;
      doc.fillColor("#1A1A1A").font(rowFont).fontSize(fontSize);

      for (const c of fixedCols) {
        const val =
          c.label === "Pos"
            ? String(r.position)
            : c.label === "N°"
              ? r.number
              : r.name || "—";
        pdfDrawCell(doc, val, x, y, c.w);
        x += c.w;
      }
      for (const c of scaledLapCols) {
        pdfDrawStackedCell(
          doc,
          r.lapTimesFormatted[c.index] || "—",
          r.lapClockTimesFormatted[c.index] || "",
          x,
          y,
          c.w,
          fontSize,
          clockFontSize
        );
        x += c.w;
      }
      pdfDrawCell(doc, vueltasVal, x, y, tailCols[0].w);
      x += tailCols[0].w;
      pdfDrawCell(doc, r.totalTimeFormatted, x, y, tailCols[1].w);

      y += rowH;
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawFooterOnCurrentPage(i + 1);
    }

    doc.end();
  });
}

function fusionTestHeaders(tests: FusionTestMeta[]): string[] {
  return tests.map((t) => `${t.name} (${t.segmentLabel})`);
}

export function fusionToCsv(rows: FusionRow[], tests: FusionTestMeta[], title: string): string {
  const header = ["Pos", "N°", "Nombre", "Categoría", "Liga", ...fusionTestHeaders(tests), "Total"];
  const lines = [
    `# ${title}`,
    header.join(","),
    ...rows.map((r) =>
      [
        r.position,
        esc(r.number),
        esc(r.name),
        esc(r.category || ""),
        esc(r.league || ""),
        ...r.byTest.map((t) => (t.timeMs != null ? t.timeFormatted : "")),
        r.totalTimeFormatted,
      ].join(",")
    ),
  ];
  return lines.join("\n");
}

export async function fusionToExcel(
  rows: FusionRow[],
  tests: FusionTestMeta[],
  title: string,
  eventName: string
): Promise<Buffer> {
  const testHeaders = fusionTestHeaders(tests);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Minerva Timing";
  const ws = wb.addWorksheet("Fusión");

  const headers = ["Pos", "N°", "Nombre", "Categoría", "Liga", ...testHeaders, "Total"];
  const colCount = headers.length;

  ws.mergeCells(1, 1, 1, colCount);
  ws.getCell("A1").value = eventName;
  ws.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF1A1A1A" } };

  ws.mergeCells(2, 1, 2, colCount);
  ws.getCell("A2").value = title;
  ws.getCell("A2").font = { size: 12, color: { argb: "FF444444" } };

  const headerRow = ws.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B3D2E" } };
    cell.alignment = { horizontal: "center", wrapText: true };
  });

  for (const r of rows) {
    ws.addRow([
      r.position,
      r.number,
      r.name,
      r.category || "—",
      r.league || "—",
      ...r.byTest.map((t) => (t.timeMs != null ? t.timeFormatted : "—")),
      r.totalTimeFormatted,
    ]);
  }

  const baseWidths = [6, 10, 28, 22, 16];
  const testWidths = tests.map(() => ({ width: 18 }));
  ws.columns = [...baseWidths.map((width) => ({ width })), ...testWidths, { width: 14 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

type FusionPdfCol = { label: string; sub?: string; w: number; value: (r: FusionRow) => string };

export async function fusionToPdf(
  rows: FusionRow[],
  tests: FusionTestMeta[],
  title: string,
  event: Event
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const FOOTER_H = 40;
    const useLandscape = tests.length > 2;

    const doc = new PDFDocument({
      size: "A4",
      layout: useLandscape ? "landscape" : "portrait",
      margins: { top: 36, bottom: FOOTER_H + 8, left: 36, right: 36 },
      bufferPages: true,
      info: { Title: title, Author: "Minerva Timing" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const pageWidth = doc.page.width - left - doc.page.margins.right;
    const contentBottom = () => doc.page.height - doc.page.margins.bottom;
    let y = doc.page.margins.top;

    const headerPath = event.headerImage
      ? path.isAbsolute(event.headerImage)
        ? event.headerImage
        : path.join(HEADERS_DIR, path.basename(event.headerImage))
      : findHeaderImage(event.id);

    if (headerPath && fs.existsSync(headerPath)) {
      try {
        doc.image(headerPath, left, y, { fit: [pageWidth, 70], align: "center" });
        y += 80;
      } catch {
        // ignore
      }
    }

    doc.fillColor("#0B3D2E").fontSize(18).font("Helvetica-Bold");
    pdfText(doc, event.name, left, y, { width: pageWidth, align: "center", lineBreak: true });
    y = doc.y + 4;

    doc.fillColor("#555555").fontSize(11).font("Helvetica");
    pdfText(doc, title, left, y, { width: pageWidth, align: "center", lineBreak: true });
    y = doc.y + 2;

    if (event.date || event.location) {
      doc.fillColor("#777777").fontSize(9);
      pdfText(doc, [event.date, event.location].filter(Boolean).join(" · "), left, y, {
        width: pageWidth,
        align: "center",
        lineBreak: true,
      });
      y = doc.y + 2;
    }

    y += 10;
    doc.moveTo(left, y).lineTo(left + pageWidth, y).strokeColor("#0B3D2E").lineWidth(1.5).stroke();
    y += 10;

    const cols: FusionPdfCol[] = [
      { label: "Pos", w: 32, value: (r) => String(r.position) },
      { label: "N°", w: 40, value: (r) => r.number },
      { label: "Nombre", w: 110, value: (r) => r.name || "—" },
      { label: "Categoría", w: 72, value: (r) => r.category || "—" },
      { label: "Liga", w: 56, value: (r) => r.league || "—" },
    ];
    for (const t of tests) {
      cols.push({
        label: t.name,
        sub: t.segmentLabel,
        w: 72,
        value: (r) => r.byTest.find((bt) => bt.testId === t.id)?.timeFormatted || "—",
      });
    }
    cols.push({ label: "Total", w: 58, value: (r) => r.totalTimeFormatted });

    const totalW = cols.reduce((s, c) => s + c.w, 0);
    const scale = pageWidth / totalW;
    const scaledCols = cols.map((c) => ({ ...c, w: c.w * scale }));

    const fontSize = useLandscape ? 8 : 9;
    const tableHeaderH = 26;

    const drawTableHeader = (yy: number) => {
      doc.rect(left, yy, pageWidth, tableHeaderH).fill("#0B3D2E");
      let x = left + 3;
      doc.fillColor("#FFFFFF").fontSize(fontSize - 1).font("Helvetica-Bold");
      for (const c of scaledCols) {
        pdfText(doc, c.label, x, yy + 4, { width: c.w - 4 });
        if (c.sub) {
          doc.font("Helvetica").fontSize(fontSize - 2);
          pdfText(doc, c.sub, x, yy + 14, { width: c.w - 4 });
          doc.font("Helvetica-Bold").fontSize(fontSize - 1);
        }
        x += c.w;
      }
      return yy + tableHeaderH + 2;
    };

    y = drawTableHeader(y);

    const drawFooterOnCurrentPage = (pageLabel: number) => {
      const prevBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 28;
      doc
        .moveTo(left, fy - 8)
        .lineTo(left + pageWidth, fy - 8)
        .strokeColor("#CCCCCC")
        .lineWidth(0.5)
        .stroke();
      doc.fillColor("#888888").fontSize(8).font("Helvetica");
      pdfText(doc, event.footerText || "Minerva Timing", left, fy, {
        width: pageWidth * 0.7,
        align: "left",
      });
      pdfText(doc, `Pág. ${pageLabel}`, left, fy, { width: pageWidth, align: "right" });
      doc.page.margins.bottom = prevBottom;
    };

    doc.font("Helvetica").fontSize(fontSize);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowFont = r.position <= 3 ? "Helvetica-Bold" : "Helvetica";
      const { fontSize: rowFontSize, rowH } = computePdfRowLayout(
        doc,
        scaledCols,
        r,
        fontSize,
        rowFont
      );

      if (y + rowH > contentBottom()) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawTableHeader(y);
      }

      if (i % 2 === 0) {
        doc.rect(left, y - 1, pageWidth, rowH).fill("#F3F7F5");
      }

      let x = left + 3;
      doc.fillColor("#1A1A1A").font(rowFont).fontSize(rowFontSize);

      for (const c of scaledCols) {
        pdfDrawCell(doc, c.value(r), x, y, c.w);
        x += c.w;
      }
      y += rowH;
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawFooterOnCurrentPage(i + 1);
    }

    doc.end();
  });
}
