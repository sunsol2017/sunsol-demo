"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Sunsol demo — page.tsx
 * Fixes:
 * - Camera/gallery uploader reliable on Android Chrome
 * - OCR no se queda “procesando” (timeouts + errores manejados)
 * - Auto-crop robusto: encuentra la zona “CONSUMPTION HISTORY (KWH)” por banda gris, y recorta por posición
 * - Descarta eje Y SIEMPRE (por margen izquierdo), aunque cambien números del eje
 * - OCR SOLO intenta leer los numeritos encima de las barras (ROIs por barra)
 * - Rango candidato 20–3000
 * - Usa 12 meses más recientes (si hay 13, ignora el primero); si hay <12 pero >=4, estima anual = promedio * 12
 */

type OcrMonthResult = { value: number | null; confidence: number; raw: string };

type WorkerLike = {
  load?: () => Promise<void>;
  loadLanguage?: (lang: string) => Promise<void>;
  initialize?: (lang: string) => Promise<void>;
  reinitialize?: (lang: string) => Promise<void>;
  setParameters?: (p: Record<string, string>) => Promise<void>;
  recognize: (image: any) => Promise<{ data: { text: string; confidence: number } }>;
  terminate?: () => Promise<void>;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
  let t: any;
  const timeout = new Promise<T>((_, rej) => {
    t = setTimeout(() => rej(new Error(`Timeout (${label}) after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

function formatNum(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function parseDigitsOnly(text: string): string {
  return (text || "").replace(/[^\d]/g, "");
}

/** Extrae un candidato entre 20–3000 de un string OCR */
function pickCandidateNumber(rawText: string): number | null {
  if (!rawText) return null;

  // Busca grupos de 2-4 dígitos (más robusto que "todo pegado")
  const matches = rawText.match(/\d{2,4}/g) || [];
  const nums = matches
    .map((m) => Number(m))
    .filter((n) => Number.isFinite(n) && n >= 20 && n <= 3000);

  if (nums.length) {
    // Heurística: preferir 3 dígitos (típico residencial) si existe; si no, el más “razonable”
    const three = nums.filter((n) => n >= 100 && n <= 999);
    if (three.length) return three[0];
    return nums[0];
  }

  // Fallback: si vino pegado, intenta últimas 4/3/2 cifras
  const digits = parseDigitsOnly(rawText);
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

/** Lee un File como bitmap respetando orientación EXIF cuando el browser soporta createImageBitmap */
async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  // Prefer createImageBitmap (aplica orientación en Chrome moderno si se pide)
  if ("createImageBitmap" in window) {
    try {
      // @ts-ignore
      const bmp: ImageBitmap = await (window as any).createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return c;
    } catch {
      // fallback abajo
    }
  }

  // Fallback: <img>
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = rej;
      el.src = url;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.floor(w));
  c.height = Math.max(1, Math.floor(h));
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

/**
 * Auto-crop zona gráfica:
 * - Busca una banda horizontal “gris” grande (header del chart) en la mitad inferior
 * - Si la encuentra, recorta un rectángulo que incluye header + barras (sin la parte de meses/line chart)
 * - Siempre corta margen izquierdo para DESCARTAR eje Y por posición (no por valores)
 */
function autoCropGraphZone(page: HTMLCanvasElement): { graph: HTMLCanvasElement; debug: { headerY?: number } } {
  const w = page.width;
  const h = page.height;

  // Scan en baja resolución para encontrar banda gris
  const scanW = 420;
  const scale = scanW / w;
  const scanH = Math.max(1, Math.round(h * scale));
  const scan = document.createElement("canvas");
  scan.width = scanW;
  scan.height = scanH;
  const sctx = scan.getContext("2d")!;
  sctx.drawImage(page, 0, 0, scanW, scanH);

  const data = sctx.getImageData(0, 0, scanW, scanH).data;

  // mean + std por fila
  const rowMean = new Float32Array(scanH);
  const rowStd = new Float32Array(scanH);

  for (let y = 0; y < scanH; y++) {
    let sum = 0;
    let sum2 = 0;
    const rowStart = y * scanW * 4;
    for (let x = 0; x < scanW; x++) {
      const i = rowStart + x * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const gray = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
      sum += gray;
      sum2 += gray * gray;
    }
    const mean = sum / scanW;
    const varr = sum2 / scanW - mean * mean;
    rowMean[y] = mean;
    rowStd[y] = Math.sqrt(Math.max(0, varr));
  }

  // Bandas candidatas: gris (mean 175–245) con variación (std>=12) y en mitad inferior
  const minY = Math.floor(scanH * 0.30);
  let best: { y0: number; y1: number; score: number } | null = null;

  let y = minY;
  while (y < scanH) {
    const isCandidate = rowMean[y] >= 175 && rowMean[y] <= 245 && rowStd[y] >= 12;
    if (!isCandidate) {
      y++;
      continue;
    }
    const start = y;
    while (y < scanH) {
      const ok = rowMean[y] >= 175 && rowMean[y] <= 245 && rowStd[y] >= 10;
      if (!ok) break;
      y++;
    }
    const end = y;
    const len = end - start;

    // header suele ser una banda relativamente “alta” (>= 8px en scan)
    if (len >= 8) {
      let stdAvg = 0;
      for (let k = start; k < end; k++) stdAvg += rowStd[k];
      stdAvg /= len;

      const score = len * stdAvg;
      if (!best || score > best.score) best = { y0: start, y1: end, score };
    }
  }

  // Fallback si no encuentra header
  let headerYpx: number | undefined;
  let cropX0 = Math.round(w * 0.06); // DESCARTA eje Y por posición
  let cropX1 = Math.round(w * 0.985);
  let cropY0: number;
  let cropH: number;

  if (best) {
    const headerTop = best.y0 / scale;
    headerYpx = Math.round(headerTop);

    // Recorte: un poco arriba del header, y altura fija relativa al total para agarrar barras + labels
    cropY0 = Math.round(clamp(headerTop - h * 0.02, 0, h - 1));
    cropH = Math.round(h * 0.28); // clave: evita caer en meses + line chart
  } else {
    // fallback (funciona con página completa típica)
    cropY0 = Math.round(h * 0.50);
    cropH = Math.round(h * 0.30);
  }

  const cropY1 = Math.round(clamp(cropY0 + cropH, 1, h));
  const graph = cropCanvas(page, cropX0, cropY0, cropX1 - cropX0, cropY1 - cropY0);

  return { graph, debug: { headerY: headerYpx } };
}

/** Prepara ROI para OCR (escala + binariza suave) */
function prepForOcr(src: HTMLCanvasElement, scaleUp = 2): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.width * scaleUp));
  c.height = Math.max(1, Math.round(src.height * scaleUp));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);

  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;

  // Binarización: deja dígitos (negro) y limpia ruido claro
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    const gray = r * 0.299 + g * 0.587 + b * 0.114;
    const v = gray < 200 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  return c;
}

/**
 * Crea ROIs por barra (13 barras típicas).
 * Asume distribución uniforme horizontal dentro del recorte del chart.
 * Devuelve también un canvas “debug” donde solo se ven las ROIs.
 */
function buildBarLabelRois(graph: HTMLCanvasElement, barCount = 13) {
  const gw = graph.width;
  const gh = graph.height;

  const segW = gw / barCount;

  // Canvas debug: solo las ROIs
  const dbg = document.createElement("canvas");
  dbg.width = gw;
  dbg.height = gh;
  const dctx = dbg.getContext("2d")!;
  dctx.fillStyle = "white";
  dctx.fillRect(0, 0, gw, gh);

  // Para encontrar el “top” de cada barra, usamos un escaneo rápido por filas en el centro del segmento
  const ctx = graph.getContext("2d")!;
  const img = ctx.getImageData(0, 0, gw, gh).data;

  function grayAt(x: number, y: number) {
    const i = (y * gw + x) * 4;
    const r = img[i],
      g = img[i + 1],
      b = img[i + 2];
    return r * 0.299 + g * 0.587 + b * 0.114;
  }

  const rois: { i: number; canvas: HTMLCanvasElement }[] = [];

  for (let i = 0; i < barCount; i++) {
    const sx0 = Math.round(i * segW);
    const sx1 = Math.round((i + 1) * segW);

    // margen dentro del segmento para evitar tocar bordes / grid
    const x0 = Math.round(sx0 + segW * 0.10);
    const x1 = Math.round(sx1 - segW * 0.10);
    const cx0 = Math.round(sx0 + segW * 0.25);
    const cx1 = Math.round(sx1 - segW * 0.25);

    // buscar top de barra: primera fila con suficientes pixeles oscuros
    let topY = Math.round(gh * 0.30); // fallback razonable si no detecta
    const darkThresh = 165; // barra gris / texto negro
    const minDark = Math.max(3, Math.round((cx1 - cx0) * 0.10)); // 10% del ancho central

    let consec = 0;
    for (let y = 0; y < gh; y++) {
      let dark = 0;
      for (let x = cx0; x < cx1; x++) {
        if (grayAt(x, y) < darkThresh) dark++;
      }
      if (dark >= minDark) {
        consec++;
        if (consec >= 2) {
          topY = y - 1;
          break;
        }
      } else {
        consec = 0;
      }
    }

    // ROI: un bloque arriba del top de barra (solo números encima)
    const roiH = Math.round(gh * 0.22); // suficientemente grande para 3-4 dígitos
    const pad = Math.round(gh * 0.01);

    const ry1 = clamp(topY + pad, 1, gh);
    const ry0 = clamp(ry1 - roiH, 0, gh - 1);

    const roi = cropCanvas(graph, x0, ry0, x1 - x0, ry1 - ry0);

    // dibuja ROI en debug (posición original)
    dctx.drawImage(graph, x0, ry0, x1 - x0, ry1 - ry0, x0, ry0, x1 - x0, ry1 - ry0);

    rois.push({ i, canvas: roi });
  }

  return { rois, debugCanvas: dbg };
}

/** OCR Worker (tesseract.js) — configurado para browser/Vercel */
async function createTesseractWorker(logger: (msg: string) => void): Promise<WorkerLike> {
  const mod: any = await import("tesseract.js");
  const createWorker: any = mod?.createWorker ?? mod?.default?.createWorker;
  if (typeof createWorker !== "function") {
    throw new Error("No pude cargar createWorker() desde tesseract.js.");
  }

  // Importante: en Next/Vercel a veces la ruta del worker/core no resuelve bien => lo forzamos por CDN.
  const worker: WorkerLike = await withTimeout(
    Promise.resolve(
      createWorker({
        logger: (m: any) => {
          const s =
            typeof m === "string"
              ? m
              : m?.status
              ? `${m.status}${typeof m.progress === "number" ? ` ${(m.progress * 100).toFixed(0)}%` : ""}`
              : JSON.stringify(m);
          logger(s);
        },
        // CDN paths (evitan “worker never resolves” en deployments)
        workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/worker.min.js",
        corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js",
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
      })
    ),
    25000,
    "createWorker"
  );

  // Soporta varias versiones de API
  if (worker.load) await withTimeout(worker.load(), 20000, "worker.load");
  if (worker.loadLanguage) await withTimeout(worker.loadLanguage("eng"), 20000, "worker.loadLanguage");
  if (worker.initialize) await withTimeout(worker.initialize("eng"), 20000, "worker.initialize");
  else if (worker.reinitialize) await withTimeout(worker.reinitialize("eng"), 20000, "worker.reinitialize");

  if (worker.setParameters) {
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      preserve_interword_spaces: "1",
      // 7 = single text line, 8 = single word (varía)
      tessedit_pageseg_mode: "7",
    });
  }

  return worker;
}

export default function Page() {
  // Inputs del sistema
  const [offsetPct, setOffsetPct] = useState<number>(90);
  const [psh, setPsh] = useState<number>(5);
  const [lossFactor, setLossFactor] = useState<number>(0.8);
  const [panelW, setPanelW] = useState<number>(450);
  const [permits, setPermits] = useState<number>(1200);
  const [interconnect, setInterconnect] = useState<number>(450);
  const [pricePerW, setPricePerW] = useState<number>(2.3);
  const miscPct = 0.03;

  // Uploader / OCR
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const [fileName, setFileName] = useState<string>("");
  const [pagePreviewUrl, setPagePreviewUrl] = useState<string>("");

  const [processing, setProcessing] = useState<boolean>(false);
  const [ocrMsg, setOcrMsg] = useState<string>("");
  const [ocrProgress, setOcrProgress] = useState<string>("");

  const [avgMonthlyKwh, setAvgMonthlyKwh] = useState<number | null>(null); // lo que usa el cálculo
  const [annualKwh, setAnnualKwh] = useState<number | null>(null);
  const [monthsUsed, setMonthsUsed] = useState<number>(0);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);

  // Debug previews
  const [dbgRaw, setDbgRaw] = useState<string>("");
  const [dbgGraph, setDbgGraph] = useState<string>("");
  const [dbgLabels, setDbgLabels] = useState<string>("");

  // Worker cache
  const workerRef = useRef<WorkerLike | null>(null);
  const workerBusyRef = useRef<boolean>(false);

  useEffect(() => {
    return () => {
      // cleanup previews
      if (pagePreviewUrl) URL.revokeObjectURL(pagePreviewUrl);
      // terminate worker
      const w = workerRef.current;
      workerRef.current = null;
      if (w?.terminate) w.terminate().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pricing = useMemo(() => {
    const kwh = avgMonthlyKwh && avgMonthlyKwh > 0 ? avgMonthlyKwh : 0;
    const pvKw =
      kwh > 0
        ? (kwh * (offsetPct / 100)) / (psh * lossFactor * 30) // kWdc aproximado
        : 0;

    const panels = pvKw > 0 ? Math.ceil((pvKw * 1000) / panelW) : 0;
    const pvBase = pvKw * 1000 * pricePerW;
    const misc = pvBase * miscPct;
    const total = pvBase + permits + interconnect + misc;

    return {
      kwh,
      pvKw,
      panels,
      pvBase,
      misc,
      total,
    };
  }, [avgMonthlyKwh, offsetPct, psh, lossFactor, panelW, pricePerW, permits, interconnect]);

  function resetOcrOutputs() {
    setOcrMsg("");
    setOcrProgress("");
    setAnnualKwh(null);
    setMonthsUsed(0);
    setOcrConfidence(null);
  }

  async function ensureWorker() {
    if (workerRef.current) return workerRef.current;
    const w = await createTesseractWorker((m) => setOcrProgress(m));
    workerRef.current = w;
    return w;
  }

  async function runOcrFromFile(file: File) {
    if (workerBusyRef.current) return; // evita doble corrida
    workerBusyRef.current = true;

    setProcessing(true);
    resetOcrOutputs();

    try {
      // canvas de página
      const pageCanvas = await fileToCanvas(file);

      // Debug raw
      setDbgRaw(pageCanvas.toDataURL("image/jpeg", 0.75));

      // Auto-crop chart zone
      const { graph } = autoCropGraphZone(pageCanvas);
      setDbgGraph(graph.toDataURL("image/jpeg", 0.8));

      // Build ROIs por barra (labels arriba)
      const { rois, debugCanvas } = buildBarLabelRois(graph, 13);
      setDbgLabels(debugCanvas.toDataURL("image/jpeg", 0.85));

      const worker = await ensureWorker();

      // OCR por ROI
      const results: { i: number; r: OcrMonthResult }[] = [];
      for (const roi of rois) {
        // pre-procesa ROI para mejorar lectura de dígitos
        const prepped = prepForOcr(roi.canvas, 2);
        const out = await withTimeout(worker.recognize(prepped), 20000, `recognize(bar ${roi.i})`);
        const raw = (out?.data?.text || "").trim();
        const conf = typeof out?.data?.confidence === "number" ? out.data.confidence : 0;
        const val = pickCandidateNumber(raw);

        results.push({ i: roi.i, r: { value: val, confidence: conf, raw } });
      }

      // Toma valores válidos
      const valid = results
        .map((x) => ({ i: x.i, value: x.r.value, confidence: x.r.confidence }))
        .filter((x) => typeof x.value === "number" && x.value !== null) as {
        i: number;
        value: number;
        confidence: number;
      }[];

      // Orden natural (izq->der)
      valid.sort((a, b) => a.i - b.i);

      // Usa 12 más recientes: si hay 13, ignora el primero (oldest)
      const mostRecent = valid.length > 12 ? valid.slice(valid.length - 12) : valid;

      if (mostRecent.length < 4) {
        setOcrMsg("OCR insuficiente: se detectaron menos de 4 meses. Toma la foto más nítida y completa (página 4), o escribe el kWh mensual promedio manualmente.");
        setOcrConfidence(0);
        setMonthsUsed(mostRecent.length);
        setAnnualKwh(null);
        return;
      }

      const sum = mostRecent.reduce((acc, x) => acc + x.value, 0);
      const avg = sum / mostRecent.length;
      const annual =
        mostRecent.length >= 12
          ? sum // anual real (12 meses)
          : avg * 12; // anual estimado

      const confAvg = mostRecent.reduce((acc, x) => acc + (x.confidence || 0), 0) / mostRecent.length;

      setAvgMonthlyKwh(Number(avg.toFixed(2)));
      setAnnualKwh(Math.round(annual));
      setMonthsUsed(mostRecent.length);
      setOcrConfidence(clamp(confAvg, 0, 100));

      setOcrMsg(
        mostRecent.length >= 12
          ? `OK. Anual (12m real): ${formatNum(Math.round(annual))} kWh. Promedio mensual: ${avg.toFixed(2)} kWh.`
          : `OK. Estimado: ${formatNum(Math.round(annual))} kWh/año usando ${mostRecent.length} mes(es). Promedio mensual: ${avg.toFixed(2)} kWh.`
      );
    } catch (err: any) {
      const msg = err?.message || String(err);
      setOcrMsg(msg);
    } finally {
      setProcessing(false);
      workerBusyRef.current = false;
    }
  }

  function onPickFile(file?: File | null) {
    if (!file) return;

    setFileName(file.name || "foto");
    setProcessing(false);
    setOcrMsg("");
    setOcrProgress("");

    // preview URL (para UI)
    const url = URL.createObjectURL(file);
    if (pagePreviewUrl) URL.revokeObjectURL(pagePreviewUrl);
    setPagePreviewUrl(url);

    // dispara OCR
    runOcrFromFile(file).catch((e) => setOcrMsg(e?.message || String(e)));
  }

  function clickCamera() {
    // Importante: botón type="button" para que NO haga submit
    cameraInputRef.current?.click();
  }
  function clickGallery() {
    galleryInputRef.current?.click();
  }

  function clearAll() {
    setFileName("");
    if (pagePreviewUrl) URL.revokeObjectURL(pagePreviewUrl);
    setPagePreviewUrl("");
    setDbgRaw("");
    setDbgGraph("");
    setDbgLabels("");
    resetOcrOutputs();
  }

  function reprocess() {
    if (!cameraInputRef.current && !galleryInputRef.current) return;
    // Reprocesar usando el último preview no es confiable (necesita el File).
    // Solución simple: pedir al usuario re-seleccionar la imagen.
    setOcrMsg("Reprocesar: vuelve a seleccionar la misma foto (Tomar foto o Subir de galería).");
  }

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="flex flex-col gap-2">
          <div className="text-2xl font-semibold">Sunsol • Cotizador (sin vendedor)</div>
          <div className="text-sm text-gray-600">
            PV: <span className="font-medium">${pricePerW.toFixed(2)}/W</span> • Batería Soluna:{" "}
            <span className="font-medium">$350/kWh</span> • Sin incentivos
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {/* Uploader */}
          <div className="rounded-2xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold">Foto / Screenshot de LUMA (página 4)</div>
                <div className="mt-1 text-sm text-gray-600">
                  Usa la página 4 donde aparece <span className="font-medium">“CONSUMPTION HISTORY (KWH)”</span> (o “Historial de consumo”). Toma la{" "}
                  <span className="font-medium">página completa</span>, nítida y sin reflejos.
                </div>
              </div>
              {processing && (
                <div className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                  Procesando…
                </div>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={clickCamera}
                className="rounded-xl bg-black px-4 py-3 text-sm font-semibold text-white active:scale-[0.99]"
                disabled={processing}
              >
                📸 Tomar foto
              </button>
              <button
                type="button"
                onClick={clickGallery}
                className="rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-900 active:scale-[0.99]"
                disabled={processing}
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
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0] ?? null;
                  e.currentTarget.value = ""; // permite seleccionar la misma foto de nuevo
                  onPickFile(f);
                }}
              />
              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0] ?? null;
                  e.currentTarget.value = "";
                  onPickFile(f);
                }}
              />
            </div>

            <div className="mt-5">
              <div className="text-sm font-medium text-gray-800">Consumo mensual promedio (kWh/mes)</div>
              <input
                type="number"
                inputMode="numeric"
                placeholder="Ej. 600"
                className="mt-2 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900"
                value={avgMonthlyKwh ?? ""}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v)) setAvgMonthlyKwh(null);
                  else setAvgMonthlyKwh(v);
                }}
              />
              <div className="mt-2 text-xs text-gray-600">Si lo llenas, reemplaza el OCR.</div>

              <div className="mt-3 text-sm text-gray-800">
                <div>
                  <span className="font-semibold">Consumo anual:</span>{" "}
                  {annualKwh ? (
                    <span>
                      {formatNum(annualKwh)} kWh{" "}
                      <span className="text-gray-500">
                        ({monthsUsed >= 12 ? "usó 12 meses" : `usó ${monthsUsed} mes(es)`})
                      </span>
                    </span>
                  ) : (
                    <span className="text-gray-500">— (sin OCR)</span>
                  )}
                </div>
                <div>
                  <span className="font-semibold">OCR confianza:</span>{" "}
                  {typeof ocrConfidence === "number" ? <span>{ocrConfidence.toFixed(0)}%</span> : <span className="text-gray-500">—</span>}
                </div>
              </div>

              {ocrProgress ? <div className="mt-3 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-700">{ocrProgress}</div> : null}

              {ocrMsg ? (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{ocrMsg}</div>
              ) : null}

              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={reprocess}
                  className="rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-900"
                  disabled={processing}
                >
                  🔁 Reprocesar OCR
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  className="rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-900"
                  disabled={processing}
                >
                  🧹 Limpiar
                </button>
              </div>

              <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
                <div className="font-semibold">Nota (importante)</div>
                <div className="mt-1">
                  El auto-crop <span className="font-semibold">descarta el eje Y por posición</span> (margen izquierdo), aunque cambien sus números. Solo intenta leer los{" "}
                  <span className="font-semibold">numeritos arriba de las barras</span>.
                </div>
                <div className="mt-1">
                  Si faltan meses en la factura, usa los disponibles (mínimo 4) y estima anual con <span className="font-semibold">promedio × 12</span>.
                </div>
              </div>
            </div>

            {/* Debug previews */}
            <div className="mt-6">
              <div className="text-sm font-semibold text-gray-900">Preview</div>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-gray-200 p-2">
                  <div className="text-xs font-medium text-gray-700">Página (raw)</div>
                  <div className="mt-2 aspect-[3/4] w-full overflow-hidden rounded-lg bg-gray-100">
                    {dbgRaw ? <img src={dbgRaw} alt="raw" className="h-full w-full object-cover" /> : null}
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200 p-2">
                  <div className="text-xs font-medium text-gray-700">Auto-crop (zona gráfica)</div>
                  <div className="mt-2 aspect-[3/4] w-full overflow-hidden rounded-lg bg-gray-100">
                    {dbgGraph ? <img src={dbgGraph} alt="graph" className="h-full w-full object-cover" /> : null}
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200 p-2">
                  <div className="text-xs font-medium text-gray-700">OCR (labels arriba de barras)</div>
                  <div className="mt-2 aspect-[3/4] w-full overflow-hidden rounded-lg bg-gray-100">
                    {dbgLabels ? <img src={dbgLabels} alt="labels" className="h-full w-full object-cover" /> : null}
                  </div>
                </div>
              </div>

              {pagePreviewUrl ? (
                <div className="mt-3 text-xs text-gray-600">
                  Archivo: <span className="font-medium">{fileName}</span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Supuestos / Resultados */}
          <div className="flex flex-col gap-6">
            <div className="rounded-2xl border border-gray-200 p-5 shadow-sm">
              <div className="text-base font-semibold">Supuestos del sistema</div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <Field label="Offset (%)" value={offsetPct} onChange={setOffsetPct} step={1} />
                <Field label="PSH" value={psh} onChange={setPsh} step={0.1} />
                <Field label="Pérdidas (factor)" value={lossFactor} onChange={setLossFactor} step={0.01} />
                <Field label="Panel (W)" value={panelW} onChange={setPanelW} step={10} />
                <Field label="Permisos (est.)" value={permits} onChange={setPermits} step={50} />
                <Field label="Interconexión (est.)" value={interconnect} onChange={setInterconnect} step={50} />
                <Field label="Precio instalado ($/W)" value={pricePerW} onChange={setPricePerW} step={0.05} />
                <div className="flex flex-col justify-end rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
                  <div className="text-xs text-gray-600">Misceláneo</div>
                  <div className="text-sm font-semibold">{(miscPct * 100).toFixed(0)}%</div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200 p-5 shadow-sm">
              <div className="text-base font-semibold">Resultado PV</div>

              <div className="mt-4 grid grid-cols-3 gap-3">
                <Stat title="Consumo mensual" value={`${formatNum(Math.round(pricing.kwh))} kWh`} />
                <Stat title="Sistema recomendado" value={`${pricing.pvKw ? pricing.pvKw.toFixed(2) : "0.00"} kW`} sub={`${pricing.panels} paneles (est.)`} />
                <Stat title="PV (sin batería)" value={`$${formatNum(Math.round(pricing.total))}`} />
              </div>

              <div className="mt-4 text-sm text-gray-700">
                <div className="flex justify-between">
                  <span>Base PV</span>
                  <span>${formatNum(Math.round(pricing.pvBase))}</span>
                </div>
                <div className="flex justify-between">
                  <span>Permisos</span>
                  <span>${formatNum(Math.round(permits))}</span>
                </div>
                <div className="flex justify-between">
                  <span>Interconexión</span>
                  <span>${formatNum(Math.round(interconnect))}</span>
                </div>
                <div className="flex justify-between">
                  <span>Misceláneo ({(miscPct * 100).toFixed(0)}%)</span>
                  <span>${formatNum(Math.round(pricing.misc))}</span>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200 p-5 shadow-sm">
              <div className="text-base font-semibold">Batería</div>
              <div className="mt-2 text-sm text-gray-600">
                (Demo) Recomendación simple según respaldo. Ajustamos cuando definamos cargas críticas reales.
              </div>

              <BatteryCard />
            </div>
          </div>
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
        className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900"
      />
    </label>
  );
}

function Stat({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="text-xs text-gray-600">{title}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {sub ? <div className="text-xs text-gray-500">{sub}</div> : null}
    </div>
  );
}

function BatteryCard() {
  const [hours, setHours] = useState<number>(8);
  const [criticalKw, setCriticalKw] = useState<number>(1.5);

  const batteryKwh = useMemo(() => {
    // Factor “realista” para pérdidas/DoD/reserva (ajustable)
    const raw = criticalKw * hours;
    const recommended = raw * 1.3;
    return Math.max(0, recommended);
  }, [hours, criticalKw]);

  const batteryCost = useMemo(() => batteryKwh * 350, [batteryKwh]);

  return (
    <div className="mt-4 grid grid-cols-2 gap-3">
      <label className="block">
        <div className="text-xs font-medium text-gray-700">Horas de respaldo</div>
        <select
          className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-gray-900"
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
        >
          {[4, 6, 8, 10, 12].map((h) => (
            <option key={h} value={h}>
              {h} horas
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <div className="text-xs font-medium text-gray-700">Cargas críticas (kW)</div>
        <select
          className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-gray-900"
          value={criticalKw}
          onChange={(e) => setCriticalKw(Number(e.target.value))}
        >
          {[1.0, 1.5, 2.0, 2.5, 3.0].map((k) => (
            <option key={k} value={k}>
              {k.toFixed(1)} kW
            </option>
          ))}
        </select>
      </label>

      <div className="col-span-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-3">
        <div className="text-xs text-gray-600">Recomendado</div>
        <div className="mt-1 flex items-end justify-between gap-3">
          <div className="text-2xl font-semibold">{batteryKwh.toFixed(0)} kWh</div>
          <div className="text-sm text-gray-600">≈ ${batteryCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="mt-1 text-xs text-gray-500">
          Nota: esto es un estimado rápido. Luego definimos cargas protegidas, picos de arranque, y modelo de batería/inversor.
        </div>
      </div>
    </div>
  );
}
