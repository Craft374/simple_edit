export type MetadataField = {
  key: string
  value: string
}

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

const EXIF_IFD0_TAGS: Record<number, string> = {
  0x010e: 'ImageDescription',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x8298: 'Copyright',
}

const EXIF_SUB_IFD_TAGS: Record<number, string> = {
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9286: 'UserComment',
}

export async function extractMetadataFields(blob: Blob): Promise<MetadataField[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer())

  if (isPng(bytes)) {
    return parsePngMetadata(bytes)
  }

  if (isJpeg(bytes)) {
    return parseJpegMetadata(bytes)
  }

  return []
}

export async function writeMetadataToPng(
  blob: Blob,
  fields: MetadataField[],
): Promise<Blob> {
  const normalizedFields = normalizeMetadataFields(fields)

  if (!normalizedFields.length) {
    return blob
  }

  const bytes = new Uint8Array(await blob.arrayBuffer())

  if (!isPng(bytes)) {
    return blob
  }

  const parts: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)]
  let offset = PNG_SIGNATURE.length
  let inserted = false

  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const type = readAscii(bytes, offset + 4, 4)
    const chunkEnd = offset + 12 + length

    if (chunkEnd > bytes.length) {
      break
    }

    if (type === 'IHDR') {
      parts.push(bytes.slice(offset, chunkEnd))

      normalizedFields.forEach((field, index) => {
        parts.push(
          buildITXtChunk(sanitizeKeyword(field.key, index), field.value.trim()),
        )
      })

      inserted = true
    } else if (type !== 'tEXt' && type !== 'iTXt' && type !== 'zTXt') {
      parts.push(bytes.slice(offset, chunkEnd))
    }

    offset = chunkEnd
  }

  if (!inserted) {
    return blob
  }

  const blobParts = parts.map((part) =>
    Uint8Array.from(part).buffer,
  )

  return new Blob(blobParts, { type: 'image/png' })
}

function parsePngMetadata(bytes: Uint8Array): MetadataField[] {
  const fields: MetadataField[] = []
  let offset = PNG_SIGNATURE.length

  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const type = readAscii(bytes, offset + 4, 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4

    if (chunkEnd > bytes.length) {
      break
    }

    const chunkData = bytes.subarray(dataStart, dataEnd)

    if (type === 'tEXt') {
      const keywordEnd = chunkData.indexOf(0)

      if (keywordEnd > 0) {
        const key = decodeLatin1(chunkData.subarray(0, keywordEnd))
        const value = decodeLatin1(chunkData.subarray(keywordEnd + 1)).trim()

        if (key && value) {
          fields.push({ key, value })
        }
      }
    }

    if (type === 'iTXt') {
      const field = parseITXtChunk(chunkData)

      if (field) {
        fields.push(field)
      }
    }

    offset = chunkEnd
  }

  return normalizeMetadataFields(fields)
}

function parseITXtChunk(chunkData: Uint8Array): MetadataField | null {
  const keywordEnd = chunkData.indexOf(0)

  if (keywordEnd <= 0) {
    return null
  }

  const key = decodeLatin1(chunkData.subarray(0, keywordEnd)) || 'Comment'
  let offset = keywordEnd + 1
  const compressionFlag = chunkData[offset]
  offset += 2

  const languageEnd = chunkData.indexOf(0, offset)

  if (languageEnd < 0) {
    return null
  }

  offset = languageEnd + 1
  const translatedEnd = chunkData.indexOf(0, offset)

  if (translatedEnd < 0) {
    return null
  }

  offset = translatedEnd + 1

  if (compressionFlag !== 0) {
    return null
  }

  const value = decodeUtf8(chunkData.subarray(offset)).trim()

  if (!value) {
    return null
  }

  return { key, value }
}

function parseJpegMetadata(bytes: Uint8Array): MetadataField[] {
  let offset = 2

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      break
    }

    const marker = bytes[offset + 1]
    offset += 2

    if (marker === 0xda || marker === 0xd9) {
      break
    }

    const segmentLength = readUint16(bytes, offset, false)
    const segmentStart = offset + 2
    const segmentEnd = offset + segmentLength

    if (segmentLength < 2 || segmentEnd > bytes.length) {
      break
    }

    if (marker === 0xe1 && readAscii(bytes, segmentStart, 6) === 'Exif\0\0') {
      return parseExifData(bytes.subarray(segmentStart + 6, segmentEnd))
    }

    offset = segmentEnd
  }

  return []
}

function parseExifData(bytes: Uint8Array): MetadataField[] {
  if (bytes.length < 8) {
    return []
  }

  const byteOrder = readAscii(bytes, 0, 2)
  const littleEndian = byteOrder === 'II'

  if (byteOrder !== 'II' && byteOrder !== 'MM') {
    return []
  }

  if (readUint16(bytes, 2, littleEndian) !== 42) {
    return []
  }

  const ifdOffset = readUint32(bytes, 4, littleEndian)
  const rootIfd = parseIfd(bytes, ifdOffset, littleEndian, EXIF_IFD0_TAGS)
  const fields = [...rootIfd.fields]

  if (rootIfd.exifOffset !== null) {
    const exifIfd = parseIfd(
      bytes,
      rootIfd.exifOffset,
      littleEndian,
      EXIF_SUB_IFD_TAGS,
    )
    fields.push(...exifIfd.fields)
  }

  return normalizeMetadataFields(fields)
}

function parseIfd(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
  tagMap: Record<number, string>,
) {
  if (offset <= 0 || offset + 2 > bytes.length) {
    return { fields: [] as MetadataField[], exifOffset: null as number | null }
  }

  const entryCount = readUint16(bytes, offset, littleEndian)
  const fields: MetadataField[] = []
  let exifOffset: number | null = null
  let cursor = offset + 2

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 12 > bytes.length) {
      break
    }

    const tag = readUint16(bytes, cursor, littleEndian)
    const type = readUint16(bytes, cursor + 2, littleEndian)
    const count = readUint32(bytes, cursor + 4, littleEndian)

    if (tag === 0x8769) {
      exifOffset = readUint32(bytes, cursor + 8, littleEndian)
    } else if (tagMap[tag]) {
      const value = readExifValue(bytes, cursor, type, count, littleEndian)

      if (value) {
        fields.push({ key: tagMap[tag], value })
      }
    }

    cursor += 12
  }

  return { fields, exifOffset }
}

function readExifValue(
  bytes: Uint8Array,
  entryOffset: number,
  type: number,
  count: number,
  littleEndian: boolean,
) {
  const unitSize = getExifUnitSize(type)

  if (!unitSize) {
    return null
  }

  const totalSize = unitSize * count
  const valueOffset = entryOffset + 8
  const data =
    totalSize <= 4
      ? bytes.subarray(valueOffset, valueOffset + totalSize)
      : readExifDataSlice(bytes, readUint32(bytes, valueOffset, littleEndian), totalSize)

  if (!data) {
    return null
  }

  if (type === 2) {
    const value = decodeLatin1(data).replace(/\0+$/g, '').trim()
    return value || null
  }

  if (type === 7) {
    let payload = data
    const prefix = readAscii(payload, 0, Math.min(8, payload.length))

    if (prefix.startsWith('ASCII')) {
      payload = payload.subarray(8)
    }

    const value = decodeLatin1(payload).replace(/\0+$/g, '').trim()
    return value || null
  }

  return null
}

function readExifDataSlice(
  bytes: Uint8Array,
  offset: number,
  length: number,
) {
  if (offset < 0 || offset + length > bytes.length) {
    return null
  }

  return bytes.subarray(offset, offset + length)
}

function getExifUnitSize(type: number) {
  switch (type) {
    case 1:
    case 2:
    case 7:
      return 1
    case 3:
      return 2
    case 4:
      return 4
    case 5:
      return 8
    default:
      return 0
  }
}

function normalizeMetadataFields(fields: MetadataField[]) {
  const uniqueFields = new Map<string, string>()

  fields.forEach((field) => {
    const key = field.key.trim()
    const value = field.value.trim()

    if (!key || !value || value.length > 4000) {
      return
    }

    uniqueFields.set(key, value)
  })

  return Array.from(uniqueFields.entries()).map(([key, value]) => ({ key, value }))
}

function sanitizeKeyword(keyword: string, index: number) {
  const normalized = keyword.trim().replace(/\s+/g, ' ')
  const keywordChars = Array.from(normalized)
    .map((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code <= 255 ? character : '_'
    })
    .join('')
    .slice(0, 79)

  return keywordChars || `field-${index + 1}`
}

function buildITXtChunk(keyword: string, value: string) {
  const keywordBytes = encodeLatin1(keyword)
  const valueBytes = new TextEncoder().encode(value)
  const data = new Uint8Array(keywordBytes.length + 5 + valueBytes.length)
  let offset = 0

  data.set(keywordBytes, offset)
  offset += keywordBytes.length
  data[offset] = 0
  offset += 1
  data[offset] = 0
  offset += 1
  data[offset] = 0
  offset += 1
  data[offset] = 0
  offset += 1
  data[offset] = 0
  offset += 1
  data.set(valueBytes, offset)

  return buildPngChunk('iTXt', data)
}

function buildPngChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(12 + data.length)
  writeUint32(chunk, 0, data.length)

  for (let index = 0; index < 4; index += 1) {
    chunk[4 + index] = type.charCodeAt(index)
  }

  chunk.set(data, 8)
  const crc = crc32(chunk.subarray(4, 8 + data.length))
  writeUint32(chunk, 8 + data.length, crc)
  return chunk
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff

  bytes.forEach((byte) => {
    crc ^= byte

    for (let index = 0; index < 8; index += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  })

  return (crc ^ 0xffffffff) >>> 0
}

function writeUint32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian: boolean) {
  if (littleEndian) {
    return bytes[offset] | (bytes[offset + 1] << 8)
  }

  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readUint32(bytes: Uint8Array, offset: number, littleEndian = false) {
  if (littleEndian) {
    return (
      bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)
    ) >>> 0
  }

  return (
    (bytes[offset] * 0x1000000 +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]) >>>
    0
  )
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  const end = Math.min(offset + length, bytes.length)
  let result = ''

  for (let index = offset; index < end; index += 1) {
    result += String.fromCharCode(bytes[index])
  }

  return result
}

function decodeLatin1(bytes: Uint8Array) {
  let result = ''

  bytes.forEach((byte) => {
    result += String.fromCharCode(byte)
  })

  return result
}

function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes)
}

function encodeLatin1(value: string) {
  const bytes = new Uint8Array(value.length)

  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff
  }

  return bytes
}

function isPng(bytes: Uint8Array) {
  if (bytes.length < PNG_SIGNATURE.length) {
    return false
  }

  return PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

function isJpeg(bytes: Uint8Array) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8
}
