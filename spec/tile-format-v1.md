# Mesh Tile Format v1 Specification

## 1. Scope

This document defines Mesh Tile Format v1 (`MTI1`), a self-describing binary
single-tile container. A consumer can decode a tile using only file bytes.

v1 uses a single fixed binary header.

## 2. File structure

All multi-byte numeric values in the fixed header are little-endian.

```
File := FixedHeaderV1 || Payload
```

- `FixedHeaderV1` is always `58` bytes.
- `Payload` is raw samples (`compression=none`) or compressed sample bytes.

## 3. FixedHeaderV1 byte map (58 bytes)

| Offset | Size | Type | Field | Description |
| --- | ---: | --- | --- | --- |
| 0 | 4 | u8[4] | `magic` | ASCII `MTI1` |
| 4 | 1 | u8 | `format_major` | Format major version (latest is `1`). |
| 5 | 8 | u64 | `tile_id` | Tile identity as unsigned 64-bit integer (mesh-kind specific; see §4.4). |
| 13 | 1 | u8 | `mesh_kind` | Mesh scheme enum. |
| 14 | 1 | u8 | `dtype_endian` | Packed dtype + endianness bit. |
| 15 | 1 | u8 | `compression` | Compression enum. |
| 16 | 4 | u32 | `rows` | Row dimension. |
| 20 | 4 | u32 | `cols` | Column dimension. |
| 24 | 1 | u8 | `bands` | Band/channel dimension. |
| 25 | 1 | u8 | `no_data_kind` | `0`=no no-data values in dataset, `1`=numeric no-data marker. |
| 26 | 8 | u8[8] | `no_data_value` | DType-encoded value in 64-bit slot; see §4.5. |
| 34 | 8 | u64 | `uncompressed_payload_length` | Uncompressed payload byte length. |
| 42 | 8 | u64 | `compressed_payload_length` | Stored payload byte length. |
| 50 | 4 | u32 | `payload_checksum` | CRC-32 of uncompressed payload bytes. |
| 54 | 4 | u32 | `header_checksum` | CRC-32 of header bytes `[0..53]`. |

## 4. Enum and field definitions

### 4.1 `mesh_kind` (u8)

- `1` = `JIS_X0410`
- `2` = `XYZ`

### 4.2 `dtype_endian` (u8)

- Bit `7` (`0x80`) is endianness:
- `0` = little-endian values
- `1` = big-endian values
- Producers SHOULD prefer little-endian value encoding (`bit7=0`) for interoperability and consistency.
- Bits `0..6` encode dtype:
- `0`=`uint8`, `1`=`int8`, `2`=`uint16`, `3`=`int16`
- `4`=`uint32`, `5`=`int32`, `6`=`float32`, `7`=`float64`

### 4.3 `compression` (u8)

- `0` = `none`
- `1` = `deflate-raw`

### 4.4 `tile_id` (u64) by `mesh_kind`

- `mesh_kind=JIS_X0410` (`1`): `tile_id` is the JIS mesh code value as an unsigned integer.
  Recommended convention for interoperability: `tile_id=0` may be used as a JIS root tile meaning
  the full JIS mesh scope (`west=122`, `south=20`, `east=154`, `north=46`).
- `mesh_kind=XYZ` (`2`): `tile_id` stores zoom + quadkey integer in a single u64.
- Bits `63..58` (most significant 6 bits): `zoom` (`0..29`)
- Bits `57..0`: `quadkey_integer` (the XYZ tile quadkey interpreted as base-4 integer)
- Encoding formula: `tile_id = (zoom << 58) | quadkey_integer`
- Validity rule: `quadkey_integer < 4^zoom`

### 4.5 `no_data_kind` and `no_data_value`

- `no_data_kind = 0`: there are no no-data values in the dataset.
- `no_data_kind = 1`: `no_data_value` carries a numeric no-data marker.
- `no_data_value` uses the `dtype` and endianness from `dtype_endian`.
- Maximum stored width is 64 bits (`u8[8]` slot).
- If `dtype` width is less than 64 bits, pad the most significant bits with `0` to fit 64 bits.
  For little-endian dtypes, padding bytes are appended at the end of the 8-byte field.
  For big-endian dtypes, padding bytes are prepended at the beginning of the 8-byte field.
- When `no_data_kind = 0`, `no_data_value` MUST be all zeros.

## 5. Payload Layout and Sample Ordering

The payload represents exactly `rows * cols * bands` numeric samples.

- Iteration order is fixed: `row` (top-to-bottom), then `col` (left-to-right), then `band`.
- Linear sample index:
  `index = ((row * cols) + col) * bands + band`
- Each sample is encoded with `dtype_endian` (`dtype` + little/big endian).

For `rows=2`, `cols=2`, `bands=3`, sample order is:

1. `(row=0, col=0, band=0..2)`
2. `(row=0, col=1, band=0..2)`
3. `(row=1, col=0, band=0..2)`
4. `(row=1, col=1, band=0..2)`

Raw payload byte size MUST equal:

`rows * cols * bands * sizeof(dtype)`

Stored payload bytes:

- `compression=none`: stored payload is raw payload bytes.
- `compression=deflate-raw`: stored payload is raw payload bytes compressed with raw DEFLATE.

## 6. Encoding rules

1. Validate required fields: `tile_id`, `mesh_kind`, `rows`, `cols`, `bands`,
   `dtype`, `endianness`, `compression`.
   `bands` MUST be in `[1, 255]`.
2. Encode sample values according to §5 ordering, `dtype`, and `endianness`.
3. Compress payload if `compression != none`.
4. Compute `payload_checksum = CRC32(uncompressed payload bytes)`.
5. Populate fixed header fields.
   Encode `no_data_value` using §4.5.
6. Set `header_checksum = CRC32(header bytes [0..53])`.
7. Emit `FixedHeaderV1 || Payload`.

## 7. Decoding rules

1. Validate `magic` and `format_major`.
2. Validate enum values and dimensions.
3. Validate `header_checksum`.
4. Read payload bytes using `compressed_payload_length`.
5. Decompress payload when required.
6. Validate uncompressed size against `uncompressed_payload_length`.
7. Validate `payload_checksum`.
8. Decode numeric samples using `dtype_endian` and §5 ordering.

## 8. Validation and deterministic errors

Decoders MUST fail deterministically for malformed inputs.

Reference error classes:

- `INVALID_MAGIC`
- `UNSUPPORTED_VERSION`
- `INVALID_HEADER_LENGTH`
- `INVALID_FIELD_VALUE`
- `MISSING_REQUIRED_FIELD`
- `HEADER_CHECKSUM_MISMATCH`
- `INVALID_PAYLOAD_LENGTH`
- `UNSUPPORTED_COMPRESSION`
- `DECOMPRESSION_FAILED`
- `PAYLOAD_CHECKSUM_MISMATCH`

## 9. Version policy

- `format_major` changes indicate breaking changes.
- A v1 reader in this repository accepts `format_major == 1`.

## 10. Integrity

- Header integrity: `header_checksum` over bytes `[0..53]`.
- Payload integrity: `payload_checksum` over uncompressed payload bytes.

Integrity checks MUST run before application-level consumption.

## 11. Security considerations

- Reject files shorter than fixed header or declared payload length.
- Reject invalid enum codes and impossible dimensions.
- Reject payload lengths exceeding safe allocation bounds.
