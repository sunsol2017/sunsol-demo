"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Sunsol – Cotizador (sin vendedor)
 *
 * OCR LUMA pág. 4 (Consumption History):
 * - Auto-crop por defecto (heurístico)
 * - Descarta eje Y por posición (margen izquierdo) aunque cambien sus números
 * - Considera SOLO números arriba de las barras
 * - Rango candidatos: 20–3000
 * - Usa los 12 más recientes (derecha → izquierda)
 * - Si faltan meses: usa >=4 y anual = (sum/meses)*12
 * - Botón “Recortar (manual)” (sliders) solo para afinar si OCR falla
 *
 * Requisito:
 *   npm i tesseract.js
 */

const PV_PRICE_PER_W = 2.30;
const SOLUNA_PRICE_PER_KWH = 350;

const BATTERY_SIZES = [5, 10, 16, 20, 32, 40] as const;

type OcrPick = {
  value: number;
  conf: number; // 0..100
  x: number; // 0..1
  y: number; // 0..1
};

type CropParams = {
  // full → chart
  chartTopPct: number;
  chartBottomPct: number;
  chartLeftPct: number;
  chartRightPct: number;

  // chart → labels band
  labelsLeftPct: number;
  labelsRightPct: number;
  labelsTopPct: number;
  labelsBottomPct: number;
};

const DEFAULT_AUTO_CROP: CropParams = {
  // Más abajo en la página (pág 4 suele tener la gráfica en el tercio inferior)
  chartTopPct: 0.56,
  chartBottomPct: 0.98,
  chartLeftPct: 0.03,
  chartRightPct: 0.99,

  // Dentro del chart:
  // - elimina eje Y (izquierda)
  // - incluye la zona donde están los numeritos encima de las barras (banda amplia)
  labelsLeftPct: 0.16,
  labelsRightPct: 0.995,
  labelsTopPct: 0.12,
  labelsBottomPct: 0.82,
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

/**
 * Pre-procesamiento simple para OCR:
 * - grayscale
 * - contraste leve
 * - threshold binario (para que los números “salten”)
 */
function preprocessForOcr(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0);

  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;

  // Ajustes (puedes afinar)
  const contrast = 1.25; // 1.0 = no change
  const threshold = 170; // 0..255

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];

    // grayscale
    let y = 0.299 * r + 0.587 * g + 0.114 * b;

    // contrast
    y = (y - 128) * contrast + 128;
    y = clamp(y, 0, 255);

    // threshold
    const v = y >= threshold ? 255 : 0;

    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return c;
}

function cropWithParams(full: HTMLCanvasElement, p: CropParams) {
  const W = full.width;
  const H = full.height;

  const chartTop = Math.round(H * p.chartTopPct);
  const chartBottom = Math.round(H * p.chartBottomPct);
  const chartLeft = Math.round(W * p.chartLeftPct);
  const chartRight = Math.round(W * p.chartRightPct);

  const chartW = Math.max(1, chartRight - chartLeft);
  const chartH = Math.max(1, chartBottom - chartTop);

  const chart = document.createElement("canvas");
  chart.width = chartW;
  chart.height = chartH;
  chart.getContext("2d")!.drawImage(full, chartLeft, chartTop, chartW, chartH, 0, 0, chartW, chartH);

  const cw = chart.width;
  const ch = chart.height;

  const labelsLeft = Math.round(cw * p.labelsLeftPct);
  const labelsRight = Math.round(cw * p.labelsRightPct);
  const labelsTop = Math.round(ch * p.labelsTopPct);
  const labelsBottom = Math.round(ch * p.labelsBottomPct);

  const lw = Math.max(1, labelsRight - labelsLeft);
  const lh = Math.max(1, labelsBottom - labelsTop);

  const labels = document.createElement("canvas");
  labels.width = lw;
  labels.height = lh;
  labels.getContext("2d")!.drawImage(chart, labelsLeft, labelsTop, lw, lh, 0, 0, lw, lh);

  return {
    chartCanvas: chart,
    labelsCanvas: labels,
  };
}

/**
 * Import de tesseract.js compatible con varias versiones (ESM/CJS):
 * - mod.createWorker o mod.default.createWorker
 * - mod.recognize o mod.default.recognize
 */
async function loadTesseractModule() {
  const mod: any = await import("tesseract.js");
  const createWorker = mod?.createWorker ?? mod?.default?.createWorker;
  const recognize = mod?.recognize ?? mod?.default?.recognize;

  return { createWorker, recognize };
}

/**
 * OCR SOLO números arriba de barras (labelsCanvas ya excluye eje Y por margen izquierdo).
 * Ordena por X, dedup por cercanía y toma los 12 más a la derecha.
 */
async function runOcrOnCanvasNumbersOnly(labelsCanvasRaw: HTMLCanvasElement) {
  const { createWorker, recognize } = await loadTesseractModule();

  // Preprocesa para OCR
  const labelsCanvas = preprocessForOcr(labelsCanvasRaw);
  const imgDataUrl = canvasToDataUrl(labelsCanvas);

  let data: any = null;

  // Preferimos worker, pero soportamos fallback
  if (typeof createWorker === "function") {
    const worker = await createWorker();

    // Algunas versiones requieren worker.load()
    if (typeof worker.load === "function") await worker.load();

    // Algunas versiones tienen loadLanguage/initialize; otras reinitialize
    if (typeof worker.loadLanguage === "function") {
      await worker.loadLanguage("eng");
    }
    if (typeof worker.initialize === "function") {
      await worker.initialize("eng");
    } else if (typeof worker.reinitialize === "function") {
      await worker.reinitialize("eng");
    }

    if (typeof worker.setParameters === "function") {
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789",
        // PSM 11: sparse text (mejor para numeritos sueltos)
        tessedit_pageseg_mode: "11",
      });
    }

    const res = await worker.recognize(imgDataUrl);
    data = res?.data;
    if (typeof worker.terminate === "function") await worker.terminate();
  } else if (typeof recognize === "function") {
    const res = await recognize(imgDataUrl, "eng", {
      tessedit_char_whitelist: "0123456789",
    });
    data = res?.data;
  } else {
    throw new Error("No se pudo cargar tesseract.js (createWorker/recognize no disponible).");
  }

  const W = labelsCanvas.width;
  const H = labelsCanvas.height;

  const words = (data?.words ?? []) as Array<{
    text: string;
    confidence: number; // 0..100
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }>;

  const picks: OcrPick[] = [];
  for (const w of words) {
    const raw = (w.text ?? "").trim();
    if (!raw) continue;

    const cleaned = raw.replace(/[^\d]/g, "");
    if (!cleaned) continue;
    if (cleaned.length > 4) continue;

    const val = parseInt(cleaned, 10);
    if (!Number.isFinite(val)) continue;

    // rango solicitado
    if (val < 20 || val > 3000) continue;

    const bb = w.bbox;
    const cx = (bb.x0 + bb.x1) / 2;
    const cy = (bb.y0 + bb.y1) / 2;

    // tamaños mínimos para evitar ruido
    const bw = Math.max(1, bb.x1 - bb.x0);
    const bh = Math.max(1, bb.y1 - bb.y0);
    if (bw < 8 || bh < 12) continue;

    picks.push({
      value: val,
      conf: w.confidence ?? 0,
      x: cx / W,
      y: cy / H,
    });
  }

  // Orden por X (izq→der)
  const sortedByX = [...picks].sort((a, b) => a.x - b.x);

  // Dedup por “slot” de barra (si detecta doble en la misma barra, guarda el de más conf)
  const merged: OcrPick[] = [];
  const MERGE_X = 0.032; // ~3.2% del ancho

  for (const p of sortedByX) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(p);
      continue;
    }
    if (Math.abs(p.x - last.x) <= MERGE_X) {
      if (p.conf > last.conf) merged[merged.length - 1] = p;
    } else {
      merged.push(p);
    }
  }

  // Toma 12 más recientes (los 12 más a la derecha)
  const used = merged.length > 12 ? merged.slice(merged.length - 12) : merged;

  const valuesUsed = used.map((p) => p.value);
  const sum = valuesUsed.reduce((a, b) => a + b, 0);
  const monthsUsed = valuesUsed.length;

  return {
    picksAll: merged,
    picksUsed: used,
    valuesUsed,
    monthsUsed,
    annualEstimated: monthsUsed >= 1 ? (sum / monthsUsed) * 12 : 0,
    monthlyAverage: monthsUsed >= 1 ? sum / monthsUsed : 0,
    avgConfidence: used.length ? used.reduce((a, b) => a + b.conf, 0) / used.length : 0,
  };
}

export default function Page() {
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const [rawImageUrl, setRawImageUrl] = useState<string | null>(null);
  const [previewChartUrl, setPreviewChartUrl] = useState<string | null>(null);
  const [previewLabelsUrl, setPreviewLabelsUrl] = useState<string | null>(null);

  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  const [ocrMonthlyAvg, setOcrMonthlyAvg] = useState<number>(0);
  const [ocrAnnual, setOcrAnnual] = useState<number>(0);
  const [ocrMonthsUsed, setOcrMonthsUsed] = useState<number>(0);
  const [ocrConfidence, setOcrConfidence] = useState<number>(0);

  const [ocrValuesAll, setOcrValuesAll] = useState<number[]>([]);
  const [ocrValuesUsed, setOcrValuesUsed] = useState<number[]>([]);

  const [monthlyKwh, setMonthlyKwh] = useState<number>(0);

  // Crop params (manual)
  const [showManualCrop, setShowManualCrop] = useState(false);
  const [cropParams, setCropParams] = useState<CropParams>({ ...DEFAULT_AUTO_CROP });

  // Store last full canvas (para reprocesar sin re-subir)
  const fullCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Assumptions
  const [offsetPct, setOffsetPct] = useState<number>(90);
  const [psh, setPsh] = useState<number>(5);
  const [lossFactor, setLossFactor] = useState<number>(0.8);
  const [panelW, setPanelW] = useState<number>(450);

  const [roofType, setRoofType] = useState<"Shingle" | "Metal" | "Concrete" | "Other">("Shingle");
  const [permits, setPermits] = useState<number>(1200);
  const [interconnection, setInterconnection] = useState<number>(450);
  const [miscPct, setMiscPct] = useState<number>(3);

  const [backupHours, setBackupHours] = useState<number>(8);
  const [criticalKw, setCriticalKw] = useState<number>(1.5);

  useEffect(() => {
    if (ocrMonthlyAvg > 0) setMonthlyKwh(round2(ocrMonthlyAvg));
  }, [ocrMonthlyAvg]);

  const roofAdderCost = useMemo(() => {
    if (roofType === "Shingle") return 0;
    if (roofType === "Metal") return 800;
    if (roofType === "Concrete") return 1500;
    return 500;
  }, [roofType]);

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
    return pvCost + misc + roofAdderCost + permits + interconnection;
  }, [pvWattsRecommended, miscPct, roofAdderCost, permits, interconnection]);

  const batteryCards = useMemo(() => {
    const usableFactor = 0.9;
    const requiredKwhNominal = (criticalKw * backupHours) / usableFactor;

    const sorted = [...BATTERY_SIZES].sort((a, b) => a - b);
    const recommended = sorted.find((k) => k >= requiredKwhNominal) ?? sorted[sorted.length - 1];

    return sorted.map((kwh) => {
      const battCost = kwh * SOLUNA_PRICE_PER_KWH;
      const total = basePvCost + battCost;
      const estHours = (kwh * usableFactor) / Math.max(0.5, criticalKw);
      return {
        kwh,
        battCost,
        total,
        estHours,
        isRecommended: kwh === recommended,
      };
    });
  }, [basePvCost, backupHours, criticalKw]);

  async function processFromFullCanvas(full: HTMLCanvasElement, params: CropParams) {
    setOcrError(null);
    setOcrValuesAll([]);
    setOcrValuesUsed([]);
    setOcrMonthsUsed(0);
    setOcrConfidence(0);
    setOcrAnnual(0);
    setOcrMonthlyAvg(0);

    const { chartCanvas, labelsCanvas } = cropWithParams(full, params);

    setPreviewChartUrl(canvasToDataUrl(chartCanvas));
    setPreviewLabelsUrl(canvasToDataUrl(labelsCanvas));

    setOcrBusy(true);
    try {
      const r = await runOcrOnCanvasNumbersOnly(labelsCanvas);

      setOcrValuesAll(r.picksAll.map((p) => p.value));
      setOcrValuesUsed(r.valuesUsed);
      setOcrMonthsUsed(r.monthsUsed);
      setOcrConfidence(r.avgConfidence);

      if (r.monthsUsed >= 4) {
        setOcrAnnual(round2(r.annualEstimated));
        setOcrMonthlyAvg(round2(r.monthlyAverage));
      } else {
        setOcrError(
          "OCR insuficiente: se detectaron menos de 4 meses. Usa “Recortar (manual)” o escribe el kWh mensual promedio."
        );
      }
    } catch (e: any) {
      setOcrError(e?.message ?? "Error de OCR");
    } finally {
      setOcrBusy(false);
    }
  }

  async function handleFile(file: File) {
    const img = await loadImageFromFile(file);
    const fullCanvas = canvasFromImage(img, 1700);
    fullCanvasRef.current = fullCanvas;

    setRawImageUrl(canvasToDataUrl(fullCanvas));

    // Auto-crop por defecto
    setCropParams({ ...DEFAULT_AUTO_CROP });
    await processFromFullCanvas(fullCanvas, DEFAULT_AUTO_CROP);
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
              Instrucciones: Usa la página 4 de LUMA donde aparece la gráfica{" "}
              <span className="font-medium">“CONSUMPTION HISTORY (KWH)”</span> (o “Historial de consumo”). Toma la{" "}
              <span className="font-medium">foto completa</span> de la página (sin recortar), nítida y sin reflejos.
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
                <div className="mt-2 text-xs text-neutral-500">Si el OCR falla, escribe el promedio mensual aquí.</div>

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
                        {ocrConfidence > 0 ? `${round2(ocrConfidence)}%` : "—"}
                      </div>
                    </>
                  )}
                </div>

                {ocrError && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {ocrError}
                  </div>
                )}

                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowManualCrop((v) => !v)}
                    className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-medium"
                  >
                    ✂️ Recortar (manual)
                  </button>

                  <button
                    type="button"
                    onClick={async () => {
                      if (!fullCanvasRef.current) return;
                      await processFromFullCanvas(fullCanvasRef.current, cropParams);
                    }}
                    className="rounded-xl bg-neutral-900 px-3 py-2 text-xs font-medium text-white"
                  >
                    🔁 Reprocesar OCR
                  </button>
                </div>
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
                    <div className="px-1 pb-1 text-[10px] text-neutral-500">Auto-crop (números)</div>
                    {previewLabelsUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img alt="labels" src={previewLabelsUrl} className="h-28 w-full rounded-md object-cover" />
                    ) : (
                      <div className="flex h-28 items-center justify-center rounded-md bg-neutral-50 text-xs text-neutral-400">
                        —
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-3 text-[11px] text-neutral-500">
                  Nota: el crop descarta el eje Y por posición (margen izquierdo). Solo intenta leer los numeritos arriba
                  de las barras. Si el preview no muestra todos los números, usa “Recortar (manual)”.
                </div>

                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-700">
                    Debug OCR (detectados / usados)
                  </summary>
                  <div className="mt-2 text-xs text-neutral-600">
                    <div>
                      <span className="font-medium">Detectados:</span>{" "}
                      {ocrValuesAll.length ? ocrValuesAll.join(", ") : "—"}
                    </div>
                    <div className="mt-1">
                      <span className="font-medium">Usados (12 más recientes):</span>{" "}
                      {ocrValuesUsed.length ? ocrValuesUsed.join(", ") : "—"}
                    </div>
                  </div>
                </details>
              </div>
            </div>

            {showManualCrop && (
              <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                <div className="text-sm font-semibold">Recorte manual (sliders)</div>
                <div className="mt-1 text-xs text-neutral-600">
                  Ajusta solo si el OCR falla. Objetivo: que el preview “Auto-crop (números)” muestre todos los numeritos
                  encima de las barras, sin incluir el eje Y.
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  {(
                    [
                      ["chartTopPct", "Chart top", 0.40, 0.75],
                      ["chartBottomPct", "Chart bottom", 0.85, 0.99],
                      ["labelsLeftPct", "Labels left (quita eje Y)", 0.10, 0.30],
                      ["labelsRightPct", "Labels right", 0.90, 1.0],
                      ["labelsTopPct", "Labels top", 0.00, 0.30],
                      ["labelsBottomPct", "Labels bottom (quita meses)", 0.55, 0.95],
                    ] as Array<[keyof CropParams, string, number, number]>
                  ).map(([key, label, min, max]) => (
                    <div key={key} className="rounded-lg bg-white p-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-neutral-700">{label}</span>
                        <span className="text-neutral-500">{round2(cropParams[key])}</span>
                      </div>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={0.005}
                        value={cropParams[key]}
                        onChange={(e) =>
                          setCropParams((prev) => ({
                            ...prev,
                            [key]: parseFloat(e.target.value),
                          }))
                        }
                        className="mt-2 w-full"
                      />
                    </div>
                  ))}
                </div>

                <div className="mt-2 text-[11px] text-neutral-500">
                  Tip: si ves solo 1 número (ej. 637) en el preview, baja “Chart top” un poco o sube “Labels bottom”.
                </div>
              </div>
            )}
          </div>

          {/* Assumptions */}
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
                <div className="text-xs font-medium text-neutral-600">Techo</div>
                <select
                  value={roofType}
                  onChange={(e) => setRoofType(e.target.value as any)}
                  className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                >
                  <option>Shingle</option>
                  <option>Metal</option>
                  <option>Concrete</option>
                  <option>Other</option>
                </select>
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
          </div>
        </div>

        {/* Battery */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-neutral-200 p-4 shadow-sm">
            <div className="text-lg font-semibold">Batería</div>

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
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4 shadow-sm">
            <div className="text-lg font-semibold">Opciones de batería + precio final</div>
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

                  <div className="mt-2 text-xs text-neutral-700">
                    Batería: {formatMoney(b.battCost)}{" "}
                    <span className="text-neutral-500">(${SOLUNA_PRICE_PER_KWH}/kWh)</span>
                  </div>
                  <div className="text-xs text-neutral-700">Total (PV + batería): {formatMoney(b.total)}</div>
                  <div className="mt-1 text-[11px] text-neutral-600">
                    Horas est. a {criticalKw} kW: <span className="font-medium">{round2(b.estHours)} h</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-8 text-xs text-neutral-500">
          Si el OCR sigue fallando: la solución real es que el preview “Auto-crop (números)” muestre TODOS los numeritos
          encima de las barras. Ajusta el recorte manual hasta lograrlo.
        </div>
      </div>
    </div>
  );
}
