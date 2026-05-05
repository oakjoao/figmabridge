"use strict";
/// <reference path="./node_modules/@figma/plugin-typings/index.d.ts" />
figma.showUI(__html__, { width: 460, height: 540, themeColors: true });
figma.ui.onmessage = async (msg) => {
    var _a, _b;
    if (msg.type === 'import') {
        try {
            const result = await runImport(msg.data);
            figma.ui.postMessage(Object.assign({ type: 'done' }, result));
        }
        catch (e) {
            figma.ui.postMessage({ type: 'error', message: String((_a = e === null || e === void 0 ? void 0 : e.message) !== null && _a !== void 0 ? _a : e) });
        }
    }
    if (msg.type === 'create-guidance') {
        try {
            const result = await runCreateGuidance(msg.data);
            figma.ui.postMessage(Object.assign({ type: 'done-guidance' }, result));
        }
        catch (e) {
            figma.ui.postMessage({ type: 'error', message: String((_b = e === null || e === void 0 ? void 0 : e.message) !== null && _b !== void 0 ? _b : e) });
        }
    }
    if (msg.type === 'close')
        figma.closePlugin();
};
// ─── Helpers ─────────────────────────────────────────────────────────────────
function hexToRgba(hex) {
    const h = hex.replace('#', '');
    const p = (s) => parseInt(h.slice(s, s + 2), 16) / 255;
    return { r: p(0), g: p(2), b: p(4), a: h.length >= 8 ? p(6) : 1 };
}
// Parse "{primitives.color-brand-500}" → { group: "primitives", name: "color-brand-500" }
// Also handles "{semantic/light.color-bg}" → { group: "semantic/light", name: "color-bg" }
function parseRef(v) {
    const m = String(v).match(/^\{([^}]+)\.([^}]+)\}$/);
    return m ? { group: m[1], name: m[2] } : null;
}
function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
/**
 * Groups token set keys into Figma collection groups.
 *
 * "primitives"           → { collectionName: "Primitives", modes: [{ key: "primitives", modeName: "Default" }] }
 * "semantic/light"       → { collectionName: "Semantic",   modes: [{ key: "semantic/light", modeName: "Light" },
 * "semantic/dark"                                                    { key: "semantic/dark",  modeName: "Dark"  }] }
 */
function groupSets(order) {
    const map = new Map();
    for (const key of order) {
        if (key.startsWith('$'))
            continue;
        if (key.includes('/')) {
            const slash = key.indexOf('/');
            const prefix = key.slice(0, slash);
            const rest = key.slice(slash + 1);
            const cn = capitalize(prefix);
            const mn = rest.split('/').map(capitalize).join(' ');
            if (!map.has(cn))
                map.set(cn, { collectionName: cn, modes: [] });
            map.get(cn).modes.push({ key, modeName: mn });
        }
        else {
            const cn = capitalize(key);
            map.set(cn, { collectionName: cn, modes: [{ key, modeName: 'Default' }] });
        }
    }
    return [...map.values()];
}
// ─── Core import ─────────────────────────────────────────────────────────────
async function runImport(data) {
    var _a, _b, _c, _d, _e, _f;
    const rawOrder = (_b = (_a = data.$metadata) === null || _a === void 0 ? void 0 : _a.tokenSetOrder) !== null && _b !== void 0 ? _b : Object.keys(data).filter((k) => !k.startsWith('$'));
    const groups = groupSets(rawOrder);
    let created = 0, updated = 0, skipped = 0;
    const errors = [];
    // varMap: "setKey/tokenName" → Variable — used for alias resolution across groups
    const varMap = new Map();
    // Pre-load everything once to avoid repeated getLocalVariables() calls inside loops
    const existingCollections = figma.variables.getLocalVariableCollections();
    const allExistingVars = figma.variables.getLocalVariables();
    const existingByKey = new Map();
    for (const v of allExistingVars) {
        existingByKey.set(`${v.variableCollectionId}/${v.name}`, v);
    }
    function findOrCreateCollection(name) {
        var _a;
        return (_a = existingCollections.find((c) => c.name === name)) !== null && _a !== void 0 ? _a : figma.variables.createVariableCollection(name);
    }
    for (const group of groups) {
        const collection = findOrCreateCollection(group.collectionName);
        // ── Set up modes ──────────────────────────────────────────────────────────
        const modeIds = new Map(); // setKey → modeId
        for (let i = 0; i < group.modes.length; i++) {
            const { key, modeName } = group.modes[i];
            if (i === 0) {
                // First mode always exists — just rename it
                const id = collection.modes[0].modeId;
                collection.renameMode(id, modeName);
                modeIds.set(key, id);
            }
            else {
                const existing = collection.modes.find((m) => m.name === modeName);
                const id = existing ? existing.modeId : collection.addMode(modeName);
                modeIds.set(key, id);
            }
        }
        // ── Collect all unique token names across all modes in this group ─────────
        const allNames = new Set();
        for (const { key } of group.modes) {
            Object.keys((_c = data[key]) !== null && _c !== void 0 ? _c : {}).forEach((n) => allNames.add(n));
        }
        // ── PASS 1: create all variables (no values yet) ──────────────────────────
        // Doing this before setting values means aliases within the same group resolve correctly.
        const isNewMap = new Map();
        for (const name of allNames) {
            // Determine Figma type from the first mode that has this token
            let resolvedType = 'FLOAT';
            for (const { key } of group.modes) {
                const def = (_d = data[key]) === null || _d === void 0 ? void 0 : _d[name];
                if (def) {
                    resolvedType = def.$type === 'color' ? 'COLOR' : 'FLOAT';
                    break;
                }
            }
            const existingVar = existingByKey.get(`${collection.id}/${name}`);
            const isNew = !existingVar;
            const variable = existingVar !== null && existingVar !== void 0 ? existingVar : figma.variables.createVariable(name, collection, resolvedType);
            isNewMap.set(name, isNew);
            // Register under every mode key so alias lookup works regardless of which mode references it
            for (const { key } of group.modes) {
                varMap.set(`${key}/${name}`, variable);
            }
        }
        // ── PASS 2: set values ────────────────────────────────────────────────────
        for (const name of allNames) {
            // Retrieve the variable we just created/found
            const variable = varMap.get(`${group.modes[0].key}/${name}`);
            if (!variable)
                continue;
            let anyOk = false;
            for (const { key } of group.modes) {
                const modeId = modeIds.get(key);
                const def = (_e = data[key]) === null || _e === void 0 ? void 0 : _e[name];
                if (!def)
                    continue; // this mode doesn't define this token — leave Figma's default
                const raw = String(def.$value);
                try {
                    const ref = parseRef(raw);
                    if (ref) {
                        // Resolve alias: check varMap first (covers variables created in this run),
                        // then fall back to pre-existing variables matched by name.
                        const target = (_f = varMap.get(`${ref.group}/${ref.name}`)) !== null && _f !== void 0 ? _f : allExistingVars.find((v) => v.name === ref.name);
                        if (target) {
                            variable.setValueForMode(modeId, figma.variables.createVariableAlias(target));
                            anyOk = true;
                        }
                        else {
                            errors.push(`"${name}" [${key}]: reference ${raw} could not be resolved`);
                            skipped++;
                        }
                    }
                    else if (def.$type === 'color') {
                        variable.setValueForMode(modeId, hexToRgba(raw));
                        anyOk = true;
                    }
                    else {
                        variable.setValueForMode(modeId, parseFloat(raw));
                        anyOk = true;
                    }
                }
                catch (e) {
                    errors.push(`"${name}" [${key}]: ${e.message}`);
                    skipped++;
                }
            }
            if (anyOk) {
                if (isNewMap.get(name))
                    created++;
                else
                    updated++;
            }
        }
    }
    return { created, updated, skipped, errors };
}
function hexToFigmaRgb(hex) {
    const { r, g, b } = hexToRgba(hex);
    return { r, g, b };
}
function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
}
async function runCreateGuidance(data) {
    var _a, _b, _c, _d, _e, _f, _g;
    // Load fonts — Inter is standard in Figma; throw a clear error if absent
    try {
        await Promise.all([
            figma.loadFontAsync({ family: 'Inter', style: 'Regular' }),
            figma.loadFontAsync({ family: 'Inter', style: 'Medium' }),
            figma.loadFontAsync({ family: 'Inter', style: 'Bold' }),
        ]);
    }
    catch (_h) {
        throw new Error('Inter font is required. Make sure it\'s enabled in your Figma file.');
    }
    // ── Page setup ─────────────────────────────────────────────────────────────
    let page = figma.root.children.find((p) => p.name === '🎨 Token Guidance');
    if (!page) {
        page = figma.createPage();
        page.name = '🎨 Token Guidance';
    }
    else {
        for (const child of [...page.children])
            child.remove();
    }
    figma.currentPage = page;
    page.backgrounds = [{ type: 'SOLID', color: { r: 0.953, g: 0.953, b: 0.961 } }];
    // ── Layout state ───────────────────────────────────────────────────────────
    const SECTION_W = 1200;
    const X = 80;
    const SECTION_GAP = 64;
    let yOffset = 80;
    let sections = 0;
    let nodes = 0;
    // Brand / neutral palette used throughout the guidance
    const C = {
        brand: { r: 0.486, g: 0.231, b: 0.929 },
        gray900: { r: 0.059, g: 0.059, b: 0.071 },
        gray600: { r: 0.275, g: 0.275, b: 0.310 },
        gray400: { r: 0.580, g: 0.580, b: 0.620 },
        gray200: { r: 0.886, g: 0.886, b: 0.902 },
        gray100: { r: 0.941, g: 0.941, b: 0.949 },
        white: { r: 1, g: 1, b: 1 },
    };
    // ── Node helpers ───────────────────────────────────────────────────────────
    function txt(content, size = 12, style = 'Regular', color = C.gray900) {
        const t = figma.createText();
        t.fontName = { family: 'Inter', style };
        t.fontSize = size;
        t.characters = content;
        t.fills = [{ type: 'SOLID', color }];
        nodes++;
        return t;
    }
    function autoFrame(name, dir, gap = 0, pad = [0, 0, 0, 0]) {
        const f = figma.createFrame();
        f.name = name;
        f.layoutMode = dir;
        f.primaryAxisSizingMode = 'AUTO';
        f.counterAxisSizingMode = 'AUTO';
        f.itemSpacing = gap;
        [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft] = pad;
        f.fills = [];
        nodes++;
        return f;
    }
    function card(name) {
        const f = autoFrame(name, 'VERTICAL', 28, [32, 40, 40, 40]);
        f.fills = [{ type: 'SOLID', color: C.white }];
        f.cornerRadius = 16;
        return f;
    }
    function divider() {
        const r = figma.createRectangle();
        r.name = 'divider';
        r.resize(SECTION_W - 80, 1);
        r.fills = [{ type: 'SOLID', color: C.gray100 }];
        nodes++;
        return r;
    }
    function placeSection(frame) {
        // Fix width, let height auto-size to content
        frame.counterAxisSizingMode = 'FIXED';
        frame.primaryAxisSizingMode = 'AUTO';
        frame.resize(SECTION_W, frame.height);
        frame.x = X;
        frame.y = yOffset;
        page.appendChild(frame);
        yOffset += frame.height + SECTION_GAP;
        sections++;
    }
    // ── Token maps ─────────────────────────────────────────────────────────────
    const prim = ((_a = data['primitives']) !== null && _a !== void 0 ? _a : {});
    const semLight = ((_b = data['semantic/light']) !== null && _b !== void 0 ? _b : {});
    const semDark = ((_c = data['semantic/dark']) !== null && _c !== void 0 ? _c : {});
    const typoSet = ((_d = data['typography']) !== null && _d !== void 0 ? _d : {});
    const spacingSet = ((_e = data['spacing']) !== null && _e !== void 0 ? _e : {});
    const radiiSet = ((_f = data['radii']) !== null && _f !== void 0 ? _f : {});
    function resolveRef(ref) {
        var _a;
        const m = String(ref).match(/^\{primitives\.([\w-]+)\}$/);
        return m ? ((_a = prim[m[1]]) !== null && _a !== void 0 ? _a : null) : null;
    }
    // ── Section 1: Color Palettes ──────────────────────────────────────────────
    const colorScales = new Map();
    for (const [name, def] of Object.entries(prim)) {
        if (def.$type !== 'color')
            continue;
        const m = name.match(/^color-(\w+)-(\d+)$/);
        if (!m)
            continue;
        if (!colorScales.has(m[1]))
            colorScales.set(m[1], []);
        colorScales.get(m[1]).push({ step: m[2], hex: String(def.$value) });
    }
    if (colorScales.size > 0) {
        const section = card('Color Palettes');
        section.appendChild(txt('Color Palettes', 18, 'Bold'));
        const scalesCol = autoFrame('scales', 'VERTICAL', 12);
        for (const [scaleName, steps] of colorScales) {
            const row = autoFrame(scaleName, 'HORIZONTAL', 0);
            // Scale label — fixed 80 px wide, vertically centred
            const labelCell = figma.createFrame();
            labelCell.name = 'scale-label';
            labelCell.resize(80, 72);
            labelCell.fills = [];
            labelCell.layoutMode = 'VERTICAL';
            labelCell.primaryAxisSizingMode = 'FIXED';
            labelCell.counterAxisSizingMode = 'FIXED';
            labelCell.primaryAxisAlignItems = 'CENTER';
            labelCell.appendChild(txt(scaleName, 11, 'Medium', C.gray600));
            nodes++;
            row.appendChild(labelCell);
            const sorted = [...steps].sort((a, b) => parseInt(a.step) - parseInt(b.step));
            for (const { step, hex } of sorted) {
                const cell = autoFrame(`${scaleName}-${step}`, 'VERTICAL', 5, [8, 5, 8, 5]);
                cell.counterAxisAlignItems = 'CENTER';
                const rect = figma.createRectangle();
                rect.resize(52, 40);
                rect.cornerRadius = 6;
                try {
                    rect.fills = [{ type: 'SOLID', color: hexToFigmaRgb(hex) }];
                }
                catch (_j) {
                    rect.fills = [{ type: 'SOLID', color: C.gray200 }];
                }
                nodes++;
                cell.appendChild(rect);
                cell.appendChild(txt(step, 9, 'Regular', C.gray400));
                row.appendChild(cell);
            }
            scalesCol.appendChild(row);
        }
        section.appendChild(scalesCol);
        placeSection(section);
    }
    // ── Section 2: Semantic Colors ─────────────────────────────────────────────
    if (Object.keys(semLight).length > 0) {
        const section = card('Semantic Colors');
        section.appendChild(txt('Semantic Colors', 18, 'Bold'));
        const modesRow = autoFrame('modes', 'HORIZONTAL', 56);
        const modes = [
            ['Light', semLight],
            ['Dark', semDark],
        ];
        for (const [modeName, modeTokens] of modes) {
            const col = autoFrame(modeName, 'VERTICAL', 6);
            col.appendChild(txt(modeName, 13, 'Medium', C.gray400));
            for (const [tokenName, def] of Object.entries(modeTokens)) {
                const row = autoFrame(tokenName, 'HORIZONTAL', 10);
                row.counterAxisAlignItems = 'CENTER';
                row.paddingTop = 4;
                row.paddingBottom = 4;
                const swatch = figma.createRectangle();
                swatch.resize(28, 28);
                swatch.cornerRadius = 6;
                swatch.strokes = [{ type: 'SOLID', color: C.gray200 }];
                swatch.strokeWeight = 1;
                swatch.strokeAlign = 'INSIDE';
                const resolved = resolveRef(def.$value);
                try {
                    swatch.fills = [{ type: 'SOLID', color: hexToFigmaRgb((_g = resolved === null || resolved === void 0 ? void 0 : resolved.$value) !== null && _g !== void 0 ? _g : '') }];
                }
                catch (_k) {
                    swatch.fills = [{ type: 'SOLID', color: C.gray200 }];
                }
                nodes++;
                row.appendChild(swatch);
                const info = autoFrame('info', 'VERTICAL', 2);
                info.appendChild(txt(tokenName.replace('color-', ''), 11, 'Medium', C.gray900));
                info.appendChild(txt(def.$value, 9, 'Regular', C.gray400));
                row.appendChild(info);
                col.appendChild(row);
            }
            modesRow.appendChild(col);
        }
        section.appendChild(modesRow);
        placeSection(section);
    }
    // ── Section 3: Typography Scale ────────────────────────────────────────────
    // Collect style names from the typography set
    const styleNames = new Set();
    for (const tokenName of Object.keys(typoSet)) {
        const m = tokenName.match(/^typography-([\w-]+)-(size|weight|lineHeight)$/);
        if (m)
            styleNames.add(m[1]);
    }
    if (styleNames.size > 0) {
        const section = card('Typography Scale');
        section.appendChild(txt('Typography Scale', 18, 'Bold'));
        const list = autoFrame('list', 'VERTICAL', 0);
        const styleList = [...styleNames].map(styleName => {
            var _a, _b, _c, _d, _e, _f;
            const sizeDef = resolveRef((_b = (_a = typoSet[`typography-${styleName}-size`]) === null || _a === void 0 ? void 0 : _a.$value) !== null && _b !== void 0 ? _b : '');
            const weightDef = resolveRef((_d = (_c = typoSet[`typography-${styleName}-weight`]) === null || _c === void 0 ? void 0 : _c.$value) !== null && _d !== void 0 ? _d : '');
            const lhDef = resolveRef((_f = (_e = typoSet[`typography-${styleName}-lineHeight`]) === null || _e === void 0 ? void 0 : _e.$value) !== null && _f !== void 0 ? _f : '');
            const sizePx = sizeDef ? parseFloat(String(sizeDef.$value)) : 16;
            return {
                name: styleName,
                sizePx: isNaN(sizePx) ? 16 : sizePx,
                sizeLabel: sizeDef ? String(sizeDef.$value) : '—',
                weightLabel: weightDef ? String(weightDef.$value) : '—',
                lhLabel: lhDef ? String(lhDef.$value) : '—',
            };
        });
        styleList.sort((a, b) => b.sizePx - a.sizePx);
        for (let i = 0; i < styleList.length; i++) {
            const style = styleList[i];
            const row = autoFrame(style.name, 'HORIZONTAL', 28);
            row.counterAxisAlignItems = 'CENTER';
            row.paddingTop = 14;
            row.paddingBottom = 14;
            // Metadata column — fixed 200 px wide
            const meta = figma.createFrame();
            meta.name = 'meta';
            meta.resize(200, 10);
            meta.fills = [];
            meta.layoutMode = 'VERTICAL';
            meta.primaryAxisSizingMode = 'AUTO';
            meta.counterAxisSizingMode = 'FIXED';
            meta.itemSpacing = 4;
            meta.appendChild(txt(style.name, 11, 'Medium', C.gray900));
            meta.appendChild(txt(`${style.sizeLabel}  ·  w${style.weightLabel}  ·  lh ${style.lhLabel}`, 10, 'Regular', C.gray400));
            nodes++;
            row.appendChild(meta);
            // Live text sample
            const sample = figma.createText();
            sample.fontName = { family: 'Inter', style: 'Regular' };
            sample.characters = style.name.startsWith('display') ? 'Display'
                : style.name.startsWith('heading') ? 'Heading sample text'
                    : 'The quick brown fox jumps';
            sample.fontSize = clamp(style.sizePx, 10, 64);
            sample.fills = [{ type: 'SOLID', color: C.gray900 }];
            nodes++;
            row.appendChild(sample);
            list.appendChild(row);
            if (i < styleList.length - 1)
                list.appendChild(divider());
        }
        section.appendChild(list);
        placeSection(section);
    }
    // ── Section 4: Spacing Scale ───────────────────────────────────────────────
    const primSpacing = [];
    for (const [name, def] of Object.entries(prim)) {
        if (def.$type !== 'dimension' || !name.startsWith('spacing-'))
            continue;
        primSpacing.push({ name, px: parseFloat(String(def.$value)) });
    }
    primSpacing.sort((a, b) => a.px - b.px);
    if (primSpacing.length > 0) {
        const section = card('Spacing Scale');
        section.appendChild(txt('Spacing Scale', 18, 'Bold'));
        const list = autoFrame('list', 'VERTICAL', 8);
        const maxPx = Math.max(...primSpacing.map(s => s.px));
        for (const { name, px } of primSpacing) {
            const row = autoFrame(name, 'HORIZONTAL', 20);
            row.counterAxisAlignItems = 'CENTER';
            // Fixed-width label
            const labelCell = figma.createFrame();
            labelCell.name = 'label';
            labelCell.resize(180, 24);
            labelCell.fills = [];
            labelCell.layoutMode = 'HORIZONTAL';
            labelCell.primaryAxisSizingMode = 'FIXED';
            labelCell.counterAxisSizingMode = 'FIXED';
            labelCell.counterAxisAlignItems = 'CENTER';
            labelCell.appendChild(txt(`${name}  ·  ${px}px`, 11, 'Regular', C.gray600));
            nodes++;
            row.appendChild(labelCell);
            // Proportional bar
            const bar = figma.createRectangle();
            bar.resize(Math.max(4, Math.round((px / maxPx) * 560)), 18);
            bar.cornerRadius = 4;
            bar.fills = [{ type: 'SOLID', color: C.brand, opacity: 0.22 }];
            nodes++;
            row.appendChild(bar);
            // Exact size tick
            const sizeRect = figma.createRectangle();
            sizeRect.resize(px, 18);
            sizeRect.cornerRadius = 2;
            sizeRect.fills = [{ type: 'SOLID', color: C.brand, opacity: 0.55 }];
            nodes++;
            row.appendChild(sizeRect);
            list.appendChild(row);
        }
        section.appendChild(list);
        placeSection(section);
    }
    // ── Section 5: Border Radius ───────────────────────────────────────────────
    const primRadii = [];
    for (const [name, def] of Object.entries(prim)) {
        if (def.$type !== 'dimension' || !name.startsWith('radius-'))
            continue;
        primRadii.push({ name, value: String(def.$value), px: parseFloat(String(def.$value)) });
    }
    if (primRadii.length > 0) {
        const section = card('Border Radius');
        section.appendChild(txt('Border Radius', 18, 'Bold'));
        const row = autoFrame('list', 'HORIZONTAL', 20);
        row.counterAxisAlignItems = 'MIN';
        for (const { name, value, px } of primRadii) {
            const item = autoFrame(name, 'VERTICAL', 8, [0, 0, 8, 0]);
            item.counterAxisAlignItems = 'CENTER';
            const rect = figma.createRectangle();
            rect.resize(72, 72);
            rect.fills = [{ type: 'SOLID', color: C.brand, opacity: 0.1 }];
            rect.strokes = [{ type: 'SOLID', color: C.brand, opacity: 0.45 }];
            rect.strokeWeight = 1.5;
            rect.strokeAlign = 'INSIDE';
            rect.cornerRadius = clamp(isNaN(px) ? 0 : px, 0, 36);
            nodes++;
            item.appendChild(rect);
            item.appendChild(txt(name.replace('radius-', ''), 10, 'Medium', C.gray900));
            item.appendChild(txt(value, 9, 'Regular', C.gray400));
            row.appendChild(item);
        }
        section.appendChild(row);
        placeSection(section);
    }
    // ── Section 6: Semantic Spacing & Radii aliases ────────────────────────────
    const hasSpacing = Object.keys(spacingSet).length > 0;
    const hasRadii = Object.keys(radiiSet).length > 0;
    if (hasSpacing || hasRadii) {
        const section = card('Semantic Aliases');
        section.appendChild(txt('Semantic Aliases', 18, 'Bold'));
        const cols = autoFrame('cols', 'HORIZONTAL', 64);
        if (hasSpacing) {
            const col = autoFrame('spacing', 'VERTICAL', 6);
            col.appendChild(txt('Spacing', 13, 'Medium', C.gray400));
            for (const [tokenName, def] of Object.entries(spacingSet)) {
                const row = autoFrame(tokenName, 'HORIZONTAL', 12);
                row.counterAxisAlignItems = 'CENTER';
                row.paddingTop = 3;
                row.paddingBottom = 3;
                const resolved = resolveRef(def.$value);
                const resolvedPx = resolved ? parseFloat(String(resolved.$value)) : null;
                // Mini bar
                if (resolvedPx !== null) {
                    const bar = figma.createRectangle();
                    bar.resize(Math.max(4, Math.min(resolvedPx, 80)), 12);
                    bar.cornerRadius = 3;
                    bar.fills = [{ type: 'SOLID', color: C.brand, opacity: 0.2 }];
                    nodes++;
                    row.appendChild(bar);
                }
                const info = autoFrame('info', 'VERTICAL', 2);
                info.appendChild(txt(tokenName.replace('spacing-', ''), 10, 'Medium', C.gray900));
                info.appendChild(txt(resolvedPx !== null ? `${def.$value}  (${resolvedPx}px)` : def.$value, 9, 'Regular', C.gray400));
                row.appendChild(info);
                col.appendChild(row);
            }
            cols.appendChild(col);
        }
        if (hasRadii) {
            const col = autoFrame('radii', 'VERTICAL', 6);
            col.appendChild(txt('Radii', 13, 'Medium', C.gray400));
            for (const [tokenName, def] of Object.entries(radiiSet)) {
                const row = autoFrame(tokenName, 'HORIZONTAL', 12);
                row.counterAxisAlignItems = 'CENTER';
                row.paddingTop = 3;
                row.paddingBottom = 3;
                const resolved = resolveRef(def.$value);
                const resolvedPx = resolved ? parseFloat(String(resolved.$value)) : null;
                const swatch = figma.createRectangle();
                swatch.resize(28, 28);
                swatch.fills = [{ type: 'SOLID', color: C.brand, opacity: 0.1 }];
                swatch.strokes = [{ type: 'SOLID', color: C.brand, opacity: 0.4 }];
                swatch.strokeWeight = 1;
                swatch.strokeAlign = 'INSIDE';
                swatch.cornerRadius = resolvedPx !== null ? clamp(resolvedPx, 0, 14) : 4;
                nodes++;
                row.appendChild(swatch);
                const info = autoFrame('info', 'VERTICAL', 2);
                info.appendChild(txt(tokenName.replace('radius-', ''), 10, 'Medium', C.gray900));
                info.appendChild(txt(def.$value, 9, 'Regular', C.gray400));
                row.appendChild(info);
                col.appendChild(row);
            }
            cols.appendChild(col);
        }
        section.appendChild(cols);
        placeSection(section);
    }
    // ── Zoom to fit ────────────────────────────────────────────────────────────
    figma.viewport.scrollAndZoomIntoView([...page.children]);
    return { sections, nodes };
}
