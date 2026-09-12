/*
 * sine_wave.ino — animated sine wave on a 0.96" SSD1306 128x64 I2C OLED
 * Host: ESP32-WROOM-32 DevKit (DOIT DevKit V1 and friends)
 *
 * Wiring (module silkscreen -> DevKit silkscreen):
 *
 *     OLED GND  ->  GND
 *     OLED VCC  ->  3V3      (NOT VIN/5V — the SSD1306 is a 3.3 V part)
 *     OLED SDA  ->  D21      (GPIO21, Arduino-ESP32 default SDA)
 *     OLED SCL  ->  D22      (GPIO22, Arduino-ESP32 default SCL)
 *
 * The module carries its own ~4.7k pull-ups, so no extra parts are needed.
 * There is no RES pin on the 4-pin variant — hence OLED_RESET = -1.
 *
 * Libraries: "Adafruit SSD1306" + "Adafruit GFX Library" (Library Manager).
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ---------------------------------------------------------------- hardware --
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1          // no reset pin broken out on this module
#define I2C_SDA       21
#define I2C_SCL       22
#define I2C_HZ        400000UL    // 400 kHz fast mode; drop to 100000 on long wires

// Most units answer at 0x3C; some production runs ship as 0x3D. Try both.
static const uint8_t OLED_ADDRS[] = { 0x3C, 0x3D };

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ------------------------------------------------------------------ layout --
static const int16_t HEADER_H = 11;      // y of the rule under the title bar
static const int16_t CENTER_Y = 38;      // the wave's rest line
static const float   AMP_MAX  = 20.0f;   // peak amplitude, pixels

// ------------------------------------------------------------------ motion --
// Arduino's TWO_PI is a double; the ESP32 FPU is single-precision only, so keep
// every term in the per-pixel maths a float.
static const float TAU          = 6.28318531f;
static const float WAVES_ACROSS = 2.0f;  // cycles visible across the panel
static const float TRAVEL_HZ    = 0.45f; // scroll speed, screen-cycles per second
static const float BREATHE_HZ   = 0.11f; // amplitude envelope
static const float RIDER_HZ     = 0.14f; // the dot sliding along the wave

// Main wave: one travelling sinusoid, sampled per pixel column.
static inline int16_t waveY(float x, float amp, float phase) {
  const float k = (x / SCREEN_WIDTH) * WAVES_ACROSS * TAU;
  return (int16_t)lroundf(CENTER_Y - amp * sinf(k - phase));
}

// Echo wave: higher frequency, drifting the other way, drawn as dots so the
// two read as separate layers on a 1-bit panel.
static inline int16_t echoY(float x, float amp, float phase) {
  const float k = (x / SCREEN_WIDTH) * WAVES_ACROSS * 1.5f * TAU;
  return (int16_t)lroundf(CENTER_Y - amp * 0.45f * sinf(k + phase * 0.6f));
}

static float fps = 0.0f;

static void drawHeader(float amp) {
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 2);
  display.print(F("SINE"));

  // Amplitude meter, right of the title.
  const int16_t barX = 34, barW = 46, barY = 3, barH = 5;
  display.drawRect(barX, barY, barW, barH, SSD1306_WHITE);
  const int16_t fill = (int16_t)((barW - 2) * (amp / AMP_MAX));
  if (fill > 0) display.fillRect(barX + 1, barY + 1, fill, barH - 2, SSD1306_WHITE);

  display.setCursor(88, 2);
  display.print((int)(fps + 0.5f));
  display.print(F(" fps"));

  display.drawFastHLine(0, HEADER_H, SCREEN_WIDTH, SSD1306_WHITE);
}

void setup() {
  Serial.begin(115200);

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(I2C_HZ);

  bool found = false;
  for (uint8_t i = 0; i < sizeof(OLED_ADDRS) / sizeof(OLED_ADDRS[0]) && !found; i++) {
    if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRS[i])) {
      found = true;
      Serial.printf("SSD1306 found at 0x%02X\n", OLED_ADDRS[i]);
    }
  }
  if (!found) {
    Serial.println(F("No SSD1306 on the bus - check VCC/GND order, SDA/SCL, address"));
    for (;;) delay(1000);
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(6, 20);
  display.println(F("SSD1306 128x64"));
  display.setCursor(6, 34);
  display.println(F("sine wave demo"));
  display.display();
  delay(1200);
}

void loop() {
  const float t     = millis() * 0.001f;
  const float phase = t * TRAVEL_HZ * TAU;
  // Envelope never collapses to zero: 35%..100% of full swing.
  const float amp   = AMP_MAX * (0.35f + 0.65f * (0.5f + 0.5f * sinf(t * BREATHE_HZ * TAU)));

  display.clearDisplay();

  // Dotted rest line, so the wave has something to swing about.
  for (int16_t x = 0; x < SCREEN_WIDTH; x += 4)
    display.drawPixel(x, CENTER_Y, SSD1306_WHITE);

  // Echo wave.
  for (int16_t x = 0; x < SCREEN_WIDTH; x += 2)
    display.drawPixel(x, echoY(x, amp, phase), SSD1306_WHITE);

  // Main wave, as a continuous polyline so steep sections stay connected.
  int16_t yPrev = waveY(0.0f, amp, phase);
  for (int16_t x = 1; x < SCREEN_WIDTH; x++) {
    const int16_t y = waveY((float)x, amp, phase);
    display.drawLine(x - 1, yPrev, x, y, SSD1306_WHITE);
    yPrev = y;
  }

  // A dot riding the crest, sliding back and forth across the panel.
  const float   rx = (SCREEN_WIDTH - 1) * (0.5f + 0.5f * sinf(t * RIDER_HZ * TAU));
  const int16_t ry = waveY(rx, amp, phase);
  display.fillCircle((int16_t)rx, ry, 2, SSD1306_WHITE);
  display.drawCircle((int16_t)rx, ry, 5, SSD1306_WHITE);

  drawHeader(amp);
  display.display();   // ~1 KB over I2C: this is what sets the frame rate

  // Frame rate, refreshed twice a second so the number stays readable.
  static uint32_t frames = 0, lastFpsMs = 0;
  frames++;
  const uint32_t now = millis();
  if (now - lastFpsMs >= 500) {
    fps = frames * 1000.0f / (now - lastFpsMs);
    frames = 0;
    lastFpsMs = now;
  }
}
