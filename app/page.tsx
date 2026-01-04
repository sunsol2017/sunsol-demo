"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Sunsol Demo – page.tsx
 * FIXES:
 * - Worker singleton (no recrear/terminate en cada OCR)
 * - CDN paths para worker/core/lang (evita problemas de bundler + mejora carga en móvil)
 * - Timeouts más altos para primera carga en Android
 * - OCR solo de labels arriba de barras (20–3000) y usa los 12 más recientes
 * - Sin “recorte manual”
 */

// ----------------------------- helpers (canvas/image) -----------------------------
function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function toFixedSmart(n: number, digits = 2) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

function canvasFromImage(img: HTMLImageElement, maxW = 1800): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const ratio = img.width > maxW ? maxW / img.width : 1;
  c.width = Math.round(img.width * ratio);
  c.height = Math.round(img.height * ratio);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
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

function downscaleCanvas(src: HTMLCanvasElement, maxW = 900): HTMLCanvasElement {
  if (src.width <= maxW) return src;
  const scale = maxW / src.width;
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function canvasToDataUrl(c: HTMLCanvasElement, quality = 0.9): string {
  try {
    return c.toDataURL("image/jpeg", quality);
  } catch {
    return c.toDataURL();
  }
}

function getImageDataGray(c: HTMLCanvasElement) {
  const ctx = c.getContext("2d")!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const data = img.data;
  const gray = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    gray[p] = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
  }
  return { gray, w: c.width, h: c.height };
}

function tightInkCrop(src: HTMLCanvasElement): { canvas: HTMLCanvasElement; rect: { x: number; y: number; w: number; h: number } } {
  const small = downscaleCanvas(src, 900);
  const { gray, w, h } = getImageDataGray(small);

  let minX = w - 1,
    minY = h - 1,
    maxX = 0,
    maxY = 0;
  const TH = 245;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      if (v < TH) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX >= maxX || minY >= maxY) {
    return { canvas: src, rect: { x: 0, y: 0, w: src.width, h: src.height } };
  }

  const pad = Math.round(Math.min(w, h) * 0.02);
  minX = clamp(minX - pad, 0, w - 1);
  minY = clamp(minY - pad, 0, h - 1);
  maxX = clamp(maxX + pad, 0, w - 1);
  maxY = clamp(maxY + pad, 0, h - 1);

  const sx = src.width / w;
  const sy = src.height / h;

  const rect = {
    x: Math.round(minX * sx),
    y: Math.round(minY * sy),
    w: Math.round((maxX - minX) * sx),
    h: Math.round((maxY - minY) * sy),
  };

  const cropped = cropCanvas(src, rect.x, rect.y, rect.w, rect.h);
  return { canvas: cropped, rect };
}

type Segment = { x0: number; x1: number; strength: number };

function movingAverage(arr: number[], win = 5) {
  const out = new Array(arr.length).fill(0);
  const half = Math.floor(win / 2);
  for (let i = 0; i < arr.length; i++) {
    let s = 0;
    let c = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < arr.length) {
        s += arr[j];
        c++;
      }
    }
    out[i] = c ? s / c : arr[i];
  }
  return out;
}

function findBarSegments(gray: Uint8ClampedArray, w: number, h: number, y0: number, y1: number): Segment[] {
  const col = new Array(w).fill(0);
  const TH = 175;
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (gray[row + x] < TH) col[x]++;
    }
  }

  const smooth = movingAverage(col, 7);
  const winH = Math.max(1, y1 - y0);
  const colTh = Math.max(6, Math.round(winH * 0.12));

  const segs: Segment[] = [];
  let inSeg = false;
  let start = 0;
  let strength = 0;

  for (let x = 0; x < w; x++) {
    const v = smooth[x];
    if (v >= colTh) {
      if (!inSeg) {
        inSeg = true;
        start = x;
        strength = v;
      } else {
        strength = Math.max(strength, v);
      }
    } else if (inSeg) {
      const end = x - 1;
      const width = end - start + 1;
      if (width >= 6) segs.push({ x0: start, x1: end, strength });
      inSeg = false;
    }
  }
  if (inSeg) {
    const end = w - 1;
    const width = end - start + 1;
    if (width >= 6) segs.push({ x0: start, x1: end, strength });
  }

  const merged: Segment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.x0 - last.x1 <= 6) {
      last.x1 = s.x1;
      last.strength = Math.max(last.strength, s.strength);
    } else {
      merged.push({ ...s });
    }
  }

  return merged;
}

function scoreSegments(segs: Segment[]) {
  const n = segs.length;
  const nScore = n >= 10 && n <= 15 ? 100 : n >= 7 && n <= 18 ? 60 : 0;
  const strength = segs.reduce((a, s) => a + s.strength, 0);
  return nScore + Math.min(80, strength / 50);
}

function detectGraphZone(src: HTMLCanvasElement) {
  const { canvas: tight } = tightInkCrop(src);

  const small = downscaleCanvas(tight, 900);
  const { gray, w, h } = getImageDataGray(small);

  const candidates = [0.15, 0.25, 0.35, 0.45].map((p) => Math.round(h * p));
  const yEnd = Math.round(h * 0.92);

  let best = { score: -1, y0: candidates[0], segs: [] as Segment[] };

  for (const y0 of candidates) {
    const segs = findBarSegments(gray, w, h, y0, yEnd);
    const sc = scoreSegments(segs);
    if (sc > best.score) best = { score: sc, y0, segs };
  }

  let segs = best.segs;
  let y0 = best.y0;

  if (segs.length < 6) {
    y0 = Math.round(h * 0.35);
    segs = findBarSegments(gray, w, h, y0, yEnd);
  }

  let minX = Math.round(w * 0.03);
  let maxX = Math.round(w * 0.98);

  if (segs.length) {
    minX = segs.reduce((m, s) => Math.min(m, s.x0), w - 1);
    maxX = segs.reduce((m, s) => Math.max(m, s.x1), 0);
  }

  const TH = 235;
  let minY = h - 1,
    maxY = 0;

  for (let yy = 0; yy < h; yy++) {
    let count = 0;
    const row = yy * w;
    for (let xx = minX; xx <= maxX; xx++) if (gray[row + xx] < TH) count++;
    if (count > Math.round((maxX - minX + 1) * 0.02)) {
      minY = Math.min(minY, yy);
      maxY = Math.max(maxY, yy);
    }
  }

  if (minY >= maxY) {
    minY = y0;
    maxY = yEnd;
  }

  const padY = Math.round(h * 0.02);
  minY = clamp(minY - padY, 0, h - 1);
  maxY = clamp(maxY + padY, 0, h - 1);

  // descartar eje Y por POSICIÓN (no por números)
  const discardLeft = Math.round(w * 0.075);
  minX = clamp(minX + discardLeft, 0, w - 1);

  const sx = tight.width / w;
  const sy = tight.height / h;

  const rect = {
    x: Math.round(minX * sx),
    y: Math.round(minY * sy),
    w: Math.round((maxX - minX) * sx),
    h: Math.round((maxY - minY) * sy),
  };

  const cropped = cropCanvas(tight, rect.x, rect.y, rect.w, rect.h);

  return {
    tight,
    graph: cropped,
    rect,
    smallDebug: { w, h, y0, yEnd, segCount: segs.length, score: best.score },
  };
}

function estimateBarTop(gray: Uint8ClampedArray, w: number, h: number, seg: Segment) {
  const TH = 165;
  const x0 = seg.x0,
    x1 = seg.x1;
  const segW = Math.max(1, x1 - x0 + 1);
  const minRunRows = 3;

  let run = 0;
  for (let y = 0; y < h; y++) {
    let dark = 0;
    const row = y * w;
    for (let x = x0; x <= x1; x++) if (gray[row + x] < TH) dark++;
    const ratio = dark / segW;

    if (ratio > 0.55) {
      run++;
      if (run >= minRunRows) return y - (minRunRows - 1);
    } else {
      run = 0;
    }
  }
  return Math.round(h * 0.35);
}

function pickCandidateNumber(raw: string): number | null {
  const digits = (raw || "").replace(/[^\d]/g, "");
  if (!digits) return null;

  const tries: string[] = [];
  if (digits.length <= 4) tries.push(digits);
  else tries.push(digits.slice(-4), digits.slice(-3), digits.slice(-2));

  for (const t of tries) {
    const n = Number(t);
    if (Number.isFinite(n) && n >= 20 && n <= 3000) return n;
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: any;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error(`Timeout (${label}) after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// ----------------------------- OCR (tesseract) -----------------------------
type OcrWorker = any;

// CDN paths (evita problemas de rutas en Next/Turbopack en móvil)
const TESS_CDN = {
  // jsdelivr suele ir bien en móviles
  workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/worker.min.js",
  corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js",
  langPath: "https://tessdata.projectnaptha.com/4.0.0",
};

// Singleton worker (clave para que NO timeoutee y no “re-cargue” siempre)
let _workerPromise: Promise<OcrWorker> | null = null;
let _worker: OcrWorker | null = null;

async function ensureTesseractWorker(logger: (msg: string) => void): Promise<OcrWorker> {
  if (_worker) return _worker;
  if (_workerPromise) return _workerPromise;

  _workerPromise = (async () => {
    const mod: any = await import("tesseract.js");
    const createWorker: any = mod?.createWorker ?? mod?.default?.createWorker ?? mod?.default ?? mod?.createWorker;
    if (!createWorker) throw new Error("No pude cargar createWorker() de tesseract.js");

    const make = async (useCdn: boolean) => {
      const opts: any = { logger: (m: any) => m?.status && logger(`${m.status}${typeof m.progress === "number" ? ` ${(m.progress * 100).toFixed(0)}%` : ""}`) };
      if (useCdn) {
        opts.workerPath = TESS_CDN.workerPath;
        opts.corePath = TESS_CDN.corePath;
        opts.langPath = TESS_CDN.langPath;
      }

      // createWorker a veces devuelve worker directo (sync) o promise, por eso Promise.resolve
      const maybe = createWorker(opts);
      const w = await withTimeout(Promise.resolve(maybe), 120000, useCdn ? "createWorker(CDN)" : "createWorker(local)");
      return w;
    };

    let worker: any;
    try {
      // 1) intenta normal
      worker = await make(false);
    } catch {
      // 2) fallback CDN (más confiable en Vercel/Next)
      worker = await make(true);
    }

    // init compatible multi-version
    if (worker.load) await withTimeout(worker.load(), 120000, "worker.load");
    if (worker.loadLanguage) await withTimeout(worker.loadLanguage("eng"), 120000, "worker.loadLanguage");
    if (worker.initialize) await withTimeout(worker.initialize("eng"), 120000, "worker.initialize");
    if (worker.reinitialize) await withTimeout(worker.reinitialize("eng"), 120000, "worker.reinitialize");

    if (worker.setParameters) {
      await withTimeout(
        worker.setParameters({
          tessedit_char_whitelist: "0123456789",
          preserve_interword_spaces: "1",
        }),
        60000,
        "worker.setParameters"
      );
    }

    _worker = worker;
    return worker;
  })();

  try {
    return await _workerPromise;
  } catch (e) {
    _workerPromise = null;
    _worker = null;
    throw e;
  }
}

async function terminateTesseractWorker() {
  try {
    if (_worker?.terminate) await _worker.terminate();
  } catch {
    // ignore
  } finally {
    _worker = null;
    _workerPromise = null;
  }
}

async function ocrSingleNumber(worker: OcrWorker, roi: HTMLCanvasElement) {
  if (worker.setParameters) {
    await worker.setParameters({
      tessedit_pageseg_mode: "7",
      tessedit_char_whitelist: "0123456789",
    });
  }

  const result: any = await withTimeout(worker.recognize(roi), 60000, "recognize(roi)");
  const text = (result?.data?.text ?? "").trim();
  const conf = Number(result?.data?.confidence ?? 0);
  const n = pickCandidateNumber(text);

  return { n, text, conf: Number.isFinite(conf) ? conf : 0 };
}

type OcrRunResult = {
  detectedAll: number[];
  usedLast12: number[];
  monthsUsed: number;
  avgMonthly: number;
  annualKwh: number;
  estimatedAnnual: boolean;
  confidenceAvg: number;
  debug: string[];
};

async function runLumaBarLabelOcr(
  pageCanvas: HTMLCanvasElement,
  setLog: (s: string) => void,
  requestId: number,
  isCanceled: () => boolean
): Promise<{ graphZone: HTMLCanvasElement; labelPreview: HTMLCanvasElement; result: OcrRunResult }> {
  const debug: string[] = [];

  setLog("Preparando imagen…");
  const { graph, smallDebug } = detectGraphZone(pageCanvas);
  debug.push(`detectGraphZone: segs=${smallDebug.segCount}, y0=${smallDebug.y0}/${smallDebug.h}, score=${toFixedSmart(smallDebug.score, 1)}`);

  if (isCanceled()) throw new Error("OCR cancelado");

  const graphSmall = downscaleCanvas(graph, 1000);
  const { gray, w, h } = getImageDataGray(graphSmall);

  const y0 = Math.round(h * 0.12);
  const y1 = Math.round(h * 0.78);

  let segs = findBarSegments(gray, w, h, y0, y1);

  if (segs.length > 18) segs = segs.sort((a, b) => b.strength - a.strength).slice(0, 18);
  segs = segs.sort((a, b) => a.x0 - b.x0);

  // Solo OCR a las 12 barras más recientes (derecha) -> MUCHÍSIMO más rápido
  if (segs.length > 12) segs = segs.slice(-12);

  debug.push(`barSegments(used): ${segs.length}`);

  const sx = graph.width / graphSmall.width;
  const sy = graph.height / graphSmall.height;

  const labelPreview = document.createElement("canvas");
  labelPreview.width = graphSmall.width;
  labelPreview.height = graphSmall.height;
  const pctx = labelPreview.getContext("2d")!;
  pctx.fillStyle = "#fff";
  pctx.fillRect(0, 0, labelPreview.width, labelPreview.height);
  pctx.drawImage(graphSmall, 0, 0);

  // SINGLETON worker
  setLog("Cargando OCR… (solo la 1ra vez tarda más)");
  const worker = await ensureTesseractWorker((m) => {
    if (!isCanceled()) setLog(m);
  });

  if (isCanceled()) throw new Error("OCR cancelado");

  setLog("Leyendo labels arriba de las barras…");
  const candidates: { xCenter: number; value: number; conf: number; raw: string }[] = [];

  for (let i = 0; i < segs.length; i++) {
    if (isCanceled()) throw new Error("OCR cancelado");
    if (requestId === -1) throw new Error("OCR cancelado");

    const seg = segs[i];
    const topY = estimateBarTop(gray, w, h, seg);

    const segW = seg.x1 - seg.x0 + 1;
    const labelH = clamp(Math.round(h * 0.10), 22, 70);
    const pad = Math.round(labelH * 0.15);

    const lx0s = clamp(seg.x0 - Math.round(segW * 0.15), 0, w - 1);
    const lx1s = clamp(seg.x1 + Math.round(segW * 0.15), 0, w - 1);
    const ly1s = clamp(topY - pad, 0, h - 1);
    const ly0s = clamp(ly1s - labelH, 0, h - 1);

    pctx.strokeStyle = "rgba(255,0,0,0.7)";
    pctx.lineWidth = 2;
    pctx.strokeRect(lx0s, ly0s, lx1s - lx0s, ly1s - ly0s);

    const lx0 = Math.round(lx0s * sx);
    const lx1 = Math.round(lx1s * sx);
    const ly0 = Math.round(ly0s * sy);
    const ly1 = Math.round(ly1s * sy);

    const roi = cropCanvas(graph, lx0, ly0, Math.max(1, lx1 - lx0), Math.max(1, ly1 - ly0));

    const roiScaled = document.createElement("canvas");
    const scale = 2;
    roiScaled.width = roi.width * scale;
    roiScaled.height = roi.height * scale;
    const rctx = roiScaled.getContext("2d")!;
    rctx.imageSmoothingEnabled = false;
    rctx.drawImage(roi, 0, 0, roiScaled.width, roiScaled.height);

    const out = await ocrSingleNumber(worker, roiScaled);

    const value = out.n;
    const xCenter = (seg.x0 + seg.x1) / 2;

    if (value != null) candidates.push({ xCenter, value, conf: out.conf, raw: out.text });

    debug.push(`roi#${i}: raw="${out.text}" -> ${value ?? "null"} (conf ${toFixedSmart(out.conf, 1)})`);
  }

  const ordered = candidates.sort((a, b) => a.xCenter - b.xCenter);
  const detectedAll = ordered.map((o) => o.value);

  const usedLast12 = detectedAll.length > 12 ? detectedAll.slice(-12) : detectedAll;

  const confAvg = ordered.length ? ordered.reduce((a, o) => a + o.conf, 0) / ordered.length : 0;

  if (usedLast12.length < 4) {
    return {
      graphZone: graph,
      labelPreview,
      result: {
        detectedAll,
        usedLast12,
        monthsUsed: usedLast12.length,
        avgMonthly: 0,
        annualKwh: 0,
        estimatedAnnual: true,
        confidenceAvg: confAvg,
        debug,
      },
    };
  }

  const sum = usedLast12.reduce((a, v) => a + v, 0);
  const avgMonthly = sum / usedLast12.length;
  const annualReal = usedLast12.length >= 12;
  const annualKwh = annualReal ? sum : avgMonthly * 12;

  return {
    graphZone: graph,
    labelPreview,
    result: {
      detectedAll,
      usedLast12,
      monthsUsed: usedLast12.length,
      avgMonthly,
      annualKwh: Math.round(annualKwh),
      estimatedAnnual: !annualReal,
      confidenceAvg: confAvg,
      debug,
    },
  };
}

// ----------------------------- Main Page -----------------------------
export default function Page() {
  // Upload & OCR state
  const [rawFileName, setRawFileName] = useState<string>("");
  const [rawPreview, setRawPreview] = useState<string>("");
  const [graphPreview, setGraphPreview] = useState<string>("");
  const [labelsPreview, setLabelsPreview] = useState<string>("");

  const [ocrStatus, setOcrStatus] = useState<string>("");
  const [ocrError, setOcrError] = useState<string>("");
  const [ocrDebugOpen, setOcrDebugOpen] = useState<boolean>(false);

  const [detectedAll, setDetectedAll] = useState<number[]>([]);
  const [usedLast12, setUsedLast12] = useState<number[]>([]);
  const [monthsUsed, setMonthsUsed] = useState<number>(0);
  const [avgMonthlyOcr, setAvgMonthlyOcr] = useState<number | null>(null);
  const [annualOcr, setAnnualOcr] = useState<number | null>(null);
  const [estimatedAnnual, setEstimatedAnnual] = useState<boolean>(false);
  const [confidenceAvg, setConfidenceAvg] = useState<number>(0);
  const [debugLines, setDebugLines] = useState<string[]>([]);

  // manual override
  const [manualMonthly, setManualMonthly] = useState<number | "">("");

  // system assumptions
  const [offsetPct, setOffsetPct] = useState<number>(90);
  const [psh, setPsh] = useState<number>(5);
  const [lossFactor, setLossFactor] = useState<number>(0.8);
  const [panelW, setPanelW] = useState<number>(450);

  const [permits, setPermits] = useState<number>(1200);
  const [interconnection, setInterconnection] = useState<number>(450);
  const [pricePerW, setPricePerW] = useState<number>(2.3);

  // battery
  const [backupHours, setBackupHours] = useState<number>(8);
  const [criticalKw, setCriticalKw] = useState<number>(1.5);

  // OCR request cancelation
  const reqRef = useRef(0);

  useEffect(() => {
    // cleanup al salir de la página (opcional)
    return () => {
      terminateTesseractWorker();
    };
  }, []);

  const effectiveMonthly = useMemo(() => {
    if (manualMonthly !== "" && Number.isFinite(Number(manualMonthly))) return Number(manualMonthly);
    if (avgMonthlyOcr != null && Number.isFinite(avgMonthlyOcr)) return avgMonthlyOcr;
    return 0;
  }, [manualMonthly, avgMonthlyOcr]);

  const sizing = useMemo(() => {
    const annualKwh = annualOcr && annualOcr > 0 ? annualOcr : effectiveMonthly > 0 ? effectiveMonthly * 12 : 0;

    const targetAnnual = annualKwh * (offsetPct / 100);
    const kwhPerKwYear = psh * 365 * lossFactor;
    const pvKw = kwhPerKwYear > 0 ? targetAnnual / kwhPerKwYear : 0;

    const panels = panelW > 0 ? Math.ceil((pvKw * 1000) / panelW) : 0;

    const basePvCost = pvKw * 1000 * pricePerW;
    const misc = 0.03 * basePvCost;
    const pvCostTotal = basePvCost + permits + interconnection + misc;

    const usable = 0.9;
    const batteryKwh = usable > 0 ? (criticalKw * backupHours) / usable : 0;

    return {
      annualKwh,
      targetAnnual,
      pvKw: pvKw > 0 ? pvKw : 0,
      panels,
      pvCostTotal: pvCostTotal > 0 ? pvCostTotal : 0,
      basePvCost,
      misc,
      batteryKwh,
    };
  }, [annualOcr, effectiveMonthly, offsetPct, psh, lossFactor, panelW, pricePerW, permits, interconnection, backupHours, criticalKw]);

  async function handleFile(file: File) {
    setOcrError("");
    setOcrStatus("");
    setDebugLines([]);
    setDetectedAll([]);
    setUsedLast12([]);
    setMonthsUsed(0);
    setAvgMonthlyOcr(null);
    setAnnualOcr(null);
    setEstimatedAnnual(false);
    setConfidenceAvg(0);

    setRawFileName(file.name);

    const img = await loadImageFromFile(file);
    const pageCanvas = canvasFromImage(img, 1800);
    setRawPreview(canvasToDataUrl(pageCanvas, 0.85));

    const myReq = ++reqRef.current;
    const isCanceled = () => reqRef.current !== myReq;

    try {
      setOcrStatus("Detectando gráfica…");
      const { graphZone, labelPreview, result } = await runLumaBarLabelOcr(
        pageCanvas,
        (s) => {
          if (!isCanceled()) setOcrStatus(s);
        },
        myReq,
        isCanceled
      );

      if (isCanceled()) return;

      setGraphPreview(canvasToDataUrl(graphZone, 0.9));
      setLabelsPreview(canvasToDataUrl(labelPreview, 0.9));

      setDetectedAll(result.detectedAll);
      setUsedLast12(result.usedLast12);
      setMonthsUsed(result.monthsUsed);
      setAvgMonthlyOcr(result.monthsUsed >= 4 ? result.avgMonthly : null);
      setAnnualOcr(result.monthsUsed >= 4 ? result.annualKwh : null);
      setEstimatedAnnual(result.estimatedAnnual);
      setConfidenceAvg(result.confidenceAvg);
      setDebugLines(result.debug);

      if (result.monthsUsed < 4) {
        setOcrError(
          "OCR insuficiente: se detectaron menos de 4 meses. Toma la foto más nítida y completa (página 4), o escribe el kWh mensual promedio manualmente."
        );
      } else {
        setOcrStatus("OCR listo ✅");
      }
    } catch (e: any) {
      if (isCanceled()) return;
      setOcrError(e?.message || "Error procesando OCR.");
      setOcrStatus("");
    }
  }

  function clearAll() {
    reqRef.current++;
    setRawFileName("");
    setRawPreview("");
    setGraphPreview("");
    setLabelsPreview("");
    setOcrStatus("");
    setOcrError("");
    setDebugLines([]);
    setDetectedAll([]);
    setUsedLast12([]);
    setMonthsUsed(0);
    setAvgMonthlyOcr(null);
    setAnnualOcr(null);
    setEstimatedAnnual(false);
    setConfidenceAvg(0);
    setManualMonthly("");
  }

  function reprocesar() {
    if (!rawPreview) return;
    const myReq = ++reqRef.current;
    const isCanceled = () => reqRef.current !== myReq;

    (async () => {
      try {
        setOcrError("");
        setOcrStatus("Reprocesando…");
        setDebugLines([]);

        const img = new Image();
        img.src = rawPreview;
        await new Promise<void>((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error("No pude recargar la imagen para reprocesar."));
        });

        const pageCanvas = canvasFromImage(img, 1800);

        const { graphZone, labelPreview, result } = await runLumaBarLabelOcr(
          pageCanvas,
          (s) => {
            if (!isCanceled()) setOcrStatus(s);
          },
          myReq,
          isCanceled
        );

        if (isCanceled()) return;

        setGraphPreview(canvasToDataUrl(graphZone, 0.9));
        setLabelsPreview(canvasToDataUrl(labelPreview, 0.9));

        setDetectedAll(result.detectedAll);
        setUsedLast12(result.usedLast12);
        setMonthsUsed(result.monthsUsed);
        setAvgMonthlyOcr(result.monthsUsed >= 4 ? result.avgMonthly : null);
        setAnnualOcr(result.monthsUsed >= 4 ? result.annualKwh : null);
        setEstimatedAnnual(result.estimatedAnnual);
        setConfidenceAvg(result.confidenceAvg);
        setDebugLines(result.debug);

        if (result.monthsUsed < 4) {
          setOcrError(
            "OCR insuficiente: se detectaron menos de 4 meses. Toma la foto más nítida y completa (página 4), o escribe el kWh mensual promedio manualmente."
          );
        } else {
          setOcrStatus("OCR listo ✅");
        }
      } catch (e: any) {
        if (isCanceled()) return;
        setOcrError(e?.message || "Error reprocesando OCR.");
        setOcrStatus("");
      }
    })();
  }

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <main className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">Sunsol · Cotizador (sin vendedor)</h1>
          <div className="text-sm text-gray-600">
            <span className="font-medium">Foto / Screenshot de LUMA (página 4)</span>: usa la gráfica{" "}
            <span className="font-semibold">“CONSUMPTION HISTORY (KWH)”</span> / <span className="font-semibold">“Historial de consumo”</span>. Toma la{" "}
            <span className="font-semibold">página completa</span>, nítida y sin reflejos.
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Foto / Screenshot de LUMA</h2>
              {rawFileName ? <span className="text-xs text-gray-500">{rawFileName}</span> : null}
            </div>

            <div className="mt-4 flex gap-3">
              <button
                type="button"
                className="flex-1 rounded-xl bg-black px-4 py-3 text-sm font-semibold text-white active:opacity-90"
                onClick={() => cameraInputRef.current?.click()}
              >
                📷 Tomar foto
              </button>

              <button
                type="button"
                className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-900 active:opacity-90"
                onClick={() => galleryInputRef.current?.click()}
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
                  if (f) handleFile(f);
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
                  if (f) handleFile(f);
                  e.currentTarget.value = "";
                }}
              />
            </div>

            <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="text-sm font-medium text-gray-700">Consumo mensual promedio (kWh/mes)</div>
              <input
                className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-gray-900"
                placeholder="Ej. 600"
                inputMode="numeric"
                value={manualMonthly === "" ? "" : String(manualMonthly)}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (!v) return setManualMonthly("");
                  const n = Number(v);
                  if (Number.isFinite(n)) setManualMonthly(n);
                }}
              />
              <div className="mt-2 text-xs text-gray-500">Si lo llenas, reemplaza el OCR.</div>

              <div className="mt-3 text-sm text-gray-700">
                <div>
                  <span className="font-semibold">Consumo anual:</span>{" "}
                  {annualOcr && annualOcr > 0 ? (
                    <>
                      {annualOcr.toLocaleString()} kWh{" "}
                      <span className="text-xs text-gray-500">({estimatedAnnual ? `estimado con ${monthsUsed} mes(es) × 12` : `12m real`})</span>
                    </>
                  ) : (
                    <span className="text-gray-500">— (sin OCR)</span>
                  )}
                </div>
                <div className="mt-1">
                  <span className="font-semibold">OCR confianza:</span>{" "}
                  {confidenceAvg > 0 ? `${toFixedSmart(confidenceAvg, 1)}%` : <span className="text-gray-500">—</span>}
                </div>
              </div>

              {ocrStatus ? (
                <div className="mt-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700">{ocrStatus}</div>
              ) : null}

              {ocrError ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{ocrError}</div>
              ) : null}

              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  className="rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-900 disabled:opacity-40"
                  disabled={!rawPreview}
                  onClick={reprocesar}
                >
                  🔁 Reprocesar OCR
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-900"
                  onClick={clearAll}
                >
                  🧹 Limpiar
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
              <div className="font-semibold">Nota (importante)</div>
              <div className="mt-1">
                El auto-crop <span className="font-semibold">descarta el eje Y por posición</span> (margen izquierdo), aunque cambien sus números. Solo
                intenta leer los <span className="font-semibold">numeritos arriba de las barras</span>.
              </div>
              <div className="mt-1">
                Si faltan meses en la factura, usa los disponibles (mínimo 4) y estima el anual con <span className="font-semibold">promedio × 12</span>.
              </div>
            </div>

            <div className="mt-5">
              <div className="text-sm font-semibold">Preview</div>
              <div className="mt-2 grid grid-cols-3 gap-3">
                <PreviewCard title="Página (raw)" src={rawPreview} />
                <PreviewCard title="Auto-crop (zona gráfica)" src={graphPreview} />
                <PreviewCard title="OCR (labels arriba de barras)" src={labelsPreview} />
              </div>

              <button type="button" className="mt-3 text-xs font-semibold text-gray-700 underline" onClick={() => setOcrDebugOpen((v) => !v)}>
                {ocrDebugOpen ? "Ocultar debug OCR" : "Ver debug OCR (detalles)"}
              </button>

              {ocrDebugOpen ? (
                <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3 text-xs text-gray-800">
                  <div className="font-semibold">Detectados (orden X):</div>
                  <div className="mt-1 break-words text-gray-700">{detectedAll.length ? detectedAll.join(", ") : "—"}</div>

                  <div className="mt-3 font-semibold">Usados (12 más recientes):</div>
                  <div className="mt-1 break-words text-gray-700">{usedLast12.length ? usedLast12.join(", ") : "—"}</div>

                  <div className="mt-3 font-semibold">Logs:</div>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-[11px] text-gray-800">
                    {(debugLines || []).slice(0, 300).join("\n")}
                  </pre>
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold">Supuestos del sistema</h2>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <Field label="Offset (%)" value={offsetPct} onChange={setOffsetPct} step={1} />
              <Field label="PSH" value={psh} onChange={setPsh} step={0.1} />
              <Field label="Pérdidas (factor)" value={lossFactor} onChange={setLossFactor} step={0.01} />
              <Field label="Panel (W)" value={panelW} onChange={setPanelW} step={1} />
              <Field label="Permisos (est.)" value={permits} onChange={setPermits} step={50} />
              <Field label="Interconexión (est.)" value={interconnection} onChange={setInterconnection} step={25} />
              <Field label="Precio instalado ($/W)" value={pricePerW} onChange={setPricePerW} step={0.05} />
            </div>

            <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50 p-4">
              <div className="text-sm font-semibold">Resultado PV</div>

              <div className="mt-3 grid grid-cols-3 gap-3">
                <Stat label="Consumo mensual" value={effectiveMonthly > 0 ? `${toFixedSmart(effectiveMonthly, 2)} kWh` : "0 kWh"} />
                <Stat
                  label="Sistema recomendado"
                  value={sizing.pvKw > 0 ? `${toFixedSmart(sizing.pvKw, 2)} kW` : "0 kW"}
                  sub={sizing.panels ? `${sizing.panels} paneles (est.)` : "0 paneles"}
                />
                <Stat
                  label="PV (sin batería)"
                  value={sizing.pvCostTotal > 0 ? `$${Math.round(sizing.pvCostTotal).toLocaleString()}` : "$0"}
                  sub={`Base PV: $${Math.round(sizing.basePvCost).toLocaleString()} · Misc 3%: $${Math.round(sizing.misc).toLocaleString()}`}
                />
              </div>

              <div className="mt-4 text-xs text-gray-600">* Cálculo aproximado: kW = (kWh anual × offset) / (PSH × 365 × pérdidas).</div>
            </div>

            <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-4">
              <div className="text-sm font-semibold">Batería (estimado rápido)</div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label="Horas de respaldo" value={backupHours} onChange={setBackupHours} step={1} />
                <Field label="Cargas críticas (kW)" value={criticalKw} onChange={setCriticalKw} step={0.1} />
              </div>

              <div className="mt-3 text-sm text-gray-700">
                <span className="font-semibold">Recomendado:</span> {sizing.batteryKwh > 0 ? `${toFixedSmart(sizing.batteryKwh, 1)} kWh` : "0 kWh"}
              </div>

              <div className="mt-2 text-xs text-gray-500">* Aproximación: kWh = (kW × horas) / 0.9 (usable).</div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

// ----------------------------- Small UI pieces -----------------------------
function PreviewCard({ title, src }: { title: string; src: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="text-xs font-semibold text-gray-700">{title}</div>
      <div className="mt-2 aspect-[4/5] w-full overflow-hidden rounded-lg bg-gray-100">{src ? <img src={src} alt={title} className="h-full w-full object-cover" /> : null}</div>
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
        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-gray-900"
      />
    </label>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="text-xs font-medium text-gray-600">{label}</div>
      <div className="mt-1 text-lg font-semibold text-gray-900">{value}</div>
      {sub ? <div className="mt-1 text-xs text-gray-500">{sub}</div> : null}
    </div>
  );
}
