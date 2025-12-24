"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Sunsol – Cotizador (sin vendedor)
 * OCR LUMA page 4 (Consumption History graph):
 * - Auto-crop por defecto
 * - Descarta eje Y por POSICIÓN (no por valores)
 * - Considera SOLO números arriba de las barras (región superior del chart)
 * - Usa los 12 más recientes (derecha a izquierda)
 * - Si faltan meses: usa >=4 y estima anual = (sum/meses)*12
 *
 * Requisitos:
 *   npm i tesseract.js
 */

const PV_PRICE_PER_W = 2.30; // $/W instalado (sin incentivos)
const SOLUNA_PRICE_PER_KWH = 350; // $/kWh

const BATTERY_SIZES = [5, 10, 16, 20, 32, 40] as const;

type OcrPick = {
  value: number;
  conf: number; // 0..100
  x: number; // normalized 0..1
  y: number; // normalized 0..1
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function formatMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
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

function canvasFromImage(img: HTMLImageElement, maxWidth = 1600): HTMLCanvasElement {
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

/**
 * Auto-crop (robusto y simple):
 * Asume que el usuario tomó la página completa 4.
 * Recorta al área inferior donde está la gráfica.
 * Luego recorta a "zona de números arriba de barras", y elimina eje Y por margen izquierdo.
 */
function autoCropToBarLabels(full: HTMLCanvasElement) {
  const W = full.width;
  const H = full.height;

  // 1) Cropea a la mitad inferior donde suele estar "CONSUMPTION HISTORY"
  //    (en LUMA page 4, la gráfica está en el tercio inferior)
  const chartTop = Math.round(H * 0.50);
  const chartBottom = Math.round(H * 0.93);
  const chartLeft = Math.round(W * 0.04);
  const chartRight = Math.round(W * 0.98);

  const chartW = Math.max(1, chartRight - chartLeft);
  const chartH = Math.max(1, chartBottom - chartTop);

  const chart = document.createElement("canvas");
  chart.width = chartW;
  chart.height = chartH;
  chart.getContext("2d")!.drawImage(full, chartLeft, chartTop, chartW, chartH, 0, 0, chartW, chartH);

  // 2) Dentro del chart: mantener SOLO la banda superior donde están los numeritos encima de las barras.
  //    Quitar parte inferior (labels de meses) y parte izquierda (eje Y)
  const cw = chart.width;
  const ch = chart.height;

  // Descarta eje Y por posición: quitamos un margen izquierdo fijo relativo.
  const labelsLeft = Math.round(cw * 0.18); // <- elimina eje Y y numeración del eje
  const labelsRight = Math.round(cw * 0.99);

  // Banda vertical: parte superior/media donde aparecen los números de las barras.
  // (evita meses de abajo y evita títulos arriba)
  const labelsTop = Math.round(ch * 0.18);
  const labelsBottom = Math.round(ch * 0.62);

  const lw = Math.max(1, labelsRight - labelsLeft);
  const lh = Math.max(1, labelsBottom - labelsTop);

  const labels = document.createElement("canvas");
  labels.width = lw;
  labels.height = lh;
  labels.getContext("2d")!.drawImage(chart, labelsLeft, labelsTop, lw, lh, 0, 0, lw, lh);

  // Para debug/preview también devolvemos el chart completo recortado
  return {
    chartCanvas: chart,
    labelsCanvas: labels,
    meta: {
      full: { W, H },
      chartCrop: { x: chartLeft, y: chartTop, w: chartW, h: chartH },
      labelsCropWithinChart: { x: labelsLeft, y: labelsTop, w: lw, h: lh },
      margins: { leftPct: 0.18, topPct: 0.18, bottomPct: 0.62 },
    },
  };
}

function canvasToDataUrl(c: HTMLCanvasElement, quality = 0.92) {
  return c.toDataURL("image/jpeg", quality);
}

/**
 * OCR sólo de números (arriba de barras).
 * Importantísimo: usamos bbox/posición para descartar eje Y (ya viene recortado),
 * y para ordenar por X y tomar los 12 más recientes.
 */
async function runOcrOnCanvasNumbersOnly(labelsCanvas: HTMLCanvasElement) {
  // dynamic import para evitar problemas SSR/build
  const tesseract = await import("tesseract.js");

  // createWorker es más estable; fallback a recognize simple si no existe
  const createWorker = (tesseract as any).createWorker as undefined | (() => any);

  const imgDataUrl = canvasToDataUrl(labelsCanvas);

  let data: any;
  if (createWorker) {
    const worker = await createWorker();
    await worker.loadLanguage("eng");
    await worker.initialize("eng");
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      // PSM 6: block of text; PSM 11: sparse text. 6 suele ir bien para numeritos.
      tessedit_pageseg_mode: "6",
    });
    const res = await worker.recognize(imgDataUrl);
    data = res.data;
    await worker.terminate();
  } else {
    const res = await (tesseract as any).recognize(imgDataUrl, "eng", {
      tessedit_char_whitelist: "0123456789",
    });
    data = res.data;
  }

  const W = labelsCanvas.width;
  const H = labelsCanvas.height;

  const words = (data?.words ?? []) as Array<{
    text: string;
    confidence: number; // 0..100
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }>;

  // Extrae candidatos numéricos por bbox.
  const picks: OcrPick[] = [];
  for (const w of words) {
    const raw = (w.text ?? "").trim();
    if (!raw) continue;

    // A veces viene como "825." o "825," → limpiamos no-dígitos
    const cleaned = raw.replace(/[^\d]/g, "");
    if (!cleaned) continue;
    if (cleaned.length > 4) continue; // evita basura enorme
    const val = parseInt(cleaned, 10);
    if (!Number.isFinite(val)) continue;

    // rango residencial típico, con límite comercial
    if (val < 20 || val > 3000) continue;

    const bb = w.bbox;
    const cx = (bb.x0 + bb.x1) / 2;
    const cy = (bb.y0 + bb.y1) / 2;

    // SOLO zona superior del recorte (números encima de barras)
    // (labelsCanvas ya es una banda, pero aún así filtramos por Y para evitar cualquier ruido)
    const yNorm = cy / H;
    if (yNorm < 0.02 || yNorm > 0.98) continue;

    // Filtra tokens demasiado pequeños (ruido)
    const bw = Math.max(1, bb.x1 - bb.x0);
    const bh = Math.max(1, bb.y1 - bb.y0);
    if (bw < 6 || bh < 10) continue;

    picks.push({
      value: val,
      conf: w.confidence ?? 0,
      x: cx / W,
      y: cy / H,
    });
  }

  // Dedup: si el OCR detecta el mismo número muy cerca, se queda el de mayor confianza
  // Agrupamos por cercanía en X (porque hay 12-13 barras).
  const sortedByX = [...picks].sort((a, b) => a.x - b.x);

  const merged: OcrPick[] = [];
  const MERGE_X = 0.035; // ~3.5% del ancho; ajusta si hace falta

  for (const p of sortedByX) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(p);
      continue;
    }
    if (Math.abs(p.x - last.x) <= MERGE_X) {
      // mismo “slot” de barra → conserva el más confiable
      if (p.conf > last.conf) merged[merged.length - 1] = p;
    } else {
      merged.push(p);
    }
  }

  // Usa los 12 más recientes: toma los 12 más a la derecha
  const last12 = merged.length > 12 ? merged.slice(merged.length - 12) : merged;

  const values = last12.map((p) => p.value);
  const sum = values.reduce((a, b) => a + b, 0);
  const monthsUsed = values.length;

  return {
    picksAll: merged,
    picksUsed: last12,
    valuesUsed: values,
    monthsUsed,
    annualEstimated: monthsUsed >= 1 ? (sum / monthsUsed) * 12 : 0,
    monthlyAverage: monthsUsed >= 1 ? sum / monthsUsed : 0,
    avgConfidence: last12.length
      ? last12.reduce((a, b) => a + b.conf, 0) / last12.length
      : 0,
  };
}

export default function Page() {
  // Upload + preview
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const [rawImageUrl, setRawImageUrl] = useState<string | null>(null);
  const [previewChartUrl, setPreviewChartUrl] = useState<string | null>(null);
  const [previewLabelsUrl, setPreviewLabelsUrl] = useState<string | null>(null);

  // OCR results
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrMonthlyAvg, setOcrMonthlyAvg] = useState<number>(0);
  const [ocrAnnual, setOcrAnnual] = useState<number>(0);
  const [ocrMonthsUsed, setOcrMonthsUsed] = useState<number>(0);
  const [ocrConfidence, setOcrConfidence] = useState<number>(0);
  const [ocrValuesDebug, setOcrValuesDebug] = useState<number[]>([]);

  // Manual override: monthly kWh
  const [monthlyKwh, setMonthlyKwh] = useState<number>(0);

  // Assumptions / knobs
  const [offsetPct, setOffsetPct] = useState<number>(90);
  const [psh, setPsh] = useState<number>(5);
  const [lossFactor, setLossFactor] = useState<number>(0.8);
  const [panelW, setPanelW] = useState<number>(450);

  // simple adders (editable)
  const [roofType, setRoofType] = useState<"Shingle" | "Metal" | "Concrete" | "Other">("Shingle");
  const [permits, setPermits] = useState<number>(1200);
  const [interconnection, setInterconnection] = useState<number>(450);
  const [miscPct, setMiscPct] = useState<number>(3);

  // Battery assumptions
  const [backupHours, setBackupHours] = useState<number>(8);
  const [criticalKw, setCriticalKw] = useState<number>(1.5);

  // Sync manual monthly kWh with OCR avg when OCR updates (but allow user override)
  useEffect(() => {
    if (ocrMonthlyAvg > 0) setMonthlyKwh(round2(ocrMonthlyAvg));
  }, [ocrMonthlyAvg]);

  const roofAdderCost = useMemo(() => {
    // placeholder adder; ajusta después
    if (roofType === "Shingle") return 0;
    if (roofType === "Metal") return 800;
    if (roofType === "Concrete") return 1500;
    return 500;
  }, [roofType]);

  const monthlyForSizing = useMemo(() => {
    return Math.max(0, monthlyKwh || 0);
  }, [monthlyKwh]);

  const pvKwRecommended = useMemo(() => {
    // kWh/month needed = monthly * offset
    const targetMonthly = monthlyForSizing * (offsetPct / 100);
    const kwhPerKwMonth = Math.max(0.1, psh * 30 * lossFactor);
    const kw = targetMonthly / kwhPerKwMonth;
    return kw;
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
    // Recomendación por respaldo (kWh nominal) considerando factor usable
    const usableFactor = 0.9; // típico
    const requiredKwhNominal = (criticalKw * backupHours) / usableFactor;

    // Ordena opciones: primero la que cubre, luego las demás
    const sorted = [...BATTERY_SIZES].sort((a, b) => a - b);
    const recommended = sorted.find((k) => k >= requiredKwhNominal) ?? sorted[sorted.length - 1];

    // muestra todas
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
        requiredKwhNominal,
      };
    });
  }, [basePvCost, backupHours, criticalKw]);

  async function handleFile(file: File) {
    setOcrError(null);
    setOcrValuesDebug([]);
    setOcrMonthsUsed(0);
    setOcrConfidence(0);
    setOcrAnnual(0);
    setOcrMonthlyAvg(0);

    const img = await loadImageFromFile(file);
    const fullCanvas = canvasFromImage(img, 1600);
    const fullUrl = canvasToDataUrl(fullCanvas);
    setRawImageUrl(fullUrl);

    const { chartCanvas, labelsCanvas } = autoCropToBarLabels(fullCanvas);
    setPreviewChartUrl(canvasToDataUrl(chartCanvas));
    setPreviewLabelsUrl(canvasToDataUrl(labelsCanvas));

    setOcrBusy(true);
    try {
      const r = await runOcrOnCanvasNumbersOnly(labelsCanvas);

      setOcrValuesDebug(r.picksAll.map((p) => p.value));
      setOcrMonthsUsed(r.monthsUsed);
      setOcrConfidence(r.avgConfidence);

      // Regla: mínimo 4 meses para estimar anual
      if (r.monthsUsed >= 4) {
        setOcrAnnual(round2(r.annualEstimated));
        setOcrMonthlyAvg(round2(r.monthlyAverage));
      } else {
        setOcrError("OCR insuficiente: se detectaron menos de 4 meses. Usa “Recortar” (manual) o escribe el kWh mensual.");
      }
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
          <div className="text-xs text-neutral-500">
            Estimado preliminar. Validación final requiere inspección.
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Uploader */}
          <div className="rounded-2xl border border-neutral-200 p-4 shadow-sm">
            <div className="text-lg font-semibold">Foto / Screenshot de LUMA (página 4)</div>
            <div className="mt-2 text-sm text-neutral-600">
              Instrucciones: Usa la página 4 de LUMA donde aparece la gráfica{" "}
              <span className="font-medium">“CONSUMPTION HISTORY (KWH)”</span> (o “Historial de consumo”).
              Toma la foto <span className="font-medium">completa</span>, nítida y sin reflejos.
            </div>

            <div className="mt-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
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

                {/* Inputs ocultos */}
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

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
                    Nota: el auto-crop descarta el eje Y por posición (margen izquierdo), aunque los números del eje cambien.
                    Solo intenta leer los numeritos arriba de cada barra.
                  </div>

                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-medium text-neutral-700">
                      Debug OCR (valores detectados)
                    </summary>
                    <div className="mt-2 text-xs text-neutral-600">
                      {ocrValuesDebug.length ? ocrValuesDebug.join(", ") : "—"}
                    </div>
                  </details>
                </div>
              </div>
            </div>
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
                  <div className="mt-1 text-lg font-semibold">{monthlyForSizing ? `${round2(monthlyForSizing)} kWh` : "—"}</div>
                </div>
                <div className="rounded-lg bg-white p-3">
                  <div className="text-[11px] text-neutral-500">Sistema recomendado</div>
                  <div className="mt-1 text-lg font-semibold">{monthlyForSizing ? `${round2(pvKwRecommended)} kW` : "—"}</div>
                  <div className="text-[11px] text-neutral-500">{monthlyForSizing ? `${panelsCount} paneles (est.)` : ""}</div>
                </div>
                <div className="rounded-lg bg-white p-3">
                  <div className="text-[11px] text-neutral-500">PV (sin batería)</div>
                  <div className="mt-1 text-lg font-semibold">{monthlyForSizing ? formatMoney(basePvCost) : "—"}</div>
                </div>
              </div>

              <div className="mt-3 text-xs text-neutral-600">
                <div>Base PV: {formatMoney(pvWattsRecommended * PV_PRICE_PER_W)}</div>
                <div>Adder techo: {formatMoney(roofAdderCost)}</div>
                <div>Permisos: {formatMoney(permits)}</div>
                <div>Interconexión: {formatMoney(interconnection)}</div>
                <div>Misceláneo: {formatMoney((pvWattsRecommended * PV_PRICE_PER_W * miscPct) / 100)}</div>
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

            <div className="mt-4 text-xs text-neutral-600">
              Recomendación basada en respaldo: <span className="font-medium">{criticalKw} kW</span> por{" "}
              <span className="font-medium">{backupHours} horas</span>.
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
                    Batería: {formatMoney(b.battCost)} <span className="text-neutral-500">(${SOLUNA_PRICE_PER_KWH}/kWh)</span>
                  </div>
                  <div className="text-xs text-neutral-700">Total (PV + batería): {formatMoney(b.total)}</div>
                  <div className="mt-1 text-[11px] text-neutral-600">
                    Horas est. a {criticalKw} kW: <span className="font-medium">{round2(b.estHours)} h</span>
                  </div>

                  {b.kwh >= 3000 ? (
                    <div className="mt-2 text-xs text-red-600">Caso comercial: requiere estimado separado.</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-8 text-xs text-neutral-500">
          Consejo para OCR: usa buena luz, evita reflejos, y mantén toda la gráfica visible.
        </div>
      </div>
    </div>
  );
}
