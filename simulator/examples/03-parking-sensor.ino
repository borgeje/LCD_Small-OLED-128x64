/*
 * 03-parking-sensor.ino - garage stop sign.
 *
 * Mounted at windshield height you are about three feet from the panel, so
 * size 4 digits (24x32 px, ~5.4 mm tall) are comfortably readable. Three
 * states, and only one of them is on screen at a time:
 *
 *   approaching  distance in inches, plus a bar that shrinks as you close
 *   in position  full-screen STOP, inverted and blinking
 *   too far      a hint, so the panel is not just blank
 *
 * Hardware: VL53L1X time-of-flight sensor (I2C 0x29, shares the bus with the
 * display). A HC-SR04 ultrasonic works too but is noisier below 6 inches.
 *
 * As written it animates a car pulling in so the sketch demos on its own.
 * With a real sensor, replace readDistanceInches() with the library call and
 * delete rehearsedApproach().
 */
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define OLED_RESET    -1
#define OLED_ADDR     0x3C

#define STOP_INCHES   12    // where the bumper should end up
#define SLOW_INCHES   36    // start paying attention
#define MAX_INCHES    96    // beyond this, nothing is arriving

Adafruit_SSD1306 display(128, 64, &Wire, OLED_RESET);

// A 20-second loop: roll in from 8 feet, stop, sit, then pull out again.
int rehearsedApproach() {
  unsigned long t = millis() % 20000;
  if (t < 9000)  return MAX_INCHES - (int)((t * (MAX_INCHES - STOP_INCHES + 2)) / 9000);
  if (t < 15000) return STOP_INCHES - 2;
  return STOP_INCHES - 2 + (int)(((t - 15000) * (MAX_INCHES - STOP_INCHES)) / 5000);
}

int readDistanceInches() {
  // Real sensor:  return sensor.getDistance() / 25.4;
  return rehearsedApproach();
}

void drawApproach(int inches) {
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("PULL FORWARD"));

  // The number, centred. Size 4 is 24 px per glyph.
  display.setTextSize(4);
  int digits = inches >= 10 ? 2 : 1;
  display.setCursor(64 - (digits * 24) / 2 - 12, 16);
  display.print(inches);

  display.setTextSize(2);
  display.setCursor(64 + (digits * 24) / 2 - 6, 28);
  display.print(F("in"));

  // A bar that empties as the bumper closes on the mark.
  int span = SLOW_INCHES - STOP_INCHES;
  int over = inches - STOP_INCHES;
  if (over < 0) over = 0;
  if (over > span) over = span;
  int filled = 124 - (over * 124) / span;

  display.drawRect(0, 54, 128, 10, SSD1306_WHITE);
  display.fillRect(2, 56, filled, 6, SSD1306_WHITE);
}

void drawStop(bool blinkOn) {
  // Whole panel inverted, so it reads as a block of light in the mirror.
  display.fillScreen(SSD1306_WHITE);
  if (!blinkOn) return;

  display.setTextColor(SSD1306_BLACK, SSD1306_WHITE);
  display.setTextSize(4);
  display.setCursor(64 - (4 * 24) / 2, 18);
  display.print(F("STOP"));
  display.setTextColor(SSD1306_WHITE);
}

void drawIdle() {
  display.setTextSize(1);
  display.setCursor(22, 28);
  display.print(F("waiting for car"));
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
  int inches = readDistanceInches();

  display.clearDisplay();
  display.invertDisplay(false);

  if (inches <= STOP_INCHES) {
    drawStop((millis() / 400) % 2 == 0);
  } else if (inches <= MAX_INCHES) {
    drawApproach(inches);
  } else {
    drawIdle();
  }

  display.display();
  delay(50);
}
