# mesh-data-tile-rs (reference)

Minimal Rust reference implementation for Mesh Tile Format v1 (`MTI1`).

Scope:
- Encode tile bytes from metadata + uncompressed payload bytes.
- Decode tile bytes into metadata + uncompressed payload bytes.
- Validate fixed header fields, CRC32 checksums, and payload length.
- Support `compression=none` and `compression=deflate-raw`.
- Provide typed payload helpers (`f64` values <-> payload bytes) for all dtypes.

Out of scope:
- GeoJSON/vector conversion.
- Map rendering integrations.

## Run tests

From repository root:

```bash
cargo test -p mesh-data-tile-rs
```

From `references/rust`:

```bash
cargo test
```

## Example

```rust
use mesh_data_tile_rs::{
    decode_payload_values, decode_tile_minimal, encode_payload_values, encode_tile,
    CompressionMode, DType, Endianness, MeshKind, TileDimensions, TileEncodeInput,
};

let dims = TileDimensions { rows: 2, cols: 2, bands: 1 };
let payload = encode_payload_values(DType::Uint16, Endianness::Little, &[10.0, 20.0, 30.0, 40.0])?;

let encoded = encode_tile(TileEncodeInput {
    tile_id: 42,
    mesh_kind: MeshKind::JisX0410,
    dtype: DType::Uint16,
    endianness: Endianness::Little,
    compression: CompressionMode::None,
    dimensions: dims,
    no_data: None,
    payload: &payload,
})?;

let decoded = decode_tile_minimal(&encoded.bytes)?;
let values = decode_payload_values(decoded.header.dtype, decoded.header.endianness, &decoded.payload)?;
assert_eq!(values, vec![10.0, 20.0, 30.0, 40.0]);
# Ok::<(), mesh_data_tile_rs::TileError>(())
```
