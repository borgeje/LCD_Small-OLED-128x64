/*
 * 01-hello-oled.ino - the repository quick-start sketch, unchanged.
 *
 * Renders once in setup() and then does nothing, which is the simplest thing
 * that can show up on the panel. If this looks right in the simulator and
 * blank on your desk, the problem is wiring or the I2C address, not the code.
 */
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1     // no reset pin broken out on this module
#define OLED_ADDR     0x3C   // 0x3D on some units

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

void setup() {
  Serial.begin(115200);

  Wire.begin();          // ESP32: GPIO21/22 - XIAO ESP32-C6: D4/D5
  Wire.setClock(400000); // 400 kHz fast mode

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("SSD1306 not found - check wiring and address"));
    for (;;) delay(1000);
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(F("Hello, OLED"));
  display.display();     // nothing appears until this is called
}

void loop() {}
