use crate::{DType, Endianness, MeshKind, Result, TileDimensions, TileError, TileErrorCode};

pub(crate) fn expected_payload_length(dimensions: TileDimensions, dtype: DType) -> Result<usize> {
    let total_samples = dimensions.total_samples()?;
    let byte_len = total_samples
        .checked_mul(dtype.byte_size() as u64)
        .ok_or_else(|| {
            TileError::new(
                TileErrorCode::InvalidPayloadLength,
                "Payload length overflow.",
            )
        })?;

    usize::try_from(byte_len).map_err(|_| {
        TileError::new(
            TileErrorCode::InvalidPayloadLength,
            "Payload length exceeds platform usize.",
        )
    })
}

pub(crate) fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32> {
    let value_bytes = bytes.get(offset..offset + 4).ok_or_else(|| {
        TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "Could not read u32 field.",
        )
    })?;
    let arr: [u8; 4] = value_bytes.try_into().map_err(|_| {
        TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "Could not parse u32 field bytes.",
        )
    })?;
    Ok(u32::from_le_bytes(arr))
}

pub(crate) fn read_u64_le(bytes: &[u8], offset: usize) -> Result<u64> {
    let value_bytes = bytes.get(offset..offset + 8).ok_or_else(|| {
        TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "Could not read u64 field.",
        )
    })?;
    let arr: [u8; 8] = value_bytes.try_into().map_err(|_| {
        TileError::new(
            TileErrorCode::InvalidHeaderLength,
            "Could not parse u64 field bytes.",
        )
    })?;
    Ok(u64::from_le_bytes(arr))
}

pub(crate) fn pack_dtype_endian(dtype: DType, endianness: Endianness) -> u8 {
    let endian_bit = match endianness {
        Endianness::Little => 0_u8,
        Endianness::Big => 0x80_u8,
    };
    endian_bit | dtype.code()
}

pub(crate) fn unpack_dtype_endian(value: u8) -> Result<(DType, Endianness)> {
    let dtype = DType::from_code(value & 0x7f)?;
    let endianness = if value & 0x80 == 0 {
        Endianness::Little
    } else {
        Endianness::Big
    };
    Ok((dtype, endianness))
}

pub(crate) fn validate_tile_id_for_mesh_kind(tile_id: u64, mesh_kind: MeshKind) -> Result<()> {
    if mesh_kind == MeshKind::Xyz {
        assert_valid_xyz_tile_id(tile_id)?;
    }
    Ok(())
}

fn assert_valid_xyz_tile_id(tile_id: u64) -> Result<()> {
    let zoom = tile_id >> 58;
    if zoom > 29 {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            format!("XYZ tile_id zoom must be <= 29, got {zoom}."),
        ));
    }

    let quadkey = tile_id & ((1_u64 << 58) - 1);
    let max_quadkey = 1_u128 << (2 * zoom);
    if u128::from(quadkey) >= max_quadkey {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            "XYZ tile_id quadkey_integer must be < 4^zoom.",
        ));
    }

    Ok(())
}

pub(crate) fn encode_no_data_field(
    no_data: Option<f64>,
    dtype: DType,
    endianness: Endianness,
) -> Result<(u8, [u8; 8])> {
    let mut out = [0_u8; 8];
    let Some(value) = no_data else {
        return Ok((0, out));
    };

    if !value.is_finite() {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            "no_data must be finite number or null.",
        ));
    }

    let value_byte_size = dtype.byte_size();
    let mut encoded = vec![0_u8; value_byte_size];
    write_numeric_value(dtype, endianness, value, false, &mut encoded)?;

    match endianness {
        Endianness::Little => out[..value_byte_size].copy_from_slice(&encoded),
        Endianness::Big => out[8 - value_byte_size..].copy_from_slice(&encoded),
    }

    Ok((1, out))
}

pub(crate) fn decode_no_data_field(
    kind: u8,
    no_data_value_raw: [u8; 8],
    dtype: DType,
    endianness: Endianness,
) -> Result<Option<f64>> {
    if kind == 0 {
        if no_data_value_raw.iter().any(|byte| *byte != 0) {
            return Err(TileError::new(
                TileErrorCode::InvalidFieldValue,
                "no_data_value must be zero when no_data_kind=0.",
            ));
        }
        return Ok(None);
    }

    if kind != 1 {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            format!("Unsupported no_data kind {kind}."),
        ));
    }

    let value_size = dtype.byte_size();
    let mut value_bytes = vec![0_u8; value_size];

    match endianness {
        Endianness::Little => {
            for byte in &no_data_value_raw[value_size..] {
                if *byte != 0 {
                    return Err(TileError::new(
                        TileErrorCode::InvalidFieldValue,
                        "no_data_value must pad most significant bytes with 0.",
                    ));
                }
            }
            value_bytes.copy_from_slice(&no_data_value_raw[..value_size]);
        }
        Endianness::Big => {
            let pad = 8 - value_size;
            for byte in &no_data_value_raw[..pad] {
                if *byte != 0 {
                    return Err(TileError::new(
                        TileErrorCode::InvalidFieldValue,
                        "no_data_value must pad most significant bytes with 0.",
                    ));
                }
            }
            value_bytes.copy_from_slice(&no_data_value_raw[pad..]);
        }
    }

    let value = read_numeric_value(dtype, endianness, &value_bytes)?;
    if !value.is_finite() {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            "no_data numeric value must be finite.",
        ));
    }

    Ok(Some(value))
}

pub(crate) fn write_numeric_value(
    dtype: DType,
    endianness: Endianness,
    value: f64,
    allow_float_nan: bool,
    out: &mut [u8],
) -> Result<()> {
    if out.len() != dtype.byte_size() {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            "Internal numeric write with invalid output buffer length.",
        ));
    }

    match dtype {
        DType::Uint8 => {
            let v = validate_integer_range(value, 0.0, u8::MAX as f64)?;
            out[0] = v as u8;
        }
        DType::Int8 => {
            let v = validate_integer_range(value, i8::MIN as f64, i8::MAX as f64)?;
            out[0] = (v as i8).to_ne_bytes()[0];
        }
        DType::Uint16 => {
            let v = validate_integer_range(value, 0.0, u16::MAX as f64)? as u16;
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
        DType::Int16 => {
            let v = validate_integer_range(value, i16::MIN as f64, i16::MAX as f64)? as i16;
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
        DType::Uint32 => {
            let v = validate_integer_range(value, 0.0, u32::MAX as f64)? as u32;
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
        DType::Int32 => {
            let v = validate_integer_range(value, i32::MIN as f64, i32::MAX as f64)? as i32;
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
        DType::Float32 => {
            if !(value.is_finite() || allow_float_nan && value.is_nan()) {
                return Err(TileError::new(
                    TileErrorCode::InvalidFieldValue,
                    format!("Non-finite value: {value}"),
                ));
            }
            let v = value as f32;
            if value.is_finite() && !v.is_finite() {
                return Err(TileError::new(
                    TileErrorCode::InvalidFieldValue,
                    format!("Out-of-range value for float32: {value}"),
                ));
            }
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
        DType::Float64 => {
            if !(value.is_finite() || allow_float_nan && value.is_nan()) {
                return Err(TileError::new(
                    TileErrorCode::InvalidFieldValue,
                    format!("Non-finite value: {value}"),
                ));
            }
            let v = value;
            let bytes = match endianness {
                Endianness::Little => v.to_le_bytes(),
                Endianness::Big => v.to_be_bytes(),
            };
            out.copy_from_slice(&bytes);
        }
    }

    Ok(())
}

pub(crate) fn read_numeric_value(
    dtype: DType,
    endianness: Endianness,
    bytes: &[u8],
) -> Result<f64> {
    if bytes.len() != dtype.byte_size() {
        return Err(TileError::new(
            TileErrorCode::InvalidPayloadLength,
            "Payload chunk size does not match dtype width.",
        ));
    }

    let value = match dtype {
        DType::Uint8 => f64::from(bytes[0]),
        DType::Int8 => f64::from(i8::from_ne_bytes([bytes[0]])),
        DType::Uint16 => {
            let arr: [u8; 2] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse uint16 payload value.",
                )
            })?;
            let v = match endianness {
                Endianness::Little => u16::from_le_bytes(arr),
                Endianness::Big => u16::from_be_bytes(arr),
            };
            f64::from(v)
        }
        DType::Int16 => {
            let arr: [u8; 2] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse int16 payload value.",
                )
            })?;
            let v = match endianness {
                Endianness::Little => i16::from_le_bytes(arr),
                Endianness::Big => i16::from_be_bytes(arr),
            };
            f64::from(v)
        }
        DType::Uint32 => {
            let arr: [u8; 4] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse uint32 payload value.",
                )
            })?;
            let v = match endianness {
                Endianness::Little => u32::from_le_bytes(arr),
                Endianness::Big => u32::from_be_bytes(arr),
            };
            f64::from(v)
        }
        DType::Int32 => {
            let arr: [u8; 4] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse int32 payload value.",
                )
            })?;
            let v = match endianness {
                Endianness::Little => i32::from_le_bytes(arr),
                Endianness::Big => i32::from_be_bytes(arr),
            };
            f64::from(v)
        }
        DType::Float32 => {
            let arr: [u8; 4] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse float32 payload value.",
                )
            })?;
            let v = match endianness {
                Endianness::Little => f32::from_le_bytes(arr),
                Endianness::Big => f32::from_be_bytes(arr),
            };
            f64::from(v)
        }
        DType::Float64 => {
            let arr: [u8; 8] = bytes.try_into().map_err(|_| {
                TileError::new(
                    TileErrorCode::InvalidPayloadLength,
                    "Could not parse float64 payload value.",
                )
            })?;
            match endianness {
                Endianness::Little => f64::from_le_bytes(arr),
                Endianness::Big => f64::from_be_bytes(arr),
            }
        }
    };

    Ok(value)
}

fn validate_integer_range(value: f64, min: f64, max: f64) -> Result<f64> {
    if !value.is_finite() {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            format!("Non-finite value: {value}"),
        ));
    }
    if value.fract() != 0.0 {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            format!("Non-integer value: {value}"),
        ));
    }
    if value < min || value > max {
        return Err(TileError::new(
            TileErrorCode::InvalidFieldValue,
            format!("Out-of-range value: {value}"),
        ));
    }
    Ok(value)
}
