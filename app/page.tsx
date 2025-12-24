"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Sunsol demo – Quote calculator (no login)
 * OCR: LUMA Page 4 "CONSUMPTION HISTORY (KWH)" bar chart
 *
 * Key rules:
 * - Auto-crop by default (no manual crop UI)
 * - Discard Y axis regardless of its numbers (remove left axis by detection)
 * - Consider ONLY numbers above bars (top region)
 * - Candidate filter: 20–3000
 * - Use 12 most recent (right-most). If fewer but >=4: estimate annual = avg * 12
 */

const PV_PRICE_PER_W = 2.3; // installed $/W
const SOLUNA_PRICE_PER_KWH = 350; // $/kWh
const DAYS_PER_MONTH = 30.4;
const BATTERY_USABLE_FACTOR = 0.9; // usable fraction
const MIN_MONTHS_FOR_OCR = 4;
const OCR_MIN_KWH = 20;
const OCR_MAX_KWH = 3000;

const ROOF_ADDER: Record<string, number> = {
  Shingle: 0,
  Metal: 750,
  "Flat/Concrete": 1200,
  Tile: 1500,
  Other: 800,
};

const CRITICAL_LOAD_OPTIONS = [
  { label: "1.5 kW (típico)", value: 1.5 },
  { label: "3.0 kW", value: 3.0 },
  { label: "5.0 kW", value: 5.0 },
  { label: "7.5 kW", value: 7.5 },
];

const BACKUP_HOURS_OPTIONS = [4, 8, 12];

const BATTERY_OPTIONS_KWH = [5, 10, 16, 20, 32, 40];

type BBox = { x0: number; y0: number; x1: number; y1: number };
type OcrToken = { text: string; value?: number; conf: number; bbox: BBox };

type OcrSummary = {
  ok: boolean;
  message?: string;

  // extracted monthly kWh series (right-most up to 12)
  monthsUsed: number;
  valuesUsed: number[];
  valuesDetected: number[];
  avgMonthly: number | null;
  annualKWh: number | null;
  avgConfidence: number | null;

  // debug images
  rawDataUrl?: string;
  chartCropDataUrl?: string;
  labelsCropDataUrl?: string;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function formatMoney(n: number) {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function canvasToDataUrl(canvas: HTMLCanvasElement, quality = 0.92) {
  try {
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return undefined;
  }
}

async function fileToImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("No se pudo cargar la imagen."));
    });
    return img;
  } finally {
    // revoke later (after image is loaded)
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

function drawImageToCanvas(img: HTMLImageElement, maxW = 1800): HTMLCanvasElement {
  const ratio = img.width / img.height;
  const w = img.width > maxW ? maxW : img.width;
  const h = Math.round(w / ratio);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.floor(w));
  c.height = Math.max(1, Math.floor(h));
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.drawImage(src, x, y, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

/**
 * Find the horizontal band for the chart title bar by scanning downscaled grayscale rows.
 * Works even if numbers on Y axis change.
 */
function findChartTitleBandY(src: HTMLCanvasElement) {
  const W = src.width;
  const H = src.height;

  // Downscale for speed
  const targetW = 420;
  const scale = targetW / W;
  const w = Math.min(targetW, W);
  const h = Math.max(1, Math.round(H * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;

  const ctx = c.getContext("2d");
  if (!ctx) return Math.round(H * 0.58);
  ctx.drawImage(src, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  const rowMean = new Float32Array(h);
  const rowStd = new Float32Array(h);
  const rowLightFrac = new Float32Array(h);

  for (let y = 0; y < h; y++) {
    let sum = 0;
    let sumSq = 0;
    let light = 0;

    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum;
      sumSq += lum * lum;

      // "light gray" band tends to be ~210-245; white (255) excluded by upper bound below
      if (lum >= 200 && lum <= 246) light++;
    }
    const mean = sum / w;
    const varr = sumSq / w - mean * mean;
    const std = Math.sqrt(Math.max(0, varr));

    rowMean[y] = mean;
    rowStd[y] = std;
    rowLightFrac[y] = light / w;
  }

  // Moving window average
  const win = 7;
  function winAvg(arr: Float32Array, y: number) {
    let s = 0;
    let c = 0;
    for (let k = -Math.floor(win / 2); k <= Math.floor(win / 2); k++) {
      const yy = y + k;
      if (yy >= 0 && yy < h) {
        s += arr[yy];
        c++;
      }
    }
    return c ? s / c : arr[y];
  }

  const yMin = Math.round(h * 0.35);
  const yMax = Math.round(h * 0.85);

  let bestY = Math.round(h * 0.60);
  let bestScore = -1e9;

  for (let y = yMin; y <= yMax; y++) {
    const mean = winAvg(rowMean, y);
    const std = winAvg(rowStd, y);
    const frac = winAvg(rowLightFrac, y);

    // Score a "light gray bar with some text" (not pure white)
    // We want: high light fraction, mean near ~230, and relatively low std (uniform-ish).
    const meanPenalty = Math.abs(mean - 232) / 90; // 0..~1
    const stdPenalty = std / 35; // 0..~1+
    const score = frac * 2.2 - meanPenalty - stdPenalty;

    // Keep only plausible rows
    if (frac < 0.35) continue;
    if (mean < 190 || mean > 250) continue;

    if (score > bestScore) {
      bestScore = score;
      bestY = y;
    }
  }

  // Convert downscaled Y back to original canvas coordinates
  const yOrig = Math.round(bestY / scale);
  return clamp(yOrig, Math.round(H * 0.40), Math.round(H * 0.80));
}

/**
 * Detect the Y-axis vertical line position inside a chart crop (left side).
 * We count dark pixels in the TOP portion (to avoid bars) and pick the strongest vertical line.
 */
function findYAxisX(chart: HTMLCanvasElement) {
  const W = chart.width;
  const H = chart.height;
  const ctx = chart.getContext("2d");
  if (!ctx) return Math.round(W * 0.08);

  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  const xMaxSearch = Math.round(W * 0.22);
  const yTop = 0;
  const yBottom = Math.round(H * 0.45); // avoid bars (bars are lower)

  let bestX = Math.round(W * 0.08);
  let bestCount = -1;

  for (let x = 0; x < xMaxSearch; x++) {
    let cnt = 0;
    for (let y = yTop; y < yBottom; y++) {
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum < 90) cnt++;
    }
    if (cnt > bestCount) {
      bestCount = cnt;
      bestX = x;
    }
  }

  return clamp(bestX, 0, Math.round(W * 0.25));
}

/**
 * Enhance canvas for OCR: upscale + grayscale + contrast + binarize.
 */
function enhanceForOcr(src: HTMLCanvasElement, upscale = 2): HTMLCanvasElement {
  const W = src.width;
  const H = src.height;

  const c = document.createElement("canvas");
  c.width = W * upscale;
  c.height = H * upscale;
  const ctx = c.getContext("2d");
  if (!ctx) return src;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, c.width, c.height);

  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;

  // Simple contrast + threshold
  // (Works well on printed grayscale charts)
  const contrast = 1.25;
  const threshold = 210;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // contrast around mid
    lum = (lum - 128) * contrast + 128;
    lum = clamp(lum, 0, 255);

    // binarize
    const v = lum > threshold ? 255 : 0;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return c;
}

function mergeAdjacentDigitTokens(tokens: OcrToken[]) {
  // Keep only digit-like tokens (including single digits for merges)
  const digitTokens = tokens
    .filter((t) => /^\d+$/.test(t.text))
    .map((t) => ({
      ...t,
      // normalize bbox
      bbox: {
        x0: t.bbox.x0,
        y0: t.bbox.y0,
        x1: t.bbox.x1,
        y1: t.bbox.y1,
      },
    }));

  // Cluster by y-mid (same "row")
  const rows: OcrToken[][] = [];
  const yTol = 18; // px tolerance after OCR scaling

  const sorted = digitTokens.sort((a, b) => {
    const ay = (a.bbox.y0 + a.bbox.y1) / 2;
    const by = (b.bbox.y0 + b.bbox.y1) / 2;
    if (Math.abs(ay - by) > yTol) return ay - by;
    return a.bbox.x0 - b.bbox.x0;
  });

  for (const t of sorted) {
    const ty = (t.bbox.y0 + t.bbox.y1) / 2;
    let placed = false;
    for (const row of rows) {
      const ry = (row[0].bbox.y0 + row[0].bbox.y1) / 2;
      if (Math.abs(ty - ry) <= yTol) {
        row.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([t]);
  }

  const merged: OcrToken[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.bbox.x0 - b.bbox.x0);

    let cur: OcrToken | null = null;
    for (const t of row) {
      if (!cur) {
        cur = { ...t };
        continue;
      }

      const gap = t.bbox.x0 - cur.bbox.x1;
      const sameLine = Math.abs(((t.bbox.y0 + t.bbox.y1) / 2) - ((cur.bbox.y0 + cur.bbox.y1) / 2)) <= yTol;

      // Merge if very close (digits from same number)
      const gapTol = 14; // px
      if (sameLine && gap >= -2 && gap <= gapTol && (cur.text.length + t.text.length) <= 4) {
        cur = {
          text: `${cur.text}${t.text}`,
          conf: (cur.conf + t.conf) / 2,
          bbox: {
            x0: Math.min(cur.bbox.x0, t.bbox.x0),
            y0: Math.min(cur.bbox.y0, t.bbox.y0),
            x1: Math.max(cur.bbox.x1, t.bbox.x1),
            y1: Math.max(cur.bbox.y1, t.bbox.y1),
          },
        };
      } else {
        merged.push(cur);
        cur = { ...t };
      }
    }
    if (cur) merged.push(cur);
  }

  // Convert to values + filter length 2..4
  const out = merged
    .filter((t) => t.text.length >= 2 && t.text.length <= 4)
    .map((t) => ({ ...t, value: parseInt(t.text, 10) }));

  return out;
}

function dedupeByX(tokens: OcrToken[]) {
  // Dedupe by x-center buckets (keep highest confidence)
  const buckets: Record<string, OcrToken> = {};
  for (const t of tokens) {
    const xc = (t.bbox.x0 + t.bbox.x1) / 2;
    const key = String(Math.round(xc / 18)); // bucket size
    const existing = buckets[key];
    if (!existing || t.conf > existing.conf) buckets[key] = t;
  }
  return Object.values(buckets).sort((a, b) => (a.bbox.x0 + a.bbox.x1) / 2 - (b.bbox.x0 + b.bbox.x1) / 2);
}

async function runTesseractOnCanvas(canvas: HTMLCanvasElement) {
  const mod: any = await import("tesseract.js");
  const T = mod?.default ?? mod;

  const recognize = T?.recognize ?? mod?.recognize;
  if (typeof recognize !== "function") {
    throw new Error("Tesseract no está disponible. Verifica que instalaste: npm i tesseract.js");
  }

  const result = await recognize(canvas, "eng", {
    logger: () => {},
    tessedit_char_whitelist: "0123456789",
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });

  const data = result?.data ?? {};
  const words = (data.words ?? []) as any[];

  const tokens: OcrToken[] = words
    .filter((w) => typeof w.text === "string" && w.text.trim().length > 0)
    .map((w) => ({
      text: w.text.trim(),
      conf: typeof w.confidence === "number" ? w.confidence : 0,
      bbox: {
        x0: w.bbox?.x0 ?? 0,
        y0: w.bbox?.y0 ?? 0,
        x1: w.bbox?.x1 ?? 0,
        y1: w.bbox?.y1 ?? 0,
      },
    }));

  return { tokens, rawText: String(data.text ?? "") };
}

async function extractMonthlyKwhFromLumaPage(rawCanvas: HTMLCanvasElement): Promise<OcrSummary> {
  try {
    const W = rawCanvas.width;
    const H = rawCanvas.height;

    // 1) Find chart title band Y (gray bar area)
    const yBand = findChartTitleBandY(rawCanvas);

    // 2) Crop a region around chart area (from slightly above the gray bar down)
    const topPad = Math.round(H * 0.01);
    const y1 = clamp(yBand - topPad, Math.round(H * 0.35), Math.round(H * 0.80));
    const y2 = Math.round(H * 0.95);
    const chartRegion = cropCanvas(rawCanvas, 0, y1, W, y2 - y1);

    // 3) Remove left area until after the Y axis line
    const axisX = findYAxisX(chartRegion);
    const leftCut = clamp(axisX + 12, 0, Math.round(chartRegion.width * 0.25));
    const chartNoAxis = cropCanvas(chartRegion, leftCut, 0, chartRegion.width - leftCut, chartRegion.height);

    // 4) Focus OCR only on the TOP portion where bar labels sit (avoid bottom line-chart area)
    const labelsHeight = Math.round(chartNoAxis.height * 0.62);
    const labelsRegion = cropCanvas(chartNoAxis, 0, 0, chartNoAxis.width, labelsHeight);

    // 5) Enhance + OCR
    const enhanced = enhanceForOcr(labelsRegion, 2);
    const { tokens } = await runTesseractOnCanvas(enhanced);

    // Merge split digits and dedupe by x position
    const merged = mergeAdjacentDigitTokens(tokens);
    const deduped = dedupeByX(merged);

    // Position-based filtering (discard anything too far left = residual axis numbers, if any)
    const cropW = enhanced.width;
    const cropH = enhanced.height;

    const candidates = deduped
      .filter((t) => typeof t.value === "number" && isFinite(t.value!))
      .filter((t) => {
        const v = t.value!;
        if (v < OCR_MIN_KWH || v > OCR_MAX_KWH) return false;

        const x0 = t.bbox.x0;
        const y0 = t.bbox.y0;

        // discard far-left (axis) and very bottom/top noise
        if (x0 < cropW * 0.06) return false;
        if (y0 < cropH * 0.02) return false;
        if (y0 > cropH * 0.92) return false;

        return true;
      });

    const detectedValues = candidates.map((c) => c.value!) as number[];

    // Sort by x-center left->right
    const byX = candidates
      .slice()
      .sort((a, b) => ((a.bbox.x0 + a.bbox.x1) / 2) - ((b.bbox.x0 + b.bbox.x1) / 2));

    // Take up to 13 bars max, then use 12 most recent (right-most)
    const valuesOrdered = byX.map((t) => t.value!) as number[];

    // Remove obvious duplicates (sometimes OCR repeats same label)
    const uniqueOrdered: number[] = [];
    for (const v of valuesOrdered) {
      if (uniqueOrdered.length === 0) uniqueOrdered.push(v);
      else {
        const last = uniqueOrdered[uniqueOrdered.length - 1];
        if (Math.abs(last - v) <= 1) continue; // near-duplicate
        uniqueOrdered.push(v);
      }
    }

    const valuesForCalc = uniqueOrdered.length > 12 ? uniqueOrdered.slice(-12) : uniqueOrdered;

    if (valuesForCalc.length < MIN_MONTHS_FOR_OCR) {
      return {
        ok: false,
        message: `OCR insuficiente: se detectaron menos de ${MIN_MONTHS_FOR_OCR} meses. Toma la foto más nítida y completa (página 4), o escribe el kWh mensual promedio.`,
        monthsUsed: valuesForCalc.length,
        valuesUsed: valuesForCalc,
        valuesDetected: uniqueOrdered,
        avgMonthly: null,
        annualKWh: null,
        avgConfidence: null,
        rawDataUrl: canvasToDataUrl(rawCanvas),
        chartCropDataUrl: canvasToDataUrl(chartNoAxis),
        labelsCropDataUrl: canvasToDataUrl(enhanced),
      };
    }

    const avgMonthly = valuesForCalc.reduce((a, b) => a + b, 0) / valuesForCalc.length;
    const annualKWh =
      valuesForCalc.length >= 12
        ? valuesForCalc.reduce((a, b) => a + b, 0)
        : avgMonthly * 12;

    const confAvg =
      candidates.length > 0 ? candidates.reduce((a, t) => a + t.conf, 0) / candidates.length : null;

    return {
      ok: true,
      message: undefined,
      monthsUsed: valuesForCalc.length,
      valuesUsed: valuesForCalc,
      valuesDetected: uniqueOrdered,
      avgMonthly: round2(avgMonthly),
      annualKWh: Math.round(annualKWh),
      avgConfidence: confAvg !== null ? round2(confAvg) : null,
      rawDataUrl: canvasToDataUrl(rawCanvas),
      chartCropDataUrl: canvasToDataUrl(chartNoAxis),
      labelsCropDataUrl: canvasToDataUrl(enhanced),
    };
  } catch (e: any) {
    return {
      ok: false,
      message: e?.message ?? "Error corriendo OCR.",
      monthsUsed: 0,
      valuesUsed: [],
      valuesDetected: [],
      avgMonthly: null,
      annualKWh: null,
      avgConfidence: null,
    };
  }
}

function recommendBatteryKwh(criticalKw: number, hours: number) {
  const requiredUsable = criticalKw * hours; // kWh
  const requiredNominal = requiredUsable / BATTERY_USABLE_FACTOR;
  const pick = BATTERY_OPTIONS_KWH.find((k) => k >= requiredNominal) ?? BATTERY_OPTIONS_KWH[BATTERY_OPTIONS_KWH.length - 1];
  return { requiredNominal: round2(requiredNominal), pick };
}

export default function Page() {
  // Upload refs
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  // OCR state
  const [ocr, setOcr] = useState<OcrSummary>({
    ok: false,
    monthsUsed: 0,
    valuesUsed: [],
    valuesDetected: [],
    avgMonthly: null,
    annualKWh: null,
    avgConfidence: null,
  });
  const [ocrBusy, setOcrBusy] = useState(false);

  // Manual override (monthly average)
  const [manualMonthly, setManualMonthly] = useState<string>("");

  // System assumptions
  const [offsetPct, setOffsetPct] = useState<number>(90);
  const [psh, setPsh] = useState<number>(5);
  const [lossFactor, setLossFactor] = useState<number>(0.8);
  const [panelW, setPanelW] = useState<number>(450);
  const [roofType, setRoofType] = useState<string>("Shingle");
  const [permits, setPermits] = useState<number>(1200);
  const [interconnection, setInterconnection] = useState<number>(450);
  const [installedPricePerW, setInstalledPricePerW] = useState<number>(PV_PRICE_PER_W);

  // Battery assumptions
  const [batteryMode, setBatteryMode] = useState<"recommended" | "none" | "custom">("recommended");
  const [backupHours, setBackupHours] = useState<number>(8);
  const [criticalKw, setCriticalKw] = useState<number>(1.5);
  const [customBatteryKwh, setCustomBatteryKwh] = useState<number>(16);

  async function handleFile(file: File) {
    setOcrBusy(true);
    try {
      const img = await fileToImage(file);
      const rawCanvas = drawImageToCanvas(img, 1800);
      const res = await extractMonthlyKwhFromLumaPage(rawCanvas);
      setOcr(res);
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

  const effectiveMonthlyKwh = useMemo(() => {
    const m = parseFloat(manualMonthly);
    if (isFinite(m) && m > 0) return m;
    if (ocr.avgMonthly !== null) return ocr.avgMonthly;
    return 0;
  }, [manualMonthly, ocr.avgMonthly]);

  const pvSizing = useMemo(() => {
    const monthly = effectiveMonthlyKwh;
    if (!monthly || monthly <= 0) {
      return {
        monthly,
        daily: 0,
        pvKw: 0,
        pvW: 0,
        panels: 0,
        pvCost: 0,
        roofAdder: ROOF_ADDER[roofType] ?? 0,
        misc: 0,
        baseTotal: 0,
      };
    }

    const daily = monthly / DAYS_PER_MONTH;
    const offset = clamp(offsetPct / 100, 0.1, 1.0);
    const pvKw = (daily * offset) / Math.max(0.1, psh * lossFactor);
    const pvW = pvKw * 1000;
    const panels = Math.ceil(pvW / Math.max(1, panelW));

    const basePv = pvW * installedPricePerW;
    const roofAdder = ROOF_ADDER[roofType] ?? 0;
    const subtotal = basePv + roofAdder + permits + interconnection;
    const misc = subtotal * 0.03;
    const baseTotal = subtotal + misc;

    return {
      monthly,
      daily: round2(daily),
      pvKw: round2(pvKw),
      pvW: Math.round(pvW),
      panels,
      pvCost: basePv,
      roofAdder,
      misc,
      baseTotal,
    };
  }, [effectiveMonthlyKwh, offsetPct, psh, lossFactor, panelW, roofType, permits, interconnection, installedPricePerW]);

  const battery = useMemo(() => {
    if (batteryMode === "none") {
      return { kwh: 0, cost: 0, requiredNominal: 0, note: "Sin batería" };
    }
    if (batteryMode === "custom") {
      const kwh = clamp(customBatteryKwh, 0, 500);
      const cost = kwh * SOLUNA_PRICE_PER_KWH;
      return { kwh, cost, requiredNominal: 0, note: "Batería (custom)" };
    }
    const rec = recommendBatteryKwh(criticalKw, backupHours);
    const kwh = rec.pick;
    const cost = kwh * SOLUNA_PRICE_PER_KWH;
    return { kwh, cost, requiredNominal: rec.requiredNominal, note: "Recomendada (según respaldo)" };
  }, [batteryMode, customBatteryKwh, criticalKw, backupHours]);

  const totals = useMemo(() => {
    const pvOnly = pvSizing.baseTotal;
    const withBattery = pvSizing.baseTotal + battery.cost;
    return { pvOnly, withBattery };
  }, [pvSizing.baseTotal, battery.cost]);

  const commercialFlag = useMemo(() => {
    // If avg monthly > 3000, likely commercial per your rule
    if (effectiveMonthlyKwh > OCR_MAX_KWH) return true;
    return false;
  }, [effectiveMonthlyKwh]);

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="flex flex-col gap-2">
          <div className="text-2xl font-semibold">Sunsol · Cotizador (sin vendedor)</div>
          <div className="text-sm text-zinc-500">
            PV: ${PV_PRICE_PER_W.toFixed(2)}/W · Batería Soluna: ${SOLUNA_PRICE_PER_KWH}/kWh · Sin incentivos
          </div>
          <div className="text-xs text-zinc-500">
            Estimado preliminar. Validación final requiere inspección.
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {/* Uploader */}
          <div className="rounded-2xl border border-zinc-200 p-4 shadow-sm">
            <div className="text-base font-semibold">Foto / Screenshot de LUMA (página 4)</div>
            <div className="mt-1 text-sm text-zinc-600">
              Usa la página 4 donde aparece “CONSUMPTION HISTORY (KWH)” (o “Historial de consumo”).
              Toma la <b>página completa</b>, nítida y sin reflejos.
            </div>

            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                onClick={onPickCamera}
                className="rounded-xl bg-black px-4 py-3 text-white shadow-sm active:scale-[0.99]"
              >
                📷 Tomar foto
              </button>

              <button
                type="button"
                onClick={onPickGallery}
                className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-zinc-900 shadow-sm active:scale-[0.99]"
              >
                🖼️ Subir de galería
              </button>

              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.currentTarget.value = "";
                }}
              />

              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.currentTarget.value = "";
                }}
              />
            </div>

            <div className="mt-4">
              <div className="text-sm font-medium text-zinc-800">Consumo mensual promedio (kWh/mes)</div>
              <input
                value={manualMonthly}
                onChange={(e) => setManualMonthly(e.target.value)}
                inputMode="decimal"
                placeholder="Ej. 600"
                className="mt-2 w-full rounded-xl border border-zinc-200 px-3 py-3 text-base outline-none focus:border-zinc-400"
              />
              <div className="mt-1 text-xs text-zinc-500">
                Si el OCR falla, escribe el promedio mensual aquí.
              </div>

              <div className="mt-3 text-sm">
                <div>
                  <span className="font-medium">Consumo anual:</span>{" "}
                  {ocr.annualKWh ? (
                    <span>{ocr.annualKWh.toLocaleString()} kWh (usó {ocr.monthsUsed} mes(es))</span>
                  ) : (
                    <span>— (sin OCR)</span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  OCR confianza: {ocr.avgConfidence !== null ? `${ocr.avgConfidence}%` : "—"}
                </div>

                {ocrBusy && (
                  <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm">
                    Procesando OCR…
                  </div>
                )}

                {!ocrBusy && ocr.message && (
                  <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {ocr.message}
                  </div>
                )}

                {commercialFlag && (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    ⚠️ Promedio &gt; {OCR_MAX_KWH} kWh/mes: probable caso comercial. Requiere estimado aparte.
                  </div>
                )}
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    // Re-run OCR if we have last raw image
                    // (We only stored data URLs; reprocess requires new file. So we just tell user to re-upload.)
                    alert("Para reprocesar, vuelve a subir/tomar la foto (recomendado: más nítida y completa).");
                  }}
                  className="flex-1 rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm shadow-sm active:scale-[0.99]"
                >
                  🔄 Reprocesar OCR
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOcr({
                      ok: false,
                      monthsUsed: 0,
                      valuesUsed: [],
                      valuesDetected: [],
                      avgMonthly: null,
                      annualKWh: null,
                      avgConfidence: null,
                    });
                    setManualMonthly("");
                  }}
                  className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm shadow-sm active:scale-[0.99]"
                >
                  🧹 Limpiar
                </button>
              </div>
            </div>

            {/* Preview */}
            {(ocr.rawDataUrl || ocr.chartCropDataUrl || ocr.labelsCropDataUrl) && (
              <div className="mt-5 rounded-2xl border border-zinc-200 p-3">
                <div className="text-sm font-semibold">Preview</div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {ocr.rawDataUrl && (
                    <div>
                      <div className="text-xs text-zinc-500">Página (raw)</div>
                      <img src={ocr.rawDataUrl} alt="raw" className="mt-1 w-full rounded-xl border border-zinc-200" />
                    </div>
                  )}
                  {ocr.chartCropDataUrl && (
                    <div>
                      <div className="text-xs text-zinc-500">Auto-crop (zona gráfica)</div>
                      <img src={ocr.chartCropDataUrl} alt="chart crop" className="mt-1 w-full rounded-xl border border-zinc-200" />
                    </div>
                  )}
                  {ocr.labelsCropDataUrl && (
                    <div>
                      <div className="text-xs text-zinc-500">OCR (labels arriba de barras)</div>
                      <img src={ocr.labelsCropDataUrl} alt="labels crop" className="mt-1 w-full rounded-xl border border-zinc-200" />
                    </div>
                  )}
                </div>

                <div className="mt-3 text-xs text-zinc-600">
                  Nota: el auto-crop <b>descarta el eje Y por detección de la línea vertical</b> (no importa si los números del eje cambian).
                  Solo intenta leer los numeritos <b>arriba de las barras</b>.
                </div>

                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-zinc-800">
                    ▶ Debug OCR (detectados / usados)
                  </summary>
                  <div className="mt-2 text-sm">
                    <div>
                      <span className="font-medium">Detectados (orden x):</span>{" "}
                      {ocr.valuesDetected.length ? ocr.valuesDetected.join(", ") : "—"}
                    </div>
                    <div className="mt-1">
                      <span className="font-medium">Usados (12 más recientes):</span>{" "}
                      {ocr.valuesUsed.length ? ocr.valuesUsed.join(", ") : "—"}
                    </div>
                  </div>
                </details>
              </div>
            )}
          </div>

          {/* Assumptions / Inputs */}
          <div className="rounded-2xl border border-zinc-200 p-4 shadow-sm">
            <div className="text-base font-semibold">Supuestos del sistema</div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Offset (%)</label>
                <input
                  type="number"
                  value={offsetPct}
                  onChange={(e) => setOffsetPct(clamp(parseFloat(e.target.value || "0"), 10, 100))}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                />
              </div>
              <div>
                <label className="text-sm font-medium">PSH</label>
                <input
                  type="number"
                  step="0.1"
                  value={psh}
                  onChange={(e) => setPsh(clamp(parseFloat(e.target.value || "0"), 1, 8))}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                />
              </div>

              <div>
                <label className="text-sm font-medium">Pérdidas (factor)</label>
                <input
                  type="number"
                  step="0.01"
                  value={lossFactor}
                  onChange={(e) => setLossFactor(clamp(parseFloat(e.target.value || "0"), 0.5, 0.95))}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Panel (W)</label>
                <input
                  type="number"
                  value={panelW}
                  onChange={(e) => setPanelW(clamp(parseFloat(e.target.value || "0"), 300, 700))}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                />
              </div>

              <div>
                <label className="text-sm font-medium">Techo</label>
                <select
                  value={roofType}
                  onChange={(e) => setRoofType(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                >
                  {Object.keys(ROOF_ADDER).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm font-medium">Permisos (est.)</label>
                <input
                  type="number"
                  value={permits}
                  onChange={(e) => setPermits(clamp(parseFloat(e.target.value || "0"), 0, 20000))}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                />
              </div>

              <div>
                <label className="text-sm font-medium">Interconexión (est.)</label>
                <input
                  type="number"
                  value={interconnection}
                  onChange={(e) => setInterconnection(clamp(parseFloat(e.target.value || "0"), 0, 20000))}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                />
              </div>

              <div>
                <label className="text-sm font-medium">Precio instalado ($/W)</label>
                <input
                  type="number"
                  step="0.01"
                  value={installedPricePerW}
                  onChange={(e) => setInstalledPricePerW(clamp(parseFloat(e.target.value || "0"), 1.0, 10.0))}
                  className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                />
                <div className="text-xs text-zinc-500 mt-1">Fijo. Sin incentivos.</div>
              </div>
            </div>

            {/* Results */}
            <div className="mt-5 grid gap-3">
              <div className="rounded-2xl border border-zinc-200 p-4">
                <div className="text-sm font-semibold">Resultado PV</div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-zinc-200 p-3">
                    <div className="text-xs text-zinc-500">Consumo mensual</div>
                    <div className="text-xl font-semibold">{effectiveMonthlyKwh ? round2(effectiveMonthlyKwh).toLocaleString() : "0"} kWh</div>
                  </div>
                  <div className="rounded-xl border border-zinc-200 p-3">
                    <div className="text-xs text-zinc-500">Sistema recomendado</div>
                    <div className="text-xl font-semibold">{pvSizing.pvKw.toLocaleString()} kW</div>
                    <div className="text-xs text-zinc-500">{pvSizing.panels} paneles (est.)</div>
                  </div>
                  <div className="rounded-xl border border-zinc-200 p-3">
                    <div className="text-xs text-zinc-500">PV (sin batería)</div>
                    <div className="text-xl font-semibold">{formatMoney(totals.pvOnly)}</div>
                  </div>
                </div>

                <div className="mt-3 text-sm text-zinc-700">
                  <div className="flex justify-between"><span>Base PV</span><span>{formatMoney(pvSizing.pvCost)}</span></div>
                  <div className="flex justify-between"><span>Adder techo</span><span>{formatMoney(pvSizing.roofAdder)}</span></div>
                  <div className="flex justify-between"><span>Permisos</span><span>{formatMoney(permits)}</span></div>
                  <div className="flex justify-between"><span>Interconexión</span><span>{formatMoney(interconnection)}</span></div>
                  <div className="flex justify-between"><span>Misceláneo (3%)</span><span>{formatMoney(pvSizing.misc)}</span></div>
                </div>
              </div>

              {/* Battery */}
              <div className="rounded-2xl border border-zinc-200 p-4">
                <div className="text-sm font-semibold">Batería</div>

                <div className="mt-2">
                  <label className="text-sm font-medium">Batería</label>
                  <select
                    value={batteryMode}
                    onChange={(e) => setBatteryMode(e.target.value as any)}
                    className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                  >
                    <option value="recommended">Recomendada (según respaldo)</option>
                    <option value="custom">Custom (kWh)</option>
                    <option value="none">Sin batería</option>
                  </select>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium">Horas de respaldo</label>
                    <select
                      value={backupHours}
                      onChange={(e) => setBackupHours(parseInt(e.target.value, 10))}
                      className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                      disabled={batteryMode === "none"}
                    >
                      {BACKUP_HOURS_OPTIONS.map((h) => (
                        <option key={h} value={h}>
                          {h} horas
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-sm font-medium">Cargas críticas</label>
                    <select
                      value={criticalKw}
                      onChange={(e) => setCriticalKw(parseFloat(e.target.value))}
                      className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                      disabled={batteryMode === "none"}
                    >
                      {CRITICAL_LOAD_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {batteryMode === "custom" && (
                    <div className="sm:col-span-2">
                      <label className="text-sm font-medium">kWh batería (custom)</label>
                      <input
                        type="number"
                        value={customBatteryKwh}
                        onChange={(e) => setCustomBatteryKwh(clamp(parseFloat(e.target.value || "0"), 0, 500))}
                        className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                      />
                    </div>
                  )}
                </div>

                <div className="mt-3 rounded-xl border border-zinc-200 p-3">
                  <div className="text-xs text-zinc-500">{battery.note}</div>
                  <div className="mt-1 flex items-end justify-between">
                    <div>
                      <div className="text-sm text-zinc-600">Recomendado</div>
                      <div className="text-xl font-semibold">{battery.kwh} kWh</div>
                      {batteryMode === "recommended" && (
                        <div className="text-xs text-zinc-500">
                          Necesario aprox: {battery.requiredNominal} kWh (nominal)
                        </div>
                      )}
                    </div>
                    <div className="text-xl font-semibold">{formatMoney(battery.cost)}</div>
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-zinc-900 bg-black p-3 text-white">
                  <div className="text-xs opacity-80">Total PV + batería</div>
                  <div className="text-2xl font-semibold">{formatMoney(totals.withBattery)}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer note */}
        <div className="mt-6 text-xs text-zinc-500">
          OCR: Si la factura tiene meses sin data, el app usa los meses disponibles (mín. {MIN_MONTHS_FOR_OCR}) y estima anual con promedio × 12.
        </div>
      </div>
    </div>
  );
}
