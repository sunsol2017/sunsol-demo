"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Sunsol Demo (no login) — LUMA Page 4 OCR
 * Goal:
 * - User uploads/takes photo of LUMA bill page 4 showing "CONSUMPTION HISTORY (KWH)" (13 months bars)
 * - App auto-crops graph area
 * - App reads ONLY the numeric labels above each bar (ignores Y axis entirely)
 * - Uses 12 most recent months (rightmost 12)
 * - If fewer than 12 months detected but >=4, estimates annual = (avg * 12)
 */

// ----------------------------- Small utilities -----------------------------

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toDataUrl(canvas: HTMLCanvasElement, type: string = "image/jpeg", quality: number = 0.9) {
  return canvas.toDataURL(type, quality);
}

async function fileToImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("No pude cargar la imagen."));
    });
    return img;
  } finally {
    // keep until image decoded; revoke later in caller
  }
}

function imageToCanvas(img: HTMLImageElement, maxW: number = 1800): HTMLCanvasElement {
  const scale = img.width > maxW ? maxW / img.width : 1;
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

function getLuma(r: number, g: number, b: number) {
  // perceptual luma
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function smooth1D(arr: number[], windowSize: number) {
  const w = Math.max(1, windowSize | 0);
  if (w === 1) return arr.slice();
  const out = new Array(arr.length).fill(0);
  const half = Math.floor(w / 2);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < arr.length) {
        sum += arr[j];
        cnt++;
      }
    }
    out[i] = sum / Math.max(1, cnt);
  }
  return out;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ----------------------------- Auto-crop graph zone -----------------------------

/**
 * Finds graph region in the lower part of the page.
 * Approach:
 * 1) Work on a downscaled canvas for speed.
 * 2) In bottom ~55% of page, find contiguous rows with "ink density" consistent with a bar chart.
 * 3) Derive bounding box from rows + columns with ink.
 */
function autoCropGraphZone(full: HTMLCanvasElement): { cropped: HTMLCanvasElement; debugBox: { x: number; y: number; w: number; h: number } } {
  // Downscale for analysis (keep ratio)
  const targetW = Math.min(1100, full.width);
  const scale = targetW / full.width;
  const aW = Math.max(1, Math.round(full.width * scale));
  const aH = Math.max(1, Math.round(full.height * scale));
  const analysis = document.createElement("canvas");
  analysis.width = aW;
  analysis.height = aH;
  analysis.getContext("2d")!.drawImage(full, 0, 0, aW, aH);

  const ctx = analysis.getContext("2d")!;
  const img = ctx.getImageData(0, 0, aW, aH);
  const d = img.data;

  const yStart = Math.floor(aH * 0.40); // search lower 60%
  const yEnd = Math.floor(aH * 0.97);

  // Row ink density (dark pixels)
  const rowInk = new Array(aH).fill(0);
  for (let y = yStart; y < yEnd; y++) {
    let cnt = 0;
    for (let x = 0; x < aW; x++) {
      const i = (y * aW + x) * 4;
      const lum = getLuma(d[i], d[i + 1], d[i + 2]);
      if (lum < 200) cnt++; // "ink-ish"
    }
    rowInk[y] = cnt / aW; // 0..1
  }

  const smoothRow = smooth1D(rowInk, 21);

  // Find a band where density is above a baseline (bar chart region tends to have grid lines + bars)
  const baseline = median(smoothRow.slice(yStart, yEnd));
  const threshold = clamp(baseline + 0.03, 0.05, 0.30);

  // Find largest contiguous segment above threshold in search region
  let bestLen = 0;
  let bestA = yStart;
  let bestB = Math.floor(aH * 0.92);

  let curA = -1;
  for (let y = yStart; y < yEnd; y++) {
    const above = smoothRow[y] >= threshold;
    if (above && curA === -1) curA = y;
    if (!above && curA !== -1) {
      const curB = y - 1;
      const len = curB - curA + 1;
      if (len > bestLen) {
        bestLen = len;
        bestA = curA;
        bestB = curB;
      }
      curA = -1;
    }
  }
  if (curA !== -1) {
    const curB = yEnd - 1;
    const len = curB - curA + 1;
    if (len > bestLen) {
      bestLen = len;
      bestA = curA;
      bestB = curB;
    }
  }

  // If the segment is too small, fallback: take a fixed lower band
  if (bestLen < Math.floor(aH * 0.12)) {
    bestA = Math.floor(aH * 0.55);
    bestB = Math.floor(aH * 0.92);
  }

  // Column ink density within [bestA..bestB]
  const colInk = new Array(aW).fill(0);
  for (let x = 0; x < aW; x++) {
    let cnt = 0;
    for (let y = bestA; y <= bestB; y++) {
      const i = (y * aW + x) * 4;
      const lum = getLuma(d[i], d[i + 1], d[i + 2]);
      if (lum < 200) cnt++;
    }
    colInk[x] = cnt / Math.max(1, bestB - bestA + 1);
  }

  const smoothCol = smooth1D(colInk, 25);
  const colBase = median(smoothCol.slice(Math.floor(aW * 0.05), Math.floor(aW * 0.95)));
  const colThresh = clamp(colBase + 0.02, 0.02, 0.25);

  let xA = Math.floor(aW * 0.05);
  while (xA < aW - 2 && smoothCol[xA] < colThresh) xA++;
  let xB = Math.floor(aW * 0.95);
  while (xB > 2 && smoothCol[xB] < colThresh) xB--;

  // Add padding
  const padX = Math.floor(aW * 0.02);
  const padY = Math.floor(aH * 0.02);
  xA = clamp(xA - padX, 0, aW - 1);
  xB = clamp(xB + padX, 0, aW - 1);
  bestA = clamp(bestA - padY, 0, aH - 1);
  bestB = clamp(bestB + padY, 0, aH - 1);

  const cropW = Math.max(1, xB - xA + 1);
  const cropH = Math.max(1, bestB - bestA + 1);

  // Map back to full-res coordinates
  const inv = 1 / scale;
  const fx = Math.round(xA * inv);
  const fy = Math.round(bestA * inv);
  const fw = Math.round(cropW * inv);
  const fh = Math.round(cropH * inv);

  const bounded = {
    x: clamp(fx, 0, full.width - 2),
    y: clamp(fy, 0, full.height - 2),
    w: clamp(fw, 20, full.width - fx),
    h: clamp(fh, 20, full.height - fy),
  };

  const cropped = cropCanvas(full, bounded.x, bounded.y, bounded.w, bounded.h);
  return { cropped, debugBox: bounded };
}

// ----------------------------- Find bars + ROIs above bars -----------------------------

/**
 * Removes Y-axis area dynamically (regardless of which numbers appear on Y axis).
 * It searches for the first "bar activity" region, then crops left to that.
 */
function removeYAxis(chart: HTMLCanvasElement): { canvas: HTMLCanvasElement; xCut: number } {
  const w = chart.width;
  const h = chart.height;
  const ctx = chart.getContext("2d")!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // Focus on middle-lower area where bars exist
  const y1 = Math.floor(h * 0.30);
  const y2 = Math.floor(h * 0.92);

  const col = new Array(w).fill(0);
  for (let x = 0; x < w; x++) {
    let ink = 0;
    for (let y = y1; y < y2; y++) {
      const i = (y * w + x) * 4;
      const lum = getLuma(d[i], d[i + 1], d[i + 2]);
      if (lum < 170) ink++;
    }
    col[x] = ink;
  }

  const smoothCol = smooth1D(col, 19);
  const maxV = Math.max(...smoothCol);
  const thresh = maxV * 0.18; // bar area columns stand out

  // Find first sustained region above threshold (bars start)
  let xStart = Math.floor(w * 0.06);
  while (xStart < w - 10 && smoothCol[xStart] < thresh) xStart++;

  // Give some padding to the left, but still cut enough to eliminate Y axis text
  const cut = clamp(xStart - Math.floor(w * 0.03), 0, Math.floor(w * 0.25));
  const out = cropCanvas(chart, cut, 0, w - cut, h);
  return { canvas: out, xCut: cut };
}

type BarInfo = { xCenter: number; xL: number; xR: number; topY: number; width: number };

function detectBars(chartNoYAxis: HTMLCanvasElement): BarInfo[] {
  const w = chartNoYAxis.width;
  const h = chartNoYAxis.height;
  const ctx = chartNoYAxis.getContext("2d")!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // bar region: skip header/top text a bit
  const yTop = Math.floor(h * 0.22);
  const yBot = Math.floor(h * 0.94);

  // Column ink density
  const colInk = new Array(w).fill(0);
  for (let x = 0; x < w; x++) {
    let ink = 0;
    for (let y = yTop; y < yBot; y++) {
      const i = (y * w + x) * 4;
      const lum = getLuma(d[i], d[i + 1], d[i + 2]);
      if (lum < 165) ink++;
    }
    colInk[x] = ink;
  }

  const smoothCol = smooth1D(colInk, 11);
  const maxInk = Math.max(...smoothCol);
  const thresh = maxInk * 0.35; // bars are strong peaks

  // Group contiguous columns above threshold = one bar
  const bars: { xL: number; xR: number }[] = [];
  let inBar = false;
  let start = 0;

  for (let x = 0; x < w; x++) {
    const on = smoothCol[x] >= thresh;
    if (on && !inBar) {
      inBar = true;
      start = x;
    }
    if (!on && inBar) {
      inBar = false;
      const end = x - 1;
      if (end - start >= 3) bars.push({ xL: start, xR: end });
    }
  }
  if (inBar) {
    const end = w - 1;
    if (end - start >= 3) bars.push({ xL: start, xR: end });
  }

  // If too many segments (grid noise), keep the strongest 13-ish by peak value
  let segments = bars;
  if (segments.length > 20) {
    const scored = segments.map((b) => {
      let peak = 0;
      for (let x = b.xL; x <= b.xR; x++) peak = Math.max(peak, smoothCol[x]);
      return { ...b, peak };
    });
    scored.sort((a, b) => b.peak - a.peak);
    segments = scored.slice(0, 18).sort((a, b) => a.xL - b.xL);
  }

  // For each segment find topY of the bar by scanning upwards in its center
  const out: BarInfo[] = [];
  for (const seg of segments) {
    const xC = Math.round((seg.xL + seg.xR) / 2);
    // scan from bottom to top to find first dark pixel run
    let topY = yBot;
    for (let y = yBot; y >= yTop; y--) {
      const i = (y * w + xC) * 4;
      const lum = getLuma(d[i], d[i + 1], d[i + 2]);
      if (lum < 140) {
        topY = y;
      } else {
        // once we passed the dark region, stop after seeing some white above
        if (topY !== yBot) break;
      }
    }
    if (topY === yBot) continue;

    out.push({
      xCenter: xC,
      xL: seg.xL,
      xR: seg.xR,
      topY,
      width: seg.xR - seg.xL + 1,
    });
  }

  // Sort left->right
  out.sort((a, b) => a.xCenter - b.xCenter);

  // Usually 13 bars; keep up to 13 best-looking by width and position
  if (out.length > 13) {
    // keep the 13 with most "bar-like" width (avoid tiny noise)
    const scored = out.map((b) => ({
      b,
      score: b.width, // simple
    }));
    scored.sort((a, b) => b.score - a.score);
    const keep = scored.slice(0, 13).map((s) => s.b).sort((a, b) => a.xCenter - b.xCenter);
    return keep;
  }
  return out;
}

function makeLabelROIs(chartNoYAxis: HTMLCanvasElement, bars: BarInfo[]): HTMLCanvasElement[] {
  const w = chartNoYAxis.width;
  const h = chartNoYAxis.height;

  // Use spacing between bars to define ROI width
  const centers = bars.map((b) => b.xCenter);
  const gaps: number[] = [];
  for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
  const typicalGap = gaps.length ? median(gaps) : w / 13;

  const roiW = Math.max(50, Math.round(typicalGap * 0.95));
  const roiH = Math.max(45, Math.round(h * 0.13)); // enough for 3-4 digits

  const rois: HTMLCanvasElement[] = [];
  for (const b of bars) {
    // ROI centered on bar center, and vertically above bar top
    const x = clamp(Math.round(b.xCenter - roiW / 2), 0, w - roiW);
    const y = clamp(Math.round(b.topY - roiH - h * 0.02), 0, h - roiH);
    const roi = cropCanvas(chartNoYAxis, x, y, roiW, roiH);
    rois.push(roi);
  }
  return rois;
}

// ----------------------------- OCR engine (tesseract.js) -----------------------------

type OcrMonthResult = { value: number | null; confidence: number; raw: string };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function createTesseractWorker(logger: (msg: string) => void): Promise<any> {
  const mod: any = await import("tesseract.js");

  // Forzamos any para evitar que TS lo infiera como unknown en build
  const createWorker: any = mod?.createWorker ?? mod?.default?.createWorker;
  if (!createWorker) throw new Error("No pude cargar createWorker() de tesseract.js.");

  const worker: any = await createWorker({
    logger: (m: any) => {
      try {
        const status = m?.status ? String(m.status) : "";
        const prog =
          typeof m?.progress === "number" ? ` ${(m.progress * 100).toFixed(0)}%` : "";
        if (status) logger(`${status}${prog}`);
      } catch {
        // no-op
      }
    },
  });

  // Compat: distintas versiones exponen APIs distintas
  if (worker?.load) await worker.load();
  if (worker?.loadLanguage) await worker.loadLanguage("eng");
  if (worker?.initialize) await worker.initialize("eng");
  else if (worker?.reinitialize) await worker.reinitialize("eng");

  if (worker?.setParameters) {
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: "8", // single word / single line (varía)
    });
  }

  return worker;
}


  return worker;
}


function parseDigitsOnly(text: string): string {
  return (text || "").replace(/[^\d]/g, "");
}

function pickCandidateNumber(rawText: string): number | null {
  const digits = parseDigitsOnly(rawText);
  if (!digits) return null;

  // Many OCR mistakes are extra digits; try to interpret smartly:
  // - Prefer 2-4 digits (20..3000)
  // - If longer, try last 4, last 3, last 2
  const tries: string[] = [];
  if (digits.length <= 4) tries.push(digits);
  else {
    tries.push(digits.slice(-4), digits.slice(-3), digits.slice(-2));
  }

  for (const t of tries) {
    const n = Number(t);
    if (Number.isFinite(n) && n >= 20 && n <= 3000) return n;
  }
  return null;
}

async function ocrROIsWithWorker(
  rois: HTMLCanvasElement[],
  setStatus: (s: string) => void,
  abortRef: { aborted: boolean }
): Promise<{ results: OcrMonthResult[]; avgConf: number }> {
  const worker = await createTesseractWorker((m) => setStatus(`OCR: ${m}`));

  try {
    const results: OcrMonthResult[] = [];
    const confs: number[] = [];

    for (let i = 0; i < rois.length; i++) {
      if (abortRef.aborted) throw new Error("OCR cancelado.");

      setStatus(`OCR: leyendo barra ${i + 1}/${rois.length}...`);
      // Small pause helps UI update on mobile
      await sleep(10);

      const r = await worker.recognize(rois[i]);
      const text = r?.data?.text ?? "";
      const confidence = typeof r?.data?.confidence === "number" ? r.data.confidence : 0;

      const val = pickCandidateNumber(text);
      results.push({ value: val, confidence, raw: text });
      if (val !== null) confs.push(confidence);
    }

    const avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    return { results, avgConf };
  } finally {
    try {
      if (worker.terminate) await worker.terminate();
    } catch {
      // ignore
    }
  }
}

// ----------------------------- Main Page -----------------------------

type ParsedConsumption = {
  valuesAllLeftToRight: number[]; // extracted numbers above bars (may be <13)
  usedMostRecent: number[]; // rightmost 12 (or fewer if missing)
  monthsUsed: number;
  annualKwh: number | null;
  avgMonthlyKwh: number | null;
  confidence: number;
  debugDetectedRaw: { raw: string; value: number | null; confidence: number }[];
};

export default function Page() {
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const [rawPreview, setRawPreview] = useState<string | null>(null);
  const [chartPreview, setChartPreview] = useState<string | null>(null);

  const [roiPreviews, setRoiPreviews] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const [parsed, setParsed] = useState<ParsedConsumption | null>(null);

  // user override (if OCR fails)
  const [manualMonthly, setManualMonthly] = useState<string>("");

  // simple PV sizing inputs (you can keep using your existing values)
  const [offsetPct, setOffsetPct] = useState<number>(90);
  const [psh, setPsh] = useState<number>(5);
  const [lossFactor, setLossFactor] = useState<number>(0.8);
  const [panelW, setPanelW] = useState<number>(450);
  const [pricePerW, setPricePerW] = useState<number>(2.3);
  const [permits, setPermits] = useState<number>(1200);
  const [interconnection, setInterconnection] = useState<number>(450);
  const [miscPct, setMiscPct] = useState<number>(3);

  // battery (simple)
  const [backupHours, setBackupHours] = useState<number>(8);
  const [criticalKw, setCriticalKw] = useState<number>(1.5);
  const [batteryPricePerKwh, setBatteryPricePerKwh] = useState<number>(350);
  const [batteryUsable, setBatteryUsable] = useState<number>(0.9);

  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });

  function resetAll() {
    abortRef.current.aborted = true; // cancel any ongoing OCR
    abortRef.current = { aborted: false };
    setError("");
    setStatus("");
    setParsed(null);
    setRawPreview(null);
    setChartPreview(null);
    setRoiPreviews([]);
  }

  async function handleFile(file: File) {
    resetAll();
    setStatus("Cargando imagen...");

    const img = await fileToImage(file);
    const objectUrl = img.src;

    try {
      const full = imageToCanvas(img, 1800);
      setRawPreview(toDataUrl(full, "image/jpeg", 0.85));

      setStatus("Auto-crop: detectando zona de gráfica...");
      const { cropped } = autoCropGraphZone(full);

      // remove Y-axis dynamically
      const noY = removeYAxis(cropped).canvas;

      setChartPreview(toDataUrl(noY, "image/jpeg", 0.9));

      setStatus("Detectando barras...");
      const bars = detectBars(noY);

      if (bars.length < 4) {
        setError(
          "OCR insuficiente: no se detectaron suficientes barras. Toma la foto más nítida y completa (página 4) y sin reflejos, o escribe el kWh mensual promedio manualmente."
        );
        setStatus("");
        return;
      }

      // ROIs above bars
      const rois = makeLabelROIs(noY, bars);
      setRoiPreviews(rois.map((c) => toDataUrl(c, "image/jpeg", 0.9)));

      setStatus("OCR: iniciando...");
      const { results, avgConf } = await ocrROIsWithWorker(rois, setStatus, abortRef.current);

      // Build numeric list left->right aligned with bars
      const valuesLeftToRight = results.map((r) => r.value).filter((v): v is number => typeof v === "number");

      // Use rightmost 12 bars (most recent)
      // Note: bars + rois are left->right. Most recent are on the right.
      const numericByBar = results.map((r) => r.value);
      const usablePairs: { idx: number; val: number; conf: number; raw: string }[] = [];
      for (let i = 0; i < numericByBar.length; i++) {
        const v = numericByBar[i];
        if (typeof v === "number" && v >= 20 && v <= 3000) {
          usablePairs.push({ idx: i, val: v, conf: results[i].confidence, raw: results[i].raw });
        }
      }

      // Keep order by bar index, then take last 12
      usablePairs.sort((a, b) => a.idx - b.idx);
      const last12 = usablePairs.slice(-12);

      const used = last12.map((x) => x.val);
      const monthsUsed = used.length;

      if (monthsUsed < 4) {
        setParsed({
          valuesAllLeftToRight: valuesLeftToRight,
          usedMostRecent: used,
          monthsUsed,
          annualKwh: null,
          avgMonthlyKwh: null,
          confidence: avgConf,
          debugDetectedRaw: results.map((r) => ({ raw: r.raw, value: r.value, confidence: r.confidence })),
        });

        setError(
          "OCR insuficiente: se detectaron menos de 4 meses. Toma la foto más nítida y completa (página 4) o escribe el kWh mensual promedio manualmente."
        );
        setStatus("");
        return;
      }

      // Annual:
      // - if 12 months detected: sum them
      // - else: annual = (avg * 12)
      let annual: number;
      if (monthsUsed >= 12) {
        annual = used.reduce((a, b) => a + b, 0);
      } else {
        const avg = used.reduce((a, b) => a + b, 0) / monthsUsed;
        annual = avg * 12;
      }

      const avgMonthly = annual / 12;

      setParsed({
        valuesAllLeftToRight: valuesLeftToRight,
        usedMostRecent: used,
        monthsUsed,
        annualKwh: Math.round(annual),
        avgMonthlyKwh: Math.round(avgMonthly * 100) / 100,
        confidence: avgConf,
        debugDetectedRaw: results.map((r) => ({ raw: r.raw, value: r.value, confidence: r.confidence })),
      });

      setStatus("");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Error procesando la imagen.");
      setStatus("");
    } finally {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // ignore
      }
    }
  }

  const effectiveMonthly = useMemo(() => {
    const manual = Number(manualMonthly);
    if (Number.isFinite(manual) && manual > 0) return manual;
    if (parsed?.avgMonthlyKwh) return parsed.avgMonthlyKwh;
    return 0;
  }, [manualMonthly, parsed]);

  const sizing = useMemo(() => {
    if (!effectiveMonthly || effectiveMonthly <= 0) return null;

    const annual = effectiveMonthly * 12;
    const offset = clamp(offsetPct, 1, 100) / 100;
    const lf = clamp(lossFactor, 0.4, 0.95);

    // kWdc = annual_kWh * offset / (PSH * 365 * lossFactor)
    const kWdc = (annual * offset) / (Math.max(1, psh) * 365 * lf);
    const panels = Math.ceil((kWdc * 1000) / Math.max(50, panelW));
    const actualKWdc = (panels * panelW) / 1000;

    const dcW = panels * panelW;
    const basePV = dcW * pricePerW;
    const sub = basePV + permits + interconnection;
    const misc = sub * (miscPct / 100);
    const totalPV = sub + misc;

    // Battery
    const neededKwh = (criticalKw * backupHours) / Math.max(0.5, batteryUsable);
    // snap to common sizes
    const sizes = [10, 13.5, 16, 20, 30, 40];
    const rec = sizes.find((s) => s >= neededKwh) ?? Math.ceil(neededKwh);
    const battCost = rec * batteryPricePerKwh;

    return {
      annual: Math.round(annual),
      kWdc: Math.round(actualKWdc * 100) / 100,
      panels,
      pvCost: Math.round(totalPV),
      pvCostNoBattery: Math.round(totalPV),
      batteryKwh: rec,
      batteryCost: Math.round(battCost),
    };
  }, [
    effectiveMonthly,
    offsetPct,
    psh,
    lossFactor,
    panelW,
    pricePerW,
    permits,
    interconnection,
    miscPct,
    criticalKw,
    backupHours,
    batteryPricePerKwh,
    batteryUsable,
  ]);

  // Buttons handlers
  const openCamera = () => cameraInputRef.current?.click();
  const openGallery = () => galleryInputRef.current?.click();

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    await handleFile(f);
  };

  const reprocess = async () => {
    // re-run OCR from current rawPreview by forcing user to re-upload is annoying;
    // Instead: tell user to re-select; but we can just ask them to pick again.
    setError("");
    setStatus("Para reprocesar, vuelve a tomar/subir la foto (con mejor nitidez).");
    await sleep(1200);
    setStatus("");
  };

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="text-2xl font-semibold">Sunsol • Cotizador (sin vendedor)</h1>
        <p className="mt-1 text-sm text-gray-600">
          Foto / Screenshot de LUMA (página 4) → detecta consumo promedio mensual usando la gráfica <b>CONSUMPTION HISTORY (KWH)</b>.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {/* Upload card */}
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold">📷 Foto / Screenshot de LUMA (página 4)</h2>
            <p className="mt-2 text-sm text-gray-600">
              Usa la página 4 donde aparece la gráfica <b>“CONSUMPTION HISTORY (KWH)”</b> (o <b>“Historial de consumo”</b>).
              Toma la <b>página completa</b>, nítida y sin reflejos.
            </p>

            <div className="mt-4 flex flex-col gap-3">
              <button
                onClick={openCamera}
                className="w-full rounded-xl bg-black px-4 py-3 text-white active:scale-[0.99]"
              >
                📸 Tomar foto
              </button>

              <button
                onClick={openGallery}
                className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 active:scale-[0.99]"
              >
                🖼️ Subir de galería
              </button>

              {/* Hidden inputs */}
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={onPickFile}
              />
              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onPickFile}
              />

              <div className="rounded-xl border border-gray-200 p-3">
                <label className="text-sm font-medium text-gray-700">Consumo mensual promedio (kWh/mes)</label>
                <input
                  value={manualMonthly}
                  onChange={(e) => setManualMonthly(e.target.value)}
                  placeholder="Ej. 600"
                  className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-base outline-none focus:border-gray-900"
                />
                <p className="mt-2 text-xs text-gray-500">
                  Si el OCR falla, escribe el promedio mensual aquí.
                </p>

                <div className="mt-3 text-sm">
                  <div>
                    <span className="text-gray-600">Consumo anual:</span>{" "}
                    <span className="font-semibold">
                      {parsed?.annualKwh ? `${parsed.annualKwh.toLocaleString()} kWh` : "— (sin OCR)"}
                    </span>
                    {parsed?.monthsUsed ? (
                      <span className="text-gray-500">{`  (usó ${parsed.monthsUsed} mes(es))`}</span>
                    ) : null}
                  </div>
                  <div className="mt-1">
                    <span className="text-gray-600">OCR confianza:</span>{" "}
                    <span className="font-semibold">
                      {parsed ? `${Math.round(parsed.confidence)}%` : "—"}
                    </span>
                  </div>
                </div>

                {status ? (
                  <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                    {status}
                  </div>
                ) : null}

                {error ? (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </div>
                ) : null}

                <div className="mt-3 flex gap-2">
                  <button
                    onClick={reprocess}
                    className="flex-1 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    🔁 Reprocesar OCR
                  </button>
                  <button
                    onClick={resetAll}
                    className="flex-1 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    🧹 Limpiar
                  </button>
                </div>
              </div>
            </div>

            {/* Preview */}
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-gray-800">Preview</h3>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-gray-200 p-2">
                  <div className="text-xs text-gray-600">Página (raw)</div>
                  {rawPreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={rawPreview} alt="raw" className="mt-2 w-full rounded-lg" />
                  ) : (
                    <div className="mt-2 h-28 rounded-lg bg-gray-100" />
                  )}
                </div>

                <div className="rounded-xl border border-gray-200 p-2">
                  <div className="text-xs text-gray-600">Auto-crop (zona gráfica, sin eje Y)</div>
                  {chartPreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={chartPreview} alt="chart" className="mt-2 w-full rounded-lg" />
                  ) : (
                    <div className="mt-2 h-28 rounded-lg bg-gray-100" />
                  )}
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-gray-200 p-3">
                <div className="text-sm font-semibold">Lo que OCR realmente lee (labels arriba de barras)</div>
                {roiPreviews.length ? (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {roiPreviews.slice(-12).map((u, idx) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={idx} src={u} alt={`roi-${idx}`} className="w-full rounded-lg border border-gray-200" />
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 text-sm text-gray-500">—</div>
                )}

                {parsed ? (
                  <div className="mt-3 text-sm">
                    <div className="text-gray-600">Detectados (orden OCR):</div>
                    <div className="mt-1 text-gray-900">
                      {parsed.debugDetectedRaw
                        .map((r) => (typeof r.value === "number" ? r.value : "—"))
                        .join(", ")}
                    </div>
                    <div className="mt-2 text-gray-600">Usados (12 más recientes):</div>
                    <div className="mt-1 font-semibold text-gray-900">{parsed.usedMostRecent.join(", ")}</div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* Quote card */}
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold">⚡ Cálculo rápido del sistema</h2>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Offset (%)" value={offsetPct} onChange={(v) => setOffsetPct(v)} />
              <Field label="PSH" value={psh} onChange={(v) => setPsh(v)} step={0.1} />

              <Field label="Pérdidas (factor)" value={lossFactor} onChange={(v) => setLossFactor(v)} step={0.01} />
              <Field label="Panel (W)" value={panelW} onChange={(v) => setPanelW(v)} step={5} />

              <Field label="Precio instalado ($/W)" value={pricePerW} onChange={(v) => setPricePerW(v)} step={0.05} />
              <Field label="Permisos (est.)" value={permits} onChange={(v) => setPermits(v)} step={50} />

              <Field
                label="Interconexión (est.)"
                value={interconnection}
                onChange={(v) => setInterconnection(v)}
                step={50}
              />
              <Field label="Misceláneo (%)" value={miscPct} onChange={(v) => setMiscPct(v)} step={0.5} />
            </div>

            <div className="mt-4 rounded-xl border border-gray-200 p-3">
              <div className="text-sm font-semibold">🔋 Batería (respaldo)</div>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <Field label="Horas de respaldo" value={backupHours} onChange={(v) => setBackupHours(v)} step={1} />
                <Field label="Cargas críticas (kW)" value={criticalKw} onChange={(v) => setCriticalKw(v)} step={0.1} />
                <Field
                  label="Precio batería ($/kWh)"
                  value={batteryPricePerKwh}
                  onChange={(v) => setBatteryPricePerKwh(v)}
                  step={10}
                />
                <Field
                  label="Usable factor"
                  value={batteryUsable}
                  onChange={(v) => setBatteryUsable(v)}
                  step={0.05}
                />
              </div>
            </div>

            <div className="mt-4 grid gap-3">
              <div className="rounded-xl border border-gray-200 p-3">
                <div className="text-sm font-semibold">Resultado PV</div>
                <div className="mt-2 text-sm text-gray-600">
                  Consumo mensual (usado):{" "}
                  <span className="font-semibold text-gray-900">
                    {effectiveMonthly ? `${Number(effectiveMonthly).toLocaleString()} kWh/mes` : "—"}
                  </span>
                </div>

                {sizing ? (
                  <div className="mt-2 text-sm">
                    <div>
                      <span className="text-gray-600">Consumo anual:</span>{" "}
                      <span className="font-semibold">{sizing.annual.toLocaleString()} kWh</span>
                    </div>
                    <div className="mt-1">
                      <span className="text-gray-600">Sistema recomendado:</span>{" "}
                      <span className="font-semibold">{sizing.kWdc} kW</span>{" "}
                      <span className="text-gray-500">({sizing.panels} paneles)</span>
                    </div>
                    <div className="mt-1">
                      <span className="text-gray-600">PV (sin batería):</span>{" "}
                      <span className="font-semibold">${sizing.pvCostNoBattery.toLocaleString()}</span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 text-sm text-gray-500">Sube una foto o entra el promedio mensual.</div>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 p-3">
                <div className="text-sm font-semibold">Batería</div>
                {sizing ? (
                  <div className="mt-2 text-sm">
                    <div>
                      <span className="text-gray-600">Recomendado:</span>{" "}
                      <span className="font-semibold">{sizing.batteryKwh} kWh</span>
                    </div>
                    <div className="mt-1">
                      <span className="text-gray-600">Costo estimado batería:</span>{" "}
                      <span className="font-semibold">${sizing.batteryCost.toLocaleString()}</span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 text-sm text-gray-500">—</div>
                )}
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
              Nota: el OCR solo intenta leer los números arriba de cada barra. El eje Y se descarta automáticamente aunque cambien sus números.
            </div>
          </div>
        </div>

        <div className="mt-8 text-xs text-gray-500">
          Tip: si en una factura faltan meses, el sistema usa los meses disponibles (mínimo 4) y estima el anual con promedio × 12.
        </div>
      </div>
    </div>
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
      <div className="text-xs font-medium text-gray-700">{label}</div>
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900"
      />
    </label>
  );
}
