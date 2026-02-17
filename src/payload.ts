import { createError } from './errors.js';
import { DType, TypedArray } from './types.js';

export interface DTypeSpec {
  byteSize: number;
  write: (view: DataView, offset: number, value: number, littleEndian: boolean) => void;
  read: (view: DataView, offset: number, littleEndian: boolean) => number;
}

const DTYPE_SPECS: Record<DType, DTypeSpec> = {
  uint8: {
    byteSize: 1,
    write(view, offset, value) {
      view.setUint8(offset, value);
    },
    read(view, offset) {
      return view.getUint8(offset);
    },
  },
  int8: {
    byteSize: 1,
    write(view, offset, value) {
      view.setInt8(offset, value);
    },
    read(view, offset) {
      return view.getInt8(offset);
    },
  },
  uint16: {
    byteSize: 2,
    write(view, offset, value, littleEndian) {
      view.setUint16(offset, value, littleEndian);
    },
    read(view, offset, littleEndian) {
      return view.getUint16(offset, littleEndian);
    },
  },
  int16: {
    byteSize: 2,
    write(view, offset, value, littleEndian) {
      view.setInt16(offset, value, littleEndian);
    },
    read(view, offset, littleEndian) {
      return view.getInt16(offset, littleEndian);
    },
  },
  uint32: {
    byteSize: 4,
    write(view, offset, value, littleEndian) {
      view.setUint32(offset, value, littleEndian);
    },
    read(view, offset, littleEndian) {
      return view.getUint32(offset, littleEndian);
    },
  },
  int32: {
    byteSize: 4,
    write(view, offset, value, littleEndian) {
      view.setInt32(offset, value, littleEndian);
    },
    read(view, offset, littleEndian) {
      return view.getInt32(offset, littleEndian);
    },
  },
  float32: {
    byteSize: 4,
    write(view, offset, value, littleEndian) {
      view.setFloat32(offset, value, littleEndian);
    },
    read(view, offset, littleEndian) {
      return view.getFloat32(offset, littleEndian);
    },
  },
  float64: {
    byteSize: 8,
    write(view, offset, value, littleEndian) {
      view.setFloat64(offset, value, littleEndian);
    },
    read(view, offset, littleEndian) {
      return view.getFloat64(offset, littleEndian);
    },
  },
};

const DTYPE_MIN_MAX: Record<DType, { min: number; max: number; integer: boolean }> = {
  uint8: { min: 0, max: 0xff, integer: true },
  int8: { min: -128, max: 127, integer: true },
  uint16: { min: 0, max: 0xffff, integer: true },
  int16: { min: -32768, max: 32767, integer: true },
  uint32: { min: 0, max: 0xffffffff, integer: true },
  int32: { min: -2147483648, max: 2147483647, integer: true },
  float32: { min: -3.4e38, max: 3.4e38, integer: false },
  float64: { min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY, integer: false },
};

export function getDTypeSpec(dtype: DType): DTypeSpec {
  return DTYPE_SPECS[dtype];
}

export function byteLengthForDType(dtype: DType): number {
  return getDTypeSpec(dtype).byteSize;
}

export function encodeValues(dtype: DType, values: ArrayLike<number>, elementCount: number, littleEndian: boolean): Uint8Array {
  const spec = getDTypeSpec(dtype);
  if (values.length !== elementCount) {
    throw createError(
      'INVALID_FIELD_VALUE',
      `Expected ${elementCount} values for dtype ${dtype}, got ${values.length}.`
    );
  }

  const buffer = new ArrayBuffer(elementCount * spec.byteSize);
  const view = new DataView(buffer);
  const limits = DTYPE_MIN_MAX[dtype];
  for (let i = 0; i < elementCount; i += 1) {
    const value = values[i];
    const allowFloatNaN = dtype === 'float32' || dtype === 'float64';
    if (!Number.isFinite(value) && !(allowFloatNaN && Number.isNaN(value))) {
      throw createError('INVALID_FIELD_VALUE', `Non-finite value at index ${i}: ${String(value)}`);
    }
    if (limits.integer && !Number.isInteger(value)) {
      throw createError('INVALID_FIELD_VALUE', `Non-integer value at index ${i}: ${value}`);
    }
    if (value < limits.min || value > limits.max) {
      throw createError('INVALID_FIELD_VALUE', `Out-of-range value at index ${i}: ${value}`);
    }
    spec.write(view, i * spec.byteSize, value, littleEndian);
  }

  return new Uint8Array(buffer);
}

export function decodeValues(dtype: DType, bytes: Uint8Array, littleEndian: boolean): TypedArray {
  const spec = getDTypeSpec(dtype);
  if (bytes.byteLength % spec.byteSize !== 0) {
    throw createError(
      'INVALID_FIELD_VALUE',
      `Payload byte length ${bytes.byteLength} is not divisible by ${spec.byteSize}`
    );
  }

  const sampleCount = bytes.byteLength / spec.byteSize;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = new Array<number>(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    values[i] = spec.read(view, i * spec.byteSize, littleEndian);
  }
  return toTypedArray(dtype, values);
}

function toTypedArray(dtype: DType, values: number[]): TypedArray {
  switch (dtype) {
    case 'uint8':
      return new Uint8Array(values);
    case 'int8':
      return new Int8Array(values);
    case 'uint16':
      return new Uint16Array(values);
    case 'int16':
      return new Int16Array(values);
    case 'uint32':
      return new Uint32Array(values);
    case 'int32':
      return new Int32Array(values);
    case 'float32':
      return new Float32Array(values);
    case 'float64':
      return new Float64Array(values);
    default:
      throw createError('INTERNAL_FAILURE', `Unsupported dtype ${(dtype as string)}`);
  }
}
