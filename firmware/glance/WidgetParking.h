#pragma once
/*
 * WidgetParking.h - garage stop sign.
 *
 * Mounted at windshield height you are about three feet away, so the distance
 * goes out at the largest size that fits and the stop state takes the whole
 * panel. It claims the screen while a car is arriving and gives it back once
 * the bay is empty again.
 *
 * Hardware: VL53L1X time-of-flight sensor (I2C 0x29, shares the bus with the
 * display). Replace readInches() with the library call.
 */

#include "Widget.h"

class ParkingWidget : public Widget {
public:
  ParkingWidget(int stopInches, int maxInches)
      : stopAt(stopInches), slowAt(stopInches * 3), maxAt(maxInches),
        inches(999), blinkOn(false), lastSample(0) {}

  const char *name() override { return "parking"; }
  unsigned long dwellMs() override { return 5000; }

  void update(unsigned long now) override {
    if (lastSample && now - lastSample < 50) return;
    lastSample = now;
    inches = readInches(now);
    blinkOn = ((now / 400) % 2) == 0;
  }

  // Anything inside range is the only thing worth showing.
  bool urgent() override { return inches <= maxAt; }

  void render(Ui &ui) override {
    if (inches <= stopAt) {
      // Blink by drawing the lit panel either way and the word only on-phase,
      // so the panel stays bright rather than flashing black.
      if (blinkOn) ui.banner("STOP");
      else ui.d->fillScreen(SSD1306_WHITE);
      return;
    }

    if (inches > maxAt) {
      ui.header("PARKING", "");
      ui.centered(30, 1, "bay empty");
      return;
    }

    char buf[8];
    snprintf(buf, sizeof(buf), "%d", inches);
    ui.header("PULL FORWARD", "");
    ui.bigValue(16, buf, "in");

    // The bar empties as the bumper closes on the mark.
    int span = slowAt - stopAt;
    int over = inches - stopAt;
    if (over < 0) over = 0;
    if (over > span) over = span;
    ui.bar(0, 52, 128, 10, (over * 100) / span);
  }

private:
  /*
   * Stand-in for the rangefinder: a 40 s cycle that leaves the bay empty most
   * of the time, then rolls in and holds at the mark. The long empty stretch
   * matters for the demo -- this widget claims the screen whenever a car is in
   * range, so a sensor that always sees one would starve the rotation.
   */
  int readInches(unsigned long now) {
    unsigned long t = now % 40000;
    if (t < 24000) return maxAt + 60;                 // bay empty
    if (t < 33000) {
      unsigned long k = t - 24000;                     // rolling in
      return maxAt - (int)((k * (maxAt - stopAt + 2)) / 9000);
    }
    return stopAt - 2;                                 // parked
  }

  int stopAt;
  int slowAt;
  int maxAt;
  int inches;
  bool blinkOn;
  unsigned long lastSample;
};
