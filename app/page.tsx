"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * LUMA pág. 4 – CONSUMPTION HISTORY (KWH)
 * Enfoque (SIN recorte manual):
 * 1) Auto-crop amplio de la zona donde normalmente está la gráfica (no depende del eje Y).
 * 2) Detecta barras por densidad de pixeles oscuros (visión, no OCR).
 * 3) Para cada barra, recorta SOLO la franja arriba de la barra (donde está el numerito).
 * 4) OCR por barra (números 20–3000).
 * 5) Usa los 12 más recientes (más a la derecha). Si hay menos de 4: falla y pide input manual.
 */

const PV_PRICE_PER_W = 2.3;
const SOLUNA_PRICE_PER_KWH = 350;

const BATTERY_SIZES = [5, 10, 16, 20, 32, 40] as const;

type BarSegment = {
  x0: number;
  x1: number;
  cx: number;
};

type OcrBar = {
  x: number; // 0..1 dentro de chart
  value: number | null;
  conf: number; // 0..100
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function formatMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
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

function canvasFromImage(img: HTMLImageElement, maxWidth = 1700): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const scale = img.width > maxWidth ? maxWidth / img.width : 1;
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function canvasToDataUrl(c: HTMLCanvasElement, quality = 0.92) {
  return c.toDataURL("image/jpeg", quality);
}

function cropPercent(full: HTMLCanvasElement, topPct: number, bottomPct: number, leftPct: number, rightPct: number) {
  const W = full.width;
  const H = full.height;
  const y0 = Math.round(H * topPct);
  const y1 = Math.round(H * bottomPct);
  const x0 = Math.round(W * leftPct);
  const x1 = Math.round(W * rightPct);

  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(full, x0, y0, w, h, 0, 0, w, h);
  return c;
}

/**
 * Prepro OCR:
 * - grayscale
 * - threshold para que los numeritos queden negros y el resto blanco
 * IMPORTANTE: esto se usa en ROIs pequeñas (arriba de cada barra), no en el chart completo.
 */
function preprocessForDigits(src: HTMLCanvasElement, threshold = 185): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0);

  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    let y = 0.299 * r + 0.587 * g + 0.114 * b;

    // threshold binario
    const v = y < threshold ? 0 : 255;

    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return c;
}

function scaleCanvas(src: HTMLCanvasElement, scale = 3): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const ctx = c.getContext("2d")!;
  // para que engorde un poco el stroke de los dígitos
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * Detecta barras por densidad vertical de pixeles “oscuros”.
 * - Excluye margen izquierdo (eje Y) por posición.
 * - No depende de los números del eje.
 */
function detectBars(chart: HTMLCanvasElement): BarSegment[] {
  const ctx = chart.getContext("2d")!;
  const W = chart.width;
  const H = chart.height;

  // Zona útil: excluye eje Y (margen izq) y algo de títulos
  const xStart = Math.round(W * 0.12);
  const xEnd = Math.round(W * 0.995);
  const yStart = Math.round(H * 0.08);
  const yEnd = Math.round(H * 0.95);

  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  // Cuenta pixeles “no blancos” por columna
  const col = new Array<number>(W).fill(0);

  // Threshold suave para capturar barras grises (y NO depender del eje)
  const darkTh = 215; // mientras más alto, más “detecta” grises

  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const i = (y * W + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const yv = 0.299 * r + 0.587 * g + 0.114 * b;
      if (yv < darkTh) col[x] += 1;
    }
  }

  // Suaviza (moving average)
  const smooth = new Array<number>(W).fill(0);
  const win = 6;
  for (let x = 0; x < W; x++) {
    let s = 0;
    let c = 0;
    for (let k = -win; k <= win; k++) {
      const xx = x + k;
      if (xx >= 0 && xx < W) {
        s += col[xx];
        c += 1;
      }
    }
    smooth[x] = s / Math.max(1, c);
  }

  // Umbral dinámico (los gridlines son finos → score bajo; barras → score alto)
  let maxV = 0;
  for (let x = xStart; x < xEnd; x++) maxV = Math.max(maxV, smooth[x]);

  const th = Math.max(40, maxV * 0.42);

  // Segmenta columnas "activas"
  const segments: BarSegment[] = [];
  let inSeg = false;
  let seg0 = 0;

  for (let x = xStart; x < xEnd; x++) {
    const active = smooth[x] >= th;
    if (active && !inSeg) {
      inSeg = true;
      seg0 = x;
    }
    if (!active && inSeg) {
      const seg1 = x - 1;
      inSeg = false;

      const w = seg1 - seg0 + 1;
      // filtros de ancho razonable para barras
      if (w >= 6 && w <= Math.round(W * 0.12)) {
        segments.push({ x0: seg0, x1: seg1, cx: (seg0 + seg1) / 2 });
      }
    }
  }
  if (inSeg) {
    const seg1 = xEnd - 1;
    const w = seg1 - seg0 + 1;
    if (w >= 6 && w <= Math.round(W * 0.12)) segments.push({ x0: seg0, x1: seg1, cx: (seg0 + seg1) / 2 });
  }

  // A veces detecta una barra partida; merge si están muy cerca
  const merged: BarSegment[] = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(s);
      continue;
    }
    if (s.x0 - last.x1 <= 4) {
      // merge
      const x0 = last.x0;
      const x1 = s.x1;
      merged[merged.length - 1] = { x0, x1, cx: (x0 + x1) / 2 };
    } else {
      merged.push(s);
    }
  }

  return merged;
}

/**
 * Encuentra el top (y) de la barra: primera fila donde el área del segmento tiene suficiente “oscuro”.
 * Esto permite recortar arriba de cada barra para capturar SOLO el numerito.
 */
function findBarTopY(chart: HTMLCanvasElement, seg: BarSegment): number | null {
  const ctx = chart.getContext("2d")!;
  const W = chart.width;
  const H = chart.height;

  const x0 = seg.x0;
  const x1 = seg.x1;
  const w = x1 - x0 + 1;

  const yStart = Math.round(H * 0.08);
  const yEnd = Math.round(H * 0.95);

  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  const darkTh = 215;

  for (let y = yStart; y < yEnd; y++) {
    let darkCount = 0;
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const yv = 0.299 * r + 0.587 * g + 0.114 * b;
      if (yv < darkTh) darkCount += 1;
    }
    // si en esa fila hay suficiente “oscuro”, probablemente empezó la barra
    if (darkCount >= Math.max(3, Math.round(w * 0.35))) {
      return y;
    }
  }

  return null;
}

/**
 * Construye ROIs (franjita arriba de cada barra) + un preview strip.
 */
function buildLabelRois(chart: HTMLCanvasElement, segments: BarSegment[]) {
  const W = chart.width;
  const H = chart.height;

  const rois: { canvas: HTMLCanvasElement; xNorm: number }[] = [];

  const padX = 10;
  const roiHeight = Math.round(H * 0.16); // franja arriba (proporcional al chart)
  const gapAboveBar = 4; // evita tocar la barra

  for (const s of segments) {
    const topY = findBarTopY(chart, s);
    if (topY == null) continue;

    const x0 = clamp(s.x0 - padX, 0, W - 1);
    const x1 = clamp(s.x1 + padX, 0, W - 1);

    const y1 = clamp(topY - gapAboveBar, 0, H - 1);
    const y0 = clamp(y1 - roiHeight, 0, H - 1);

    const w = Math.max(1, x1 - x0 + 1);
    const h = Math.max(1, y1 - y0 + 1);

    // ROI original
    const roi = document.createElement("canvas");
    roi.width = w;
    roi.height = h;
    roi.getContext("2d")!.drawImage(chart, x0, y0, w, h, 0, 0, w, h);

    // Scale up + binariza para OCR
    const scaled = scaleCanvas(roi, 3);
    const pre = preprocessForDigits(scaled, 185);

    rois.push({ canvas: pre, xNorm: s.cx / W });
  }

  // Preview strip (solo para ver lo que realmente OCR está leyendo)
  const cellH = rois.length ? rois[0].canvas.height : 1;
  const cellW = rois.length ? rois[0].canvas.width : 1;
  const strip = document.createElement("canvas");
  strip.width = Math.max(1, rois.length * (cellW + 14) + 14);
  strip.height = Math.max(1, cellH + 14);
  const sctx = strip.getContext("2d")!;
  sctx.fillStyle = "white";
  sctx.fillRect(0, 0, strip.width, strip.height);

  rois.forEach((r, idx) => {
    const x = 7 + idx * (cellW + 14);
    const y = 7;
    sctx.drawImage(r.canvas, x, y);
  });

  return { rois, strip };
}

/**
 * Import de tesseract.js compatible con varias versiones.
 */
async function loadTesseractModule() {
  const mod: any = await import("tesseract.js");
  const createWorker = mod?.createWorker ?? mod?.default?.createWorker;
  const recognize = mod?.recognize ?? mod?.default?.recognize;
  return { createWorker, recognize };
}

function bestNumberFromTessData(data: any) {
  const words = (data?.words ?? []) as Array<{ text: string; confidence: number }>;
  const candidates: { value: number; conf: number }[] = [];

  for (const w of words) {
    const cleaned = (w.text ?? "").replace(/[^\d]/g, "");
    if (!cleaned) continue;
    if (cleaned.length < 2 || cleaned.length > 4) continue;

    const val = parseInt(cleaned, 10);
    if (!Number.isFinite(val)) continue;
    if (val < 20 || val > 3000) continue;

    candidates.push({ value: val, conf: w.confidence ?? 0 });
  }

  // fallback usando text completo
  if (!candidates.length) {
    const t = (data?.text ?? "") as string;
    const matches = t.match(/\d{2,4}/g) ?? [];
    for (const m of matches) {
      const val = parseInt(m, 10);
      if (!Number.isFinite(val)) continue;
      if (val < 20 || val > 3000) continue;
      candidates.push({ value: val, conf: data?.confidence ?? 0 });
    }
  }

  if (!candidates.length) return { value: null as number | null, conf: 0 };

  candidates.sort((a, b) => b.conf - a.conf);
  return { value: candidates[0].value, conf: candidates[0].conf };
}

/**
 * OCR por barra (ROI por barra) usando UN worker para todo.
 */
async function ocrBars(rois: { canvas: HTMLCanvasElement; xNorm: number }[]) {
  const { createWorker, recognize } = await loadTesseractModule();

  // Preferimos worker para rendimiento
  if (typeof createWorker === "function") {
    const worker = await createWorker();

    if (typeof worker.load === "function") await worker.load();
    if (typeof worker.loadLanguage === "function") await worker.loadLanguage("eng");
    if (typeof worker.initialize === "function") await worker.initialize("eng");
    else if (typeof worker.reinitialize === "function") await worker.reinitialize("eng");

    if (typeof worker.setParameters === "function") {
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789",
        tessedit_pageseg_mode: "7", // single line (cada ROI es una “línea”)
        user_defined_dpi: "300",
      });
    }

    const out: OcrBar[] = [];
    for (const r of rois) {
      const res = await worker.recognize(r.canvas);
      const best = bestNumberFromTessData(res?.data);
      out.push({ x: r.xNorm, value: best.value, conf: best.conf });
    }

    if (typeof worker.terminate === "function") await worker.terminate();
    return out;
  }

  // Fallback (más lento): recognize directo
  if (typeof recognize === "function") {
    const out: OcrBar[] = [];
    for (const r of rois) {
      const res = await recognize(r.canvas, "eng", {
        tessedit_char_whitelist: "0123456789",
      });
      const best = bestNumberFromTessData(res?.data);
      out.push({ x: r.xNorm, value: best.value, conf: best.conf });
    }
    return out;
  }

  throw new Error("No se pudo cargar tesseract.js (createWorker/recognize no disponible).");
}

export default function Page() {
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const [rawImageUrl, setRawImageUrl] = useState<string | null>(null);
  const [chartPreviewUrl, setChartPreviewUrl] = useState<string | null>(null);
  const [stripPreviewUrl, setStripPreviewUrl] = useState<string | null>(null);

  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  const [monthlyKwh, setMonthlyKwh] = useState<number>(0);

  const [ocrMonthlyAvg, setOcrMonthlyAvg] = useState<number>(0);
  const [ocrAnnual, setOcrAnnual] = useState<number>(0);
  const [ocrMonthsUsed, setOcrMonthsUsed] = useState<number>(0);
  const [ocrConfidence, setOcrConfidence] = useState<number>(0);

  const [valuesDetectedAll, setValuesDetectedAll] = useState<number[]>([]);
  const [valuesUsed12, setValuesUsed12] = useState<number[]>([]);
  const [commercialFlag, setCommercialFlag] = useState<boolean>(false);

  // Assumptions PV
  const [offsetPct, setOffsetPct] = useState<number>(90);
  const [psh, setPsh] = useState<number>(5);
  const [lossFactor, setLossFactor] = useState<number>(0.8);
  const [panelW, setPanelW] = useState<number>(450);

  const [permits, setPermits] = useState<number>(1200);
  const [interconnection, setInterconnection] = useState<number>(450);
  const [miscPct, setMiscPct] = useState<number>(3);

  const [backupHours, setBackupHours] = useState<number>(8);
  const [criticalKw, setCriticalKw] = useState<number>(1.5);

  // Si OCR da promedio, úsalo como input
  useEffect(() => {
    if (ocrMonthlyAvg > 0) setMonthlyKwh(round2(ocrMonthlyAvg));
  }, [ocrMonthlyAvg]);

  const monthlyForSizing = useMemo(() => Math.max(0, monthlyKwh || 0), [monthlyKwh]);

  const pvKwRecommended = useMemo(() => {
    const targetMonthly = monthlyForSizing * (offsetPct / 100);
    const kwhPerKwMonth = Math.max(0.1, psh * 30 * lossFactor);
    return targetMonthly / kwhPerKwMonth;
  }, [monthlyForSizing, offsetPct, psh, lossFactor]);

  const pvWattsRecommended = useMemo(() => pvKwRecommended * 1000, [pvKwRecommended]);

  const panelsCount = useMemo(() => {
    if (!panelW) return 0;
    return Math.ceil(pvWattsRecommended / panelW);
  }, [pvWattsRecommended, panelW]);

  const basePvCost = useMemo(() => {
    const pvCost = pvWattsRecommended * PV_PRICE_PER_W;
    const misc = (pvCost * miscPct) / 100;
    return pvCost + misc + permits + interconnection;
  }, [pvWattsRecommended, miscPct, permits, interconnection]);

  const batteryCards = useMemo(() => {
    const usableFactor = 0.9;
    const requiredKwhNominal = (criticalKw * backupHours) / usableFactor;
    const sorted = [...BATTERY_SIZES].sort((a, b) => a - b);
    const recommended = sorted.find((k) => k >= requiredKwhNominal) ?? sorted[sorted.length - 1];

    return sorted.map((kwh) => {
      const battCost = kwh * SOLUNA_PRICE_PER_KWH;
      const total = basePvCost + battCost;
      const estHours = (kwh * usableFactor) / Math.max(0.5, criticalKw);
      return { kwh, battCost, total, estHours, isRecommended: kwh === recommended };
    });
  }, [basePvCost, backupHours, criticalKw]);

  async function handleFile(file: File) {
    setOcrError(null);
    setCommercialFlag(false);
    setValuesDetectedAll([]);
    setValuesUsed12([]);
    setOcrMonthlyAvg(0);
    setOcrAnnual(0);
    setOcrConfidence(0);
    setOcrMonthsUsed(0);

    const img = await loadImageFromFile(file);
    const full = canvasFromImage(img, 1700);

    setRawImageUrl(canvasToDataUrl(full));

    // Auto-crop amplio en la zona inferior/media donde vive la gráfica
    // (si incluyes un poco de más, NO pasa nada: barras detection filtra)
    const chart = cropPercent(full, 0.42, 0.93, 0.02, 0.99);
    setChartPreviewUrl(canvasToDataUrl(chart));

    // Detectar barras por visión
    const segments = detectBars(chart);

    // Construir ROIs (arriba de cada barra)
    const { rois, strip } = buildLabelRois(chart, segments);
    setStripPreviewUrl(canvasToDataUrl(strip));

    setOcrBusy(true);
    try {
      if (rois.length < 4) {
        setOcrError("No pude detectar suficientes barras. Asegúrate que sea la página 4 completa y nítida.");
        return;
      }

      // OCR por barra
      const bars = await ocrBars(rois);

      // Orden por X (izq→der)
      bars.sort((a, b) => a.x - b.x);

      const detectedVals = bars.map((b) => b.value).filter((v): v is number => typeof v === "number");
      setValuesDetectedAll(detectedVals);

      // 12 más recientes (derecha)
      const numericBars = bars.filter((b) => typeof b.value === "number") as Array<OcrBar & { value: number }>;
      const used = numericBars.length > 12 ? numericBars.slice(numericBars.length - 12) : numericBars;

      if (used.length < 4) {
        setOcrError("OCR insuficiente: se detectaron menos de 4 meses. Toma la foto más nítida y completa.");
        return;
      }

      // Comercial flag
      const hasOver3000 = used.some((u) => u.value > 3000);
      setCommercialFlag(hasOver3000);

      const valuesUsed = used.map((u) => u.value);
      setValuesUsed12(valuesUsed);

      const sum = valuesUsed.reduce((a, b) => a + b, 0);
      const monthsUsed = valuesUsed.length;

      const monthlyAvg = sum / monthsUsed;
      const annual = monthlyAvg * 12;

      const avgConf = used.reduce((a, b) => a + (b.conf ?? 0), 0) / monthsUsed;

      setOcrMonthsUsed(monthsUsed);
      setOcrMonthlyAvg(round2(monthlyAvg));
      setOcrAnnual(round2(annual));
      setOcrConfidence(round2(avgConf));
    } catch (e: any) {
      setOcrError(e?.message ?? "Error de OCR");
    } finally {
      setOcrBusy(false);
    }
  }

  function onPickCamera() {
    cameraInputRef.current?.click();
  }
  function onPickGallery() {
    galleryInputRef.current?.click();
  }

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="flex flex-col gap-2">
          <div className="text-2xl font-semibold">Sunsol · Cotizador (sin vendedor)</div>
          <div className="text-sm text-neutral-600">
            PV: ${PV_PRICE_PER_W.toFixed(2)}/W · Batería Soluna: ${SOLUNA_PRICE_PER_KWH}/kWh · Sin incentivos
          </div>
          <div className="text-xs text-neutral-500">Estimado preliminar. Validación final requiere inspección.</div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Uploader */}
          <div className="rounded-2xl border border-neutral-200 p-4 shadow-sm">
            <div className="text-lg font-semibold">Foto / Screenshot de LUMA (página 4)</div>
            <div className="mt-2 text-sm text-neutral-600">
              Usa la página 4 donde aparece <span className="font-medium">“CONSUMPTION HISTORY (KWH)”</span>. Toma la{" "}
              <span className="font-medium">página completa</span>, nítida y sin reflejos.
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onPickCamera}
                className="rounded-xl bg-black px-4 py-2 text-sm font-medium text-white"
              >
                📷 Tomar foto
              </button>
              <button
                type="button"
                onClick={onPickGallery}
                className="rounded-xl border border-neutral-300 bg-white px-4 py-2 text-sm font-medium"
              >
                🖼️ Subir de galería
              </button>

              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) await handleFile(f);
                  e.currentTarget.value = "";
                }}
              />
              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) await handleFile(f);
                  e.currentTarget.value = "";
                }}
              />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-neutral-200 p-3">
                <div className="text-xs font-medium text-neutral-600">Consumo mensual promedio (kWh/mes)</div>
                <input
                  value={monthlyKwh || ""}
                  onChange={(e) => setMonthlyKwh(parseFloat(e.target.value || "0"))}
                  inputMode="decimal"
                  placeholder="Ej. 600"
                  className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                />
                <div className="mt-2 text-xs text-neutral-500">
                  Si el OCR falla, escribe el promedio mensual aquí.
                </div>

                <div className="mt-3 text-xs text-neutral-700">
                  {ocrBusy ? (
                    <span className="text-neutral-500">Procesando OCR…</span>
                  ) : (
                    <>
                      <div>
                        <span className="font-medium">Consumo anual:</span>{" "}
                        {ocrAnnual > 0 ? `${Math.round(ocrAnnual).toLocaleString()} kWh` : "—"}{" "}
                        <span className="text-neutral-500">
                          ({ocrMonthsUsed > 0 ? `usó ${ocrMonthsUsed} mes(es)` : "sin OCR"})
                        </span>
                      </div>
                      <div>
                        <span className="font-medium">OCR confianza:</span>{" "}
                        {ocrConfidence > 0 ? `${ocrConfidence}%` : "—"}
                      </div>
                      {commercialFlag && (
                        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          ⚠️ Se detectó un mes &gt; 3000 kWh. Probable caso comercial (requiere estimado distinto).
                        </div>
                      )}
                    </>
                  )}
                </div>

                {ocrError && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {ocrError}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-neutral-200 p-3">
                <div className="text-xs font-medium text-neutral-600">Preview</div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-neutral-200 p-1">
                    <div className="px-1 pb-1 text-[10px] text-neutral-500">Página (raw)</div>
                    {rawImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img alt="raw" src={rawImageUrl} className="h-28 w-full rounded-md object-cover" />
                    ) : (
                      <div className="flex h-28 items-center justify-center rounded-md bg-neutral-50 text-xs text-neutral-400">
                        —
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-neutral-200 p-1">
                    <div className="px-1 pb-1 text-[10px] text-neutral-500">Auto-crop (zona gráfica)</div>
                    {chartPreviewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img alt="chart" src={chartPreviewUrl} className="h-28 w-full rounded-md object-cover" />
                    ) : (
                      <div className="flex h-28 items-center justify-center rounded-md bg-neutral-50 text-xs text-neutral-400">
                        —
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-2 rounded-lg border border-neutral-200 p-1">
                  <div className="px-1 pb-1 text-[10px] text-neutral-500">
                    Lo que OCR realmente lee (ROIs arriba de barras)
                  </div>
                  {stripPreviewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="strip" src={stripPreviewUrl} className="h-20 w-full rounded-md object-contain bg-white" />
                  ) : (
                    <div className="flex h-20 items-center justify-center rounded-md bg-neutral-50 text-xs text-neutral-400">
                      —
                    </div>
                  )}
                </div>

                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-700">
                    Debug OCR (detectados / usados)
                  </summary>
                  <div className="mt-2 text-xs text-neutral-600">
                    <div>
                      <span className="font-medium">Detectados:</span>{" "}
                      {valuesDetectedAll.length ? valuesDetectedAll.join(", ") : "—"}
                    </div>
                    <div className="mt-1">
                      <span className="font-medium">Usados (12 más recientes):</span>{" "}
                      {valuesUsed12.length ? valuesUsed12.join(", ") : "—"}
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </div>

          {/* Supuestos */}
          <div className="rounded-2xl border border-neutral-200 p-4 shadow-sm">
            <div className="text-lg font-semibold">Supuestos del sistema</div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-medium text-neutral-600">Offset (%)</div>
                <input
                  value={offsetPct}
                  onChange={(e) => setOffsetPct(parseFloat(e.target.value || "0"))}
                  inputMode="decimal"
                  className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-600">PSH</div>
                <input
                  value={psh}
                  onChange={(e) => setPsh(parseFloat(e.target.value || "0"))}
                  inputMode="decimal"
                  className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-600">Pérdidas (factor)</div>
                <input
                  value={lossFactor}
                  onChange={(e) => setLossFactor(parseFloat(e.target.value || "0"))}
                  inputMode="decimal"
                  className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-600">Panel (W)</div>
                <input
                  value={panelW}
                  onChange={(e) => setPanelW(parseFloat(e.target.value || "0"))}
                  inputMode="decimal"
                  className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-600">Permisos (est.)</div>
                <input
                  value={permits}
                  onChange={(e) => setPermits(parseFloat(e.target.value || "0"))}
                  inputMode="decimal"
                  className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-600">Interconexión (est.)</div>
                <input
                  value={interconnection}
                  onChange={(e) => setInterconnection(parseFloat(e.target.value || "0"))}
                  inputMode="decimal"
                  className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-600">Misceláneo (%)</div>
                <input
                  value={miscPct}
                  onChange={(e) => setMiscPct(parseFloat(e.target.value || "0"))}
                  inputMode="decimal"
                  className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="mt-5 rounded-xl bg-neutral-50 p-3">
              <div className="text-sm font-semibold">Resultado PV</div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-white p-3">
                  <div className="text-[11px] text-neutral-500">Consumo mensual</div>
                  <div className="mt-1 text-lg font-semibold">
                    {monthlyForSizing ? `${round2(monthlyForSizing)} kWh` : "—"}
                  </div>
                </div>
                <div className="rounded-lg bg-white p-3">
                  <div className="text-[11px] text-neutral-500">Sistema recomendado</div>
                  <div className="mt-1 text-lg font-semibold">
                    {monthlyForSizing ? `${round2(pvKwRecommended)} kW` : "—"}
                  </div>
                  <div className="text-[11px] text-neutral-500">
                    {monthlyForSizing ? `${panelsCount} paneles (est.)` : ""}
                  </div>
                </div>
                <div className="rounded-lg bg-white p-3">
                  <div className="text-[11px] text-neutral-500">PV (sin batería)</div>
                  <div className="mt-1 text-lg font-semibold">{monthlyForSizing ? formatMoney(basePvCost) : "—"}</div>
                </div>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-neutral-200 p-3">
              <div className="text-sm font-semibold">Batería</div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-medium text-neutral-600">Horas de respaldo</div>
                  <select
                    value={backupHours}
                    onChange={(e) => setBackupHours(parseFloat(e.target.value))}
                    className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                  >
                    {[4, 6, 8, 10, 12].map((h) => (
                      <option key={h} value={h}>
                        {h} horas
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs font-medium text-neutral-600">Cargas críticas (kW)</div>
                  <select
                    value={criticalKw}
                    onChange={(e) => setCriticalKw(parseFloat(e.target.value))}
                    className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                  >
                    {[1, 1.5, 2, 3, 5].map((k) => (
                      <option key={k} value={k}>
                        {k} kW (típico)
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {batteryCards.map((b) => (
                  <div
                    key={b.kwh}
                    className={`rounded-xl border p-3 ${
                      b.isRecommended ? "border-emerald-300 bg-emerald-50" : "border-neutral-200 bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold">{b.kwh} kWh</div>
                      {b.isRecommended ? (
                        <span className="rounded-full bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white">
                          Recomendado
                        </span>
                      ) : (
                        <span className="text-[10px] text-neutral-500">Opción</span>
                      )}
                    </div>
                    <div className="mt-2 text-xs text-neutral-700">Total (PV + batería): {formatMoney(b.total)}</div>
                    <div className="mt-1 text-[11px] text-neutral-600">
                      Horas est. a {criticalKw} kW: <span className="font-medium">{round2(b.estHours)} h</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 text-xs text-neutral-500">
              Cómo se calcula consumo mensual desde la foto: se leen los numeritos arriba de las barras, se toman los{" "}
              <span className="font-medium">12 más recientes</span>, se promedia (kWh/mes) y anual = promedio × 12. Si hay
              menos de 12 meses disponibles, se usa lo que haya (mín. 4) y se extrapola a 12.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
