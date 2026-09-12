# Wiring the OLED to an ESP32-WROOM-32 DevKit

For the board with a metal-can **ESP32-WROOM-32** module, a **CP2102** USB-serial chip,
a USB-C socket and **EN** / **BOOT** buttons — the DOIT "DevKit V1" family and its many
clones.

## The four wires

| OLED pin | DevKit pin (silkscreen) | GPIO | Note |
|---|---|---|---|
| **GND** | `GND` | — | Any of the three GND pins; the one next to `3V3` keeps the run short |
| **VCC** | `3V3` | — | **Not `VIN`/`5V`.** The SSD1306 is a 3.3 V part and this module has no level shifter |
| **SDA** | `D21` | GPIO21 | Arduino-ESP32 default SDA |
| **SCL** | `D22` | GPIO22 | Arduino-ESP32 default SCL |

Using GPIO21/22 means `Wire.begin()` needs no arguments — though the demo passes them
explicitly so the wiring is readable from the code.

`3V3`, `GND`, `D21` and `D22` are all on the **same header** on a DevKit V1, so the
display connects with four parallel jumpers and no wire crossing the board.

```
                      USB-C
        ┌───────────────┴───────────────┐
        │                               │
  EN  ──┤ ESP32-WROOM-32                ├── D23
  VP  ──┤                               ├── D22  ──────┐  SCL
  VN  ──┤                               ├── TX0        │
  D34 ──┤                               ├── RX0        │
  D35 ──┤                               ├── D21  ────┐ │  SDA
  D32 ──┤                               ├── D19      │ │
  D33 ──┤                               ├── D18      │ │
  D25 ──┤                               ├── D5       │ │
  D26 ──┤                               ├── TX2      │ │
  D27 ──┤                               ├── RX2      │ │
  D14 ──┤                               ├── D4       │ │
  D12 ──┤                               ├── D2       │ │
  D13 ──┤                               ├── D15      │ │
  GND ──┤                               ├── GND ───┐ │ │
  VIN ──┤                               ├── 3V3 ─┐ │ │ │
        └───────────────────────────────┘       │ │ │ │
                                                │ │ │ │
                                        VCC ────┘ │ │ │
                                        GND ──────┘ │ │
                                        SDA ────────┘ │
                                        SCL ──────────┘
                                        (0.96" SSD1306 OLED)
```

Pin *order* varies between DevKit revisions (38-pin boards add `D0`, `D2`, `D15` and
extra GNDs). **Go by the silkscreen labels, not by position in this diagram.**

## Before you connect the OLED

The display's own 4 pins also ship in two orders — see the
[pinout table](hosyond-0.96in-oled-ssd1306-128x64.md#2-pinout). Most are
`GND VCC SCL SDA`; some are `VCC GND SCL SDA`. **Read the OLED's silkscreen too**;
reversing VCC and GND is the usual way one of these dies.

## Pins not to use instead

- **GPIO6–11** — the on-board SPI flash.
- **GPIO34–39** (`D34`, `D35`, `VP`, `VN`) — input-only, no pull-ups. SDA is
  bidirectional, so an I²C bus cannot work here.
- **GPIO0, 2, 5, 12, 15** — strapping pins read at reset. A pull-up on GPIO12 can stop
  the board booting.
- **GPIO1 / GPIO3** (`TX0` / `RX0`) — the CP2102 serial link; using them breaks
  flashing and the serial monitor.

Good alternates: GPIO25/26/27, GPIO32/33, GPIO18/19/23 — pass them as
`Wire.begin(sda, scl)`.

## Power

The panel draws ~10–25 mA, well inside what the DevKit's 3.3 V regulator supplies from
USB. Nothing else is needed — no external pull-ups (the module carries ~4.7 kΩ), no
level shifter, no reset wire.

## Flashing

Select **ESP32 Dev Module** in the Arduino IDE (or `board = esp32dev` in PlatformIO) and
pick the CP2102 port. If the upload stalls at `Connecting........_____`, hold **BOOT**,
tap **EN**, release **BOOT**, and retry — some clones don't auto-reset into the
bootloader.
