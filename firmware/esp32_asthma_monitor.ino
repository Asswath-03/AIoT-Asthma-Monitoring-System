#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>

// ================= OLED =================
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ================= DHT22 =================
#define DHTPIN 13
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

// ================= MQ135 =================
#define MQ135_PIN 34

// ================= Buzzer =================
#define BUZZER_PIN 25

// ---- Thresholds ----
const float TEMP_THRESHOLD = 37.0;
const int AIR_THRESHOLD = 2500;   // raised — your sensor idles around 2300-2380

// ---- Buzzer state ----
bool buzzerRunning = false;
bool alertPlayed = false;
unsigned long buzzerStartTime = 0;
const unsigned long BUZZER_TIME = 3000;

void setup() {
  Serial.begin(115200);

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  Wire.begin(21, 22);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED init failed");
    while (true);
  }

  dht.begin();

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  Serial.println("=================================");
  Serial.println("AIoT Asthma Monitoring Started");
  Serial.println("=================================");
}

void loop() {
  // ---------- Read sensors ----------
  float temperature = dht.readTemperature();
  float humidity = dht.readHumidity();
  int air = analogRead(MQ135_PIN);

  bool alert = false;
  if (!isnan(temperature) && temperature >= TEMP_THRESHOLD) alert = true;
  if (air >= AIR_THRESHOLD) alert = true;

  // ---------- OLED ----------
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("AIoT ASTHMA");

  if (isnan(temperature) || isnan(humidity)) {
    display.setCursor(0, 25);
    display.println("DHT22 ERROR");
  } else {
    display.setCursor(0, 16);
    display.print("Temp : "); display.print(temperature, 1); display.println(" C");

    display.setCursor(0, 28);
    display.print("Hum  : "); display.print(humidity, 0); display.println(" %");

    display.setCursor(0, 40);
    display.print("Air  : "); display.println(air);

    display.setCursor(0, 56);
    display.print(alert ? "Status: ALERT" : "Status: GOOD");
  }
  display.display();

  // ---------- Serial ----------
  Serial.print("Temp: "); Serial.print(temperature); Serial.print(" C   ");
  Serial.print("Hum: "); Serial.print(humidity); Serial.print(" %   ");
  Serial.print("Air: "); Serial.print(air);
  Serial.println(alert ? "  ALERT" : "  GOOD");

  // ---------- Buzzer (non-blocking) ----------
  if (alert && !alertPlayed) {
    digitalWrite(BUZZER_PIN, HIGH);
    Serial.println("Buzzer ON");
    buzzerRunning = true;
    alertPlayed = true;
    buzzerStartTime = millis();
  }

  if (buzzerRunning && millis() - buzzerStartTime >= BUZZER_TIME) {
    digitalWrite(BUZZER_PIN, LOW);
    Serial.println("Buzzer OFF");
    buzzerRunning = false;
  }

  if (!alert) {
    alertPlayed = false;
  }

  delay(2000);
}