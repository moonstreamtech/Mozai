# Play Store hi-res icon (512×512)

Standalone asset for the Google Play Store listing ("Hi-res icon" field).
Play requires it to be **exactly 512×512, 32-bit PNG, fully opaque**.

**`icon-512-white.png` is intentionally made to look like the
real on-device launcher icon**: a white field with a subtle **diagonal
crosshatch texture**, and the blue M/X mark centred at the same proportion the
launcher shows (~54% of the frame).

> ⚠️ The faint diagonal crosshatch is **intentional brand texture**, not noise
> or a compression artifact. **Do not "clean" / flatten it.** It is part of the
> mark and must be preserved so the store icon matches the installed app icon.

This is **NOT** the in-app launcher icon. The adaptive launcher icons under
`android/app/src/main/res/mipmap-*/ic_launcher*` are correct as-is and must not
be replaced by this.

## Where the crosshatch comes from (layer analysis)

The adaptive icon (`mipmap-anydpi-v26/ic_launcher.xml`) composites:

- **background** = `@color/ic_launcher_background` → **solid white `#FFFFFF`**
  (a flat color — the crosshatch is *not* here). The default teal-grid
  `drawable/ic_launcher_background.xml` is unused leftover template and is *not*
  referenced.
- **foreground** = `@mipmap/ic_launcher_foreground` (PNG). **The crosshatch is
  baked into the white tile of this foreground raster**, together with the blue
  mark.

So on-device = white + foreground-tile(crosshatch + mark), masked to the
launcher shape. The pre-composited legacy `mipmap-*/ic_launcher.png` files show
the same merged look (white field + crosshatch + mark, rounded) but are smaller.

## Source used & fidelity

No vector source exists (no `.svg`; the `drawable-v24/ic_launcher_foreground.xml`
vector is the Android Studio default robot, not the brand mark; no Capacitor
1024 master — `public/mozai-icon.png` is only 324×324, same foreground style).

**Source used: largest raster — the 294×294 square crosshatch tile inside
`mipmap-xxxhdpi/ic_launcher_foreground.png` (432×432).** Fidelity is a
**raster upscale** (294 → 512, ~1.74×, Lanczos — chosen over nearest, which
made the mark and crosshatch jagged). Higher-res than upscaling the 192×192
composited `ic_launcher.png`. If a true vector of the mark is ever added,
regenerate from that.

## How it was generated

Crop the 294×294 opaque crosshatch tile from the 432 foreground (the crosshatch
reaches all four edges), composite on opaque white, and Lanczos-upscale to
512×512 — giving the crosshatch edge-to-edge with the mark at its real ~54%
on-device proportion, then flatten to a fully-opaque PNG.

(The previous white/navy variants that flattened the crosshatch were wrong and
have been replaced; the navy variant was dropped since the goal is to match the
white launcher look.)
