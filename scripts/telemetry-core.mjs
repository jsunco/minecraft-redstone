/**
 * Small, dependency-free helpers for Minecraft telemetry.
 *
 * compactProjection selects explicit dot paths, or (by default) removes bulky
 * NBT/component payloads. Explicit paths are an allowlist and may request those
 * otherwise omitted fields. Every returned dictionary has a null prototype.
 * Arrays of objects with unique integer `slot` fields become slot-keyed maps;
 * empty arrays named `slots` also become maps. Other arrays retain their shape.
 * Values must be JSON data: no accessors, cycles, sparse arrays, class instances,
 * non-finite numbers, undefined, functions, symbols or bigint values.
 *
 * DeltaCache consumes ALREADY PROJECTED values, without rounding or filtering.
 * A snapshot's `value` is a complete baseline. A delta's `remove` entries are
 * RFC 6901 JSON Pointers to delete; its `set` entries are {path, value} pointers
 * to add/replace. Apply removes, then sets. The empty pointer replaces the root.
 * Arrays with changed lengths are replaced whole, avoiding index-shift hazards.
 * `sample` commits the baseline only when it returns a fitting snapshot/delta;
 * the caller must deliver that record. A transport delivery failure should call
 * reset(watchId), causing the next successful sample to be a full snapshot.
 * Oversize results NEVER advance the baseline. No values are silently truncated.
 */

const OMITTED_KEYS = new Set(['nbt', 'snbt', 'blockentitynbt', 'rawnbt', 'components']);
const MIN_RESULT_BYTES = Buffer.byteLength(JSON.stringify({ kind: 'oversize' }), 'utf8');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const dict = () => Object.create(null);
const setOwn = (target, key, value) => Object.defineProperty(target, key, {
  value, enumerable: true, configurable: true, writable: true,
});
const pointerPart = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function dataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !own(descriptor, 'value')) {
    throw new TypeError(`Telemetry requires an own data property: ${String(key)}`);
  }
  return descriptor.value;
}

function copyJson(value, { compact = false, key = '', stack = new WeakSet() } = {}) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Telemetry numbers must be finite');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Telemetry values must be JSON data');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('Telemetry dictionaries must have Object or null prototypes');
  }
  if (stack.has(value)) throw new TypeError('Telemetry values must not contain cycles');
  stack.add(value);
  try {
    if (array) {
      const copied = [];
      for (let index = 0; index < value.length; index++) {
        if (!own(value, index)) throw new TypeError('Telemetry arrays must not be sparse');
        copied.push(copyJson(dataProperty(value, String(index)), { compact, stack }));
      }
      // Normalization is part of projection, not DeltaCache's exact-value copy.
      if (compact && (
        (copied.length === 0 && key === 'slots') ||
        (copied.length > 0 && copied.every(item => item !== null && typeof item === 'object' &&
          !Array.isArray(item) && own(item, 'slot') && Number.isSafeInteger(item.slot)) &&
          new Set(copied.map(item => item.slot)).size === copied.length)
      )) {
        const slots = dict();
        for (const item of copied) slots[String(item.slot)] = item;
        return slots;
      }
      return copied;
    }
    const result = dict();
    for (const childKey of Object.keys(value).sort()) {
      if (compact && OMITTED_KEYS.has(childKey.replace(/[_-]/g, '').toLowerCase())) continue;
      result[childKey] = copyJson(dataProperty(value, childKey), { compact, key: childKey, stack });
    }
    return result;
  } finally {
    stack.delete(value);
  }
}

/** Select exact dot paths; absent paths are absent and explicit null is retained. */
export function compactProjection(value, fields = []) {
  if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string' ||
    field.split('.').some(part => part.length === 0))) {
    throw new TypeError('fields must be an array of nonempty dot paths');
  }
  if (fields.length === 0) return copyJson(value, { compact: true });
  const result = dict();
  for (const field of [...new Set(fields)].sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b))) {
    const parts = field.split('.');
    let found = value;
    let present = true;
    for (const part of parts) {
      if (found === null || typeof found !== 'object' || !own(found, part)) {
        present = false;
        break;
      }
      found = dataProperty(found, part);
    }
    if (!present) continue;
    let target = result;
    for (const part of parts.slice(0, -1)) {
      if (!own(target, part)) setOwn(target, part, dict());
      // A previously selected ancestor already contains this complete subtree.
      if (target[part] === null || typeof target[part] !== 'object') {
        throw new TypeError('Conflicting field selection');
      }
      target = target[part];
    }
    setOwn(target, parts.at(-1), copyJson(found));
  }
  // Preserve explicit NBT/component choices, but normalize slot arrays separately.
  return normalizeSlots(result);
}

function normalizeSlots(value, key = '') {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const copied = value.map(item => normalizeSlots(item));
    if ((copied.length === 0 && key === 'slots') || (copied.length > 0 &&
      copied.every(item => item !== null && typeof item === 'object' && !Array.isArray(item) &&
        own(item, 'slot') && Number.isSafeInteger(item.slot)) &&
      new Set(copied.map(item => item.slot)).size === copied.length)) {
      const slots = dict();
      for (const item of copied) slots[String(item.slot)] = item;
      return slots;
    }
    return copied;
  }
  const result = dict();
  for (const childKey of Object.keys(value)) result[childKey] = normalizeSlots(value[childKey], childKey);
  return result;
}

function diff(previous, current, path, set, remove) {
  if (previous === current) return;
  if (previous === null || current === null || typeof previous !== 'object' || typeof current !== 'object' ||
      Array.isArray(previous) !== Array.isArray(current)) {
    set.push({ path, value: current });
    return;
  }
  if (Array.isArray(current)) {
    if (previous.length !== current.length) set.push({ path, value: current });
    else for (let index = 0; index < current.length; index++) diff(previous[index], current[index], `${path}/${index}`, set, remove);
    return;
  }
  for (const key of Object.keys(previous).sort()) {
    if (!own(current, key)) remove.push(`${path}/${pointerPart(key)}`);
  }
  for (const key of Object.keys(current).sort()) {
    const childPath = `${path}/${pointerPart(key)}`;
    if (!own(previous, key)) set.push({ path: childPath, value: current[key] });
    else diff(previous[key], current[key], childPath, set, remove);
  }
}

/** Stateful, per-watch deltas. reset() clears all watches; reset(id) clears one. */
export class DeltaCache {
  #baselines = new Map();

  reset(watchId) {
    if (arguments.length === 0) this.#baselines.clear();
    else this.#baselines.delete(watchId);
  }

  sample(watchId, value, { full = false, maxBytes = 6000 } = {}) {
    if (typeof watchId !== 'string' || watchId.length === 0) throw new TypeError('watchId must be a nonempty string');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_RESULT_BYTES) {
      throw new RangeError(`maxBytes must be an integer of at least ${MIN_RESULT_BYTES}`);
    }
    if (typeof full !== 'boolean') throw new TypeError('full must be boolean');
    const current = copyJson(value);
    let record;
    if (full || !this.#baselines.has(watchId)) {
      record = { kind: 'snapshot', watchId, value: current };
    } else {
      const set = [];
      const remove = [];
      diff(this.#baselines.get(watchId), current, '', set, remove);
      record = set.length || remove.length
        ? { kind: 'delta', watchId, set, remove }
        : { kind: 'unchanged', watchId };
    }
    const requiredBytes = size(record);
    if (requiredBytes > maxBytes) {
      const summaries = [
        { kind: 'oversize', watchId, unavailable: true, reason: 'maxBytes', requiredBytes, maxBytes, baselineRetained: true },
        { kind: 'oversize', requiredBytes, baselineRetained: true },
        { kind: 'oversize', requiredBytes },
        { kind: 'oversize' },
      ];
      return summaries.find(summary => size(summary) <= maxBytes);
    }
    // Do not share object references with either caller input or returned records.
    if (record.kind !== 'unchanged') this.#baselines.set(watchId, copyJson(current));
    return record;
  }
}
