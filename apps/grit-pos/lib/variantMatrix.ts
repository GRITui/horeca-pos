// ---------------------------------------------------------------------------
// Retail variant-matrix helpers.
//
// A "matrix" product carries variants whose `attributes` JSON describes one
// combination of attribute axes, e.g. { size: "L", color: "black" }, plus an
// optional child `sku`. These helpers expand axes into child-SKU combinations
// and resolve an attribute selection back to a concrete child variant/SKU.
//
// Deliberately isomorphic (no server-only, no Prisma types): the POS
// ProductPicker uses the same functions client-side that the catalog API
// uses server-side.
// ---------------------------------------------------------------------------

/** One concrete combination of attribute values, e.g. {size:'L',color:'black'}. */
export type AttributeSelection = Record<string, string>;

/** Attribute axes, e.g. { size: ['S','M','L'], color: ['black','white'] }. */
export type AttributeAxes = Record<string, string[]>;

/** The minimal variant shape these helpers need (CatalogVariantDTO fits). */
export interface MatrixVariantLike {
  id: string;
  sku?: string | null;
  attributes?: unknown;
}

/** Parses a raw `attributes` JSON value into a flat string map, or null. */
export function parseAttributes(value: unknown): AttributeSelection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
  );
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

/** True when at least one variant carries a usable attribute map. */
export function hasAttributeMatrix(variants: MatrixVariantLike[]): boolean {
  return variants.some((v) => parseAttributes(v.attributes) !== null);
}

/**
 * Collects the attribute axes present across a product's variants, preserving
 * first-seen order of both axis names and values:
 *   [{size:'S'},{size:'M'}] -> { size: ['S','M'] }
 */
export function attributeAxesFromVariants(variants: MatrixVariantLike[]): AttributeAxes {
  const axes: AttributeAxes = {};
  for (const variant of variants) {
    const attrs = parseAttributes(variant.attributes);
    if (!attrs) continue;
    for (const [axis, value] of Object.entries(attrs)) {
      const values = (axes[axis] ??= []);
      if (!values.includes(value)) values.push(value);
    }
  }
  return axes;
}

/**
 * Expands attribute axes into every child combination (cartesian product),
 * in axis-major order: { size:['S','M'], color:['b','w'] } ->
 * [{size:'S',color:'b'}, {size:'S',color:'w'}, {size:'M',color:'b'}, …].
 * Used when generating the child-SKU set for a matrix product.
 */
export function expandAttributeAxes(axes: AttributeAxes): AttributeSelection[] {
  const entries = Object.entries(axes).filter(([, values]) => values.length > 0);
  if (entries.length === 0) return [];
  return entries.reduce<AttributeSelection[]>(
    (combos, [axis, values]) =>
      combos.flatMap((combo) => values.map((value) => ({ ...combo, [axis]: value }))),
    [{}],
  );
}

/** Slug for embedding an attribute value in a generated SKU (L, BLK-RED, …). */
function skuSegment(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Deterministic child SKU for one combination: PARENT + axis values in the
 * given axis order, e.g. buildChildSku('TSHIRT', {size:'L',color:'black'})
 * -> 'TSHIRT-L-BLACK'.
 */
export function buildChildSku(parentSku: string, combo: AttributeSelection): string {
  const suffix = Object.values(combo).map(skuSegment).filter(Boolean).join("-");
  return suffix ? `${parentSku}-${suffix}` : parentSku;
}

/**
 * Expands axes into the full child-SKU matrix for a parent SKU:
 * [{ sku, attributes }, …] — one entry per combination.
 */
export function expandChildSkus(
  parentSku: string,
  axes: AttributeAxes,
): Array<{ sku: string; attributes: AttributeSelection }> {
  return expandAttributeAxes(axes).map((attributes) => ({
    sku: buildChildSku(parentSku, attributes),
    attributes,
  }));
}

/**
 * Resolves a (complete) attribute selection to the concrete child variant, or
 * null when no variant matches exactly. Extra axes in the selection that the
 * variant doesn't carry cause a non-match; a partial selection (fewer axes
 * than the variant carries) also doesn't match.
 */
export function resolveVariantSelection<V extends MatrixVariantLike>(
  variants: V[],
  selection: AttributeSelection,
): V | null {
  const selectionEntries = Object.entries(selection);
  for (const variant of variants) {
    const attrs = parseAttributes(variant.attributes);
    if (!attrs) continue;
    if (Object.keys(attrs).length !== selectionEntries.length) continue;
    if (selectionEntries.every(([axis, value]) => attrs[axis] === value)) {
      return variant;
    }
  }
  return null;
}
