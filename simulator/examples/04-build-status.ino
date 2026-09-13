/*
 * 04-build-status.ino - CI on the desk.
 *
 * A tick or a cross large enough to read peripherally, the branch under it,
 * and a count of PRs waiting on you. Red inverts the panel, which is the
 * whole point: you notice it without looking at it.
 *
 * The pixel budget is why the mark is drawn with lines rather than set in
 * text -- at this size a glyph would be a smudge, and a 40 px tick is not.
 *
 * Hardware: any Wi-Fi capable ESP32. Poll the GitHub API roughly every 30 s
 * (well inside the unauthenticated rate limit) and parse the conclusion of
 * the latest check suite. Here the states are rehearsed on a timer.
 */
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define OLED_RESET  -1
#define OLED_ADDR   0x3C

#define ST_PASS     0
#define ST_FAIL     1
#define ST_RUNNING  2

Adafruit_SSD1306 display(128, 64, &Wire, OLED_RESET);

const char *BRANCH = "main";
int reviewsWaiting = 2;

int fetchStatus() {
  // Real version: HTTPClient GET the check-suite conclusion and map it here.
  unsigned long phase = (millis() / 6000) % 3;
  if (phase == 0) return ST_PASS;
  if (phase == 1) return ST_RUNNING;
  return ST_FAIL;
}

void drawTick(int cx, int cy, uint16_t color) {
  // Three strokes each, so the mark has weight at a distance.
  for (int i = 0; i < 3; i++) {
    display.drawLine(cx - 16, cy + i, cx - 5, cy + 11 + i, color);
    display.drawLine(cx - 5, cy + 11 + i, cx + 16, cy - 10 + i, color);
  }
}

void drawCross(int cx, int cy, uint16_t color) {
  for (int i = 0; i < 3; i++) {
    display.drawLine(cx - 13 + i, cy - 13, cx + 13 + i, cy + 13, color);
    display.drawLine(cx + 13 + i, cy - 13, cx - 13 + i, cy + 13, color);
  }
}

void drawSpinner(int cx, int cy, uint16_t color) {
  // Two arcs chasing each other, stepped 12 times per revolution.
  int step = (millis() / 80) % 12;
  for (int i = 0; i < 12; i++) {
    int lit = (i == step) || (i == (step + 6) % 12);
    if (!lit) continue;
    float a = (i * 3.14159 * 2.0) / 12.0;
    int x = cx + (int)(cos(a) * 16.0);
    int y = cy + (int)(sin(a) * 16.0);
    display.fillCircle(x, y, 2, color);
  }
  display.drawCircle(cx, cy, 16, color);
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(400000);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("no display"));
    for (;;) delay(1000);
  }
  display.setTextColor(SSD1306_WHITE);
}

void loop() {
  int status = fetchStatus();
  bool failing = (status == ST_FAIL);

  display.clearDisplay();

  // On a failure the panel inverts, so the mark is drawn in black-on-lit.
  uint16_t ink = failing ? SSD1306_BLACK : SSD1306_WHITE;
  if (failing) display.fillScreen(SSD1306_WHITE);
  display.setTextColor(ink, failing ? SSD1306_WHITE : SSD1306_BLACK);

  if (status == ST_PASS) drawTick(34, 28, ink);
  else if (status == ST_FAIL) drawCross(34, 28, ink);
  else drawSpinner(34, 28, ink);

  display.setTextSize(1);
  display.setCursor(60, 12);
  if (status == ST_PASS) display.print(F("passing"));
  else if (status == ST_FAIL) display.print(F("FAILED"));
  else display.print(F("running"));

  display.setCursor(60, 24);
  display.print(BRANCH);

  display.drawFastHLine(0, 50, 128, ink);
  display.setCursor(0, 55);
  display.print(reviewsWaiting);
  display.print(F(" PRs need review"));

  display.display();
  delay(80);
}
