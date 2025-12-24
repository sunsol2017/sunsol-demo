"use client";

import React, { useMemo, useRef, useState } from "react";

/**
 * Sunsol - Cotizador (sin vendedor)
 * - Foto/screenshot de LUMA página 4 (CONSUMPTION HISTORY)
 * - Auto-crop a la zona de la gráfica (bottom portion)
 * - Si OCR falla => permite crop manual (usuario dibuja rectángulo)
 * - Extrae consumo mensual por meses (EN/ES), toma 12 más recientes
 * - Si faltan meses: anualiza con meses disponibles (min 4)
 * - PV $/W y Batería Soluna $/kWh, sin incentivos
 */

const PV_PRICE_PER_W_DEFAULT = 2.3;
const SOLUNA_PRICE_PER_KWH = 350;

const DEFAULT_PSH = 5;
const DEFAULT_LOSS_FACTOR = 0.8;
const DEFAULT_OFFSET = 90;
const DEFAULT_PANEL_W = 450;

const DEFAULT_PERMITS = 1200;
const DEFAULT_INTERCONNECTION = 450;
const DEFAULT_MISC_FACTOR = 0.03;

const BATTERY_OPTIONS = [5, 10, 16, 20, 32, 40] as const;
const BATTERY_USABLE_FACTOR = 0.9;

// Para tu regla:
const KWH_MIN = 20;
const KWH_MAX = 3000;
const MIN_MONTHS_REQUIRED = 4;

type ParseResult = {
  ok: boolean;
  reason?: string;

  monthsDetected?: string[]; // tokens de meses encontrados
  monthlyValues?: number[]; // valores detectados (orden aproximado)
  monthsUsedCount?: number;

  annualKwh?: number;
  monthlyAvgKwh?: number;

  commercialFlag?: boolean; // si detectó >3000
};

// ===== OCR (tesseract.js) =====
async function runOcr(blob: Blob): Promise<{ text: string; confidence: number }> {
  const Tesseract = (await import("tesseract.js")).default;
  const { data } = await Tesseract.recognize(blob, "eng", { logger: () => {} });
  return {
    text: String(data?.text || ""),
    confidence: Number.isFinite(data?.confidence) ? (data.confidence as number) : 0,
  };
}

// ===== Image helpers =====
function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/**
 * Auto-crop: recorta zona inferior donde suele estar "CONSUMPTION HISTORY".
 * Ajuste simple: y desde 45% hacia abajo (55% de alto).
 */
async function autoCropLumaGraph(blob: Blob): Promise<Blob> {
  const img = await loadImageFromBlob(blob);

  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;

  const y = Math.floor(srcH * 0.45);
  const h = Math.floor(srcH * 0.55);
  const x = 0;
  const w = srcW;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No canvas context");
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);

  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (!b) reject(new Error("No se pudo crear el recorte (blob)."));
        else resolve(b);
      },
      "image/jpeg",
      0.92
    );
  });
}

// ===== Parse: meses EN/ES + valores 20–3000 =====
function normalizeText(t: string) {
  return (t || "")
    .replace(/\r/g, "\n")
    .replace(/[|]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

const MONTH_PATTERNS: { token: string; re: RegExp }[] = [
  // Inglés
  { token: "jan", re: /\bjan(?:uary)?\b/i },
  { token: "feb", re: /\bfeb(?:ruary)?\b/i },
  { token: "mar", re: /\bmar(?:ch)?\b/i },
  { token: "apr", re: /\bapr(?:il)?\b/i },
  { token: "may", re: /\bmay\b/i },
  { token: "jun", re: /\bjun(?:e)?\b/i },
  { token: "jul", re: /\bjul(?:y)?\b/i },
  { token: "aug", re: /\baug(?:ust)?\b/i },
  { token: "sep", re: /\bsep(?:tember)?\b/i },
  { token: "oct", re: /\boct(?:ober)?\b/i },
  { token: "nov", re: /\bnov(?:ember)?\b/i },
  { token: "dec", re: /\bdec(?:ember)?\b/i },

  // Español (abreviaturas comunes)
  { token: "ene", re: /\bene(?:ro)?\b/i },
  { token: "feb_es", re: /\bfeb(?:rero)?\b/i },
  { token: "mar_es", re: /\bmar(?:zo)?\b/i },
  { token: "abr", re: /\babr(?:il)?\b/i },
  { token: "may_es", re: /\bmay(?:o)?\b/i },
  { token: "jun_es", re: /\bjun(?:io)?\b/i },
  { token: "jul_es", re: /\bjul(?:io)?\b/i },
  { token: "ago", re: /\bago(?:sto)?\b/i },
  { token: "sep_es", re: /\bsep(?:tiembre)?\b/i },
  { token: "oct_es", re: /\boct(?:ubre)?\b/i },
  { token: "nov_es", re: /\bnov(?:iembre)?\b/i },
  { token: "dic", re: /\bdic(?:iembre)?\b/i },

  // Formato tipo "Dec-24" / "Dic-24"
  { token: "dec_dash", re: /\bdec[-/]\d{2}\b/i },
  { token: "dic_dash", re: /\bdic[-/]\d{2}\b/i },
];

function extractMonthsInOrder(block: string): string[] {
  const lower = block.toLowerCase();
  const hits: { idx: number; token: string }[] = [];

  for (const p of MONTH_PATTERNS) {
    // Buscar múltiples ocurrencias por regex (global)
    const re = new RegExp(p.re.source, "ig");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      hits.push({ idx: m.index, token: m[0].toLowerCase() });
    }
  }

  hits.sort((a, b) => a.idx - b.idx);

  // Deduplicar por token + orden (evita repetir "mar" etc)
  const out: string[] = [];
  for (const h of hits) {
    const tok = h.token;
    if (out.length === 0 || out[out.length - 1] !== tok) out.push(tok);
  }
  return out;
}

function extractConsumptionFromOcr(textRaw: string): ParseResult {
  const text = normalizeText(textRaw);
  const lower = text.toLowerCase();

  // Enfocar a bloque de la gráfica si aparece el encabezado
  const keyIdx =
    lower.indexOf("consumption history") >= 0
      ? lower.indexOf("consumption history")
      : lower.indexOf("historial de consumo") >= 0
        ? lower.indexOf("historial de consumo")
        : lower.indexOf("consumptionhistory");

  let block = text;
  if (keyIdx >= 0) {
    block = text.slice(keyIdx);
  }

  // Cortar antes de "Cost per kWh" si aparece
  const endKeyIdx = block.toLowerCase().indexOf("cost per kwh");
  if (endKeyIdx > 0) block = block.slice(0, endKeyIdx);

  // Meses detectados (EN/ES)
  const monthsDetected = extractMonthsInOrder(block);

  // Extraer números candidatos
  const nums = Array.from(block.matchAll(/\b(\d{2,4})\b/g))
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));

  // Filtrar rango 20–3000
  const candidates = nums.filter((n) => n >= KWH_MIN && n <= KWH_MAX);

  // Si hay números fuera de rango alto (p.ej OCR leyó 8250), marcar posible comercial
  const commercialFlag = nums.some((n) => n > KWH_MAX);

  // Necesitamos señal de que estamos en el área correcta:
  // Si no detecta meses y hay muy pocos candidatos, fallar.
  if (monthsDetected.length < MIN_MONTHS_REQUIRED && candidates.length < MIN_MONTHS_REQUIRED) {
    return {
      ok: false,
      reason: "No se detectaron meses suficientes ni valores claros en la gráfica. Usa página 4 completa y foto nítida.",
      commercialFlag,
    };
  }

  // Heurística de orden:
  // En OCR, muchas veces los valores de barras aparecen juntos.
  // Tomamos los últimos N valores donde N = min(13, max(meses_detectados, 13 si hay suficientes números)).
  const targetN = Math.min(13, Math.max(monthsDetected.length, Math.min(13, candidates.length)));
  let series = candidates.slice(-targetN);

  // Limpiar: si hay 0 o muy pocos, fallo.
  if (series.length < MIN_MONTHS_REQUIRED) {
    return {
      ok: false,
      reason: `Solo pude extraer ${series.length} mes(es). Se requieren mínimo ${MIN_MONTHS_REQUIRED}.`,
      monthsDetected,
      monthlyValues: series,
      commercialFlag,
    };
  }

  // Regla: usar 12 más recientes si hay 12+
  let used: number[] = [];
  if (series.length >= 12) {
    used = series.slice(-12);
  } else {
    used = series; // 4–11 meses
  }

  const sum = used.reduce((a, b) => a + b, 0);
  const monthsUsedCount = used.length;

  // Si hay 12 meses => anual real = suma
  // Si hay 4–11 => anualizar
  const annualKwh = monthsUsedCount >= 12 ? sum : (sum / monthsUsedCount) * 12;
  const monthlyAvgKwh = annualKwh / 12;

  return {
    ok: true,
    monthsDetected,
    monthlyValues: series,
    monthsUsedCount,
    annualKwh,
    monthlyAvgKwh,
    commercialFlag,
  };
}

// ===== PV sizing =====
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function pvKwFromMonthlyKwh(monthlyKwh: number, psh: number, lossFactor: number, offsetPct: number) {
  const offset = clamp(offsetPct, 0, 100) / 100;
  const denom = Math.max(0.1, psh) * 30 * Math.max(0.1, lossFactor);
  return (monthlyKwh * offset) / denom;
}

function formatMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function formatNumber(n: number, digits = 0) {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

// ===== Manual Crop Modal (simple: dibuja rectángulo sobre canvas) =====
type CropRect = { x: number; y: number; w: number; h: number };

function CropModal({
  open,
  imageBlob,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  imageBlob: Blob | null;
  onCancel: () => void;
  onConfirm: (cropped: Blob) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  const dragRef = useRef<{ dragging: boolean; startX: number; startY: number } | null>(null);

  React.useEffect(() => {
    if (!open || !imageBlob) return;

    (async () => {
      const img = await loadImageFromBlob(imageBlob);
      setImgEl(img);

      const canvas = canvasRef.current;
      if (!canvas) return;

      // Ajustar canvas a un ancho manejable
      const maxW = 900;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = Math.floor(img.width * scale);
      canvas.height = Math.floor(img.height * scale);

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Rect default: zona inferior (similar auto-crop)
      const defaultRect: CropRect = {
        x: 0,
        y: Math.floor(canvas.height * 0.45),
        w: canvas.width,
        h: Math.floor(canvas.height * 0.55),
      };
      setRect(defaultRect);
      drawRect(ctx, defaultRect);
    })();
  }, [open, imageBlob]);

  function draw() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !imgEl) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    if (rect) drawRect(ctx, rect);
  }

  function drawRect(ctx: CanvasRenderingContext2D, r: CropRect) {
    ctx.save();
    ctx.strokeStyle = "#00a77a";
    ctx.lineWidth = 3;
    ctx.fillStyle = "rgba(0,167,122,0.12)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  function getPos(e: React.MouseEvent<HTMLCanvasElement, MouseEvent>) {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y };
  }

  function onDown(e: React.MouseEvent<HTMLCanvasElement, MouseEvent>) {
    if (!canvasRef.current) return;
    const { x, y } = getPos(e);
    dragRef.current = { dragging: true, startX: x, startY: y };
    setRect({ x, y, w: 1, h: 1 });
  }

  function onMove(e: React.MouseEvent<HTMLCanvasElement, MouseEvent>) {
    if (!dragRef.current?.dragging) return;
    const { x, y } = getPos(e);
    const sx = dragRef.current.startX;
    const sy = dragRef.current.startY;

    const nx = Math.min(sx, x);
    const ny = Math.min(sy, y);
    const nw = Math.abs(x - sx);
    const nh = Math.abs(y - sy);

    setRect({ x: nx, y: ny, w: Math.max(1, nw), h: Math.max(1, nh) });
    requestAnimationFrame(draw);
  }

  function onUp() {
    if (dragRef.current) dragRef.current.dragging = false;
    requestAnimationFrame(draw);
  }

  async function confirmCrop() {
    if (!imageBlob || !imgEl || !rect || !canvasRef.current) return;

    // Convertir rect canvas -> rect en imagen original (considerando escala)
    const canvas = canvasRef.current;
    const scaleX = imgEl.width / canvas.width;
    const scaleY = imgEl.height / canvas.height;

    const sx = Math.floor(rect.x * scaleX);
    const sy = Math.floor(rect.y * scaleY);
    const sw = Math.floor(rect.w * scaleX);
    const sh = Math.floor(rect.h * scaleY);

    const outCanvas = document.createElement("canvas");
    outCanvas.width = sw;
    outCanvas.height = sh;
    const ctx = outCanvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, sw, sh);

    const outBlob = await new Promise<Blob>((resolve, reject) => {
      outCanvas.toBlob(
        (b) => {
          if (!b) reject(new Error("No se pudo generar recorte."));
          else resolve(b);
        },
        "image/jpeg",
        0.92
      );
    });

    onConfirm(outBlob);
  }

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 14,
        zIndex: 9999,
      }}
    >
      <div style={{ background: "white", borderRadius: 14, maxWidth: 980, width: "100%", padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
          <b>Recortar manualmente</b>
          <button onClick={onCancel} style={{ border: "1px solid #ddd", background: "white", borderRadius: 10, padding: "8px 10px" }}>
            Cerrar
          </button>
        </div>

        <div style={{ marginTop: 10, color: "#666", fontSize: 13 }}>
          Arrastra para dibujar un rectángulo sobre la <b>gráfica</b> (CONSUMPTION HISTORY). Luego presiona “Usar recorte”.
        </div>

        <div style={{ marginTop: 10, overflow: "auto", border: "1px solid #eee", borderRadius: 12 }}>
          <canvas
            ref={canvasRef}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={onUp}
            style={{ width: "100%", height: "auto", display: "block", cursor: "crosshair" }}
          />
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={onCancel} style={{ border: "1px solid #ddd", background: "white", borderRadius: 10, padding: "10px 12px" }}>
            Cancelar
          </button>
          <button onClick={confirmCrop} style={{ border: "1px solid #00a77a", background: "#00a77a", color: "white", borderRadius: 10, padding: "10px 12px" }}>
            Usar recorte
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== Main Page =====
export default function Page() {
  // Inputs
  const [monthlyKwh, setMonthlyKwh] = useState<number>(0);
  const [annualKwh, setAnnualKwh] = useState<number>(0);
  const [monthsUsedCount, setMonthsUsedCount] = useState<number>(0);

  const [offsetPct, setOffsetPct] = useState<number>(DEFAULT_OFFSET);
  const [psh, setPsh] = useState<number>(DEFAULT_PSH);
  const [lossFactor, setLossFactor] = useState<number>(DEFAULT_LOSS_FACTOR);
  const [panelW, setPanelW] = useState<number>(DEFAULT_PANEL_W);
  const [pricePerW, setPricePerW] = useState<number>(PV_PRICE_PER_W_DEFAULT);

  const [permits, setPermits] = useState<number>(DEFAULT_PERMITS);
  const [interconnection, setInterconnection] = useState<number>(DEFAULT_INTERCONNECTION);
  const [miscFactor, setMiscFactor] = useState<number>(DEFAULT_MISC_FACTOR);

  // Battery sizing
  const [criticalKw, setCriticalKw] = useState<number>(1.5);
  const [backupHours, setBackupHours] = useState<number>(8);

  // OCR UI
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [ocrMsg, setOcrMsg] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("");

  const [rawDetectedValues, setRawDetectedValues] = useState<number[] | null>(null);
  const [commercialFlag, setCommercialFlag] = useState<boolean>(false);

  const [lastFileBlob, setLastFileBlob] = useState<Blob | null>(null);
  const [showManualCrop, setShowManualCrop] = useState(false);
  const [allowManualCrop, setAllowManualCrop] = useState(false);

  const fileInputCameraRef = useRef<HTMLInputElement | null>(null);
  const fileInputGalleryRef = useRef<HTMLInputElement | null>(null);

  function resetOcrOutputs() {
    setOcrConfidence(null);
    setOcrMsg("");
    setRawDetectedValues(null);
    setCommercialFlag(false);
    setAllowManualCrop(false);
  }

  async function runPipelineOnBlob(originalBlob: Blob, mode: "auto" | "manual") {
    setOcrBusy(true);
    setAllowManualCrop(false);
    setOcrMsg(mode === "auto" ? "Procesando OCR (auto-crop)..." : "Procesando OCR (recorte manual)...");

    try {
      const blobToOcr = mode === "auto" ? await autoCropLumaGraph(originalBlob) : originalBlob;
      const { text, confidence } = await runOcr(blobToOcr);
      setOcrConfidence(confidence);

      const parsed = extractConsumptionFromOcr(text);
      setCommercialFlag(Boolean(parsed.commercialFlag));

      if (parsed.ok && parsed.annualKwh && parsed.monthlyAvgKwh) {
        setAnnualKwh(Number(parsed.annualKwh.toFixed(0)));
        setMonthlyKwh(Number(parsed.monthlyAvgKwh.toFixed(2)));
        setMonthsUsedCount(parsed.monthsUsedCount || 0);
        setRawDetectedValues(parsed.monthlyValues || null);

        const used = parsed.monthsUsedCount || 0;
        const noteAnnual =
          used >= 12 ? "Anual (12m real)" : `Anual estimado (usando ${used} mes(es) y anualizando)`;

        setOcrMsg(
          `OK. ${noteAnnual}: ${formatNumber(parsed.annualKwh, 0)} kWh. Promedio mensual: ${formatNumber(parsed.monthlyAvgKwh, 2)} kWh.`
        );
      } else {
        setOcrMsg(`No pude leer la gráfica. ${parsed.reason || ""}`.trim());
        // Habilitar manual crop solo si falló el auto
        if (mode === "auto") setAllowManualCrop(true);
      }
    } catch (e: any) {
      setOcrMsg(`Error OCR: ${String(e?.message || e)}`);
      if (mode === "auto") setAllowManualCrop(true);
    } finally {
      setOcrBusy(false);
    }
  }

  async function handleFile(file?: File | null) {
    if (!file) return;

    resetOcrOutputs();

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setLastFileBlob(file);

    await runPipelineOnBlob(file, "auto");
  }

  // PV results
  const pvKw = useMemo(() => pvKwFromMonthlyKwh(monthlyKwh, psh, lossFactor, offsetPct), [
    monthlyKwh,
    psh,
    lossFactor,
    offsetPct,
  ]);

  const panelCount = useMemo(() => {
    const w = Math.max(1, panelW);
    return Math.ceil((pvKw * 1000) / w);
  }, [pvKw, panelW]);

  const basePvCost = useMemo(() => pvKw * 1000 * pricePerW, [pvKw, pricePerW]);
  const roofAdderCost = 0;
  const miscCost = useMemo(() => (basePvCost + roofAdderCost + permits + interconnection) * miscFactor, [
    basePvCost,
    roofAdderCost,
    permits,
    interconnection,
    miscFactor,
  ]);

  const pvTotalNoBattery = useMemo(
    () => basePvCost + roofAdderCost + permits + interconnection + miscCost,
    [basePvCost, roofAdderCost, permits, interconnection, miscCost]
  );

  // Battery recommendations
  const recommendedBatteryKwh = useMemo(() => {
    const needed = (criticalKw * backupHours) / BATTERY_USABLE_FACTOR;
    for (const kwh of BATTERY_OPTIONS) {
      if (kwh >= needed) return kwh;
    }
    return BATTERY_OPTIONS[BATTERY_OPTIONS.length - 1];
  }, [criticalKw, backupHours]);

  const batteryCards = useMemo(() => {
    const unique = Array.from(new Set([recommendedBatteryKwh, ...BATTERY_OPTIONS])).sort((a, b) => a - b);
    return unique.map((kwh) => {
      const battCost = kwh * SOLUNA_PRICE_PER_KWH;
      const total = pvTotalNoBattery + battCost;
      const estHours = (kwh * BATTERY_USABLE_FACTOR) / Math.max(0.5, criticalKw);
      return { kwh, battCost, total, estHours };
    });
  }, [recommendedBatteryKwh, pvTotalNoBattery, criticalKw]);

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: 16, fontFamily: "system-ui, Arial" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Sunsol • Cotizador (sin vendedor)</h1>
      <div style={{ color: "#555", marginBottom: 16 }}>
        PV: ${pricePerW.toFixed(2)}/W • Batería Soluna: ${SOLUNA_PRICE_PER_KWH}/kWh • Sin incentivos
      </div>

      {/* Uploader */}
      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Foto / Screenshot de LUMA (página 4)</h2>

        <div style={{ color: "#666", fontSize: 13, marginBottom: 10 }}>
          <b>Instrucciones:</b> Usa la <b>página 4</b> de LUMA donde aparece la gráfica{" "}
          <b>“CONSUMPTION HISTORY (KWH)”</b> (o “Historial de consumo”). Toma la foto <b>completa</b> de la página (sin recortar),
          nítida y sin reflejos.
        </div>

        {/* Ejemplo (opcional). Coloca un archivo en /public/luma-example.png */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>Ejemplo:</div>
          <img
            src="/luma-example.png"
            alt="Ejemplo LUMA página 4"
            style={{ width: "100%", maxHeight: 320, objectFit: "contain", borderRadius: 12, border: "1px solid #eee" }}
            onError={(e) => {
              // si no existe, no rompas UI
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button
            onClick={() => fileInputCameraRef.current?.click()}
            disabled={ocrBusy}
            style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", background: "white" }}
          >
            📷 Tomar foto
          </button>
          <button
            onClick={() => fileInputGalleryRef.current?.click()}
            disabled={ocrBusy}
            style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", background: "white" }}
          >
            🖼️ Subir de galería
          </button>

          {allowManualCrop && lastFileBlob && (
            <button
              onClick={() => setShowManualCrop(true)}
              disabled={ocrBusy}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #00a77a", background: "#00a77a", color: "white" }}
            >
              ✂️ Recortar (manual)
            </button>
          )}
        </div>

        {/* hidden inputs */}
        <input
          ref={fileInputCameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => handleFile(e.target.files?.[0] || null)}
        />
        <input
          ref={fileInputGalleryRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => handleFile(e.target.files?.[0] || null)}
        />

        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: "#666" }}>Consumo mensual promedio (kWh/mes)</label>
            <input
              value={monthlyKwh || ""}
              onChange={(e) => setMonthlyKwh(Number(e.target.value || 0))}
              inputMode="decimal"
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 10,
                border: "1px solid #ddd",
                fontSize: 16,
              }}
            />
            <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
              Si el OCR falla, escribe el promedio mensual aquí.
            </div>

            <div style={{ marginTop: 10, fontSize: 13 }}>
              <b>Consumo anual:</b> {annualKwh ? `${formatNumber(annualKwh)} kWh` : "—"}
              {monthsUsedCount > 0 && (
                <span style={{ color: "#666" }}>
                  {" "}
                  (usó {monthsUsedCount} mes(es){monthsUsedCount >= 12 ? "" : ", anualizado"})
                </span>
              )}
            </div>

            {ocrConfidence !== null && (
              <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>OCR confianza: {ocrConfidence.toFixed(1)}%</div>
            )}

            {commercialFlag && (
              <div style={{ marginTop: 8, fontSize: 13, color: "#b45309" }}>
                ⚠️ Detecté valores fuera de rango (&gt; {KWH_MAX}). Posible caso comercial: requiere otro estimado.
              </div>
            )}

            {ocrMsg && (
              <div style={{ marginTop: 8, fontSize: 13, color: ocrMsg.startsWith("OK") ? "#0a7" : "#a00" }}>{ocrMsg}</div>
            )}
          </div>

          <div>
            {previewUrl ? (
              <div>
                <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>Preview</div>
                <img
                  src={previewUrl}
                  alt="preview"
                  style={{ width: "100%", borderRadius: 12, border: "1px solid #eee" }}
                />
              </div>
            ) : (
              <div style={{ color: "#888", fontSize: 13, border: "1px dashed #ddd", borderRadius: 12, padding: 16 }}>
                No hay imagen todavía.
              </div>
            )}
          </div>
        </div>

        {rawDetectedValues && (
          <div style={{ marginTop: 12, fontSize: 12, color: "#666" }}>
            Valores detectados (orden OCR aprox): {rawDetectedValues.join(", ")}
          </div>
        )}
      </section>

      {/* Supuestos */}
      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Supuestos del sistema</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(220px, 1fr))", gap: 12 }}>
          <Field label="Offset (%)" value={offsetPct} onChange={setOffsetPct} />
          <Field label="PSH" value={psh} onChange={setPsh} />
          <Field label="Pérdidas (factor)" value={lossFactor} onChange={setLossFactor} step="0.01" />
          <Field label="Panel (W)" value={panelW} onChange={setPanelW} />
          <Field label="Permisos (est.)" value={permits} onChange={setPermits} />
          <Field label="Interconexión (est.)" value={interconnection} onChange={setInterconnection} />
          <Field label="Precio instalado ($/W)" value={pricePerW} onChange={setPricePerW} step="0.01" />
          <Field label="Misceláneo (factor)" value={miscFactor} onChange={setMiscFactor} step="0.01" />
        </div>
      </section>

      {/* Resultados PV */}
      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Resultado PV</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(220px, 1fr))", gap: 12 }}>
          <Stat label="Consumo mensual (prom.)" value={`${formatNumber(monthlyKwh, 2)} kWh`} />
          <Stat label="Sistema recomendado" value={`${formatNumber(pvKw, 2)} kW`} sub={`${panelCount} paneles (est.)`} />
          <Stat label="PV (sin batería)" value={formatMoney(pvTotalNoBattery)} />
        </div>

        <div style={{ marginTop: 10, fontSize: 13, color: "#666" }}>
          * Estimado preliminar. Validación final requiere inspección.
        </div>
      </section>

      {/* Batería */}
      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Batería</h2>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(220px, 1fr))", gap: 12, marginBottom: 12 }}>
          <Field label="Cargas críticas (kW típico)" value={criticalKw} onChange={setCriticalKw} step="0.1" />
          <Field label="Horas de respaldo" value={backupHours} onChange={setBackupHours} step="1" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(220px, 1fr))", gap: 12 }}>
          {batteryCards.map((b) => (
            <div key={b.kwh} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <b>{b.kwh} kWh</b>
                {b.kwh === recommendedBatteryKwh && (
                  <span style={{ fontSize: 12, color: "#0a7", border: "1px solid #0a7", padding: "2px 8px", borderRadius: 999 }}>
                    Recomendado
                  </span>
                )}
              </div>
              <div style={{ marginTop: 8, fontSize: 13 }}>
                Batería: {formatMoney(b.battCost)}
                <br />
                Total PV + Batería: <b>{formatMoney(b.total)}</b>
                <br />
                Respaldo est.: {formatNumber(b.estHours, 1)} hrs
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Manual crop modal */}
      <CropModal
        open={showManualCrop}
        imageBlob={lastFileBlob}
        onCancel={() => setShowManualCrop(false)}
        onConfirm={async (cropped) => {
          setShowManualCrop(false);
          // Reintento OCR con recorte manual (sin auto-crop)
          await runPipelineOnBlob(cropped, "manual");
        }}
      />
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: string;
}) {
  return (
    <div>
      <label style={{ fontSize: 12, color: "#666" }}>{label}</label>
      <input
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Number(e.target.value || 0))}
        inputMode="decimal"
        step={step || "1"}
        style={{
          width: "100%",
          padding: 10,
          borderRadius: 10,
          border: "1px solid #ddd",
          fontSize: 16,
        }}
      />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
