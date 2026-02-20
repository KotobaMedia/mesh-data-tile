use std::fs;
use std::path::PathBuf;

use mesh_data_tile_rs::{
    decode_payload_values, decode_tile_minimal, CompressionMode, DType, MeshKind, TileErrorCode,
};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from("../../test/fixtures").join(name)
}

fn decode_xyz_tile_id(tile_id: u64) -> (u8, u32, u32) {
    let zoom = (tile_id >> 58) as u8;
    let quadkey = tile_id & ((1_u64 << 58) - 1);

    let mut x = 0_u32;
    let mut y = 0_u32;
    for level in 0..zoom {
        let shift = ((zoom - level - 1) * 2) as u64;
        let digit = ((quadkey >> shift) & 0x3) as u8;
        x = (x << 1) | u32::from(digit & 0b01);
        y = (y << 1) | u32::from((digit & 0b10) >> 1);
    }

    (zoom, x, y)
}

#[test]
fn decodes_uncompressed_and_compressed_fixtures() {
    let uncompressed_bytes =
        fs::read(fixture_path("uncompressed.tile")).expect("read uncompressed fixture");
    let compressed_bytes =
        fs::read(fixture_path("compressed.tile")).expect("read compressed fixture");

    let uncompressed =
        decode_tile_minimal(&uncompressed_bytes).expect("decode uncompressed fixture");
    let compressed = decode_tile_minimal(&compressed_bytes).expect("decode compressed fixture");

    assert_eq!(uncompressed.header.mesh_kind, MeshKind::JisX0410);
    assert_eq!(compressed.header.mesh_kind, MeshKind::JisX0410);
    assert_eq!(uncompressed.header.compression, CompressionMode::None);
    assert_eq!(compressed.header.compression, CompressionMode::DeflateRaw);
    assert_eq!(uncompressed.payload, compressed.payload);
}

#[test]
fn decodes_xyz_fixtures_and_values() {
    let uncompressed_bytes =
        fs::read(fixture_path("xyz-uncompressed.tile")).expect("read xyz uncompressed fixture");
    let compressed_bytes =
        fs::read(fixture_path("xyz-compressed.tile")).expect("read xyz compressed fixture");

    let uncompressed =
        decode_tile_minimal(&uncompressed_bytes).expect("decode xyz uncompressed fixture");
    let compressed = decode_tile_minimal(&compressed_bytes).expect("decode xyz compressed fixture");

    assert_eq!(uncompressed.header.mesh_kind, MeshKind::Xyz);
    assert_eq!(compressed.header.mesh_kind, MeshKind::Xyz);
    assert_eq!(uncompressed.header.compression, CompressionMode::None);
    assert_eq!(compressed.header.compression, CompressionMode::DeflateRaw);
    assert_eq!(uncompressed.payload, compressed.payload);

    let (zoom, x, y) = decode_xyz_tile_id(uncompressed.header.tile_id);
    assert_eq!((zoom, x, y), (12, 3639, 1612));

    assert_eq!(uncompressed.header.dtype, DType::Uint8);
    let values = decode_payload_values(
        uncompressed.header.dtype,
        uncompressed.header.endianness,
        &uncompressed.payload,
    )
    .expect("decode xyz payload values");

    assert_eq!(
        values,
        vec![10.0, 110.0, 210.0, 20.0, 120.0, 220.0, 30.0, 130.0, 230.0, 40.0, 140.0, 240.0,]
    );
}

#[test]
fn rejects_invalid_magic() {
    let uncompressed_bytes =
        fs::read(fixture_path("uncompressed.tile")).expect("read uncompressed fixture");
    let mut malformed = uncompressed_bytes;
    malformed[0] = 0;

    let err = decode_tile_minimal(&malformed).expect_err("decode should fail");
    assert_eq!(err.code, TileErrorCode::InvalidMagic);
}
