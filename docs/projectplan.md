# Graphic Package Editor — Drag & Drop + Resize

## Problem

- Logo/sponsor overlays use fixed 4-corner positions and fixed pixel sizes
- Doesn't scale properly across different screen sizes
- No visual way to fine-tune placement

## Solution

Switch to percentage-based positioning and sizing with a visual drag-and-drop editor.

## Tasks

- [x] 1. **DB migration**: Add percentage-based columns to `playhub_graphic_packages`
  - `logo_x` NUMERIC (0-100, default 85) — % from left
  - `logo_y` NUMERIC (0-100, default 3) — % from top
  - `logo_scale` NUMERIC (1-30, default 8) — % of video width
  - `sponsor_x` NUMERIC (0-100, default 3) — % from left
  - `sponsor_y` NUMERIC (0-100, default 85) — % from top
  - `sponsor_scale` NUMERIC (1-30, default 10) — % of video width
  - Drop the CHECK constraints on old `logo_position`/`sponsor_position` columns

- [x] 2. **Update API routes**: Accept and return the new fields in `graphic-packages/route.ts`

- [x] 3. **Update VideoPlayer**: Render overlays using percentage-based `left`/`top`/`width` styles instead of fixed corner classes

- [x] 4. **Update Editor UI** in the manage page:
  - Replace position dropdown with visual preview area (16:9 aspect ratio)
  - Drag to position logos (mouse + touch)
  - Slider for scale/size
  - Show real-time preview of logo placement

- [x] 5. **Update watch API** and **recordings API**: Return new fields in graphic package data

## Migration SQL

```sql
ALTER TABLE playhub_graphic_packages
  ADD COLUMN logo_x NUMERIC DEFAULT 85,
  ADD COLUMN logo_y NUMERIC DEFAULT 3,
  ADD COLUMN logo_scale NUMERIC DEFAULT 8,
  ADD COLUMN sponsor_x NUMERIC DEFAULT 3,
  ADD COLUMN sponsor_y NUMERIC DEFAULT 85,
  ADD COLUMN sponsor_scale NUMERIC DEFAULT 10;

ALTER TABLE playhub_graphic_packages DROP CONSTRAINT IF EXISTS valid_logo_position;
ALTER TABLE playhub_graphic_packages DROP CONSTRAINT IF EXISTS valid_sponsor_position;
```

## Defaults Map (old → new)

- `top-right` → x:85, y:3
- `top-left` → x:3, y:3
- `bottom-right` → x:85, y:85
- `bottom-left` → x:3, y:85

## Notes

- Scale is % of video width (e.g. 8 = logo is 8% of video width)
- Position is top-left corner of the image as % of video dimensions
- All values are percentages, so they scale naturally with any screen size
