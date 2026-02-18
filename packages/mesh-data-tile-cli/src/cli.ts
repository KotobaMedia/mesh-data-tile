#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import {
  decodeTileToCsv,
  decodeXyzTileId,
  encodeTile,
  inspectTile,
  TileFormatError,
  type InspectTileResult,
  type TileEncodeInput,
  type DType,
  type Endianness,
  type CompressionMode,
  type MeshKind,
} from 'mesh-data-tile';

const DTYPE_VALUES: DType[] = ['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'float32', 'float64'];
const ENDIAN_VALUES: Endianness[] = ['little', 'big'];
const COMPRESSION_VALUES: CompressionMode[] = ['none', 'deflate-raw'];
const MESH_KIND_VALUES: MeshKind[] = ['jis-x0410', 'xyz'];

interface DecodeCommandOptions {
  output?: string;
}

interface EncodeCommandOptions {
  output?: string;
  metadata?: string;
  values?: string;
  valuesFile?: string;
  tileId?: string;
  meshKind?: string;
  rows?: string;
  cols?: string;
  bands?: string;
  dtype?: string;
  endianness?: string;
  compression?: string;
  noData?: string;
}

interface InspectTileTextResult {
  info: InspectTileResult;
  text: string;
}

function fail(message: string, code = 1): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

function parseEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    fail(`Invalid ${label} "${value}". Allowed: ${allowed.join(', ')}`);
  }
  return value as T;
}

function parseOptionalU32(name: 'rows' | 'cols' | 'bands', value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`Invalid --${name} value "${value}". Expected unsigned integer.`);
  }
  if ((name === 'rows' || name === 'cols') && parsed > 0xffffffff) {
    fail(`Invalid --${name} value "${value}". Must fit u32.`);
  }
  if (name === 'bands' && parsed > 0xff) {
    fail(`Invalid --${name} value "${value}". Must fit u8.`);
  }
  return parsed;
}

function parseNoData(input?: string): number | null | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === 'null') {
    return null;
  }
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) {
    fail(`Invalid --no-data value ${input}`);
  }
  return parsed;
}

async function readValues(values: string | undefined, valuesPath: string | undefined): Promise<number[]> {
  if (valuesPath) {
    const text = await readFile(valuesPath, 'utf-8');
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('values file must be a JSON array');
    }
    return parsed.map((value) => Number(value));
  }
  if (values) {
    const parsed = JSON.parse(values);
    if (!Array.isArray(parsed)) {
      throw new Error('values must be a JSON array');
    }
    return parsed.map((value) => Number(value));
  }
  return [];
}

async function writeOutput(path: string | undefined, content: Uint8Array | string, binary = false): Promise<void> {
  if (!path) {
    if (typeof content === 'string') {
      console.log(content);
    } else if (binary) {
      process.stdout.write(Buffer.from(content));
    } else {
      console.log(new TextDecoder().decode(content));
    }
    return;
  }
  await writeFile(path, content);
}

function formatInspectOutput(info: InspectTileResult): string {
  const lines = [
    `Format Major: ${info.header.format_major}`,
    `Tile ID: ${info.header.tile_id.toString()}`,
    `Mesh Kind: ${info.header.mesh_kind}`,
    `DType: ${info.header.dtype}`,
    `Endianness: ${info.header.endianness}`,
    `Compression: ${info.header.compression}`,
    `Rows: ${info.header.dimensions.rows}`,
    `Cols: ${info.header.dimensions.cols}`,
    `Bands: ${info.header.dimensions.bands}`,
    `NoData: ${info.header.no_data === null ? 'null' : String(info.header.no_data)}`,
    `Uncompressed Payload Bytes: ${info.header.payload.uncompressed_bytes}`,
    `Compressed Payload Bytes: ${info.header.payload.compressed_bytes}`,
    `Payload CRC32: ${info.header.checksum.payload_crc32}`,
    `Header CRC32: ${info.header.checksum.header_crc32}`,
    `Header Length: ${info.header_length}`,
    `Payload Offset: ${info.payload_offset}`,
    `Payload Length: ${info.payload_length}`,
  ];

  if (info.header.mesh_kind === 'xyz') {
    const xyz = decodeXyzTileId(info.header.tile_id);
    lines.push(`XYZ Zoom: ${xyz.zoom}`);
    lines.push(`XYZ X: ${xyz.x}`);
    lines.push(`XYZ Y: ${xyz.y}`);
    lines.push(`XYZ Quadkey Integer: ${xyz.quadkey_integer.toString()}`);
  }

  return lines.join('\n');
}

function inspectTileToText(bytes: Uint8Array): InspectTileTextResult {
  const info = inspectTile(bytes);
  return {
    info,
    text: formatInspectOutput(info),
  };
}

async function decodeTileFileToCsv(path: string) {
  const bytes = new Uint8Array(await readFile(path));
  return decodeTileToCsv(bytes);
}

async function encodeTileToFile(path: string, input: TileEncodeInput) {
  const encoded = await encodeTile(input);
  await writeFile(path, encoded.bytes);
  return encoded;
}

async function runInspect(inputPath: string): Promise<void> {
  const input = new Uint8Array(await readFile(inputPath));
  const result = inspectTileToText(input);
  console.log(result.text);
}

async function runDecode(inputPath: string, options: DecodeCommandOptions): Promise<void> {
  const result = await decodeTileFileToCsv(inputPath);
  await writeOutput(options.output, result.csv);
}

function parseEnumIfDefined<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    fail(`Invalid ${label} value type.`);
  }
  return parseEnum(value, allowed, label);
}

async function runEncode(options: EncodeCommandOptions): Promise<void> {
  if (!options.output) {
    fail('encode requires --output <file>');
  }

  let metadata: Partial<TileEncodeInput> = {};
  if (options.metadata) {
    const text = await readFile(options.metadata, 'utf-8');
    metadata = JSON.parse(text);
  }

  const values = await readValues(options.values, options.valuesFile);
  if (values.length === 0) {
    fail('encode requires --values or --values-file');
  }

  const meshKind = parseEnumIfDefined(options.meshKind ?? metadata.mesh_kind, MESH_KIND_VALUES, 'mesh-kind');
  const dtype = parseEnumIfDefined(options.dtype ?? metadata.dtype, DTYPE_VALUES, 'dtype');
  const endianness = parseEnumIfDefined(options.endianness ?? metadata.endianness, ENDIAN_VALUES, 'endianness');
  const compression = parseEnumIfDefined(
    options.compression ?? metadata.compression,
    COMPRESSION_VALUES,
    'compression'
  );

  const input: TileEncodeInput = {
    tile_id: options.tileId ?? metadata.tile_id ?? '',
    mesh_kind: meshKind as MeshKind,
    rows: parseOptionalU32('rows', options.rows ?? metadata.rows) ?? 0,
    cols: parseOptionalU32('cols', options.cols ?? metadata.cols) ?? 0,
    bands: parseOptionalU32('bands', options.bands ?? metadata.bands) ?? 0,
    dtype: dtype as DType,
    endianness: endianness as Endianness,
    compression: compression as CompressionMode,
    no_data: options.noData !== undefined ? parseNoData(options.noData) : metadata.no_data,
    data: values,
  };

  if (!input.tile_id) {
    fail('Missing required --tile-id');
  }
  if (!input.mesh_kind) {
    fail('Missing required --mesh-kind');
  }
  if (!input.dtype) {
    fail('Missing required --dtype');
  }
  if (!input.endianness) {
    fail('Missing required --endianness');
  }

  await encodeTileToFile(options.output, input);
}

async function runWithErrorHandling(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof TileFormatError) {
      fail(`${error.code}: ${error.message}`);
    }
    throw error;
  }
}

function buildProgram(): Command {
  const program = new Command();
  program.name('mesh-tile').description('mesh-tile v1').showHelpAfterError();

  program
    .command('inspect')
    .description('Inspect tile header metadata')
    .argument('<input>', 'Input tile file path')
    .action(async (input: string) => {
      await runWithErrorHandling(async () => {
        await runInspect(input);
      });
    });

  program
    .command('decode')
    .description('Decode a tile')
    .argument('<input>', 'Input tile file path')
    .option('--output <path>', 'Write CSV output to file')
    .action(async (input: string, options: DecodeCommandOptions) => {
      await runWithErrorHandling(async () => {
        await runDecode(input, options);
      });
    });

  program
    .command('encode')
    .description('Encode values into a tile')
    .requiredOption('--output <file>', 'Output tile path')
    .option('--metadata <json_file>', 'Metadata JSON file path')
    .option('--values <json_array>', 'Inline JSON array of values')
    .option('--values-file <json_file>', 'JSON file with array of values')
    .option('--tile-id <u64>', 'Tile id')
    .option('--mesh-kind <kind>', `Mesh kind: ${MESH_KIND_VALUES.join('|')}`)
    .option('--rows <u32>', 'Rows')
    .option('--cols <u32>', 'Cols')
    .option('--bands <u8>', 'Bands')
    .option('--dtype <dtype>', `Data type: ${DTYPE_VALUES.join('|')}`)
    .option('--endianness <endian>', `Endianness: ${ENDIAN_VALUES.join('|')}`)
    .option('--compression <compression>', `Compression: ${COMPRESSION_VALUES.join('|')}`)
    .option('--no-data <value>', 'NoData value or null')
    .action(async (options: EncodeCommandOptions) => {
      await runWithErrorHandling(async () => {
        await runEncode(options);
      });
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  if (process.argv.length <= 2) {
    program.outputHelp();
    process.exit(0);
  }
  await program.parseAsync(process.argv);
}

void main();
