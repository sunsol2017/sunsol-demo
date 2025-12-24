"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type OcrSummary = {
  detectedAll: number[]; // en orden izquierda->derecha (los que pasen filtro)
  used12MostRecent: number[]; // últimos 12 (o menos si hay <12)
  monthsUsed: number; // cantidad usada en el cálculo
  annualKwh: number; // 12m real o estimado
  avgMonthlyKwh: number; // anual/12
  confidencePct: number; // promedio confidencias (aprox)
  status: "idle" | "working" | "ok" | "insufficient" | "error";
  message?: string;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function formatCurrency(n: number) {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function formatNumber(n: number, digits = 2) {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

async function fileToBitmap(file: File): Promise<ImageBitmap> {
  // createImageBitmap es rápido y respeta orientación en la mayoría de browsers modernos
  return await createImageBitmap(file);
}

function canvasFromBitmap(bitmap: ImageBitmap, maxDim = 1600): HTMLCanvasElement {
  const w = bitmap.width;
  const h = bitmap.height;

  const scale = Math.min(1, maxDim / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);

  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;

  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("No canvas context");
  ctx.drawImage(bitmap, 0, 0, cw, ch);
  return c;
}

function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("No canvas context");
  ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

function getLumaAt(data: Uint8ClampedArray, idx: number) {
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function binarizeInPlace(c: HTMLCanvasElement) {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;

  // Binarización simple + contraste: texto negro sobre fondo blanco
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    // umbral: ajustado para labels negros en fondo blanco
    const v = l < 170 ? 0 : 255;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

function scaleCanvas(src: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("No canvas context");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * Encuentra bounds del "plot" (zona con barras) dentro de un recorte rough.
 * La idea: detectar densidad de pixeles oscuros en una banda vertical/horizontal
 * y recortar a donde realmente están las barras, evitando el eje Y y márgenes.
 */
function findPlotBounds(rough: HTMLCanvasElement) {
  const ctx = rough.getContext("2d");
  if (!ctx) throw new Error("No canvas context");

  const w = rough.width;
  const h = rough.height;

  // Área donde esperamos barras (evita encabezado y pie)
  const y0 = Math.floor(h * 0.10);
  const y1 = Math.floor(h * 0.95);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  const xScore = new Array<number>(w).fill(0);
  const yScore = new Array<number>(h).fill(0);

  // muestreo más liviano
  const xStep = 2;
  const yStep = 3;

  // Score por columna (densidad de oscuro)
  for (let x = 0; x < w; x += xStep) {
    let s = 0;
    for (let y = y0; y < y1; y += yStep) {
      const idx = (y * w + x) * 4;
      const l = getLumaAt(d, idx);
      if (l < 175) s++; // "oscuro"
    }
    xScore[x] = s;
  }

  // Score por fila (densidad de oscuro)
  const xA = Math.floor(w * 0.05);
  const xB = Math.floor(w * 0.95);
  for (let y = 0; y < h; y += yStep) {
    let s = 0;
    for (let x = xA; x < xB; x += xStep) {
      const idx = (y * w + x) * 4;
      const l = getLumaAt(d, idx);
      if (l < 175) s++;
    }
    yScore[y] = s;
  }

  const xMax = Math.max(...xScore);
  const yMax = Math.max(...yScore);

  // thresholds adaptativos
  const xTh = Math.max(6, xMax * 0.30);
  const yTh = Math.max(10, yMax * 0.30);

  let xmin = 0;
  while (xmin < w && xScore[xmin] < xTh) xmin++;
  let xmax = w - 1;
  while (xmax >= 0 && xScore[xmax] < xTh) xmax--;

  let ymin = 0;
  while (ymin < h && yScore[ymin] < yTh) ymin++;
  let ymax = h - 1;
  while (ymax >= 0 && yScore[ymax] < yTh) ymax--;

  // Si falló (no encontró nada coherente), devuelve todo
  if (xmin >= xmax || ymin >= ymax) {
    return { x: 0, y: 0, w, h };
  }

  // padding (para no cortar barras/labels)
  const padX = Math.round((xmax - xmin) * 0.04);
  const padY = Math.round((ymax - ymin) * 0.06);

  xmin = clamp(xmin - padX, 0, w - 1);
  xmax = clamp(xmax + padX, 0, w - 1);
  ymin = clamp(ymin - padY, 0, h - 1);
  ymax = clamp(ymax + padY, 0, h - 1);

  return { x: xmin, y: ymin, w: xmax - xmin + 1, h: ymax - ymin + 1 };
}

/**
 * Recorte rough: asume página completa. Si la imagen ya es "solo gráfica", igual funciona.
 */
function roughCropForLumaPage(full: HTMLCanvasElement) {
  const w = full.width;
  const h = full.height;

  // Si es landscape (posible screenshot ya recortado), usa casi todo
  const landscape = w > h * 1.1;
  if (landscape) {
    return cropCanvas(full, Math.round(w * 0.02), Math.round(h * 0.05), Math.round(w * 0.96), Math.round(h * 0.90));
  }

  // Portrait (foto de página completa): la gráfica suele estar en la mitad inferior
  return cropCanvas(full, Math.round(w * 0.03), Math.round(h * 0.38), Math.round(w * 0.94), Math.round(h * 0.48));
}

/**
 * Encuentra el "top" de la barra en un segmento vertical (para cortar justo arriba y leer solo el label).
 */
function findBarTopY(
  ctx: CanvasRenderingContext2D,
  segX0: number,
  segX1: number,
  yTop: number,
  yBottom: number
): number | null {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const x0 = clamp(Math.floor(segX0), 0, w - 1);
  const x1 = clamp(Math.floor(segX1), 0, w - 1);
  const yt = clamp(Math.floor(yTop), 0, h - 1);
  const yb = clamp(Math.floor(yBottom), 0, h - 1);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // muestrea 9 puntos en X dentro del segmento
  const samples = 9;
  const xs: number[] = [];
  for (let i = 0; i < samples; i++) {
    const x = Math.round(x0 + (i / (samples - 1)) * (x1 - x0));
    xs.push(x);
  }

  // sube desde abajo hasta encontrar "muchos oscuros" (barra)
  for (let y = yb; y >= yt; y -= 1) {
    let dark = 0;
    for (const x of xs) {
      const idx = (y * w + x) * 4;
      const l = getLumaAt(d, idx);
      if (l < 165) dark++;
    }
    if (dark >= Math.ceil(samples * 0.45)) {
      // primera fila donde se ve la barra -> top aproximado
      // sigue subiendo un poquito para encontrar el borde superior real
      let y2 = y;
      for (let k = 0; k < 8 && y2 > yt; k++) {
        const yTry = y2 - 1;
        let dark2 = 0;
        for (const x of xs) {
          const idx = (yTry * w + x) * 4;
          const l = getLumaAt(d, idx);
          if (l < 165) dark2++;
        }
        if (dark2 >= Math.ceil(samples * 0.45)) y2 = yTry;
        else break;
      }
      return y2;
    }
  }
  return null;
}

/**
 * Construye ROIs encima de cada barra (13 columnas), y OCR por ROI.
 * Devuelve números en orden izq->der.
 */
async function ocrLumaBarLabels(plotCanvas: HTMLCanvasElement): Promise<{ values: number[]; confidences: number[]; roiStrip?: string }> {
  // Tesseract worker (dinámico para evitar líos SSR/turbopack)
  const worker = await getTesseractWorker();

  const ctx = plotCanvas.getContext("2d");
  if (!ctx) throw new Error("No canvas context");

  const w = plotCanvas.width;
  const h = plotCanvas.height;

  // Área vertical donde están barras (evita header y eje inferior)
  const barsTop = Math.round(h * 0.18);
  const barsBottom = Math.round(h * 0.90);

  const barCount = 13; // LUMA usualmente 13 meses
  const padX = Math.round(w * 0.02);

  const rois: HTMLCanvasElement[] = [];
  const values: number[] = [];
  const confs: number[] = [];

  for (let i = 0; i < barCount; i++) {
    // segmento por barra (uniforme). Funciona bien con gráficas estándar de LUMA.
    const segX0 = padX + (i / barCount) * (w - 2 * padX);
    const segX1 = padX + ((i + 1) / barCount) * (w - 2 * padX);

    const topY = findBarTopY(ctx, segX0, segX1, barsTop, barsBottom);
    if (topY == null) continue;

    const labelH = Math.max(28, Math.round(h * 0.12));
    const roiY = clamp(topY - labelH - 2, 0, h - 1);
    const roiH = clamp(labelH, 10, h);

    const roiX = clamp(segX0 + (segX1 - segX0) * 0.10, 0, w - 1);
    const roiW = clamp((segX1 - segX0) * 0.80, 10, w);

    let roi = cropCanvas(plotCanvas, roiX, roiY, roiW, roiH);

    // Preprocess: agranda + binariza
    roi = scaleCanvas(roi, 2);
    binarizeInPlace(roi);

    rois.push(roi);

    const res = await worker.recognize(roi);
    const text = (res?.data?.text ?? "").trim();

    // Extract solo dígitos (kWh)
    // (tesseract a veces mete espacios o cosas raras)
    const m = text.replace(/[^\d]/g, " ").match(/\d{2,4}/);
    if (!m) continue;

    const n = parseInt(m[0], 10);
    // filtro 20–3000 (según tu regla)
    if (isFinite(n) && n >= 20 && n <= 3000) {
      values.push(n);
      const c = typeof res?.data?.confidence === "number" ? res.data.confidence : 0;
      confs.push(c);
    }
  }

  // Debug strip (ROIs concatenadas) para ver qué está leyendo el OCR
  let roiStrip: string | undefined;
  if (rois.length > 0) {
    const strip = document.createElement("canvas");
    const gap = 6;
    const roiH = Math.max(...rois.map((c) => c.height));
    const roiWsum = rois.reduce((s, c) => s + c.width, 0) + gap * (rois.length - 1);
    strip.width = Math.min(2200, roiWsum); // evita mega-dataurl
    strip.height = roiH;

    const sctx = strip.getContext("2d");
    if (sctx) {
      sctx.fillStyle = "#ffffff";
      sctx.fillRect(0, 0, strip.width, strip.height);

      let x = 0;
      for (const r of rois) {
        if (x + r.width > strip.width) break;
        sctx.drawImage(r, x, 0);
        x += r.width + gap;
      }
      roiStrip = strip.toDataURL("image/jpeg", 0.9);
    }
  }

  return { values, confidences: confs, roiStrip };
}

/**
 * Worker Tesseract robusto (arregla el error tipo "loadLanguage is not a function")
 */
async function getTesseractWorker(): Promise<any> {
  const g = globalThis as any;
  if (g.__LUMA_TESS_WORKER) return g.__LUMA_TESS_WORKER;

  const mod: any = await import("tesseract.js");
  const createWorker =
    mod.createWorker ?? mod.default?.createWorker ?? mod.default;

  if (!createWorker) {
    throw new Error("tesseract.js: no se encontró createWorker");
  }

  let worker: any;
  try {
    worker = await createWorker({
      logger: () => {},
    });
  } catch {
    // fallback por si la firma es distinta
    worker = await createWorker("eng", 1, {
      logger: () => {},
    });
  }

  // init compatible con varias versiones
  if (worker.load) await worker.load();
  if (worker.loadLanguage) await worker.loadLanguage("eng");
  if (worker.initialize) await worker.initialize("eng");
  if (worker.setParameters) {
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      tessedit_pageseg_mode: "7", // SINGLE_LINE
    });
  }

  g.__LUMA_TESS_WORKER = worker;
  return worker;
}

export default function Page() {
  // Inputs del modelo
  const [offsetPct, setOffsetPct] = useState(90);
  const [psh, setPsh] = useState(5);
  const [lossFactor, setLossFactor] = useState(0.8);
  const [panelW, setPanelW] = useState(450);

  const [roofType, setRoofType] = useState<"Shingle" | "Metal" | "Concrete">("Shingle");
  const [permits, setPermits] = useState(1200);
  const [interconnection, setInterconnection] = useState(450);
  const [installedPricePerW, setInstalledPricePerW] = useState(2.3);

  // Battery
  const SOLUNA_PRICE_PER_KWH = 350;
  const BATTERY_USABLE_FACTOR = 0.9;

  const [backupHours, setBackupHours] = useState(8);
  const [criticalKw, setCriticalKw] = useState(1.5);

  // Consumo (manual u OCR)
  const [monthlyKwhInput, setMonthlyKwhInput] = useState<string>("");

  // Imagen + previews
  const [rawPreview, setRawPreview] = useState<string>("");
  const [plotPreview, setPlotPreview] = useState<string>("");
  const [roiPreview, setRoiPreview] = useState<string>("");

  const [ocr, setOcr] = useState<OcrSummary>({ detectedAll: [], used12MostRecent: [], monthsUsed: 0, annualKwh: 0, avgMonthlyKwh: 0, confidencePct: 0, status: "idle" });
  const [busy, setBusy] = useState(false);

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const roofAdderPerW = useMemo(() => {
    // Ajusta estos adders a tu realidad si quieres
    if (roofType === "Metal") return 0.08;
    if (roofType === "Concrete") return 0.18;
    return 0.0;
  }, [roofType]);

  const monthlyKwh = useMemo(() => {
    const n = parseFloat(monthlyKwhInput);
    return isFinite(n) ? n : 0;
  }, [monthlyKwhInput]);

  const annualKwh = useMemo(() => monthlyKwh * 12, [monthlyKwh]);

  const pvSizing = useMemo(() => {
    const eff = Math.max(0.1, lossFactor);
    const sun = Math.max(0.1, psh);
    const offset = clamp(offsetPct, 0, 100) / 100;

    const targetAnnual = annualKwh * offset;
    const kwhPerKwYear = sun * 365 * eff;
    const kwNeeded = kwhPerKwYear > 0 ? targetAnnual / kwhPerKwYear : 0;

    const panels = panelW > 0 ? Math.max(0, Math.ceil((kwNeeded * 1000) / panelW)) : 0;
    const systemKw = panels * panelW / 1000;

    const basePvCost = systemKw * 1000 * installedPricePerW;
    const roofAdderCost = systemKw * 1000 * roofAdderPerW;
    const sub = basePvCost + roofAdderCost + permits + interconnection;
    const misc = sub * 0.03;
    const totalPv = sub + misc;

    return { targetAnnual, kwNeeded, panels, systemKw, basePvCost, roofAdderCost, misc, totalPv };
  }, [annualKwh, offsetPct, psh, lossFactor, panelW, installedPricePerW, roofAdderPerW, permits, interconnection]);

  const batterySizing = useMemo(() => {
    const req = (criticalKw * backupHours) / Math.max(0.1, BATTERY_USABLE_FACTOR);
    const options = [10, 16, 20, 32, 40, 48, 60, 80, 100];
    const pick = options.find((x) => x >= req) ?? options[options.length - 1];
    const cost = pick * SOLUNA_PRICE_PER_KWH;
    return { requiredKwh: req, recommendedKwh: pick, batteryCost: cost };
  }, [criticalKw, backupHours]);

  const totalWithBattery = useMemo(() => pvSizing.totalPv + batterySizing.batteryCost, [pvSizing.totalPv, batterySizing.batteryCost]);

  async function processFile(file: File) {
    setBusy(true);
    setOcr({ detectedAll: [], used12MostRecent: [], monthsUsed: 0, annualKwh: 0, avgMonthlyKwh: 0, confidencePct: 0, status: "working" });

    try {
      const bmp = await fileToBitmap(file);
      const full = canvasFromBitmap(bmp, 1600);

      setRawPreview(full.toDataURL("image/jpeg", 0.9));

      // 1) rough crop
      const rough = roughCropForLumaPage(full);

      // 2) find plot bounds inside rough
      const b = findPlotBounds(rough);
      const plot = cropCanvas(rough, b.x, b.y, b.w, b.h);
      setPlotPreview(plot.toDataURL("image/jpeg", 0.9));

      // 3) OCR bar labels only
      const { values, confidences, roiStrip } = await ocrLumaBarLabels(plot);
      if (roiStrip) setRoiPreview(roiStrip);

      // values ya vienen filtrados 20–3000 y en orden izq->der (según ROIs válidos)
      // si se “perdió” alguno, igual usamos los que haya (mínimo 4)
      const detectedAll = values.slice();

      // usa 12 más recientes (derecha)
      const used = detectedAll.length > 12 ? detectedAll.slice(detectedAll.length - 12) : detectedAll.slice();
      const monthsUsed = used.length;

      if (monthsUsed < 4) {
        setOcr({
          detectedAll,
          used12MostRecent: used,
          monthsUsed,
          annualKwh: 0,
          avgMonthlyKwh: 0,
          confidencePct: 0,
          status: "insufficient",
          message: "OCR insuficiente: se detectaron menos de 4 meses. Toma la foto más nítida y completa (página 4), o escribe el kWh mensual promedio.",
        });
        return;
      }

      const sum = used.reduce((a, b) => a + b, 0);
      const avg = sum / monthsUsed;
      const annual = monthsUsed >= 12 ? sum : avg * 12;

      const conf = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;

      setOcr({
        detectedAll,
        used12MostRecent: used,
        monthsUsed: Math.min(12, monthsUsed),
        annualKwh: annual,
        avgMonthlyKwh: annual / 12,
        confidencePct: clamp(conf, 0, 100),
        status: "ok",
        message: monthsUsed >= 12 ? "OK. Anual (12m real) y promedio mensual calculados desde la gráfica." : "OK. Anual estimado usando los meses disponibles (>=4).",
      });

      // llena el input mensual con el promedio calculado
      setMonthlyKwhInput(formatNumber(annual / 12, 2));
    } catch (e: any) {
      setOcr({
        detectedAll: [],
        used12MostRecent: [],
        monthsUsed: 0,
        annualKwh: 0,
        avgMonthlyKwh: 0,
        confidencePct: 0,
        status: "error",
        message: e?.message ? String(e.message) : "Error OCR",
      });
    } finally {
      setBusy(false);
    }
  }

  function onPickFile(file?: File | null) {
    if (!file) return;
    void processFile(file);
  }

  function clearAll() {
    setRawPreview("");
    setPlotPreview("");
    setRoiPreview("");
    setMonthlyKwhInput("");
    setOcr({ detectedAll: [], used12MostRecent: [], monthsUsed: 0, annualKwh: 0, avgMonthlyKwh: 0, confidencePct: 0, status: "idle" });
  }

  const commercialLikely = useMemo(() => {
    if (!monthlyKwh || !isFinite(monthlyKwh)) return false;
    return monthlyKwh > 3000;
  }, [monthlyKwh]);

  useEffect(() => {
    // si el usuario escribe manualmente, no tocamos nada más
  }, [monthlyKwhInput]);

  return (
    <main className="min-h-screen bg-white text-slate-900">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Sunsol · Cotizador (sin vendedor)</h1>
          <p className="text-sm text-slate-600">
            PV: ${installedPricePerW.toFixed(2)}/W · Batería Soluna: ${SOLUNA_PRICE_PER_KWH}/kWh · Sin incentivos
          </p>
          <p className="text-xs text-slate-500">Estimado preliminar. Validación final requiere inspección.</p>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Uploader + Consumo */}
          <section className="rounded-2xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Foto / Screenshot de LUMA (página 4)</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Usa la página 4 donde aparece <span className="font-medium">“CONSUMPTION HISTORY (KWH)”</span> (o “Historial de consumo”).
                  Toma la <span className="font-medium">página completa</span>, nítida y sin reflejos.
                </p>
              </div>
            </div>

            {/* Inputs escondidos */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0])}
            />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0])}
            />

            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="w-full rounded-xl bg-black px-4 py-3 text-white shadow-sm disabled:opacity-60"
                disabled={busy}
              >
                📷 Tomar foto
              </button>

              <button
                type="button"
                onClick={() => galleryInputRef.current?.click()}
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-900 shadow-sm disabled:opacity-60"
                disabled={busy}
              >
                🖼️ Subir de galería
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 p-4">
              <label className="text-sm font-medium">Consumo mensual promedio (kWh/mes)</label>
              <input
                value={monthlyKwhInput}
                onChange={(e) => setMonthlyKwhInput(e.target.value)}
                placeholder="Ej. 600"
                inputMode="decimal"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-base outline-none focus:border-slate-500"
              />
              <p className="mt-2 text-sm text-slate-500">Si el OCR falla, escribe el promedio mensual aquí.</p>

              <div className="mt-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">Consumo anual:</span>
                  <span className="font-semibold">{ocr.status === "ok" ? `${formatNumber(ocr.annualKwh, 0)} kWh` : "— (sin OCR)"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">OCR confianza:</span>
                  <span className="font-semibold">{ocr.status === "ok" ? `${formatNumber(ocr.confidencePct, 1)}%` : "—"}</span>
                </div>
              </div>

              {commercialLikely && (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  ⚠️ Promedio mensual &gt; 3000 kWh. Probable caso comercial: requiere otro estimado de costos.
                </div>
              )}

              {(ocr.status === "insufficient" || ocr.status === "error") && (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {ocr.message}
                </div>
              )}

              {ocr.status === "working" && (
                <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  Procesando OCR…
                </div>
              )}

              {ocr.status === "ok" && (
                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                  ✅ {ocr.message}
                  <div className="mt-2">
                    <div className="font-medium">
                      Anual: {formatNumber(ocr.annualKwh, 0)} kWh · Promedio mensual: {formatNumber(ocr.annualKwh / 12, 2)} kWh
                    </div>
                    <div className="mt-1 text-xs text-emerald-900/80">
                      Usó {Math.min(12, ocr.used12MostRecent.length)} mes(es). (Detectados: {ocr.detectedAll.join(", ") || "—"})
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    // reprocesa usando el rawPreview no es posible, necesita el file; por UX dejamos que el usuario vuelva a tomar/subir
                    // (si quieres reprocesar exacto sin re-subir, habría que guardar el File en state)
                    // Aquí solo resetea mensajes para que el usuario re-intente.
                    setOcr((o) => ({ ...o, message: o.message }));
                  }}
                  className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm"
                  disabled={busy}
                >
                  🔁 Reprocesar OCR
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm"
                  disabled={busy}
                >
                  🧹 Limpiar
                </button>
              </div>
            </div>

            {/* Previews */}
            {(rawPreview || plotPreview || roiPreview) && (
              <div className="mt-4">
                <h3 className="text-sm font-semibold">Preview</h3>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-slate-200 p-2">
                    <div className="mb-2 text-xs text-slate-500">Página (raw)</div>
                    {rawPreview ? <img src={rawPreview} alt="raw" className="w-full rounded-lg" /> : <div className="text-xs text-slate-400">—</div>}
                  </div>

                  <div className="rounded-xl border border-slate-200 p-2">
                    <div className="mb-2 text-xs text-slate-500">Auto-crop (zona gráfica)</div>
                    {plotPreview ? <img src={plotPreview} alt="plot" className="w-full rounded-lg" /> : <div className="text-xs text-slate-400">—</div>}
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-slate-200 p-2">
                  <div className="mb-2 text-xs text-slate-500">Lo que OCR realmente lee (ROIs arriba de barras)</div>
                  {roiPreview ? <img src={roiPreview} alt="roi" className="w-full rounded-lg" /> : <div className="text-xs text-slate-400">—</div>}
                  <div className="mt-2 text-xs text-slate-500">
                    Nota: el auto-crop busca la zona de barras y el OCR solo intenta leer los numeritos arriba de cada barra (no el eje Y).
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Supuestos */}
          <section className="rounded-2xl border border-slate-200 p-4 shadow-sm">
            <h2 className="text-base font-semibold">Supuestos del sistema</h2>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-slate-700">Offset (%)</label>
                <input
                  type="number"
                  value={offsetPct}
                  onChange={(e) => setOffsetPct(parseFloat(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="text-sm text-slate-700">PSH</label>
                <input
                  type="number"
                  value={psh}
                  onChange={(e) => setPsh(parseFloat(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="text-sm text-slate-700">Pérdidas (factor)</label>
                <input
                  type="number"
                  step="0.01"
                  value={lossFactor}
                  onChange={(e) => setLossFactor(parseFloat(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="text-sm text-slate-700">Panel (W)</label>
                <input
                  type="number"
                  value={panelW}
                  onChange={(e) => setPanelW(parseFloat(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="text-sm text-slate-700">Techo</label>
                <select
                  value={roofType}
                  onChange={(e) => setRoofType(e.target.value as any)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
                >
                  <option>Shingle</option>
                  <option>Metal</option>
                  <option>Concrete</option>
                </select>
                <div className="mt-1 text-xs text-slate-500">Adder techo: ${roofAdderPerW.toFixed(2)}/W</div>
              </div>

              <div>
                <label className="text-sm text-slate-700">Permisos (est.)</label>
                <input
                  type="number"
                  value={permits}
                  onChange={(e) => setPermits(parseFloat(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="text-sm text-slate-700">Interconexión (est.)</label>
                <input
                  type="number"
                  value={interconnection}
                  onChange={(e) => setInterconnection(parseFloat(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="text-sm text-slate-700">Precio instalado ($/W)</label>
                <input
                  type="number"
                  step="0.01"
                  value={installedPricePerW}
                  onChange={(e) => setInstalledPricePerW(parseFloat(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
                />
                <div className="mt-1 text-xs text-slate-500">Fijo. Sin incentivos.</div>
              </div>
            </div>
          </section>

          {/* Resultado PV */}
          <section className="rounded-2xl border border-slate-200 p-4 shadow-sm">
            <h2 className="text-base font-semibold">⚡ Resultado PV</h2>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="text-xs text-slate-500">Consumo mensual</div>
                <div className="mt-1 text-xl font-semibold">{monthlyKwh ? `${formatNumber(monthlyKwh, 0)} kWh` : "—"}</div>
              </div>

              <div className="rounded-xl border border-slate-200 p-3">
                <div className="text-xs text-slate-500">Sistema recomendado</div>
                <div className="mt-1 text-xl font-semibold">{pvSizing.systemKw ? `${formatNumber(pvSizing.systemKw, 2)} kW` : "—"}</div>
                <div className="mt-1 text-xs text-slate-500">{pvSizing.panels ? `${pvSizing.panels} paneles (est.)` : ""}</div>
              </div>

              <div className="rounded-xl border border-slate-200 p-3">
                <div className="text-xs text-slate-500">PV (sin batería)</div>
                <div className="mt-1 text-xl font-semibold">{formatCurrency(pvSizing.totalPv)}</div>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 p-3 text-sm">
              <div className="flex justify-between"><span className="text-slate-600">Base PV</span><span>{formatCurrency(pvSizing.basePvCost)}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Adder techo</span><span>{formatCurrency(pvSizing.roofAdderCost)}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Permisos</span><span>{formatCurrency(permits)}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Interconexión</span><span>{formatCurrency(interconnection)}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Misceláneo (3%)</span><span>{formatCurrency(pvSizing.misc)}</span></div>
            </div>
          </section>

          {/* Batería */}
          <section className="rounded-2xl border border-slate-200 p-4 shadow-sm">
            <h2 className="text-base font-semibold">🔋 Batería</h2>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-slate-700">Horas de respaldo</label>
                <select
                  value={backupHours}
                  onChange={(e) => setBackupHours(parseFloat(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
                >
                  <option value={4}>4 horas</option>
                  <option value={6}>6 horas</option>
                  <option value={8}>8 horas</option>
                  <option value={10}>10 horas</option>
                  <option value={12}>12 horas</option>
                </select>
              </div>

              <div>
                <label className="text-sm text-slate-700">Cargas críticas (kW típico)</label>
                <select
                  value={criticalKw}
                  onChange={(e) => setCriticalKw(parseFloat(e.target.value))}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
                >
                  <option value={1.0}>1.0 kW</option>
                  <option value={1.5}>1.5 kW</option>
                  <option value={2.0}>2.0 kW</option>
                  <option value={2.5}>2.5 kW</option>
                  <option value={3.0}>3.0 kW</option>
                </select>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 p-3 text-sm">
              <div className="flex justify-between"><span className="text-slate-600">Necesario (aprox.)</span><span>{formatNumber(batterySizing.requiredKwh, 1)} kWh</span></div>
              <div className="mt-1 flex justify-between">
                <span className="text-slate-600">Recomendado</span>
                <span className="font-semibold">{batterySizing.recommendedKwh} kWh</span>
              </div>
              <div className="mt-1 flex justify-between"><span className="text-slate-600">Costo batería</span><span className="font-semibold">{formatCurrency(batterySizing.batteryCost)}</span></div>
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Total PV + Batería</div>
              <div className="mt-1 text-2xl font-semibold">{formatCurrency(totalWithBattery)}</div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
