/*
 * 05-readability-ruler.ino - what actually fits, and how far away you can
 * read it.
 *
 * Not a project: a measuring stick. The active area of this panel is about
 * 21.7 x 10.9 mm, so one pixel is roughly 0.17 mm. That makes the built-in
 * 5x7 font work out as:
 *
 *   size 1   6x8 px    1.4 mm tall   21 chars x 8 lines   desk distance
 *   size 2   12x16 px  2.7 mm tall   10 chars x 4 lines   arm's length
 *   size 3   18x24 px  4.1 mm tall   7 chars x 2 lines    a few feet
 *   size 4   24x32 px  5.4 mm tall   5 chars x 2 lines    across a room
 *
 * Run this, then look at the panel from where the finished thing will live.
 * Whichever row you can still read is the size your project gets to use --
 * and that, more than anything else, decides what can go on this screen.
 */
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define OLED_RESET -1
#define OLED_ADDR  0x3C

Adafruit_SSD1306 display(128, 64, &Wire, OLED_RESET);

int page = 0;

void drawSizeSamples() {
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("1: 21x8 chars 1.4mm"));

  display.setTextSize(2);
  display.setCursor(0, 10);
  display.print(F("2: 2.7mm"));

  display.setTextSize(3);
  display.setCursor(0, 28);
  display.print(F("3 4.1"));

  display.setTextSize(4);
  display.setCursor(0, 32 + 0);
  // Size 4 needs the bottom half to itself; show it on its own page instead.
}

void drawBigSample() {
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("size 4: 5 chars wide"));

  display.setTextSize(4);
  display.setCursor(4, 20);
  display.print(F("88:88"));
}

void drawGrid() {
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("128x64 grid, 8px"));

  for (int x = 0; x <= 128; x += 8) display.drawFastVLine(x, 10, 54, SSD1306_WHITE);
  for (int y = 10; y <= 63; y += 8) display.drawFastHLine(0, y, 128, SSD1306_WHITE);

  // Corner markers, to check nothing is cropped by the panel bezel.
  display.fillRect(0, 10, 3, 3, SSD1306_WHITE);
  display.fillRect(125, 10, 3, 3, SSD1306_WHITE);
  display.fillRect(0, 61, 3, 3, SSD1306_WHITE);
  display.fillRect(125, 61, 3, 3, SSD1306_WHITE);
}

void drawPrimitives() {
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("GFX primitives"));

  display.drawRect(2, 12, 28, 20, SSD1306_WHITE);
  display.fillRect(34, 12, 28, 20, SSD1306_WHITE);
  display.drawRoundRect(66, 12, 28, 20, 6, SSD1306_WHITE);
  display.fillRoundRect(98, 12, 28, 20, 6, SSD1306_WHITE);

  display.drawCircle(14, 48, 12, SSD1306_WHITE);
  display.fillCircle(46, 48, 12, SSD1306_WHITE);
  display.drawTriangle(66, 60, 80, 36, 94, 60, SSD1306_WHITE);
  display.fillTriangle(98, 60, 112, 36, 126, 60, SSD1306_WHITE);
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
  page = (millis() / 3000) % 4;

  display.clearDisplay();
  if (page == 0) drawSizeSamples();
  else if (page == 1) drawBigSample();
  else if (page == 2) drawGrid();
  else drawPrimitives();
  display.display();

  delay(200);
}
