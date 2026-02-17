import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decodeTile,
  decodeTileFileToCsv,
  decodeTileToCsv,
  decodeXyzTileId,
  encodeTile,
  encodeTileToFile,
  encodeXyzTileId,
  formatDecodedCsv,
  formatInspectOutput,
  inspectTile,
  inspectTileFile,
  inspectTileToText,
} from '../src/index.js';
import { TileFormatError } from '../src/errors.js';

const fixturesDir = join(process.cwd(), 'test', 'fixtures');

function tileTemplate() {
  return {
    tile_id: 1001n,
    mesh_kind: 'jis-x0410' as const,
    rows: 2,
    cols: 2,
    bands: 1,
    dtype: 'uint16' as const,
    endianness: 'little' as const,
    compression: 'none' as const,
    no_data: null,
  };
}

describe('mesh tile v1 conformance', () => {
  it('xyz tile_id encode/decode roundtrip', () => {
    const tileId = encodeXyzTileId({ zoom: 3, x: 5, y: 2 });
    const decoded = decodeXyzTileId(tileId);

    assert.equal(tileId, (3n << 58n) | 25n);
    assert.deepEqual(decoded, {
      zoom: 3,
      x: 5,
      y: 2,
      quadkey_integer: 25n,
    });
  });

  it('xyz tile_id supports zoom 29', () => {
    const maxCoord = 2 ** 29 - 1;
    const tileId = encodeXyzTileId({ zoom: 29, x: maxCoord, y: maxCoord });
    const decoded = decodeXyzTileId(tileId);

    assert.equal(decoded.zoom, 29);
    assert.equal(decoded.x, maxCoord);
    assert.equal(decoded.y, maxCoord);
    assert.equal(decoded.quadkey_integer, (1n << 58n) - 1n);
  });

  it('rejects invalid xyz tile_id values', async () => {
    assert.throws(() => {
      encodeXyzTileId({ zoom: 30, x: 0, y: 0 });
    }, /zoom must be an integer in \[0, 29\]/);

    assert.throws(() => {
      decodeXyzTileId(30n << 58n);
    }, /zoom must be <= 29/);

    await assert.rejects(
      async () => {
        await encodeTile({
          ...tileTemplate(),
          mesh_kind: 'xyz',
          tile_id: (1n << 58n) | 16n,
          dtype: 'uint8',
          data: [1, 2, 3, 4],
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof TileFormatError);
        assert.equal((error as TileFormatError).code, 'INVALID_FIELD_VALUE');
        return true;
      }
    );
  });

  it('roundtrip encode/decode', async () => {
    const payload = [1, 2, 3, 4];
    const encoded = await encodeTile({
      ...tileTemplate(),
      dtype: 'float32',
      data: new Float32Array(payload),
    });
    const decoded = await decodeTile(encoded.bytes);
    assert.equal(decoded.header.tile_id, 1001n);
    assert.deepEqual(Array.from(decoded.data as unknown as number[]), payload);
    assert.equal(decoded.header.payload.uncompressed_bytes, decoded.payload.byteLength);
  });

  it('uses compact fixed header size', async () => {
    const encoded = await encodeTile({
      ...tileTemplate(),
      tile_id: 1008n,
      dtype: 'uint8',
      data: [1, 2, 3, 4],
    });
    const inspected = inspectTile(encoded.bytes);
    assert.equal(inspected.header_length, 58);
    assert.equal(inspected.payload_offset, 58);
  });

  it('rejects bands larger than u8', async () => {
    const values = new Array<number>(2 * 2 * 256).fill(1);
    await assert.rejects(
      async () => {
        await encodeTile({
          ...tileTemplate(),
          tile_id: 1009n,
          bands: 256,
          dtype: 'uint8',
          data: values,
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof TileFormatError);
        assert.equal((error as TileFormatError).code, 'INVALID_FIELD_VALUE');
        return true;
      }
    );
  });

  it('encodes no_data_value with dtype_endian and zero MSB padding', async () => {
    const little = await encodeTile({
      ...tileTemplate(),
      tile_id: 1010n,
      rows: 1,
      cols: 1,
      bands: 1,
      dtype: 'uint16',
      endianness: 'little',
      no_data: 0x1234,
      data: [1],
    });
    const big = await encodeTile({
      ...tileTemplate(),
      tile_id: 1011n,
      rows: 1,
      cols: 1,
      bands: 1,
      dtype: 'uint16',
      endianness: 'big',
      no_data: 0x1234,
      data: [1],
    });

    assert.equal(little.bytes[25], 1);
    assert.deepEqual(Array.from(little.bytes.slice(26, 34)), [0x34, 0x12, 0, 0, 0, 0, 0, 0]);
    assert.equal(big.bytes[25], 1);
    assert.deepEqual(Array.from(big.bytes.slice(26, 34)), [0, 0, 0, 0, 0, 0, 0x12, 0x34]);
  });

  it('endianness correctness', async () => {
    const payload = [1, 258, 1024, 2048];
    const little = await encodeTile({
      ...tileTemplate(),
      tile_id: 1002n,
      dtype: 'uint16',
      endianness: 'little',
      data: payload,
    });
    const big = await encodeTile({
      ...tileTemplate(),
      tile_id: 1003n,
      dtype: 'uint16',
      endianness: 'big',
      data: payload,
    });

    assert.notEqual(Buffer.from(little.bytes).toString('hex'), Buffer.from(big.bytes).toString('hex'));

    const decodedLittle = await decodeTile(little.bytes);
    const decodedBig = await decodeTile(big.bytes);
    assert.deepEqual(Array.from(decodedLittle.data as unknown as number[]), payload);
    assert.deepEqual(Array.from(decodedBig.data as unknown as number[]), payload);
  });

  it('compression correctness', async () => {
    const payload = [1, 2, 3, 4];
    const compressed = await encodeTile({
      ...tileTemplate(),
      tile_id: 1004n,
      dtype: 'uint16',
      compression: 'deflate-raw',
      data: payload,
    });
    const decoded = await decodeTile(compressed.bytes);
    assert.equal(decoded.header.compression, 'deflate-raw');
    assert.deepEqual(Array.from(decoded.data as unknown as number[]), payload);
  });

  it('invalid-header rejection', async () => {
    const encoded = await encodeTile({
      ...tileTemplate(),
      tile_id: 1005n,
      dtype: 'uint8',
      data: [1, 2, 3, 4],
    });
    const malformed = new Uint8Array(encoded.bytes);
    malformed[1] = 0x00;

    await assert.rejects(
      async () => {
        await decodeTile(malformed);
      },
      (error: unknown) => {
        assert.ok(error instanceof TileFormatError);
        assert.equal((error as TileFormatError).code, 'INVALID_MAGIC');
        return true;
      }
    );
  });

  it('rejects unsupported major version', async () => {
    const encoded = await encodeTile({
      ...tileTemplate(),
      tile_id: 1007n,
      dtype: 'uint8',
      data: [1, 2, 3, 4],
    });
    const malformed = new Uint8Array(encoded.bytes);
    malformed[4] = 2;

    await assert.rejects(
      async () => {
        await decodeTile(malformed);
      },
      (error: unknown) => {
        assert.ok(error instanceof TileFormatError);
        assert.equal((error as TileFormatError).code, 'UNSUPPORTED_VERSION');
        return true;
      }
    );
  });

  it('checksum validation failure path', async () => {
    const encoded = await encodeTile({
      ...tileTemplate(),
      tile_id: 1006n,
      dtype: 'uint8',
      data: [5, 6, 7, 8],
    });
    const malformed = new Uint8Array(encoded.bytes);
    const info = inspectTile(malformed);
    malformed[info.payload_offset] = malformed[info.payload_offset] === 0 ? 1 : 0;

    await assert.rejects(
      async () => {
        await decodeTile(malformed);
      },
      (error: unknown) => {
        assert.ok(error instanceof TileFormatError);
        assert.equal((error as TileFormatError).code, 'PAYLOAD_CHECKSUM_MISMATCH');
        return true;
      }
    );
  });

  it('fixture files exist for uncompressed and compressed tiles', async () => {
    const uncompressedPath = join(fixturesDir, 'uncompressed.tile');
    const compressedPath = join(fixturesDir, 'compressed.tile');
    await fs.access(uncompressedPath);
    await fs.access(compressedPath);

    const [uncompressedData, compressedData] = await Promise.all([
      new Uint8Array(await fs.readFile(uncompressedPath)),
      new Uint8Array(await fs.readFile(compressedPath)),
    ]);

    const decodedUncompressed = await decodeTile(uncompressedData);
    const decodedCompressed = await decodeTile(compressedData);
    assert.equal(decodedUncompressed.header.compression, 'none');
    assert.equal(decodedCompressed.header.compression, 'deflate-raw');
    assert.deepEqual(Array.from(decodedUncompressed.payload), Array.from(decodedCompressed.payload));
  });

  it('xyz fixture files exist for uncompressed and compressed tiles', async () => {
    const uncompressedPath = join(fixturesDir, 'xyz-uncompressed.tile');
    const compressedPath = join(fixturesDir, 'xyz-compressed.tile');
    await fs.access(uncompressedPath);
    await fs.access(compressedPath);

    const [uncompressedData, compressedData] = await Promise.all([
      new Uint8Array(await fs.readFile(uncompressedPath)),
      new Uint8Array(await fs.readFile(compressedPath)),
    ]);

    const decodedUncompressed = await decodeTile(uncompressedData);
    const decodedCompressed = await decodeTile(compressedData);
    const xyz = decodeXyzTileId(decodedUncompressed.header.tile_id);

    assert.equal(decodedUncompressed.header.mesh_kind, 'xyz');
    assert.equal(decodedCompressed.header.mesh_kind, 'xyz');
    assert.equal(decodedUncompressed.header.compression, 'none');
    assert.equal(decodedCompressed.header.compression, 'deflate-raw');
    assert.equal(xyz.zoom, 12);
    assert.equal(xyz.x, 3639);
    assert.equal(xyz.y, 1612);
    assert.deepEqual(Array.from(decodedUncompressed.payload), Array.from(decodedCompressed.payload));
    assert.deepEqual(Array.from(decodedUncompressed.data as unknown as number[]), [
      10, 110, 210, 20, 120, 220, 30, 130, 230, 40, 140, 240,
    ]);
  });

  it('xyz tile_id integrates with tile encode/decode', async () => {
    const tileId = encodeXyzTileId({ zoom: 12, x: 3639, y: 1612 });
    const encoded = await encodeTile({
      ...tileTemplate(),
      tile_id: tileId,
      mesh_kind: 'xyz',
      dtype: 'uint8',
      data: [7, 8, 9, 10],
    });

    const inspected = inspectTile(encoded.bytes);
    const decodedTileId = decodeXyzTileId(inspected.header.tile_id);

    assert.equal(inspected.header.mesh_kind, 'xyz');
    assert.equal(inspected.header.tile_id, tileId);
    assert.equal(decodedTileId.zoom, 12);
    assert.equal(decodedTileId.x, 3639);
    assert.equal(decodedTileId.y, 1612);
  });

  it('library api decodes tile bytes to csv', async () => {
    const input = new Uint8Array(await fs.readFile(join(fixturesDir, 'uncompressed.tile')));
    const { csv, decoded } = await decodeTileToCsv(input);

    assert.equal(decoded.header.mesh_kind, 'jis-x0410');
    assert.equal(
      csv,
      ['x,y,b0,b1,b2', '0,0,1,101,201', '1,0,2,102,202', '0,1,3,103,203', '1,1,4,104,204'].join('\n')
    );
  });

  it('library api inspect text includes xyz coordinates', async () => {
    const input = new Uint8Array(await fs.readFile(join(fixturesDir, 'xyz-uncompressed.tile')));
    const result = inspectTileToText(input);
    const fromFormatter = formatInspectOutput(inspectTile(input));

    assert.equal(result.text, fromFormatter);
    assert.match(result.text, /XYZ Zoom: 12/);
    assert.match(result.text, /XYZ X: 3639/);
    assert.match(result.text, /XYZ Y: 1612/);
  });

  it('library api file helpers roundtrip', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'mesh-data-tile-'));
    const outputPath = join(tempDir, 'api-roundtrip.tile');

    try {
      await encodeTileToFile(outputPath, {
        ...tileTemplate(),
        tile_id: 2001n,
        dtype: 'uint16',
        data: [10, 20, 30, 40],
      });

      const inspected = await inspectTileFile(outputPath);
      const decoded = await decodeTileFileToCsv(outputPath);

      assert.equal(inspected.info.header.tile_id, 2001n);
      assert.equal(decoded.csv, ['x,y,b0', '0,0,10', '1,0,20', '0,1,30', '1,1,40'].join('\n'));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('formatDecodedCsv rejects mismatched value counts', () => {
    assert.throws(
      () => {
        formatDecodedCsv([1, 2], 1, 1, 1);
      },
      (error: unknown) => {
        assert.ok(error instanceof TileFormatError);
        assert.equal((error as TileFormatError).code, 'INVALID_PAYLOAD_LENGTH');
        return true;
      }
    );
  });
});
