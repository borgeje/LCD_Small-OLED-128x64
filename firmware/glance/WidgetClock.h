#pragma once
/*
 * WidgetClock.h - minutes until the next thing.
 *
 * One number that changes slowly and that you would actually act on, which is
 * about the highest bar a screen this size can clear. Under five minutes it
 * switches to MM:SS and claims the screen, because that is the point at which
 * you need to stand up.
 *
 * Hardware: any Wi-Fi capable ESP32. Fetch the next event from the Google
 * Calendar API on a slow poll and feed setNextEvent() the seconds remaining
 * and a title; NTP keeps the countdown honest between polls.
 */

#include "Widget.h"

class ClockWidget : public Widget {
public:
  ClockWidget() : secondsLeft(0), title("nothing scheduled") {}

  const char *name() override { return "calendar"; }
  unsigned long dwellMs() override { return 6000; }

  void setNextEvent(long seconds, const char *what) {
    secondsLeft = seconds;
    title = what;
  }

  void update(unsigned long now) override {
    // Stand-in for the calendar: a meeting every four minutes.
    long cycle = 240 - (long)((now / 1000) % 240);
    setNextEvent(cycle, "standup");
  }

  bool urgent() override { return secondsLeft > 0 && secondsLeft <= 60; }

  void render(Ui &ui) override {
    char buf[12];

    if (secondsLeft <= 0) {
      ui.header("NEXT", "");
      ui.centered(30, 1, "nothing scheduled");
      return;
    }

    ui.header("NEXT", title);

    if (secondsLeft < 300) {
      // Close in, seconds are what you care about.
      snprintf(buf, sizeof(buf), "%ld:%02ld", secondsLeft / 60, secondsLeft % 60);
      ui.bigValue(16, buf, "");
    } else {
      snprintf(buf, sizeof(buf), "%ld", secondsLeft / 60);
      ui.bigValue(16, buf, "min");
    }

    // A bar that drains over the last ten minutes.
    if (secondsLeft <= 600) {
      ui.bar(0, 52, 128, 10, (int)((secondsLeft * 100) / 600));
    }
  }

private:
  long secondsLeft;
  const char *title;
};
