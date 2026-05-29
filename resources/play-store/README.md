# Play Store hi-res icon (512×512)

Standalone assets for the Google Play Store listing ("Hi-res icon" field).
Play requires the icon to be **exactly 512×512, 32-bit PNG, fully opaque**.

These are **NOT** the in-app launcher icons. The adaptive launcher icons under
`android/app/src/main/res/mipmap-*/ic_launcher*` are correct as-is (intentionally
small mark inside a transparent safe-zone, because Android masks/crops them
on-device) and must not be replaced by these.

## Variants

| File | Background | Use |
| --- | --- | --- |
| `icon-512-white.png` | White `#FFFFFF` | Recommended. Clean, matches the brand's white tile. |
| `icon-512-navy.png`  | Navy `#172038`  | Alternative. Higher contrast / more striking on the store. |

Both are 512×512, RGBA with alpha fully opaque (255). Pick one for the listing.

## Source & fidelity

No vector source exists in the repo:

- No `.svg` of the logo anywhere.
- No Capacitor master (`resources/icon.png` / `icon-only.png`).
- The vector drawable `drawable-v24/ic_launcher_foreground.xml` is the **Android
  Studio default robot clip-art** (with `drawable/ic_launcher_background.xml`'s
  default teal grid) and is *not* referenced by the real adaptive icon, so it is
  not a usable source.
- The real adaptive icon (`mipmap-anydpi-v26/ic_launcher.xml`) uses the **PNG**
  foreground + white background `@color/ic_launcher_background` (`#FFFFFF`).

**Source used: largest raster — `mipmap-xxxhdpi/ic_launcher_foreground.png`
(432×432).** Within it the blue mark occupies only a 160×160 centred bbox (the
rest is the adaptive safe-zone). Fidelity is therefore a **raster upscale**
(~160px mark → ~369px), high-quality Lanczos. Crisp enough for 512; if a true
vector of the mark ever lands in the repo, regenerate from that for best results.

## How these were generated

From the 432 foreground: the mark's bounding box was isolated by blueness
(`B - R > 15`, which cleanly separates the mark from the tile's faint diagonal
texture), the texture was flattened to a solid background, and the mark was
centred on a 512 canvas at ~72% scale (≈14% even margin), then flattened to a
fully-opaque PNG.
