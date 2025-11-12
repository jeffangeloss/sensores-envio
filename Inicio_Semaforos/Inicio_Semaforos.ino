#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <RTClib.h>
#include <ESP32Servo.h>

#include <Adafruit_Sensor.h>
#include <Adafruit_BMP280.h>
#include <DHT.h>

// ========= PROTOTIPOS =========
void applyTraffic();
void applyPauseTraffic();
String sensorsJson();
void readSensorsTick();
void registerRoutes();
String hhmmss();
void ensureWiFi();

// ====== RTC ======
#define USE_DS3231 1  // 1=DS3231, 0=DS1307
#if USE_DS3231
  RTC_DS3231 rtc;
#else
  RTC_DS1307 rtc;
#endif
bool rtc_ok=false;

// ====== Semáforo (tiempos/estado) ======
const int LED_ROJO=16, LED_AMARILLO=17, LED_VERDE=18;
uint32_t T_ROJO=8000, T_VERDE=9000, T_AMARILLO=2000;
enum TL{ROJO,VERDE,AMARILLO}; TL st=ROJO; uint32_t t0=0;

// ====== LCD ======
LiquidCrystal_I2C lcd(0x27,16,2);
String prev0="", prev1="";
static inline void lcdLine(uint8_t r, String s){
  if(s.length()>16)s=s.substring(0,16);
  while(s.length()<16)s+=' ';
  String& p=(r==0?prev0:prev1);
  if(s==p) return;
  lcd.setCursor(0,r); lcd.print(s); p=s;
}

// ====== Servos (19 derecha, 23 izquierda) ======
const int SERVO1_PIN=19, SERVO2_PIN=23;
const bool SERVO1_REVERSED = false;
const bool SERVO2_REVERSED = true;
const int  SERVO1_TRIM = 0;
const int  SERVO2_TRIM = 0;
const int SERVO_NEUTRO=90;
const int SERVO_OPEN = 90;
const int SERVO_CLOSE= 0;

Servo s1, s2;
int pos1=SERVO_NEUTRO, pos2=SERVO_NEUTRO;
int tgt1=SERVO_CLOSE,  tgt2=SERVO_CLOSE;
uint32_t lastServoTick=0;
const uint16_t SERVO_PERIOD_MS=20;
const uint8_t  SERVO_STEP_DEG=2;

// ====== Control de ciclo ======
volatile bool running=false;     // ARRANCA DETENIDO
volatile bool force_reset=true;  // al iniciar, reinicia ciclo

// ====== API configuración tiempos ======
struct DurCfg { uint32_t rojo, verde, amarillo; } cfg;
void applyCfgToGlobals(){ T_ROJO=cfg.rojo; T_VERDE=cfg.verde; T_AMARILLO=cfg.amarillo; }
void loadCfgDefaults(){ cfg.rojo=8000; cfg.verde=9000; cfg.amarillo=2000; applyCfgToGlobals(); }

// ====== WiFi STA + HTTP ======
const char* WIFI_SSID = "jefferson";
const char* WIFI_PASS = "123456789";
WebServer server(80);  // el proxy corre en 8080; el ESP32 queda en 80

// ====== Utiles ======
static inline String two(int v){ char b[3]; snprintf(b,sizeof(b),"%02d",v); return String(b); }
String hhmmss(){
  if(!rtc_ok) return "--:--:--";
  DateTime n=rtc.now();
  char b[9]; snprintf(b,9,"%02d:%02d:%02d",n.hour(),n.minute(),n.second());
  return b;
}
static inline String stText(){ return st==ROJO?"RED":(st==VERDE?"GREEN":"YELLOW"); }
static inline uint32_t dur(){ return st==ROJO?T_ROJO:(st==VERDE?T_VERDE:T_AMARILLO); }

// ====== Servo helpers ======
static inline int clamp180(int a){ if(a<0) return 0; if(a>180) return 180; return a; }
static inline int physAngle(int logical, bool reversed, int trim){
  int a = reversed ? (180 - logical) : logical;
  return clamp180(a + trim);
}
void updateServoTargetsByState(){
  if(st==ROJO){       tgt1=SERVO_CLOSE; tgt2=SERVO_CLOSE; }
  else /*VERDE/AMARILLO*/ { tgt1=SERVO_OPEN;  tgt2=SERVO_OPEN;  }
}
void servoTick(){
  if(millis()-lastServoTick < SERVO_PERIOD_MS) return;
  lastServoTick = millis();
  auto stepTo=[&](int& cur, int tgt){
    if(cur < tgt){ cur += SERVO_STEP_DEG; if(cur>tgt) cur=tgt; }
    else if(cur > tgt){ cur -= SERVO_STEP_DEG; if(cur<tgt) cur=tgt; }
    if(cur<0) cur=0; if(cur>180) cur=180;
  };
  stepTo(pos1, tgt1);
  stepTo(pos2, tgt2);
  s1.write( physAngle(pos1, SERVO1_REVERSED, SERVO1_TRIM) );
  s2.write( physAngle(pos2, SERVO2_REVERSED, SERVO2_TRIM) );
}

// ====== Serial: S=YYYY-MM-DDTHH:MM:SS ======
bool parseISO(const String& iso, DateTime& out){
  if(iso.length()<19) return false;
  int Y=iso.substring(0,4).toInt();
  int M=iso.substring(5,7).toInt();
  int D=iso.substring(8,10).toInt();
  int h=iso.substring(11,13).toInt();
  int m=iso.substring(14,16).toInt();
  int s=iso.substring(17,19).toInt();
  if(Y<2000||M<1||M>12||D<1||D>31||h<0||h>23||m<0||m>59||s<0||s>59) return false;
  out = DateTime(Y,M,D,h,m,s); return true;
}
void serialTick(){
  static String buf="";
  while(Serial.available()){
    char c=Serial.read();
    if(c=='\r'||c=='\n'){
      if(buf.startsWith("S=") && rtc_ok){
        DateTime dt;
        if(parseISO(buf.substring(2), dt)){
          rtc.adjust(dt);
          Serial.println(F("[RTC] Ajustado OK"));
        }else{
          Serial.println(F("[RTC] Formato invalido. Ej: S=2025-11-06T21:30:00"));
        }
      }
      buf="";
    }else{
      if(buf.length()<40) buf+=c;
    }
  }
}

// ======================= SENSORES ========================
// Pines
#define DHT_PIN   27
#define DHT_TYPE  DHT11
#define SOIL_PIN  34   // FC-28 (analógico)
#define RAIN_PIN  26   // FC-37 (digital DO)

// Calibración FC-28 (ajusta a tu módulo)
const int SOIL_DRY = 3300;   // lectura en seco (~0-4095)
const int SOIL_WET = 1300;   // lectura muy húmeda

// Objetos sensor
Adafruit_BMP280 bmp;      // I2C en SDA(21)/SCL(22)
DHT dht(DHT_PIN, DHT_TYPE);

// Estado actual de sensores
struct Sensors {
  bool bmp_ok=false, dht_ok=false;
  float bmp_temp_c=NAN, bmp_press_hpa=NAN, bmp_alt_m=NAN;
  float dht_temp_c=NAN, dht_hum_pct=NAN;
  uint16_t soil_raw=0;   // 0..4095
  uint8_t  soil_pct=0;   // 0..100
  bool rain=false;       // true = lluvia detectada
  uint32_t last_ms=0;
} S;

uint32_t lastSensorTick=0;
const uint32_t SENSOR_PERIOD_MS=2000;

static uint8_t clampPct(int v){ if(v<0) return 0; if(v>100) return 100; return (uint8_t)v; }

void readSensorsTick(){
  if(millis()-lastSensorTick < SENSOR_PERIOD_MS) return;
  lastSensorTick = millis();

  // BMP280
  if(S.bmp_ok){
    S.bmp_temp_c   = bmp.readTemperature();
    S.bmp_press_hpa= bmp.readPressure()/100.0F;
    S.bmp_alt_m    = bmp.readAltitude(1013.25);
  }

  // DHT11
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if(!isnan(h) && !isnan(t)){ S.dht_ok=true; S.dht_hum_pct=h; S.dht_temp_c=t; } else { S.dht_ok=false; }

  // FC-28 (analógico)
  S.soil_raw = analogRead(SOIL_PIN);
  int pct = map((int)S.soil_raw, SOIL_WET, SOIL_DRY, 100, 0);
  S.soil_pct = clampPct(pct);

  // FC-37 (digital): LOW = lluvia
  S.rain = (digitalRead(RAIN_PIN) == LOW);

  // ---- Serial (sensores) ----
  if(S.dht_ok){
    Serial.print("HUMEDAD (ambiente): "); Serial.print(S.dht_hum_pct);
    Serial.print(" %  |  TEMPERATURA: ");  Serial.print(S.dht_temp_c);
    Serial.println(" °C");
  }else{
    Serial.println("HUMEDAD (ambiente): ERR");
  }

  Serial.print("PRESION: ");
  if(!isnan(S.bmp_press_hpa)) Serial.print(S.bmp_press_hpa); else Serial.print("N/A");
  Serial.println(" hPa");

  Serial.print("ALTITUD: ");
  if(!isnan(S.bmp_alt_m)) Serial.print(S.bmp_alt_m); else Serial.print("N/A");
  Serial.println(" m");

  Serial.print("HUMEDAD DEL SUELO: "); Serial.print(S.soil_pct); Serial.println(" %");
  Serial.print("HAY LLUVIA?: "); Serial.println(S.rain ? "SI" : "NO");
  Serial.println("-----------------------------");

  S.last_ms = millis();
}

// JSON sensores
String sensorsJson(){
  String j="{";
  j += "\"bmp\":{\"ok\":"+String(S.bmp_ok?"true":"false")+
       ",\"temp_c\":"+String(S.bmp_temp_c,1)+
       ",\"press_hpa\":"+String(S.bmp_press_hpa,1)+
       ",\"alt_m\":"+String(S.bmp_alt_m,1)+"},";
  j += "\"dht\":{\"ok\":"+String(S.dht_ok?"true":"false")+
       ",\"temp_c\":"+String(S.dht_temp_c,1)+
       ",\"hum_pct\":"+String(S.dht_hum_pct,1)+"},";
  j += "\"soil\":{\"raw\":"+String(S.soil_raw)+",\"pct\":"+String(S.soil_pct)+"},";
  j += "\"rain\":"+String(S.rain?"true":"false")+",";
  j += "\"last_ms\":"+String(S.last_ms);
  j += "}";
  return j;
}

// ======================= API HTTP =======================
void handleRoot(){
  String html =
    "<!doctype html><meta charset='utf-8'><title>ESP32 Semáforo</title>"
    "<style>body{font-family:system-ui;margin:24px}button{padding:10px 16px;margin:6px;font-size:16px}</style>"
    "<h1>Semáforo ESP32</h1>"
    "<p><button onclick='fetch(\"/api/start\",{method:\"POST\"}).then(()=>location.reload())'>Iniciar</button>"
    "<button onclick='fetch(\"/api/stop\",{method:\"POST\"}).then(()=>location.reload())'>Detener</button>"
    "<button onclick='location.href=\"/api/status\"'>Estado</button> "
    "<button onclick='location.href=\"/api/sensors\"'>Sensores</button></p>";
  server.send(200,"text/html",html);
}
void handleStart(){ running=true; force_reset=true; server.send(200,"application/json","{\"ok\":true,\"running\":true}"); }
void handleStop(){ running=false; applyPauseTraffic(); server.send(200,"application/json","{\"ok\":true,\"running\":false}"); }

void handleStatus(){
  uint32_t ms_rem = 0;
  if(running){
    uint32_t elapsed = millis() - t0;
    uint32_t d = dur();
    ms_rem = (elapsed < d) ? (d - elapsed) : 0;
  }
  String j = String("{\"running\":") + (running?"true":"false") +
             ",\"state\":\""+ stText() +"\""+
             ",\"time\":\""+ hhmmss() +"\""+
             ",\"durations_ms\":{\"red\":"+ String(T_ROJO) +",\"green\":"+ String(T_VERDE) +",\"yellow\":"+ String(T_AMARILLO) +"}"+
             ",\"ms_remaining\":"+ String(ms_rem) +","+
             "\"sensors\":"+ sensorsJson() +
             "}";
  server.send(200,"application/json", j);
}

void handleConfig(){
  if (server.method() == HTTP_GET){
    String j = String("{\"red\":")+cfg.rojo+",\"green\":"+cfg.verde+",\"yellow\":"+cfg.amarillo+"}";
    server.send(200,"application/json",j); return;
  }
  String body = server.arg("plain");
  uint32_t r=cfg.rojo, g=cfg.verde, y=cfg.amarillo;

  // ======= Parser minimalista CORRECTO (sin paréntesis extra) =======
  auto safePick=[&](const char* k, uint32_t& out){
    int i = body.indexOf(String("\"")+k+"\"");
    if(i<0) return;
    i = body.indexOf(':', i); if(i<0) return;
    int j = i+1; while(j<(int)body.length() && (body[j]==' '||body[j]=='\t')) j++;
    int k2=j; while(k2<(int)body.length() && isDigit(body[k2])) k2++;
    out = (uint32_t) body.substring(j,k2).toInt();
  };
  safePick("red", r); safePick("green", g); safePick("yellow", y);

  cfg.rojo=r; cfg.verde=g; cfg.amarillo=y; applyCfgToGlobals();
  t0 = millis();
  String resp = String("{\"ok\":true,\"saved\":{\"red\":")+r+",\"green\":"+g+",\"yellow\":"+y+"}}";
  server.send(200,"application/json", resp);
}

void handleSensors(){
  readSensorsTick(); // refresca lecturas si pasaron 2s
  server.send(200,"application/json", sensorsJson());
}

void registerRoutes(){
  server.on("/",           HTTP_GET,  handleRoot);
  server.on("/api/status", HTTP_GET,  handleStatus);
  server.on("/api/start",  HTTP_POST, handleStart);
  server.on("/api/stop",   HTTP_POST, handleStop);
  server.on("/api/config", HTTP_GET,  handleConfig);
  server.on("/api/config", HTTP_POST, handleConfig);
  server.on("/api/sensors",HTTP_GET,  handleSensors);

  // Alias
  server.on("/status", HTTP_GET,  handleStatus);
  server.on("/start",  HTTP_ANY,  handleStart);
  server.on("/stop",   HTTP_ANY,  handleStop);

  server.onNotFound([](){
    String msg = "Not found: " + server.uri() + "\nTry /api/status, /api/sensors, /api/start, /api/stop, /api/config\n";
    server.send(404,"text/plain",msg);
  });
}

// ======================= Semáforo =======================
void applyTraffic(){
  digitalWrite(LED_ROJO,     st==ROJO && running);
  digitalWrite(LED_AMARILLO, st==AMARILLO && running);
  digitalWrite(LED_VERDE,    st==VERDE && running);
  updateServoTargetsByState();
}
void applyPauseTraffic(){
  digitalWrite(LED_ROJO,LOW);
  digitalWrite(LED_AMARILLO,LOW);
  digitalWrite(LED_VERDE,LOW);
  tgt1 = SERVO_CLOSE; tgt2 = SERVO_CLOSE;
}

// ======================= WiFi helpers =======================
const uint32_t WIFI_RETRY_INTERVAL_MS = 10000;
uint32_t lastWifiAttempt = 0;
bool wifiEverConnected = false;

void connectWiFiBlocking(){
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[WiFi] Conectando a "); Serial.println(WIFI_SSID);
  lcdLine(0,"Conectando WiFi");
  lcdLine(1,String(WIFI_SSID));

  while(WiFi.status() != WL_CONNECTED){
    delay(250);
    serialTick();
    servoTick();
    readSensorsTick();
  }

  wifiEverConnected = true;
  Serial.print("[WiFi] Conectado. IP: "); Serial.println(WiFi.localIP());
  lcdLine(0,"PAUSADO");
  lcdLine(1,"IP "+WiFi.localIP().toString());
}

void ensureWiFi(){
  if(WiFi.status() == WL_CONNECTED){
    if(!wifiEverConnected){
      wifiEverConnected = true;
      Serial.print("[WiFi] Conectado. IP: "); Serial.println(WiFi.localIP());
    }
    return;
  }

  uint32_t now = millis();
  if(now - lastWifiAttempt < WIFI_RETRY_INTERVAL_MS) return;
  lastWifiAttempt = now;

  Serial.println("[WiFi] Reconectando...");
  lcdLine(0,"Reconectando");
  lcdLine(1,String(WIFI_SSID));

  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// ======================= SETUP/LOOP =====================
void setup(){
  Serial.begin(115200);
  pinMode(LED_ROJO,OUTPUT); pinMode(LED_AMARILLO,OUTPUT); pinMode(LED_VERDE,OUTPUT);
  pinMode(RAIN_PIN, INPUT_PULLUP);            // FC-37 DO con pull-up
  analogReadResolution(12);                   // 0..4095 para FC-28

  Wire.begin(21,22);
  lcd.init(); lcd.backlight();
  lcdLine(0,"ESP32 Semaforos");
  lcdLine(1,"RTC iniciando...");

  // RTC
  rtc_ok = rtc.begin();
#if USE_DS3231
  if(rtc_ok && rtc.lostPower()) rtc.adjust(DateTime(F(__DATE__),F(__TIME__)));
#else
  if(rtc_ok && !rtc.isrunning()) rtc.adjust(DateTime(F(__DATE__),F(__TIME__)));
#endif
  lcdLine(1, rtc_ok? "RTC OK":"RTC FAIL");

  // Servos
  delay(200);
  s1.setPeriodHertz(50); s2.setPeriodHertz(50);
  s1.attach(SERVO1_PIN, 500, 2400);
  s2.attach(SERVO2_PIN, 500, 2400);
  pos1 = pos2 = SERVO_NEUTRO;
  s1.write( physAngle(pos1, SERVO1_REVERSED, SERVO1_TRIM) );
  s2.write( physAngle(pos2, SERVO2_REVERSED, SERVO2_TRIM) );

  // Sensores
  dht.begin();
  delay(1500); // estabiliza DHT11
  S.bmp_ok = bmp.begin(0x76) || bmp.begin(0x77);
  if(!S.bmp_ok) Serial.println(F("[BMP280] no detectado"));
  else {
    bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                    Adafruit_BMP280::SAMPLING_X2,
                    Adafruit_BMP280::SAMPLING_X16,
                    Adafruit_BMP280::FILTER_X16,
                    Adafruit_BMP280::STANDBY_MS_500);
  }

  // Estado inicial -> PAUSADO (LCD + servos cerrados)
  loadCfgDefaults();
  running=false; force_reset=true; st=ROJO; applyPauseTraffic();

  // WiFi STA
  connectWiFiBlocking();
  WiFi.setAutoReconnect(true);
  WiFi.reconnect();

  registerRoutes();
  server.begin();

  Serial.println(F("Ajustar hora por Serial: S=YYYY-MM-DDTHH:MM:SS"));
}

void loop(){
  ensureWiFi();
  server.handleClient();   // servicio HTTP
  serialTick();
  readSensorsTick();
  servoTick();

  if(running){
    if(force_reset){ st = ROJO; t0 = millis(); force_reset=false; }
    if(millis()-t0 >= dur()){
      st = (st==ROJO)?VERDE:(st==VERDE?AMARILLO:ROJO);
      t0 = millis();
    }
    applyTraffic();
  }

  // LCD: si está PAUSADO, debe decir "PAUSADO" y no correr reloj de estado
  static uint32_t last=0;
  if(millis()-last>=250){
    last=millis();
    if(running){
      lcdLine(0,"Semaf: "+stText());
      lcdLine(1,"Hora:  "+hhmmss());
    }else{
      lcdLine(0,"PAUSADO");
      if(WiFi.status()==WL_CONNECTED){
        lcdLine(1,"IP "+WiFi.localIP().toString());
      }else{
        lcdLine(1,"Sin WiFi");
      }
    }
  }
}
