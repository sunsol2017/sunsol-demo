
"use client";

import React, { useMemo, useState } from "react";
import Tesseract from "tesseract.js";
import {
  Check,
  Info,
  Zap,
  BatteryCharging,
  Calculator,
  PhoneCall,
  Upload,
  Camera,
  Clock,
  PlugZap,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

const BATTERY_OPTIONS = [
  { kwh: 5, label: "5 kWh" },
  { kwh: 10, label: "10 kWh" },
  { kwh: 16, label: "16 kWh" },
  { kwh: 20, label: "20 kWh" },
  { kwh: 32, label: "32 kWh" },
  { kwh: 40, label: "40 kWh" },
];

const PV_PRICE_PER_W = 2.3; // fixed
const SOLUNA_PRICE_PER_KWH = 350; // fixed
const BATTERY_USABLE_FACTOR = 0.9;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function formatMoney(n: number) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
function formatNum(n: number, d = 1) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString(undefined, { maximumFractionDigits: d });
}

function nearestBatterySize(target: number) {
  let best = BATTERY_OPTIONS[0].kwh;
  let bestD = Math.abs(best - target);
  for (const opt of BATTERY_OPTIONS) {
    const d = Math.abs(opt.kwh - target);
    if (d < bestD) {
      bestD = d;
      best = opt.kwh;
    }
  }
  return best;
}

function pick3AroundRecommended(recommendedKwh: number) {
  const sorted = BATTERY_OPTIONS.map((b) => b.kwh).slice().sort((a, b) => a - b);
  const idx = sorted.indexOf(recommendedKwh);
  const smaller = idx > 0 ? sorted[idx - 1] : recommendedKwh;
  const larger = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : recommendedKwh;
  const unique3 = Array.from(new Set([smaller, recommendedKwh, larger]));
  return unique3.sort((a, b) => a - b);
}

export default function SunsolQuoteDemo() {
  // Inputs
  const [monthlyKwhManual, setMonthlyKwhManual] = useState<string>("");
  const [ocrKwh, setOcrKwh] = useState<number | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");

  // PV sizing assumptions
  const [offsetPct, setOffsetPct] = useState<number>(90);
  const [psh, setPsh] = useState<number>(5.0);
  const [lossFactor, setLossFactor] = useState<number>(0.8);
  const [panelW, setPanelW] = useState<number>(450);
  const [roofType, setRoofType] = useState<"shingle" | "concrete" | "metal" | "flat">("shingle");

  // Fees (simple)
  const [permitFee, setPermitFee] = useState<number>(1200);
  const [interconnectionFee, setInterconnectionFee] = useState<number>(450);

  // Battery selection
  const [batteryKwh, setBatteryKwh] = useState<"auto" | "none" | string>("auto");

  // Battery sizing questions (#2)
  const [backupHours, setBackupHours] = useState<number>(8);
  const [criticalKw, setCriticalKw] = useState<number>(1.5);

  // OCR handler
  async function onUploadImage(file: File) {
    setOcrBusy(true);
    setOcrStatus("Leyendo imagen…");
    setOcrKwh(null);

    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(file);
      });

      const res = await Tesseract.recognize(dataUrl, "eng");
      const text = String(res?.data?.text || "");
      const lower = text.toLowerCase();

      // Loose parse: find numbers near "kwh"
      const cleaned = lower.replace(/[^0-9a-z.]/gi, " ");
      const tokens = cleaned.split(" ").filter(Boolean);

      let best: number | null = null;

      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "kwh" || t.includes("kwh")) {
          // look back a bit for numeric token
          for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
            const cand = Number(tokens[j].replaceAll(",", ""));
            if (Number.isFinite(cand) && cand >= 50 && cand <= 10000) {
              best = best == null ? cand : Math.max(best, cand);
              break;
            }
          }
        }
      }

      if (best != null) {
        setOcrKwh(best);
        setMonthlyKwhManual(String(best));
        setOcrStatus(`kWh detectado: ${best}`);
      } else {
        setOcrStatus("No pude detectar kWh. Entra el kWh manual abajo.");
      }
    } catch (err) {
      console.error(err);
      setOcrStatus("No pude procesar la imagen. Prueba un recorte más nítido.");
    } finally {
      setOcrBusy(false);
    }
  }

  const computed = useMemo(() => {
    // Monthly kWh priority: OCR -> manual
    const manualKwh = Number(String(monthlyKwhManual).replaceAll(",", ""));
    const monthlyKwh =
      ocrKwh != null ? ocrKwh : Number.isFinite(manualKwh) && manualKwh > 0 ? manualKwh : 0;

    const dailyKwh = monthlyKwh / 30.4;
    const targetDaily = dailyKwh * (clamp(offsetPct, 0, 100) / 100);

    const pshVal = clamp(Number(psh) || 0, 2.0, 7.5);
    const lossVal = clamp(Number(lossFactor) || 0, 0.65, 0.9);

    // PV sizing: kW = daily_kWh / (PSH * losses)
    const pvKwIdeal = pshVal * lossVal > 0 ? targetDaily / (pshVal * lossVal) : 0;

    // Panel count / rounding
    const pW = clamp(Number(panelW) || 450, 300, 700);
    const panels = pW > 0 ? Math.ceil((pvKwIdeal * 1000) / pW) : 0;
    const pvKwRounded = panels > 0 ? (panels * pW) / 1000 : 0;

    // Roof adder demo
    const roofAdderPct =
      roofType === "concrete" ? 0.03 : roofType === "metal" ? 0.06 : roofType === "flat" ? 0.04 : 0;

    const basePvCost = pvKwRounded * 1000 * PV_PRICE_PER_W;
    const roofAdderCost = basePvCost * roofAdderPct;

    const permits = clamp(Number(permitFee) || 0, 0, 99999);
    const interconnection = clamp(Number(interconnectionFee) || 0, 0, 99999);

    const miscPct = 0.03;
    const miscCost = (basePvCost + roofAdderCost) * miscPct;

    const pvTotalNoBattery = basePvCost + roofAdderCost + permits + interconnection + miscCost;

    // Battery recommendation based on backupHours * criticalKw
    const requiredBatteryKwh = (backupHours * criticalKw) / BATTERY_USABLE_FACTOR;
    const recommendedKwh = nearestBatterySize(requiredBatteryKwh);

    const batteryKwhEffective =
      batteryKwh === "auto"
        ? recommendedKwh
        : batteryKwh === "none"
        ? null
        : Number(batteryKwh);

    const batteryCost = batteryKwhEffective ? batteryKwhEffective * SOLUNA_PRICE_PER_KWH : 0;

    const three = pick3AroundRecommended(recommendedKwh);

    // ✅ CORREGIDO: batteryCards usa pvTotalNoBattery (ya calculado)
    const batteryCards = three.map((kwh) => {
      const battCost = kwh * SOLUNA_PRICE_PER_KWH;
      const totalWithBattery = pvTotalNoBattery + battCost;
      const estHours = (kwh * BATTERY_USABLE_FACTOR) / Math.max(0.5, criticalKw);
      const label =
        kwh === recommendedKwh ? "Recomendada" : kwh < recommendedKwh ? "Económica" : "Premium";

      return { kwh, label, batteryCost: battCost, totalCost: totalWithBattery, estHours };
    });

    return {
      monthlyKwh,
      dailyKwh,
      pvKwRounded,
      panels,
      basePvCost,
      roofAdderCost,
      permits,
      interconnection,
      miscCost,
      pvTotalNoBattery,
      requiredBatteryKwh,
      recommendedKwh,
      batteryKwhEffective,
      batteryCost,
      batteryCards,
    };
  }, [
    monthlyKwhManual,
    ocrKwh,
    offsetPct,
    psh,
    lossFactor,
    panelW,
    roofType,
    permitFee,
    interconnectionFee,
    batteryKwh,
    backupHours,
    criticalKw,
  ]);

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sunsol • Cotizador (sin vendedor)</h1>
          <p className="text-sm text-muted-foreground">
            PV: <b>$2.30/W</b> • Batería Soluna: <b>$350/kWh</b> • <b>Sin incentivos</b>
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Info className="h-4 w-4" />
          Estimado preliminar. Validación final requiere inspección.
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Foto / Screenshot de LUMA (historial)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-2xl border p-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-xl border p-2">
                    <Camera className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Sube una foto del área donde sale el kWh mensual</p>
                    <p className="text-xs text-muted-foreground">
                      Ideal: recorte nítido del cuadro que dice <b>kWh</b>.
                    </p>
                    {ocrStatus ? <p className="mt-1 text-xs text-muted-foreground">{ocrStatus}</p> : null}
                  </div>
                </div>

                <input
                  type="file"
                  accept="image/*"
                  disabled={ocrBusy}
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f) onUploadImage(f);
                  }}
                  className="block w-full max-w-[260px] text-sm"
                />
              </div>
            </div>

            <div>
              <Label>Consumo mensual (kWh)</Label>
              <Input
                inputMode="numeric"
                value={monthlyKwhManual}
                onChange={(e) => setMonthlyKwhManual(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Si el OCR falla, escribe el kWh aquí.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calculator className="h-5 w-5" />
              Supuestos del sistema
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <Label>Offset (%)</Label>
              <Input
                inputMode="numeric"
                value={offsetPct}
                onChange={(e) => setOffsetPct(Number(e.target.value))}
              />
            </div>

            <div>
              <Label>PSH</Label>
              <Input inputMode="decimal" value={psh} onChange={(e) => setPsh(Number(e.target.value))} />
            </div>

            <div>
              <Label>Pérdidas (factor)</Label>
              <Input
                inputMode="decimal"
                value={lossFactor}
                onChange={(e) => setLossFactor(Number(e.target.value))}
              />
            </div>

            <div>
              <Label>Panel (W)</Label>
              <Input inputMode="numeric" value={panelW} onChange={(e) => setPanelW(Number(e.target.value))} />
            </div>

            <div>
              <Label>Techo</Label>
              <Select value={roofType} onValueChange={(v) => setRoofType(v as any)}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shingle">Shingle</SelectItem>
                  <SelectItem value="concrete">Hormigón</SelectItem>
                  <SelectItem value="metal">Metal</SelectItem>
                  <SelectItem value="flat">Techo plano</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Permisos (est.)</Label>
              <Input inputMode="numeric" value={permitFee} onChange={(e) => setPermitFee(Number(e.target.value))} />
            </div>

            <div>
              <Label>Interconexión (est.)</Label>
              <Input
                inputMode="numeric"
                value={interconnectionFee}
                onChange={(e) => setInterconnectionFee(Number(e.target.value))}
              />
            </div>

            <div>
              <Label>Precio instalado ($/W)</Label>
              <Input value={PV_PRICE_PER_W} readOnly />
              <p className="text-xs text-muted-foreground">Fijo. Sin incentivos.</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="rounded-2xl md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Resultado PV
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="rounded-2xl border p-3">
                <div className="text-xs text-muted-foreground">Consumo mensual</div>
                <div className="text-2xl font-semibold">{formatNum(computed.monthlyKwh, 0)} kWh</div>
              </div>
              <div className="rounded-2xl border p-3">
                <div className="text-xs text-muted-foreground">Sistema recomendado</div>
                <div className="text-2xl font-semibold">{formatNum(computed.pvKwRounded, 1)} kW</div>
                <div className="text-xs text-muted-foreground">{computed.panels} paneles (est.)</div>
              </div>
              <div className="rounded-2xl border p-3">
                <div className="text-xs text-muted-foreground">PV (sin batería)</div>
                <div className="text-2xl font-semibold">{formatMoney(computed.pvTotalNoBattery)}</div>
              </div>
            </div>

            <Separator />

            <div className="text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Base PV</span>
                <span>{formatMoney(computed.basePvCost)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Adder techo</span>
                <span>{formatMoney(computed.roofAdderCost)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Permisos</span>
                <span>{formatMoney(computed.permits)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Interconexión</span>
                <span>{formatMoney(computed.interconnection)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Misceláneo (3%)</span>
                <span>{formatMoney(computed.miscCost)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BatteryCharging className="h-5 w-5" />
              Batería
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>Batería</Label>
              <Select value={batteryKwh} onValueChange={setBatteryKwh as any}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Recomendada (según respaldo)</SelectItem>
                  <SelectItem value="none">Sin batería</SelectItem>
                  {BATTERY_OPTIONS.map((b) => (
                    <SelectItem key={b.kwh} value={String(b.kwh)}>
                      {b.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <div>
                <Label className="flex items-center gap-2">
                  <Clock className="h-4 w-4" /> Horas de respaldo
                </Label>
                <Select value={String(backupHours)} onValueChange={(v) => setBackupHours(Number(v))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="4">4 horas</SelectItem>
                    <SelectItem value="8">8 horas</SelectItem>
                    <SelectItem value="12">12 horas</SelectItem>
                    <SelectItem value="24">24 horas</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="flex items-center gap-2">
                  <PlugZap className="h-4 w-4" /> Cargas críticas
                </Label>
                <Select value={String(criticalKw)} onValueChange={(v) => setCriticalKw(Number(v))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1.0 kW (mínimo)</SelectItem>
                    <SelectItem value="1.5">1.5 kW (típico)</SelectItem>
                    <SelectItem value="2">2.0 kW (alto)</SelectItem>
                    <SelectItem value="3">3.0 kW (muy alto)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded-2xl border p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Recomendado</span>
                <span className="font-semibold">{computed.recommendedKwh} kWh</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Necesario aprox.: {formatNum(computed.requiredBatteryKwh, 1)} kWh • Seleccionado:{" "}
                {computed.batteryKwhEffective ? `${computed.batteryKwhEffective} kWh` : "Sin batería"}
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-muted-foreground">Costo batería</span>
                <span>{formatMoney(computed.batteryCost)}</span>
              </div>
            </div>

            <Separator />

            <div className="text-sm font-medium">Económica / Recomendada / Premium</div>
            <div className="grid grid-cols-1 gap-3">
              {computed.batteryCards.map((opt) => (
                <div key={opt.kwh} className="rounded-2xl border p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">
                      {opt.label}: {opt.kwh} kWh
                    </div>
                    <Badge className="rounded-full" variant="secondary">
                      {formatMoney(opt.totalCost)}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Batería: {formatMoney(opt.batteryCost)} • Respaldo aprox.: {formatNum(opt.estHours, 1)} h @{" "}
                    {formatNum(criticalKw, 1)} kW
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant={computed.batteryKwhEffective === opt.kwh ? "default" : "secondary"}
                      className="rounded-2xl"
                      onClick={() => setBatteryKwh(String(opt.kwh))}
                    >
                      {computed.batteryKwhEffective === opt.kwh ? "Seleccionada" : "Elegir"}
                    </Button>
                    <Button variant="outline" className="rounded-2xl" onClick={() => setBatteryKwh("auto")}>
                      Auto
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <Separator />

            <div className="rounded-2xl border p-3">
              <div className="text-xs text-muted-foreground">Total final (con selección actual)</div>
              <div className="text-2xl font-semibold">
                {formatMoney(computed.pvTotalNoBattery + computed.batteryCost)}
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Check className="h-4 w-4" />
                Sin incentivo/crédito contributivo en este estimado.
              </div>
            </div>

            <Button className="w-full rounded-2xl" variant="outline">
              <PhoneCall className="mr-2 h-4 w-4" />
              Continuar con Sunsol
            </Button>
          </CardContent>
        </Card>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Nota: El tamaño final depende de evaluación de techo, sombras, orientación y validación de cargas críticas.
      </p>
    </div>
  );
}
