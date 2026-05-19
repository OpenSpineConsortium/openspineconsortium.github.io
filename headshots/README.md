# headshots/

Drop contributor headshot images in this folder.

## Naming convention

```
lastname,firstname[,mi].ext
```

- `mi` (middle initial) is **optional**.
- `ext` may be `jpg`, `jpeg`, `png`, or `webp` — the site auto-detects it.
- Match the **`headshot`** field in `../contributions/manifest.json`. By default
  that field is `Lastname,Firstname`; if your file includes a middle initial,
  update the field to match exactly (e.g. `Kim,Jerick,A`).

Examples:

```
Schwing,Greg.jpg
Schehr,Ashley.png
Kim,Jerick,A.jpg        # middle initial — set "headshot": "Kim,Jerick,A" in the manifest
```

## You do not need a headshot for everyone

If no image is found for a person, the site automatically shows a circular
avatar with their initials instead. Add images whenever you have them — no code
changes required.

## Tips

- Square images look best (they are center-cropped into a circle).
- ~400×400 px is plenty; keep files small for fast loading.
- File and folder names are case-sensitive on GitHub Pages.
