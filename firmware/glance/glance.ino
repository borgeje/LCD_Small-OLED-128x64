/*
 * glance.ino - one box, several screens.
 *
 * Wiring only: which widgets exist, in what order, and how the host behaves.
 * Everything else lives in the headers next to this file. Adding a screen is
 * a class with a render() and one host.add() line.
 *
 * Pick a profile below. The point of the framework is that the office box and
 * the garage box are the same firmware with a different three lines.
 *
 * Hardware (see ../../README.md for the full pinout):
 *   OLED VCC -> 3V3, GND -> GND
 *   ESP32 DevKit      SDA GPIO21, SCL GPIO22
 *   XIAO ESP32-C6     SDA D4,     SCL D5
 *   Optional button between BUTTON_PIN and GND (short press: next screen,
 *   long press: pin the current one).
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#include "Ui.h"
#include "Widget.h"
#include "WidgetHost.h"
#include "WidgetCo2.h"
#include "WidgetParking.h"
#include "WidgetBuild.h"
#include "WidgetFreezer.h"
#include "WidgetClock.h"

/* ---- profile ---- */
// Exactly one. PROFILE_DEMO runs everything, which is what the simulator shows.
#define PROFILE_DEMO
// #define PROFILE_OFFICE
// #define PROFILE_GARAGE

#define OLED_RESET   -1
#define OLED_ADDR    0x3C
#define BUTTON_PIN   4      // to GND; comment out host.setButton() to omit

Adafruit_SSD1306 display(128, 64, &Wire, OLED_RESET);
WidgetHost host(display);

Co2Widget     co2(1000);            // ppm at which the room makes you sleepy
ClockWidget   calendar;
BuildWidget   build("main");
ParkingWidget parking(12, 96);      // stop at 12", ignore beyond 96"
// 8 s of sustained over-temperature here so the alarm is reachable in a short
// simulator run; on real hardware use 120000, since every freezer crosses its
// threshold during a defrost cycle.
FreezerWidget freezer(5, 8000);

void setup() {
  Serial.begin(115200);

  Wire.begin();             // ESP32: GPIO21/22 - XIAO ESP32-C6: D4/D5
  Wire.setClock(400000);    // 400 kHz: a frame costs 23 ms instead of 94 ms

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("SSD1306 not found - check wiring and address"));
    for (;;) delay(1000);
  }

#if defined(PROFILE_OFFICE)
  host.add(&co2);
  host.add(&calendar);
  host.add(&build);
#elif defined(PROFILE_GARAGE)
  host.add(&parking);
  host.add(&freezer);
#else
  host.add(&co2);
  host.add(&calendar);
  host.add(&build);
  host.add(&parking);
  host.add(&freezer);
#endif

  host.setButton(BUTTON_PIN);
  host.setFrameInterval(100);   // 10 fps is plenty for anything glanceable
  host.setIdleTimeout(0);       // e.g. 600000 to blank after 10 idle minutes
  host.begin();

  Serial.print(F("glance: "));
  Serial.print(host.count());
  Serial.println(F(" screens"));
}

void loop() {
  host.tick(millis());
  delay(5);
}
