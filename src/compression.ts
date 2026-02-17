import { CompressionMode } from './types.js';
import { createError } from './errors.js';

const SUPPORTED_CODEC = {
  'deflate-raw': 'deflate-raw',
} as const;

export function isCompressionModeSupported(mode: CompressionMode): boolean {
  if (mode === 'none') {
    return true;
  }
  if (typeof globalThis.CompressionStream !== 'function' || typeof globalThis.DecompressionStream !== 'function') {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(SUPPORTED_CODEC, mode);
}

async function convert(mode: CompressionMode, payload: Uint8Array, operation: 'compress' | 'decompress'): Promise<Uint8Array> {
  if (mode === 'none') {
    return payload;
  }

  if (!isCompressionModeSupported(mode)) {
    throw createError(
      'UNSUPPORTED_COMPRESSION',
      `Compression mode "${mode}" is not supported in this runtime.`
    );
  }

  const codec = SUPPORTED_CODEC[mode];
  if (!codec) {
    throw createError('UNSUPPORTED_COMPRESSION', `Compression mode "${mode}" is unsupported.`);
  }

  try {
    const stablePayload = new Uint8Array(payload);
    const source = new Blob([stablePayload]).stream();
    const stream =
      operation === 'compress'
        ? source.pipeThrough(new globalThis.CompressionStream(codec))
        : source.pipeThrough(new globalThis.DecompressionStream(codec));
    const result = await new Response(stream).arrayBuffer();
    return new Uint8Array(result);
  } catch (error) {
    throw createError(
      operation === 'compress' ? 'COMPRESSION_FAILED' : 'DECOMPRESSION_FAILED',
      `Could not ${operation} payload using ${mode}.`,
      error
    );
  }
}

export function compressPayload(mode: CompressionMode, payload: Uint8Array): Promise<Uint8Array> {
  return convert(mode, payload, 'compress');
}

export function decompressPayload(mode: CompressionMode, payload: Uint8Array): Promise<Uint8Array> {
  return convert(mode, payload, 'decompress');
}
