"use client";

import React, { useMemo, useState, useEffect } from "react";

type RoofType = "Shingle" | "Metal" | "Concrete";

const PV_PRICE_PER_W = 2.3; // $/W
const SOLUNA_PRICE_PER_KWH = 350; // $/kWh
const BATTERY_SIZES = [5, 10, 16, 20, 32, 40] as const;

const BATTERY_USABLE_FACTOR = 0.9; // usable energy factor (typical)
const DAYS_PER_MONTH = 30.4;

function clampNumber(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function roundTo(n: number, step: number) {
  if (!Number.isFinite(n) || step <= 0) return n;
  return Math.round(n / step) * step;
}

function formatMoney(n: number) {
  if (!Number.isFinite(n)) return "$0";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function safeParseNumber(v: string) {
  const x = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : 0;
}

export default function Page() {
  // -----------------------------
  // User inputs
  // -----------------------------
  const [monthlyKwh, setMonthlyKwh] = useState<string>(""); // can be OCR or manual
  const [offsetPct, setOffsetPct] = useState<number>(90);
  const [psh, setPsh] = useState<number>(5);
  const [lossFactor, setLossFactor] = useState<number>(0.8);
  const [panelW, setPanelW] = useState<number>(450);
  const [roofType, setRoofType] = useState<RoofType>("Shingle");

  const [permits, setPermits] = useState<number>(1200);
  const [interconnection, setInterconnection] = useState<number>(450);
  const [miscPct, setMiscPct] = useState<number>(3);

  // Battery sizing inputs
  const [batteryMode, setBatteryMode] = useState<"recommended" | "manual">("recommended");
  const [manualBatteryKwh, setManualBatteryKwh] = useState<number>(16);
  const [backupHours, setBackupHours] = useState<number>(8);
  const [criticalKw, setCriticalKw] = useState<number>(1.5);

  // OCR state
  const [ocrBusy, setOcrBusy] = useState<boolean>(false);
  const [ocrNote, setOcrNote] = useState<string>("");

  // Uploader UI state
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [lastFileName, setLastFileName] = useState<string | null>(null);

  // Cleanup blob urls
  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    };
  }, [imagePreview]);

  // -----------------------------
  // Roof adder (simple placeholder)
  // You can tune these later
  // -----------------------------
  const roofAdderCost = useMemo(() => {
    // You can set these to 0 if you don't want this adder
    if (roofType === "Shingle") return 0;
    if (roofType === "Metal") return 350;
    if (roofType === "Concrete") return 650;
    return 0;
  }, [roofType]);

  // -----------------------------
  // Core calculations
  // -----------------------------
  const calc = useMemo(() => {
    const kwhMonth = safeParseNumber(monthlyKwh);
    const offset = clampNumber(offsetPct / 100, 0, 1);
    const pshSafe = Math.max(0.1, psh);
    const lossSafe = clampNumber(lossFactor, 0.3, 1);

    // kWh/day
    const kwhDay = kwhMonth / DAYS_PER_MONTH;

    // PV kW needed (DC-ish estimate)
    // PV(kW) = (kWh/day * offset) / (PSH * losses)
    const pvKw = (kwhDay * offset) / (pshSafe * lossSafe);

    // Panel count
    const panelKw = Math.max(0.1, panelW) / 1000;
    const rawPanels = pvKw / panelKw;
    const panels = kwhMonth > 0 ? Math.max(1, Math.ceil(rawPanels)) : 0;

    // Nameplate PV W
    const pvW = panels * panelW;

    // PV base cost
    const basePvCost = pvW * PV_PRICE_PER_W;

    // Misc
    const miscCost = (basePvCost * clampNumber(miscPct, 0, 20)) / 100;

    // PV total without battery
    const pvTotalNoBattery =
      basePvCost + roofAdderCost + Math.max(0, permits) + Math.max(0, interconnection) + miscCost;

    // Battery recommendation:
    // needed usable kWh = criticalKw * hours
    // required installed kWh = usable / factor
    const neededUsableKwh = Math.max(0, criticalKw) * Math.max(0, backupHours);
    const requiredInstalledKwh =
      neededUsableKwh > 0 ? neededUsableKwh / BATTERY_USABLE_FACTOR : 0;

    const recommendedBattery =
      BATTERY_SIZES.find((s) => s >= requiredInstalledKwh) ?? BATTERY_SIZES[BATTERY_SIZES.length - 1];

    const selectedBatteryKwh = batteryMode === "recommended" ? recommendedBattery : manualBatteryKwh;

    const batteryCost = Math.max(0, selectedBatteryKwh) * SOLUNA_PRICE_PER_KWH;

    const totalWithBattery = pvTotalNoBattery + batteryCost;

    // Estimated backup hours for selected battery
    const estBackupHours =
      criticalKw > 0 ? (selectedBatteryKwh * BATTERY_USABLE_FACTOR) / criticalKw : 0;

    return {
      kwhMonth,
      kwhDay,
      pvKw,
      panels,
      pvW,
      basePvCost,
      miscCost,
      pvTotalNoBattery,
      batteryCost,
      totalWithBattery,
      recommendedBattery,
      selectedBatteryKwh,
      estBackupHours,
      requiredInstalledKwh,
    };
  }, [
    monthlyKwh,
    offsetPct,
    psh,
    lossFactor,
    panelW,
    roofAdderCost,
    permits,
    interconnection,
    miscPct,
    batteryMode,
    manualBatteryKwh,
    backupHours,
    criticalKw,
  ]);

  // -----------------------------
  // OCR / Image handling
  // -----------------------------
  const extractKwhFromText = (text: string): number | null => {
    // Try to find something like 479.77 near "kwh"
    // This is heuristic; you can tune later with real LUMA samples.
    const cleaned = text.replace(/\s+/g, " ").toLowerCase();

    // Match patterns like "kwh 479.77" or "479.77 kwh"
    const patterns = [
      /kwh[^0-9]{0,10}([0-9]{2,6}(?:\.[0-9]{1,3})?)/i,
      /([0-9]{2,6}(?:\.[0-9]{1,3})?)[^a-z0-9]{0,10}kwh/i,
    ];

    for (const p of patterns) {
      const m = cleaned.match(p);
      if (m && m[1]) {
        const n = safeParseNumber(m[1]);
        if (n > 0) return n;
      }
    }

    // Fallback: pick the largest “reasonable” number in text (50..5000)
    const nums = cleaned.match(/[0-9]{2,6}(?:\.[0-9]{1,3})?/g) || [];
    const candidates = nums
      .map((s) => safeParseNumber(s))
      .filter((n) => n >= 50 && n <= 5000);

    if (candidates.length === 0) return null;
    return Math.max(...candidates);
  };

  const processImageFile = async (file: File) => {
    setOcrBusy(true);
    setOcrNote("Leyendo imagen…");

    try {
      // Lazy import to keep bundle lighter
      const Tesseract = (await import("tesseract.js")).default;

      setOcrNote("Ejecutando OCR (puede tardar)…");
      const res = await Tesseract.recognize(file, "eng", {
        logger: (m: any) => {
          if (m?.status === "recognizing text" && typeof m?.progress === "number") {
            const pct = Math.round(m.progress * 100);
            setOcrNote(`OCR: ${pct}%`);
          }
        },
      });

      const text = res?.data?.text || "";
      const kwh = extractKwhFromText(text);

      if (kwh && kwh > 0) {
        setMonthlyKwh(String(roundTo(kwh, 0.01)));
        setOcrNote(`kWh detectado: ${roundTo(kwh, 0.01)}`);
      } else {
        setOcrNote("No pude detectar el kWh. Escribe el kWh manualmente.");
      }
    } catch (e) {
      setOcrNote("OCR falló. Escribe el kWh manualmente.");
    } finally {
      setOcrBusy(false);
    }
  };

  const handleImageFile = async (file: File) => {
    if (!file.type.startsWith("image/")) return;

    setLastFileName(file.name);

    const url = URL.createObjectURL(file);
    setImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });

    await processImageFile(file);
  };

  const onCameraChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-upload same file
    if (!file) return;
    await handleImageFile(file);
  };

  const onGalleryChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await handleImageFile(file);
  };

  const clearImage = () => {
    setImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setLastFileName(null);
    setOcrNote("");
    setOcrBusy(false);
    // (no borramos monthlyKwh automáticamente para no frustrar al cliente)
  };

  const onDropZone = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    await handleImageFile(file);
  };

  // -----------------------------
  // UI
  // -----------------------------
  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="rounded-xl border bg-white p-4">
          <div className="text-xl font-bold">Sunsol • Cotizador (sin vendedor)</div>
          <div className="text-sm text-gray-600">
            PV: <b>${PV_PRICE_PER_W.toFixed(2)}/W</b> • Batería Soluna: <b>${SOLUNA_PRICE_PER_KWH}/kWh</b> •{" "}
            <b>Sin incentivos</b>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            Estimado preliminar. Validación final requiere inspección.
          </div>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Uploader */}
          <div className="rounded-xl border bg-white p-4">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-base font-semibold">Foto / Screenshot de LUMA (historial)</div>
              {ocrBusy ? (
                <span className="text-xs font-medium text-gray-700">Procesando…</span>
              ) : null}
            </div>

            <div className="text-sm text-gray-600">
              Sube una foto del área donde sale el <b>kWh mensual</b>. Ideal: recorte nítido del cuadro que dice kWh.
            </div>

            {/* Inputs ocultos */}
            <input
              id="lumaCamera"
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={onCameraChange}
              disabled={ocrBusy}
            />
            <input
              id="lumaGallery"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onGalleryChange}
              disabled={ocrBusy}
            />

            {/* Botones */}
            <div className="mt-3 flex flex-wrap gap-2">
              <label
                htmlFor="lumaCamera"
                className={`cursor-pointer rounded-md border px-3 py-2 text-sm font-medium shadow-sm active:scale-[0.99] ${
                  ocrBusy ? "opacity-50 pointer-events-none" : ""
                }`}
              >
                📷 Tomar foto
              </label>

              <label
                htmlFor="lumaGallery"
                className={`cursor-pointer rounded-md border px-3 py-2 text-sm font-medium shadow-sm active:scale-[0.99] ${
                  ocrBusy ? "opacity-50 pointer-events-none" : ""
                }`}
              >
                🖼️ Subir de galería
              </label>

              <button
                type="button"
                onClick={clearImage}
                className="rounded-md border px-3 py-2 text-sm font-medium shadow-sm active:scale-[0.99]"
                disabled={ocrBusy || (!imagePreview && !lastFileName && !ocrNote)}
              >
                🧽 Borrar
              </button>
            </div>

            {/* Dropzone + preview */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDropZone}
              className="mt-3 rounded-lg border border-dashed bg-gray-50 p-3"
            >
              <div className="text-xs text-gray-600">En computadora: arrastra y suelta la imagen aquí.</div>

              {lastFileName ? (
                <div className="mt-2 text-xs text-gray-700">
                  Archivo: <b>{lastFileName}</b>
                </div>
              ) : null}

              {imagePreview ? (
                <div className="mt-3">
                  <img
                    src={imagePreview}
                    alt="Preview LUMA"
                    className="max-h-64 w-full rounded-md object-contain"
                  />
                </div>
              ) : (
                <div className="mt-3 text-sm text-gray-500">No hay imagen seleccionada todavía.</div>
              )}
            </div>

            {/* OCR note */}
            <div className="mt-3 text-sm">
              {ocrNote ? <div className="text-gray-700">{ocrNote}</div> : <div className="text-gray-500">—</div>}
            </div>

            {/* Manual entry */}
            <div className="mt-3">
              <label className="text-sm font-medium text-gray-800">Consumo mensual (kWh)</label>
              <input
                value={monthlyKwh}
                onChange={(e) => setMonthlyKwh(e.target.value)}
                placeholder="Ej: 480"
                inputMode="decimal"
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
              />
              <div className="mt-1 text-xs text-gray-500">Si el OCR falla, escribe el kWh aquí.</div>
            </div>
          </div>

          {/* Assumptions */}
          <div className="rounded-xl border bg-white p-4">
            <div className="text-base font-semibold">Supuestos del sistema</div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium text-gray-800">Offset (%)</label>
                <input
                  value={offsetPct}
                  onChange={(e) => setOffsetPct(safeParseNumber(e.target.value))}
                  inputMode="decimal"
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-gray-800">PSH</label>
                <input
                  value={psh}
                  onChange={(e) => setPsh(safeParseNumber(e.target.value))}
                  inputMode="decimal"
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-gray-800">Pérdidas (factor)</label>
                <input
                  value={lossFactor}
                  onChange={(e) => setLossFactor(safeParseNumber(e.target.value))}
                  inputMode="decimal"
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-gray-800">Panel (W)</label>
                <input
                  value={panelW}
                  onChange={(e) => setPanelW(safeParseNumber(e.target.value))}
                  inputMode="numeric"
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-gray-800">Techo</label>
                <select
                  value={roofType}
                  onChange={(e) => setRoofType(e.target.value as RoofType)}
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                >
                  <option value="Shingle">Shingle</option>
                  <option value="Metal">Metal</option>
                  <option value="Concrete">Concrete</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-800">Permisos (est.)</label>
                <input
                  value={permits}
                  onChange={(e) => setPermits(safeParseNumber(e.target.value))}
                  inputMode="decimal"
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-gray-800">Interconexión (est.)</label>
                <input
                  value={interconnection}
                  onChange={(e) => setInterconnection(safeParseNumber(e.target.value))}
                  inputMode="decimal"
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-gray-800">Misceláneo (%)</label>
                <input
                  value={miscPct}
                  onChange={(e) => setMiscPct(safeParseNumber(e.target.value))}
                  inputMode="decimal"
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="mt-3 text-xs text-gray-500">Precio instalado ($/W): fijo ${PV_PRICE_PER_W.toFixed(2)}. Sin incentivos.</div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {/* PV results */}
          <div className="rounded-xl border bg-white p-4">
            <div className="text-base font-semibold">Resultado PV</div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-gray-500">Consumo mensual</div>
                <div className="text-lg font-bold">{calc.kwhMonth ? `${roundTo(calc.kwhMonth, 0.01)} kWh` : "0 kWh"}</div>
              </div>

              <div className="rounded-lg border p-3">
                <div className="text-xs text-gray-500">Sistema recomendado</div>
                <div className="text-lg font-bold">{calc.panels ? `${roundTo(calc.pvKw, 0.01)} kW` : "0 kW"}</div>
                <div className="text-xs text-gray-500">{calc.panels ? `${calc.panels} paneles (est.)` : "0 paneles (est.)"}</div>
              </div>

              <div className="rounded-lg border p-3">
                <div className="text-xs text-gray-500">PV (sin batería)</div>
                <div className="text-lg font-bold">{formatMoney(calc.pvTotalNoBattery)}</div>
              </div>
            </div>

            <div className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between"><span>Base PV</span><span>{formatMoney(calc.basePvCost)}</span></div>
              <div className="flex justify-between"><span>Adder techo</span><span>{formatMoney(roofAdderCost)}</span></div>
              <div className="flex justify-between"><span>Permisos</span><span>{formatMoney(permits)}</span></div>
              <div className="flex justify-between"><span>Interconexión</span><span>{formatMoney(interconnection)}</span></div>
              <div className="flex justify-between"><span>Misceláneo ({miscPct}%)</span><span>{formatMoney(calc.miscCost)}</span></div>
            </div>
          </div>

          {/* Battery */}
          <div className="rounded-xl border bg-white p-4">
            <div className="text-base font-semibold">Batería</div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium text-gray-800">Modo</label>
                <select
                  value={batteryMode}
                  onChange={(e) => setBatteryMode(e.target.value as any)}
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                >
                  <option value="recommended">Recomendada (según respaldo)</option>
                  <option value="manual">Seleccionar tamaño</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-800">Horas de respaldo</label>
                <select
                  value={backupHours}
                  onChange={(e) => setBackupHours(safeParseNumber(e.target.value))}
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                >
                  {[4, 6, 8, 10, 12, 16].map((h) => (
                    <option key={h} value={h}>
                      {h} horas
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-800">Cargas críticas (kW)</label>
                <select
                  value={criticalKw}
                  onChange={(e) => setCriticalKw(safeParseNumber(e.target.value))}
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                >
                  {[1, 1.5, 2, 3, 4, 5].map((k) => (
                    <option key={k} value={k}>
                      {k} kW (típico)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-800">Tamaño batería</label>
                <select
                  value={batteryMode === "recommended" ? calc.recommendedBattery : manualBatteryKwh}
                  onChange={(e) => setManualBatteryKwh(safeParseNumber(e.target.value))}
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                  disabled={batteryMode !== "manual"}
                >
                  {BATTERY_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s} kWh
                    </option>
                  ))}
                </select>
                <div className="mt-1 text-xs text-gray-500">
                  Recomendada: <b>{calc.recommendedBattery} kWh</b> (necesaria aprox. {roundTo(calc.requiredInstalledKwh, 0.01)} kWh)
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-lg border p-3">
              <div className="flex justify-between text-sm">
                <span>Batería seleccionada</span>
                <b>{calc.selectedBatteryKwh} kWh</b>
              </div>
              <div className="flex justify-between text-sm mt-1">
                <span>Costo batería</span>
                <b>{formatMoney(calc.batteryCost)}</b>
              </div>
              <div className="flex justify-between text-sm mt-1">
                <span>Horas estimadas (según cargas)</span>
                <b>{Number.isFinite(calc.estBackupHours) ? roundTo(calc.estBackupHours, 0.1) : 0} h</b>
              </div>
            </div>
          </div>
        </div>

        {/* Total */}
        <div className="rounded-xl border bg-white p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-base font-semibold">Total estimado</div>
              <div className="text-xs text-gray-500">PV + permisos/interconexión/misceláneo + batería (si aplica). Sin incentivos.</div>
            </div>

            <div className="text-right">
              <div className="text-xs text-gray-500">Total con batería</div>
              <div className="text-2xl font-bold">{formatMoney(calc.totalWithBattery)}</div>
            </div>
          </div>
        </div>

        <footer className="pb-8 text-xs text-gray-500">
          Nota: Este es un estimado preliminar automatizado. Precio final requiere evaluación de techo, distancias, paneles eléctricos, y requisitos de LUMA.
        </footer>
      </div>
    </div>
  );
}
