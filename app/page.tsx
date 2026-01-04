"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Sunsol Demo - Page 4 LUMA "CONSUMPTION HISTORY (KWH)" OCR
 *
 * Objetivo:
 * - El usuario sube/toma foto de la PÁGINA 4 completa.
 * - Auto-crop detecta zona de la gráfica y luego recorta a la zona donde están:
 *   - barras + labels numéricos encima de cada barra
 * - OCR SOLO intenta leer esos labels encima de barras.
 * - Descarta eje Y por posición (margen izquierdo) sin depender de sus números.
 * - Filtra candidatos 20–3000 kWh.
 * - Usa 12 más recientes si hay 13; si faltan meses usa los disponibles (mínimo 4).
 * - Estima anual = promedio_mensual * 12
 */

type Rect = { x: number; y: number; w: number; h: number };
type OcrPick = { value: number; confidence: number; raw: string; xCenter: number; yCenter: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: any;
  const timeout = new Promise<T>((_, rej) => {
    t = setTimeout(() => rej(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t)) as Promise<T>;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo cargar la imagen."));
    img.src = src;
  });
}

function canvasFromImage(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D no disponible.");
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

function cropCanvas(src: HTMLCanvasElement, r: Rect): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.floor(r.w));
  c.height = Math.max(1, Math.floor(r.h));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D no disponible.");
  ctx.drawImage(src, Math.floor(r.x), Math.floor(r.y), Math.floor(r.w), Math.floor(r.h), 0, 0, c.width, c.height);
  return c;
}

function canvasToDataUrl(c: HTMLCanvasElement, quality = 0.92) {
  return c.toDataURL("image/jpeg", quality);
}

/**
 * Pre-procesado simple para mejorar OCR de números:
 * - escala grises
 * - contraste
 * - umbral (threshold)
 */
function preprocessForDigits(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D no disponible.");

  ctx.drawImage(src, 0, 0);

  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;

  // Ajustes (puedes afinar si hace falta)
  const contrast = 1.7; // 1.0 = normal
  const threshold = 190; // 0..255

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];

    // grayscale (luminosidad)
    let v = 0.299 * r + 0.587 * g + 0.114 * b;

    // contraste
    v = (v - 128) * contrast + 128;

    // threshold
    const bw = v > threshold ? 255 : 0;

    d[i] = bw;
    d[i + 1] = bw;
    d[i + 2] = bw;
    d[i + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Auto-crop de la zona de la gráfica dentro de la página 4 completa.
 * Heurística robusta:
 * - Si la imagen parece ya ser “solo gráfica” (no muy alta), usamos todo el frame.
 * - Si es página completa (portrait alta), tomamos la franja donde típicamente está la gráfica.
 * Importante: NO dependemos de números del eje Y.
 */
function autoCropGraphZone(fullW: number, fullH: number): Rect {
  // Si parece un recorte ya cerca de la gráfica (más "compacto"), no recortes agresivo.
  const aspect = fullH / Math.max(1, fullW);
  const looksCropped = aspect < 1.25 || fullH < 850;

  if (looksCropped) {
    return { x: 0, y: 0, w: fullW, h: fullH };
  }

  // Página completa típica: tabla arriba + gráfica abajo + a veces otra gráfica debajo.
  // Recortamos para quedarnos con la sección donde está "CONSUMPTION HISTORY (KWH)" con barras.
  const x0 = fullW * 0.02;
  const x1 = fullW * 0.99;

  // Ajuste clave: evitar capturar la gráfica inferior de "Cost per kWh"
  const y0 = fullH * 0.42;
  const y1 = fullH * 0.86;

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Dentro de la zona de la gráfica, recorta a un ROI donde están:
 * - barras + labels numéricos encima de barras
 * Excluye:
 * - eje Y (margen izquierdo) independientemente de sus números
 * - parte inferior con labels de meses (no nos interesan)
 */
function autoCropLabelsAboveBarsZone(graphW: number, graphH: number): Rect {
  // Descarta eje Y por posición (margen izquierdo)
  const x0 = graphW * 0.12; // importante: sube/baja si tu primer label (p.ej. 422) se corta
  const x1 = graphW * 0.99;

  // Excluir header superior (pero dejamos algo porque labels altos pueden acercarse)
  const y0 = graphH * 0.18;

  // Excluir zona inferior (meses + ejes)
  const y1 = graphH * 0.72;

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Parse de dígitos + filtro 20–3000.
 * Acepta cosas como "825", " 825 ", "825." etc.
 */
function pickCandidateNumber(text: string): number | null {
  const digits = (text || "").replace(/[^\d]/g, "");
  if (!digits) return null;

  // A veces OCR mete dígitos extra: intentamos variantes (últimos 4, 3, 2)
  const tries: string[] = [];
  if (digits.length <= 4) {
    tries.push(digits);
  } else {
    tries.push(digits.slice(-4), digits.slice(-3), digits.slice(-2));
  }

  for (const t of tries) {
    const n = Number(t);
    if (Number.isFinite(n) && n >= 20 && n <= 3000) return n;
  }
  return null;
}

/**
 * Extrae labels numéricos “encima de barras” de un OCR de un ROI.
 * Estrategia:
 * - Usamos res.data.words con bbox.
 * - Filtramos por:
 *   - número 20–3000
 *   - bbox dentro de una banda vertical razonable (evita header y eje inferior)
 * - Luego agrupamos por X en 13 bins (13 meses), y nos quedamos con el de mayor confianza por bin.
 */
function extractBarLabelsFromOcr(result: any, roiW: number, roiH: number) {
  const words: any[] = result?.data?.words || [];

  const picks: OcrPick[] = [];

  for (const w of words) {
    const raw = String(w.text ?? w?.symbols?.map((s: any) => s.text).join("") ?? "").trim();
    if (!raw) continue;

    const val = pickCandidateNumber(raw);
    if (val == null) continue;

    // bbox compat (distintas versiones)
    const bbox = w.bbox || {
      x0: w.x0 ?? 0,
      y0: w.y0 ?? 0,
      x1: w.x1 ?? 0,
      y1: w.y1 ?? 0,
    };

    const x0 = Number(bbox.x0 ?? 0);
    const y0 = Number(bbox.y0 ?? 0);
    const x1 = Number(bbox.x1 ?? 0);
    const y1 = Number(bbox.y1 ?? 0);

    const xCenter = (x0 + x1) / 2;
    const yCenter = (y0 + y1) / 2;

    // Banda vertical: evita textos del header muy arriba y evita cualquier cosa cerca del eje/meses
    const yN = yCenter / Math.max(1, roiH);
    if (yN < 0.10 || yN > 0.90) continue;

    const conf = Number(w.confidence ?? w.conf ?? 0);
    picks.push({
      value: val,
      confidence: conf,
      raw,
      xCenter,
      yCenter,
    });
  }

  // Binear por X en 13 bins (13 meses típicamente)
  const bins = new Map<number, OcrPick>();
  const BIN_COUNT = 13;

  for (const p of picks) {
    const xN = p.xCenter / Math.max(1, roiW);
    const bin = clamp(Math.floor(xN * BIN_COUNT), 0, BIN_COUNT - 1);
    const cur = bins.get(bin);
    if (!cur || p.confidence > cur.confidence) bins.set(bin, p);
  }

  // Construimos lista en orden de izquierda->derecha
  const ordered: OcrPick[] = [];
  for (let i = 0; i < BIN_COUNT; i++) {
    const v = bins.get(i);
    if (v) ordered.push(v);
  }

  // Si hay >12, usamos los 12 más recientes = los más a la derecha
  const last12 = ordered.slice(-12);

  const values = last12.map((x) => x.value);
  const confidences = last12.map((x) => x.confidence);

  const avgConf =
    confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0;

  return {
    detectedAll: ordered,
    usedLast12: last12,
    values,
    avgConf,
  };
}

/**
 * OCR Worker (tesseract.js) - compat multi-version.
 * Evita:
 * - loadLanguage missing
 * - initialize missing
 * - typing unknown en build
 */
let workerPromise: Promise<any> | null = null;

async function getTesseractWorker(logger: (msg: string) => void) {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const mod: any = await import("tesseract.js");
    const createWorker = mod.createWorker ?? mod.default?.createWorker;
    if (!createWorker) throw new Error("No se encontró createWorker() en tesseract.js.");

    let worker: any;

    // probamos firmas comunes
    try {
      worker = await createWorker("eng", 1, { logger });
    } catch {
      try {
        worker = await createWorker("eng", { logger });
      } catch {
        worker = await createWorker({ logger });
      }
    }

    // Inicialización compat
    if (worker.load) await worker.load();
    if (worker.loadLanguage) await worker.loadLanguage("eng");
    if (worker.initialize) await worker.initialize("eng");
    if (worker.reinitialize) await worker.reinitialize("eng");

    // Parámetros: whitelist dígitos y modo de segmentación más “bloque”
    if (worker.setParameters) {
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789",
        preserve_interword_spaces: "1",
        // PSM 6 = assume a single uniform block of text (mejor para múltiples labels)
        tessedit_pageseg_mode: "6",
      });
    }

    return worker;
  })();

  return workerPromise;
}

async function terminateWorkerSafe() {
  try {
    const w = await workerPromise;
    if (w?.terminate) await w.terminate();
  } catch {
    // ignore
  } finally {
    workerPromise = null;
  }
}

export default function Page() {
  // ------------------- OCR state -------------------
  const [rawDataUrl, setRawDataUrl] = useState<string | null>(null);
  const [rawPreviewUrl, setRawPreviewUrl] = useState<string | null>(null);

  const [graphCropUrl, setGraphCropUrl] = useState<string | null>(null);
  const [roiUrl, setRoiUrl] = useState<string | null>(null);

  const [ocrStatus, setOcrStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);

  const [ocrMonthlyAvg, setOcrMonthlyAvg] = useState<number | null>(null);
  const [ocrAnnual, setOcrAnnual] = useState<number | null>(null);
  const [monthsUsed, setMonthsUsed] = useState<number>(0);

  const [debugDetected, setDebugDetected] = useState<string>("");
  const [debugUsed, setDebugUsed] = useState<string>("");

  const jobIdRef = useRef(0);

  // ------------------- Inputs del sistema -------------------
  const [offsetPct, setOffsetPct] = useState<number>(90);
  const [psh, setPsh] = useState<number>(5);
  const [lossFactor, setLossFactor] = useState<number>(0.8);
  const [panelW, setPanelW] = useState<number>(450);
  const [roofType, setRoofType] = useState<"shingle" | "metal" | "flat" | "ground">("shingle");
  const [permits, setPermits] = useState<number>(1200);
  const [interconnection, setInterconnection] = useState<number>(450);
  const [installedPricePerW, setInstalledPricePerW] = useState<number>(2.3);

  const [batteryPricePerKwh, setBatteryPricePerKwh] = useState<number>(350);
  const [backupHours, setBackupHours] = useState<number>(8);
  const [criticalLoadKw, setCriticalLoadKw] = useState<number>(1.5);

  // Manual override mensual (si OCR falla)
  const [manualMonthlyKwh, setManualMonthlyKwh] = useState<string>("");

  const effectiveMonthlyKwh = useMemo(() => {
    const manual = Number(manualMonthlyKwh);
    if (manualMonthlyKwh.trim() !== "" && Number.isFinite(manual) && manual > 0) return manual;
    return ocrMonthlyAvg ?? 0;
  }, [manualMonthlyKwh, ocrMonthlyAvg]);

  // ------------------- Cálculos -------------------
  const sizing = useMemo(() => {
    const monthly = effectiveMonthlyKwh;
    const annual = monthly > 0 ? monthly * 12 : 0;

    const annualPerKw = psh * lossFactor * 365; // kWh por kWdc por año aprox
    const pvKw = annual > 0 && annualPerKw > 0 ? (annual * (offsetPct / 100)) / annualPerKw : 0;

    const panels = pvKw > 0 && panelW > 0 ? Math.ceil((pvKw * 1000) / panelW) : 0;

    const roofAdderPerW =
      roofType === "shingle" ? 0 :
      roofType === "metal" ? 0.10 :
      roofType === "flat" ? 0.20 :
      0.30;

    const pvBase = pvKw * 1000 * installedPricePerW;
    const roofAdder = pvKw * 1000 * roofAdderPerW;

    const subtotal = pvBase + roofAdder + permits + interconnection;
    const misc = subtotal * 0.03; // 3% misceláneo

    const pvTotal = subtotal + misc;

    // Batería recomendada (aprox): kWh = horas * kW / factor_utilizable
    const usableFactor = 0.75;
    const batteryKwh = backupHours > 0 && criticalLoadKw > 0 ? (backupHours * criticalLoadKw) / usableFactor : 0;
    const batteryKwhRounded = batteryKwh > 0 ? Math.ceil(batteryKwh) : 0;
    const batteryCost = batteryKwhRounded * batteryPricePerKwh;

    return {
      monthly,
      annual,
      pvKw: round2(pvKw),
      panels,
      pvBase: Math.round(pvBase),
      roofAdder: Math.round(roofAdder),
      permits: Math.round(permits),
      interconnection: Math.round(interconnection),
      misc: Math.round(misc),
      pvTotal: Math.round(pvTotal),
      batteryKwh: batteryKwhRounded,
      batteryCost: Math.round(batteryCost),
      totalWithBattery: Math.round(pvTotal + batteryCost),
    };
  }, [
    effectiveMonthlyKwh,
    offsetPct,
    psh,
    lossFactor,
    panelW,
    roofType,
    permits,
    interconnection,
    installedPricePerW,
    backupHours,
    criticalLoadKw,
    batteryPricePerKwh,
  ]);

  // ------------------- OCR Pipeline -------------------
  async function runOcrFromDataUrl(dataUrl: string) {
    const myJob = ++jobIdRef.current;
    setOcrStatus("running");
    setOcrError(null);
    setOcrConfidence(null);
    setOcrMonthlyAvg(null);
    setOcrAnnual(null);
    setMonthsUsed(0);
    setDebugDetected("");
    setDebugUsed("");

    const logLines: string[] = [];
    const logger = (msg: string) => {
      // Mantén esto ligero: muchos logs pueden ser ruidosos en móvil
      logLines.push(msg);
    };

    try {
      const img = await withTimeout(loadImage(dataUrl), 8000, "loadImage");
      if (myJob !== jobIdRef.current) return;

      const full = canvasFromImage(img);

      // 1) Auto-crop zona gráfica (barras)
      const gRect = autoCropGraphZone(full.width, full.height);
      const graphCanvas = cropCanvas(full, gRect);
      const graphUrl = canvasToDataUrl(graphCanvas);
      setGraphCropUrl(graphUrl);

      // 2) Auto-crop ROI donde están labels arriba de barras (descarta eje Y por posición)
      const roiRect = autoCropLabelsAboveBarsZone(graphCanvas.width, graphCanvas.height);
      const roiCanvas = cropCanvas(graphCanvas, roiRect);

      // 3) Preprocess para OCR dígitos
      const prep = preprocessForDigits(roiCanvas);
      const roiDataUrl = canvasToDataUrl(prep);
      setRoiUrl(roiDataUrl);

      // 4) OCR (single call)
      const worker = await withTimeout(getTesseractWorker(logger), 20000, "createWorker");
      if (myJob !== jobIdRef.current) return;

      const res = await withTimeout(worker.recognize(roiDataUrl), 25000, "recognize");
      if (myJob !== jobIdRef.current) return;

      const extracted = extractBarLabelsFromOcr(res, prep.width, prep.height);

      // Debug visible
      setDebugDetected(
        extracted.detectedAll
          .map((p) => `${p.value}(${Math.round(p.confidence)}%)`)
          .join(", ")
      );
      setDebugUsed(
        extracted.usedLast12
          .map((p) => `${p.value}(${Math.round(p.confidence)}%)`)
          .join(", ")
      );

      const values = extracted.values;
      const valid = values.filter((n) => Number.isFinite(n)) as number[];

      // Reglas:
      // - mínimo 4 meses
      // - anual = avg * 12 (aunque solo tengas 4–11 meses)
      if (valid.length < 4) {
        setOcrStatus("error");
        setOcrError("OCR insuficiente: se detectaron menos de 4 meses. Toma la foto más nítida y completa (página 4), o escribe el kWh mensual promedio manualmente.");
        setOcrConfidence(Math.round(extracted.avgConf));
        return;
      }

      const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
      const annual = avg * 12;

      setMonthsUsed(valid.length);
      setOcrMonthlyAvg(round2(avg));
      setOcrAnnual(Math.round(annual));
      setOcrConfidence(Math.round(extracted.avgConf));
      setOcrStatus("done");
    } catch (e: any) {
      // Si se queda “pegado”, lo más común es worker / wasm. Reseteamos el worker.
      await terminateWorkerSafe();

      if (myJob !== jobIdRef.current) return;

      setOcrStatus("error");
      setOcrError(e?.message || "Error procesando OCR.");
    }
  }

  async function handleFile(file: File | null) {
    if (!file) return;

    // preview rápido
    const objectUrl = URL.createObjectURL(file);
    setRawPreviewUrl(objectUrl);

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || "");
      setRawDataUrl(dataUrl);
      await runOcrFromDataUrl(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  function clearAll() {
    jobIdRef.current++;
    setRawDataUrl(null);
    setRawPreviewUrl(null);
    setGraphCropUrl(null);
    setRoiUrl(null);

    setOcrStatus("idle");
    setOcrError(null);
    setOcrConfidence(null);
    setOcrMonthlyAvg(null);
    setOcrAnnual(null);
    setMonthsUsed(0);

    setDebugDetected("");
    setDebugUsed("");
    setManualMonthlyKwh("");
  }

  async function reprocess() {
    if (!rawDataUrl) return;
    await runOcrFromDataUrl(rawDataUrl);
  }

  // Cleanup object URL
  useEffect(() => {
    return () => {
      if (rawPreviewUrl) URL.revokeObjectURL(rawPreviewUrl);
    };
  }, [rawPreviewUrl]);

  // ------------------- UI helpers -------------------
  const fileInputCameraRef = useRef<HTMLInputElement | null>(null);
  const fileInputGalleryRef = useRef<HTMLInputElement | null>(null);

  const ocrBanner = useMemo(() => {
    if (ocrStatus === "running") {
      return (
        <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
          Procesando OCR…
        </div>
      );
    }
    if (ocrStatus === "error") {
      return (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {ocrError}
        </div>
      );
    }
    if (ocrStatus === "done") {
      return (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          OK. Anual estimado: <b>{ocrAnnual?.toLocaleString()}</b> kWh. Promedio mensual:{" "}
          <b>{ocrMonthlyAvg?.toLocaleString()}</b> kWh. Usó <b>{monthsUsed}</b> mes(es). Confianza OCR:{" "}
          <b>{ocrConfidence}%</b>.
        </div>
      );
    }
    return null;
  }, [ocrStatus, ocrError, ocrAnnual, ocrMonthlyAvg, monthsUsed, ocrConfidence]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Sunsol · Cotizador (sin vendedor)</h1>
        <p className="mt-1 text-sm text-gray-600">
          Foto / Screenshot de LUMA (página 4) → detecta consumo promedio mensual usando la gráfica{" "}
          <b>CONSUMPTION HISTORY (KWH)</b>.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* LEFT: OCR uploader */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Foto / Screenshot de LUMA (página 4)</h2>

          <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
            <div className="font-medium">Instrucciones</div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                Usa la <b>página 4</b> donde aparece la gráfica <b>“CONSUMPTION HISTORY (KWH)”</b> (o “Historial de consumo”).
              </li>
              <li>
                Toma la <b>página completa</b> (sin recortar), nítida y sin reflejos.
              </li>
              <li>
                El sistema lee <b>solo los numeritos encima de las barras</b> (descarta el eje Y automáticamente aunque cambie).
              </li>
              <li>
                Si faltan meses, usa los disponibles (mínimo 4) y estima anual = promedio × 12.
              </li>
            </ul>
          </div>

          <div className="mt-4 flex gap-3">
            <button
              className="flex-1 rounded-xl bg-black px-4 py-3 text-white disabled:opacity-50"
              onClick={() => fileInputCameraRef.current?.click()}
              disabled={ocrStatus === "running"}
            >
              📷 Tomar foto
            </button>

            <button
              className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 disabled:opacity-50"
              onClick={() => fileInputGalleryRef.current?.click()}
              disabled={ocrStatus === "running"}
            >
              🖼️ Subir de galería
            </button>

            {/* hidden inputs */}
            <input
              ref={fileInputCameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
            <input
              ref={fileInputGalleryRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700">
              Consumo mensual promedio (kWh/mes)
            </label>
            <input
              type="number"
              inputMode="numeric"
              placeholder="Ej. 600"
              className="mt-2 w-full rounded-xl border border-gray-300 px-3 py-3 text-base outline-none focus:border-gray-900"
              value={manualMonthlyKwh}
              onChange={(e) => setManualMonthlyKwh(e.target.value)}
            />
            <div className="mt-2 text-xs text-gray-600">
              Si el OCR falla, escribe el promedio mensual aquí. Si lo llenas, <b>reemplaza</b> el OCR.
            </div>

            <div className="mt-3 text-sm text-gray-700">
              <div>
                <span className="font-medium">Consumo anual:</span>{" "}
                {effectiveMonthlyKwh > 0 ? (
                  <span>{Math.round(effectiveMonthlyKwh * 12).toLocaleString()} kWh</span>
                ) : (
                  <span className="text-gray-500">— (sin OCR)</span>
                )}
              </div>
              <div className="mt-1">
                <span className="font-medium">OCR confianza:</span>{" "}
                {ocrConfidence != null ? <span>{ocrConfidence}%</span> : <span className="text-gray-500">—</span>}
              </div>
            </div>

            {ocrBanner}

            <div className="mt-4 flex gap-3">
              <button
                className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 disabled:opacity-50"
                onClick={reprocess}
                disabled={!rawDataUrl || ocrStatus === "running"}
              >
                🔁 Reprocesar OCR
              </button>
              <button
                className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 disabled:opacity-50"
                onClick={clearAll}
                disabled={ocrStatus === "running"}
              >
                🧹 Limpiar
              </button>
            </div>
          </div>

          {/* Previews */}
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-gray-800">Preview</h3>

            <div className="mt-3 grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-gray-200 p-2">
                <div className="text-xs font-medium text-gray-600">Página (raw)</div>
                {rawPreviewUrl ? (
                  <img src={rawPreviewUrl} className="mt-2 h-28 w-full rounded-lg object-cover" alt="raw" />
                ) : (
                  <div className="mt-2 flex h-28 items-center justify-center rounded-lg bg-gray-50 text-xs text-gray-500">
                    —
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 p-2">
                <div className="text-xs font-medium text-gray-600">Auto-crop (zona gráfica)</div>
                {graphCropUrl ? (
                  <img src={graphCropUrl} className="mt-2 h-28 w-full rounded-lg object-cover" alt="graph crop" />
                ) : (
                  <div className="mt-2 flex h-28 items-center justify-center rounded-lg bg-gray-50 text-xs text-gray-500">
                    —
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 p-2">
                <div className="text-xs font-medium text-gray-600">OCR (labels arriba de barras)</div>
                {roiUrl ? (
                  <img src={roiUrl} className="mt-2 h-28 w-full rounded-lg object-cover" alt="roi" />
                ) : (
                  <div className="mt-2 flex h-28 items-center justify-center rounded-lg bg-gray-50 text-xs text-gray-500">
                    —
                  </div>
                )}
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
              <div className="font-medium">Debug OCR (detectados / usados)</div>
              <div className="mt-2">
                <span className="font-medium">Detectados:</span>{" "}
                {debugDetected ? debugDetected : <span className="text-gray-500">—</span>}
              </div>
              <div className="mt-1">
                <span className="font-medium">Usados (12 más recientes):</span>{" "}
                {debugUsed ? debugUsed : <span className="text-gray-500">—</span>}
              </div>
              <div className="mt-2 text-gray-500">
                Nota: el auto-crop descarta el eje Y por posición (margen izquierdo). Solo intenta leer los numeritos encima de las barras.
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT: Calculator */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Cálculo rápido del sistema</h2>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="Offset (%)" value={offsetPct} onChange={setOffsetPct} step={1} />
            <Field label="PSH" value={psh} onChange={setPsh} step={0.1} />
            <Field label="Pérdidas (factor)" value={lossFactor} onChange={setLossFactor} step={0.01} />
            <Field label="Panel (W)" value={panelW} onChange={setPanelW} step={10} />

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700">Techo</label>
              <select
                className="mt-2 w-full rounded-xl border border-gray-300 px-3 py-3 text-base outline-none focus:border-gray-900"
                value={roofType}
                onChange={(e) => setRoofType(e.target.value as any)}
              >
                <option value="shingle">Shingle</option>
                <option value="metal">Metal</option>
                <option value="flat">Flat</option>
                <option value="ground">Ground</option>
              </select>
              <div className="mt-1 text-xs text-gray-500">
                (Shingle = $0/W adder; otros tipos tienen adder estimado)
              </div>
            </div>

            <Field label="Permisos (est.)" value={permits} onChange={setPermits} step={50} />
            <Field label="Interconexión (est.)" value={interconnection} onChange={setInterconnection} step={25} />
            <Field label="Precio instalado ($/W)" value={installedPricePerW} onChange={setInstalledPricePerW} step={0.01} />
            <div className="col-span-2" />
          </div>

          <div className="mt-5 rounded-2xl border border-gray-200 bg-gray-50 p-4">
            <div className="text-sm font-semibold text-gray-800">Resultado PV</div>

            <div className="mt-3 grid grid-cols-3 gap-3">
              <Kpi label="Consumo mensual" value={sizing.monthly > 0 ? `${round2(sizing.monthly)} kWh` : "0 kWh"} />
              <Kpi label="Sistema recomendado" value={sizing.pvKw > 0 ? `${sizing.pvKw} kW` : "0 kW"} sub={sizing.panels > 0 ? `${sizing.panels} paneles (est.)` : "0 paneles (est.)"} />
              <Kpi label="PV (sin batería)" value={`$${sizing.pvTotal.toLocaleString()}`} />
            </div>

            <div className="mt-4 text-xs text-gray-700">
              <div className="flex justify-between"><span>Base PV</span><span>${sizing.pvBase.toLocaleString()}</span></div>
              <div className="flex justify-between"><span>Adder techo</span><span>${sizing.roofAdder.toLocaleString()}</span></div>
              <div className="flex justify-between"><span>Permisos</span><span>${sizing.permits.toLocaleString()}</span></div>
              <div className="flex justify-between"><span>Interconexión</span><span>${sizing.interconnection.toLocaleString()}</span></div>
              <div className="flex justify-between"><span>Misceláneo (3%)</span><span>${sizing.misc.toLocaleString()}</span></div>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-gray-200 bg-white p-4">
            <div className="text-sm font-semibold text-gray-800">Batería</div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Horas de respaldo" value={backupHours} onChange={setBackupHours} step={1} />
              <Field label="Cargas críticas (kW)" value={criticalLoadKw} onChange={setCriticalLoadKw} step={0.1} />
              <Field label="Precio batería ($/kWh)" value={batteryPricePerKwh} onChange={setBatteryPricePerKwh} step={10} />
              <div className="col-span-2">
                <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
                  Recomendado: <b>{sizing.batteryKwh}</b> kWh (según respaldo). Costo est.:{" "}
                  <b>${sizing.batteryCost.toLocaleString()}</b>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="text-sm font-semibold text-gray-800">Total estimado</div>
              <div className="mt-2 text-2xl font-semibold">
                ${sizing.totalWithBattery.toLocaleString()}
              </div>
              <div className="mt-1 text-xs text-gray-600">
                PV + batería (estimado preliminar). Validación final requiere inspección.
              </div>
            </div>
          </div>
        </section>
      </div>

      <footer className="mt-8 text-xs text-gray-500">
        Tip: Si en móvil se queda “Procesando OCR…” revisa el Console del navegador (DevTools) — el OCR corre del lado del cliente.
      </footer>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="block">
      <div className="text-sm font-medium text-gray-700">{label}</div>
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full rounded-xl border border-gray-300 px-3 py-3 text-base outline-none focus:border-gray-900"
      />
    </label>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="text-xs text-gray-600">{label}</div>
      <div className="mt-1 text-lg font-semibold text-gray-900">{value}</div>
      {sub ? <div className="mt-1 text-xs text-gray-500">{sub}</div> : null}
    </div>
  );
}

