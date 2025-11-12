import { FormEvent, useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Play, Square, Clock, Wifi, Database, Activity, AlertCircle, LogOut } from "lucide-react";
import { describeApiError, requestEsp32, getApiBaseOverride, getApiBaseUrl, setApiBaseUrl } from "@/lib/api";

type TrafficState = "RED" | "YELLOW" | "GREEN" | "OFF";

interface StatusPayload {
  running?: boolean;
  state?: string;
  time?: string;
  ms_remaining?: number;
  durations_ms?: { red?: number; green?: number; yellow?: number };
  sensors?: SensorsPayload; // por si tu /api/status incluye sensores
}

interface SensorsPayload {
  bmp?: { ok?: boolean; temp_c?: number; press_hpa?: number; alt_m?: number };
  dht?: { ok?: boolean; temp_c?: number; hum_pct?: number };
  soil?: { raw?: number; pct?: number };
  rain?: boolean;
  last_ms?: number;
}

type ProxySyncResult = { ok: true } | { ok: false; error?: unknown };

const describeUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message || "Error desconocido";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Error desconocido";
  }
};

const trafficStateMap: Record<string, TrafficState> = {
  RED: "RED", ROJO: "RED",
  GREEN: "GREEN", VERDE: "GREEN",
  YELLOW: "YELLOW", AMARILLO: "YELLOW",
  OFF: "OFF", APAGADO: "OFF",
};

const normalizeTrafficState = (value: unknown): TrafficState | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return trafficStateMap[normalized] ?? null;
};

const formatLocalTime = () => new Date().toLocaleTimeString("es-ES", { hour12: false });

export default function Dashboard() {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const initialOverride = getApiBaseOverride();
  const initialEffective = getApiBaseUrl();
  const [apiOverride, setApiOverride] = useState(initialOverride);
  const [apiEffective, setApiEffective] = useState(initialEffective);
  const [apiField, setApiField] = useState(initialOverride);
  const [isSavingApiBase, setIsSavingApiBase] = useState(false);
  const [proxyBase, setProxyBase] = useState<string | null>(null);
  const proxyStatusRef = useRef<"unknown" | "available" | "unavailable">("unknown");

  const apiTarget = apiEffective || (typeof window !== "undefined" ? window.location.origin : "");

  const [trafficState, setTrafficState] = useState<TrafficState>("OFF");
  const [isRunning, setIsRunning] = useState(false);
  const [espTime, setEspTime] = useState<string | null>(null);
  const [localTime, setLocalTime] = useState(() => formatLocalTime());
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "disconnected">("disconnected");

  const [durMs, setDurMs] = useState({ red: 8000, green: 9000, yellow: 2000 });

  // --- Sensores ---
  const [sensors, setSensors] = useState<SensorsPayload | null>(null);
  const [sensorsError, setSensorsError] = useState<string | null>(null);
  const [lastSensorsAt, setLastSensorsAt] = useState<string>("—");

  const timerRef = useRef<number | null>(null);
  const isCheckingStatus = useRef(false);
  const isFetchingSensors = useRef(false);

  const refreshProxyBase = useCallback(async () => {
    if (typeof window === "undefined") return;
    try {
      const res = await fetch("/_config/esp32_base");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const payload = await res.json().catch(() => null);
      const base = payload && typeof payload.base === "string" ? payload.base : "";
      setProxyBase(base);
      proxyStatusRef.current = "available";
    } catch (error) {
      proxyStatusRef.current = "unavailable";
      setProxyBase(null);
      console.debug("Proxy Servidor.py no disponible", error);
    }
  }, []);

  const syncProxyBase = useCallback(
    async (override: string): Promise<ProxySyncResult> => {
      if (typeof window === "undefined") return { ok: false };
      try {
        const res = await fetch("/_config/esp32_base", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base: override }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Status ${res.status}`);
        }
        let payload: any = null;
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
        const base = payload && typeof payload.base === "string" ? payload.base : "";
        setProxyBase(base);
        proxyStatusRef.current = "available";
        return { ok: true };
      } catch (error) {
        proxyStatusRef.current = "unavailable";
        setProxyBase(null);
        console.debug("No se pudo sincronizar proxy (Servidor.py)", error);
        return { ok: false, error };
      }
    },
    []
  );

  const safeClearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const nextDelay = useCallback(
    (s: TrafficState) =>
      s === "GREEN" ? durMs.green :
      s === "YELLOW" ? durMs.yellow :
      s === "RED" ? durMs.red : 3000,
    [durMs]
  );

  // setTimeout encadenado para soportar duraciones distintas por color
  const startLocalCycle = useCallback((initial: TrafficState, firstDelayMs?: number) => {
    safeClearTimer();
    let state: TrafficState = initial === "OFF" ? "GREEN" : initial;
    setTrafficState(state);

    let delay = typeof firstDelayMs === "number" && firstDelayMs >= 0 ? firstDelayMs : nextDelay(state);

    const tick = () => {
      state = state === "GREEN" ? "YELLOW" : state === "YELLOW" ? "RED" : "GREEN";
      setTrafficState(state);
      timerRef.current = window.setTimeout(tick, nextDelay(state));
    };

    timerRef.current = window.setTimeout(tick, delay);
  }, [nextDelay, safeClearTimer]);

  const checkStatus = useCallback(async () => {
    if (isCheckingStatus.current) return;
    isCheckingStatus.current = true;
    try {
      const { response, data } = await requestEsp32<StatusPayload>("/api/status", { failOnBadGateway: true });
      if (!response.ok) throw Object.assign(new Error(`Status ${response.status}`), { response });

      setConnectionStatus("connected");
      const payload = (data ?? {}) as StatusPayload;

      if (typeof payload.time === "string" && payload.time.trim() !== "") setEspTime(payload.time);

      if (payload.durations_ms) {
        setDurMs(d => ({
          red: payload.durations_ms?.red ?? d.red,
          green: payload.durations_ms?.green ?? d.green,
          yellow: payload.durations_ms?.yellow ?? d.yellow,
        }));
      }

      if (typeof payload.running === "boolean") {
        setIsRunning(payload.running);
        if (!payload.running) {
          safeClearTimer();
          setTrafficState("OFF");
        }
      }

      const normalizedState = normalizeTrafficState(payload.state);
      if (payload.running && normalizedState) {
        const rem = typeof payload.ms_remaining === "number" ? payload.ms_remaining : undefined;
        startLocalCycle(normalizedState, rem);
      } else if (normalizedState === "OFF") {
        setTrafficState("OFF");
      }

      // si /api/status ya trae sensores, úsalo
      if (payload.sensors) {
        setSensors(payload.sensors);
        setSensorsError(null);
        setLastSensorsAt(new Date().toLocaleTimeString());
      }
    } catch (error) {
      console.error("Error comprobando estado del ESP32", error);
      setConnectionStatus("disconnected");
      setEspTime(null);
    } finally {
      isCheckingStatus.current = false;
    }
  }, [safeClearTimer, startLocalCycle]);

  const fetchSensors = useCallback(async () => {
    if (isFetchingSensors.current) return;
    isFetchingSensors.current = true;
    try {
      const { response, data } = await requestEsp32<SensorsPayload>("/api/sensors", { failOnBadGateway: true });
      if (!response.ok) throw Object.assign(new Error(`Status ${response.status}`), { response });
      setSensors((data ?? null) as SensorsPayload);
      setSensorsError(null);
      setLastSensorsAt(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Error leyendo sensores", err);
      setSensorsError(describeApiError(err));
    } finally {
      isFetchingSensors.current = false;
    }
  }, []);

  const performApiBaseUpdate = useCallback(
    async (value: string, reset = false) => {
      setIsSavingApiBase(true);
      const previousProxyStatus = proxyStatusRef.current;
      try {
        const { effective, override } = setApiBaseUrl(value);
        setApiOverride(override);
        setApiEffective(effective);
        setApiField(override);
        const proxyResult = await syncProxyBase(override);
        const description = override
          ? `Las peticiones se enviarán a ${effective}.`
          : "Las peticiones usarán el proxy/local actual.";
        toast({
          title: reset ? "Destino restablecido" : "Destino actualizado",
          description,
        });
        await Promise.allSettled([checkStatus(), fetchSensors()]);
        if (!proxyResult.ok && previousProxyStatus === "available" && proxyResult.error) {
          toast({
            title: "Proxy no actualizado",
            description: "No se pudo notificar a Servidor.py. Ejecuta el proxy con --esp32 <IP> o ajústalo manualmente.",
            variant: "destructive",
          });
        }
      } catch (error) {
        console.error("Error actualizando destino API", error);
        toast({
          title: "Error actualizando destino",
          description: describeUnknownError(error),
          variant: "destructive",
        });
        proxyStatusRef.current = previousProxyStatus;
      } finally {
        setIsSavingApiBase(false);
      }
    },
    [checkStatus, fetchSensors, syncProxyBase, toast]
  );

  const handleSaveApiBase = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await performApiBaseUpdate(apiField);
  }, [apiField, performApiBaseUpdate]);

  const handleResetApiBase = useCallback(async () => {
    await performApiBaseUpdate("", true);
  }, [performApiBaseUpdate]);

  useEffect(() => { setApiField(apiOverride); }, [apiOverride]);

  useEffect(() => { refreshProxyBase(); }, [refreshProxyBase]);

  // Redirigir si no hay usuario
  useEffect(() => { if (!loading && !user) navigate("/auth"); }, [user, loading, navigate]);

  // Limpiar timers al desmontar
  useEffect(() => () => safeClearTimer(), [safeClearTimer]);

  // Reloj local
  useEffect(() => {
    const interval = window.setInterval(() => setLocalTime(formatLocalTime()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Sondeo periódico
  useEffect(() => {
    checkStatus();
    fetchSensors();
    const i1 = window.setInterval(checkStatus, 10000);
    const i2 = window.setInterval(fetchSensors, 5000);
    return () => { window.clearInterval(i1); window.clearInterval(i2); };
  }, [checkStatus, fetchSensors]);

  const handleStart = async () => {
    if (isRunning) return;
    safeClearTimer();
    try {
      const { response, data } = await requestEsp32("/api/start", { method: "POST" });
      if (!response.ok) {
        const payload = (data as { error?: string } | null) ?? null;
        throw Object.assign(new Error(payload?.error ?? `Error ${response.status}`), { response });
      }
      setIsRunning(true);
      setConnectionStatus("connected");
      toast({ title: "Sistema iniciado", description: "Semáforo en operación" });
      await checkStatus();
    } catch (error) {
      console.error("No se pudo iniciar el semáforo", error);
      setConnectionStatus("disconnected");
      toast({ title: "Fallo al iniciar", description: describeApiError(error), variant: "destructive" });
    }
  };

  const handleStop = async () => {
    if (!isRunning) return;
    try {
      const { response, data } = await requestEsp32("/api/stop", { method: "POST" });
      if (!response.ok) {
        const payload = (data as { error?: string } | null) ?? null;
        throw Object.assign(new Error(payload?.error ?? `Error ${response.status}`), { response });
      }
      safeClearTimer();
      setIsRunning(false);
      setTrafficState("OFF");
      setConnectionStatus("connected");
      toast({ title: "Sistema detenido", description: "Semáforo fuera de servicio", variant: "destructive" });
      await checkStatus();
    } catch (error) {
      console.error("No se pudo detener el semáforo", error);
      toast({ title: "Fallo al detener", description: describeApiError(error), variant: "destructive" });
    }
  };

  const handleSignOut = async () => {
    if (!confirm("¿Cerrar sesión?")) return;
    try {
      await signOut();
      toast({ title: "Sesión cerrada", description: "Has salido del sistema" });
      navigate("/auth");
    } catch {
      toast({ variant: "destructive", title: "Error", description: "No se pudo cerrar la sesión" });
    }
  };

  const getStateColor = (state: TrafficState) => {
    switch (state) {
      case "RED": return "bg-red-500";
      case "YELLOW": return "bg-yellow-500";
      case "GREEN": return "bg-green-500";
      default: return "bg-gray-500";
    }
  };

  const fmt = (v?: number, d = 1) =>
    typeof v === "number" && isFinite(v) ? v.toFixed(d) : "—";

  const rainLabel = sensors?.rain ? "Sí" : "No";
  const rainChip  = sensors?.rain ? "Lluvia" : "Seco";

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Activity className="h-12 w-12 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Cargando sistema...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold mb-2">Sala de Control de Semáforos</h1>
            <p className="text-muted-foreground">Panel de administración</p>
          </div>
          {user && (
            <div className="self-start">
              <Button variant="outline" onClick={handleSignOut}>
                <LogOut className="mr-2 h-4 w-4" />
                Cerrar sesión
              </Button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Wifi className="h-5 w-5" /> Conexión</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Badge variant={connectionStatus === "connected" ? "default" : "secondary"}>
                {connectionStatus === "connected" ? "Conectado" : "Desconectado"}
              </Badge>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground break-all">Destino efectivo: {apiTarget}</p>
                {proxyBase !== null && (
                  <p className="text-xs text-muted-foreground break-all">
                    Proxy Servidor.py: {proxyBase || "sin configurar"}
                  </p>
                )}
              </div>
              <form onSubmit={handleSaveApiBase} className="space-y-2">
                <Label htmlFor="api-base" className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  URL/IP del ESP32
                </Label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    id="api-base"
                    value={apiField}
                    onChange={event => setApiField(event.currentTarget.value)}
                    placeholder="http://10.122.132.45"
                    className="flex-1"
                    autoComplete="off"
                  />
                  <div className="flex gap-2">
                    <Button type="submit" disabled={isSavingApiBase}>
                      Guardar
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleResetApiBase}
                      disabled={isSavingApiBase || (!apiOverride && apiField.trim().length === 0)}
                    >
                      Usar proxy
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Introduce la IP entregada por el hotspot (10.122.132.X). Déjalo vacío para que Servidor.py actúe como proxy.
                </p>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5" /> RTC (DS3231)</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-mono">{espTime ?? localTime}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Database className="h-5 w-5" /> LCD I2C</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm">Dirección: 0x27 (SDA=21, SCL=22)</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border-primary/30">
            <CardHeader>
              <CardTitle>Estado del Semáforo</CardTitle>
              <CardDescription>
                Estado actual: <span className="font-bold text-foreground">{trafficState}</span>{" | "}
                {isRunning ? "EN EJECUCIÓN" : "DETENIDO"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col items-center gap-6">
                <div className="relative">
                  <div className="w-32 h-80 bg-card border-4 border-border rounded-2xl p-4 flex flex-col justify-around items-center shadow-2xl">
                    <div className={`w-20 h-20 rounded-full ${trafficState === "RED" ? getStateColor("RED") : "bg-gray-700"} shadow-lg transition-all duration-300 ${trafficState === "RED" ? "shadow-red-500/50" : ""}`} />
                    <div className={`w-20 h-20 rounded-full ${trafficState === "YELLOW" ? getStateColor("YELLOW") : "bg-gray-700"} shadow-lg transition-all duration-300 ${trafficState === "YELLOW" ? "shadow-yellow-500/50" : ""}`} />
                    <div className={`w-20 h-20 rounded-full ${trafficState === "GREEN" ? getStateColor("GREEN") : "bg-gray-700"} shadow-lg transition-all duration-300 ${trafficState === "GREEN" ? "shadow-green-500/50" : ""}`} />
                  </div>
                </div>

                <div className="flex gap-4 w-full">
                  <Button onClick={handleStart} disabled={isRunning} className="flex-1">
                    <Play className="mr-2 h-4 w-4" /> Iniciar
                  </Button>
                  <Button onClick={handleStop} disabled={!isRunning} variant="destructive" className="flex-1">
                    <Square className="mr-2 h-4 w-4" /> Detener
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5 text-primary" /> Endpoints API</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="p-3 bg-muted rounded-lg"><p className="text-sm font-mono text-muted-foreground">GET /api/status — Estado actual</p></div>
                <div className="p-3 bg-muted rounded-lg"><p className="text-sm font-mono text-muted-foreground">GET /api/sensors — Sensores</p></div>
                <div className="p-3 bg-muted rounded-lg"><p className="text-sm font-mono text-muted-foreground">POST /api/start — Iniciar</p></div>
                <div className="p-3 bg-muted rounded-lg"><p className="text-sm font-mono text-muted-foreground">POST /api/stop — Detener</p></div>
                <div className="p-3 bg-muted rounded-lg"><p className="text-sm font-mono text-muted-foreground">GET/POST /api/config — Duraciones</p></div>
              </CardContent>
            </Card>

            <Card className="border-accent/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><AlertCircle className="h-5 w-5 text-accent" /> Información</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>✓ Autenticación de usuario activa</p>
                  <p>✓ Proyecto académico de ciberseguridad</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* === Tarjetas de Sensores === */}
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-5 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">🌡️ Temperatura</CardTitle>
              <CardDescription>DHT11 / °C</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{fmt(sensors?.dht?.temp_c, 1)}</div>
              {!sensors?.dht?.ok && <Badge variant="secondary" className="mt-3">ERR</Badge>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">💧 Humedad</CardTitle>
              <CardDescription>DHT11 / %</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{fmt(sensors?.dht?.hum_pct, 0)}</div>
              {!sensors?.dht?.ok && <Badge variant="secondary" className="mt-3">ERR</Badge>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">🌪️ Presión</CardTitle>
              <CardDescription>BMP280 / hPa</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{fmt(sensors?.bmp?.press_hpa, 1)}</div>
              {!sensors?.bmp?.ok && <Badge variant="secondary" className="mt-3">ERR</Badge>}
              <div className="mt-2 text-xs text-muted-foreground">Altitud: {fmt(sensors?.bmp?.alt_m, 0)} m</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">🌱 Humedad del Suelo</CardTitle>
              <CardDescription>FC-28 / %</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{fmt(sensors?.soil?.pct, 0)}</div>
              <Badge variant="outline" className="mt-3">RAW → {fmt(sensors?.soil?.raw, 0)}</Badge>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">🌧️ Lluvia</CardTitle>
              <CardDescription>FC-37</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{rainLabel}</div>
              <Badge variant="secondary" className="mt-3"> {rainChip} </Badge>
            </CardContent>
          </Card>
        </div>

        <div className="mt-4 text-xs text-muted-foreground">
          Última lectura sensores: {lastSensorsAt} {sensorsError ? ` | Error: ${sensorsError}` : ""}
        </div>
      </div>
    </div>
  );
}
