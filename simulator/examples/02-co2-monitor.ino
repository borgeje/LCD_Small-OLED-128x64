/*
 * 02-co2-monitor.ino - office air quality, as one big number.
 *
 * Layout is the pattern most things on a 0.96" panel should use: a small
 * label, one large number readable from a few feet away, and a sparkline of
 * where it has been. Above the threshold the whole panel inverts, which is
 * what actually catches your eye from across a desk.
 *
 * Hardware: Sensirion SCD40/SCD41 on the same I2C bus as the display
 * (sensor 0x62, display 0x3C - no conflict, no extra pins).
 *
 * As written it synthesises a plausible ppm curve so it animates in the
 * simulator with no sensor attached. For the real thing, drop in the
 * SparkFun_SCD4x or Sensirion I2C SCD4x library and replace readCO2().
 */
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define OLED_RESET   -1
#define OLED_ADDR    0x3C

#define WARN_PPM     1000   // above this the room makes you sleepy
#define HISTORY      64     // one sample per 2 px across the panel

Adafruit_SSD1306 display(128, 64, &Wire, OLED_RESET);

int history[HISTORY];
int historyCount = 0;
unsigned long lastSample = 0;

int readCO2() {
  // Stand-in for scd4x.getCO2(): a slow drift with a shorter ripple on top,
  // so the sparkline has something to show.
  float t = millis() / 1000.0;
  float slow = sin(t / 30.0) * 420.0;
  float fast = sin(t / 4.0) * 45.0;
  return (int)(900.0 + slow + fast);
}

void pushSample(int ppm) {
  if (historyCount < HISTORY) {
    history[historyCount++] = ppm;
  } else {
    for (int i = 1; i < HISTORY; i++) history[i - 1] = history[i];
    history[HISTORY - 1] = ppm;
  }
}

void drawSparkline(int x, int y, int w, int h) {
  if (historyCount < 2) return;

  int lo = history[0];
  int hi = history[0];
  for (int i = 1; i < historyCount; i++) {
    if (history[i] < lo) lo = history[i];
    if (history[i] > hi) hi = history[i];
  }
  if (hi - lo < 40) hi = lo + 40;   // keep a flat line from filling the box

  int prevX = 0;
  int prevY = 0;
  for (int i = 0; i < historyCount; i++) {
    int px = x + (i * (w - 1)) / (HISTORY - 1);
    int py = y + h - 1 - ((history[i] - lo) * (h - 1)) / (hi - lo);
    if (i > 0) display.drawLine(prevX, prevY, px, py, SSD1306_WHITE);
    prevX = px;
    prevY = py;
  }

  // Mark the threshold if it falls inside the window.
  if (WARN_PPM > lo && WARN_PPM < hi) {
    int wy = y + h - 1 - ((WARN_PPM - lo) * (h - 1)) / (hi - lo);
    for (int px = x; px < x + w; px += 4) display.drawPixel(px, wy, SSD1306_WHITE);
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(400000);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("no display"));
    for (;;) delay(1000);
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(F("warming up"));
  display.display();
}

void loop() {
  if (millis() - lastSample >= 500) {
    lastSample = millis();
    pushSample(readCO2());
  }

  int ppm = historyCount ? history[historyCount - 1] : 0;

  display.clearDisplay();

  // Label
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("CO2"));

  // Trend over the last 10 s, which is a long enough window to agree with
  // what the sparkline below is showing.
  if (historyCount > 20) {
    int delta = history[historyCount - 1] - history[historyCount - 21];
    display.setCursor(30, 0);
    if (delta > 15) display.print(F("rising"));
    else if (delta < -15) display.print(F("falling"));
    else display.print(F("steady"));
  }

  display.setCursor(104, 0);
  display.print(F("ppm"));

  // The number itself: size 3 is 18x24 px per glyph, about the smallest
  // that stays readable from across a desk.
  display.setTextSize(3);
  int digits = ppm >= 1000 ? 4 : (ppm >= 100 ? 3 : 2);
  display.setCursor(64 - (digits * 18) / 2, 13);
  display.print(ppm);

  drawSparkline(0, 44, 128, 20);

  // Peripheral-vision alarm.
  display.invertDisplay(ppm > WARN_PPM);

  display.display();
  delay(100);
}
