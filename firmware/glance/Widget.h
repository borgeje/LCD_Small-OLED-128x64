#pragma once
/*
 * Widget.h - what a screen has to provide.
 *
 * Deliberately small. A widget samples in update() and draws in render(); it
 * never calls display() itself and never decides when it is on screen. The
 * host owns the panel, the rotation and the clock, which is what keeps
 * widgets to about fifty lines each.
 *
 * update() runs on every tick even when the widget is not showing, so a
 * sparkline keeps filling while other screens are up and urgent() can fire
 * from a widget nobody is looking at.
 */

#include "Ui.h"

class Widget {
public:
  // Called once at startup, after the display is up.
  virtual void begin() {}

  // Called every tick, showing or not. Keep it cheap and non-blocking:
  // no delay(), no long I2C reads.
  virtual void update(unsigned long now) {}

  // Draw one frame. The host has already cleared the buffer and will push it.
  virtual void render(Ui &ui) = 0;

  /*
   * Return true to demand the screen. The host switches immediately and stays
   * put while it holds -- this is the freezer alarm interrupting the CO2
   * reading, not a politeness request.
   */
  virtual bool urgent() { return false; }

  // How long this widget holds the screen in the rotation.
  virtual unsigned long dwellMs() { return 6000; }

  // Shown in the startup banner and in serial logs.
  virtual const char *name() { return "widget"; }
};
