# FigmaBridge

> Import **TokenForge** design tokens into Figma Variables — collections, modes, and aliases included.

FigmaBridge is the companion Figma plugin for TokenForge, a web app for designing and exporting design tokens. It takes the W3C-format JSON that TokenForge exports and turns it into native Figma Variables, preserving:

- **Collections** — one Figma variable collection per top-level token set (e.g. `Primitives`, `Semantic`).
- **Modes** — sets nested under a slash (e.g. `semantic/light`, `semantic/dark`) become modes on the same collection.
- **Aliases** — references like `{primitives.color-brand-500}` become real Figma variable aliases, not flattened values.
- **Types** — colors are imported as `COLOR` variables; everything else as `FLOAT`.

It can also generate a one-page **Token Guidance** document inside your Figma file, with swatches and usage examples for the imported tokens.

## Install

The plugin is open source and distributed via its manifest. There's no Community listing — you import it into Figma desktop yourself.

1. Clone or download this repo:

   ```bash
   git clone https://github.com/oakjoao/figmabridge.git
   ```

2. Build the plugin code (one-time):

   ```bash
   cd figmabridge
   npm install
   npm run build
   ```

   This compiles `code.ts` → `code.js`. The plugin loads `code.js` and `ui.html` at runtime.

3. Open Figma **desktop** (the browser version cannot load local plugins).

4. **Menu → Plugins → Development → Import plugin from manifest…** and pick `figmabridge/manifest.json`.

FigmaBridge will now appear under **Plugins → Development → FigmaBridge** in any Figma file.

> **Tip:** Run `npm run watch` while you're editing the plugin source — Figma will reload the new `code.js` next time you re-run the plugin.

## Use it with TokenForge

The intended workflow is:

1. Open TokenForge, sign in, and design your token set (colors, spacing, typography, etc.).
2. Go to **Export → FigmaBridge** and download `tokens-figmabridge.json`.
3. In Figma, run **Plugins → Development → FigmaBridge**.
4. **Drag** the JSON file onto the drop zone (or paste its contents into the text area) and click **Import**.
5. Open the **Local variables** panel — your collections, modes and aliases are there.

The plugin re-uses existing variables with the same name in the same collection on subsequent imports, so you can iterate in TokenForge and re-import without recreating everything.

### Optional: generate a guidance page

After import, FigmaBridge can create a `🎨 Token Guidance` page with swatch grids and labeled examples of your primitives and semantic tokens. Use it as living documentation that always reflects the current token state.

## Input format

FigmaBridge accepts the W3C Design Tokens format that TokenForge exports. The relevant shape is:

```jsonc
{
  "$metadata": {
    "tokenSetOrder": ["primitives", "semantic/light", "semantic/dark"]
  },
  "primitives": {
    "color-brand-500": { "$value": "#7c3aed", "$type": "color" },
    "spacing-md":      { "$value": 16,        "$type": "dimension" }
  },
  "semantic/light": {
    "color-bg":   { "$value": "{primitives.color-bg-light}",  "$type": "color" },
    "color-text": { "$value": "{primitives.color-text-dark}", "$type": "color" }
  },
  "semantic/dark": {
    "color-bg":   { "$value": "{primitives.color-bg-dark}",   "$type": "color" },
    "color-text": { "$value": "{primitives.color-text-light}","$type": "color" }
  }
}
```

Rules FigmaBridge follows:

| Key shape           | Result                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `primitives`        | Collection **Primitives** with a single `Default` mode                 |
| `semantic/light`    | Collection **Semantic**, mode `Light`                                  |
| `semantic/dark`     | Collection **Semantic**, mode `Dark` (added to the same collection)    |
| `$type: "color"`    | Imported as a Figma `COLOR` variable                                   |
| Anything else       | Imported as a `FLOAT` variable                                         |
| `{group.tokenName}` | Imported as a Figma alias to the matching variable                     |

Unresolvable aliases are reported back in the plugin UI; they do not abort the rest of the import.

## Permissions

FigmaBridge declares `currentuser` only (used so we can attribute changes properly). It does not make any network requests — your tokens never leave your machine.

## Develop

```bash
npm install        # one time
npm run build      # one-off compile
npm run watch      # rebuild on save
```

The plugin is plain TypeScript against `@figma/plugin-typings`. There is no bundler — `code.ts` compiles directly to `code.js`, and `ui.html` is a single self-contained file. Open a PR or issue if you want to add a new token type, fix import behavior, or improve the guidance layout.

## License

MIT. See [LICENSE](LICENSE) if present, otherwise treat as MIT.
