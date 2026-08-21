export type Tool = 'brush' | 'rect' | 'crop'
export type PaintMode = 'fill' | 'erase' | 'mosaic'

export type EditorRect = {
  x: number
  y: number
  width: number
  height: number
}

export type CropHandle =
  | 'new'
  | 'move'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w'
  | 'nw'

type StrokeOptions = {
  mode: PaintMode
  color: string
  size: number
  mosaicPixelSize?: number
  mosaicSourceContext?: CanvasRenderingContext2D
  from: { x: number; y: number }
  to: { x: number; y: number }
}

type BrushPreviewOptions = {
  mode: PaintMode
  color: string
  size: number
  point: { x: number; y: number }
}

export const MAX_IMAGE_DIMENSION = 4096
export const MIN_CROP_SIZE = 24

export const DEFAULT_PALETTE = [
  '#0f172a',
  '#f8fafc',
  '#ef4444',
  '#f59e0b',
  '#22c55e',
  '#38bdf8',
  '#a855f7',
  '#111827',
]

export const INITIAL_USER_PALETTE = [
  '#0f172a',
  '#f8fafc',
  '#ef4444',
  '#38bdf8',
  '#22c55e',
]

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function normalizeRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): EditorRect {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  }
}

export function pointInRect(x: number, y: number, rect: EditorRect) {
  return (
    x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height
  )
}

export function sanitizeRect(
  rect: EditorRect,
  boundsWidth: number,
  boundsHeight: number,
): EditorRect {
  const minWidth = Math.min(MIN_CROP_SIZE, boundsWidth)
  const minHeight = Math.min(MIN_CROP_SIZE, boundsHeight)
  const width = clamp(rect.width, minWidth, boundsWidth)
  const height = clamp(rect.height, minHeight, boundsHeight)

  return {
    x: clamp(rect.x, 0, boundsWidth - width),
    y: clamp(rect.y, 0, boundsHeight - height),
    width,
    height,
  }
}

export function constrainRectToBounds(
  rect: EditorRect,
  boundsWidth: number,
  boundsHeight: number,
): EditorRect {
  const x = clamp(rect.x, 0, boundsWidth)
  const y = clamp(rect.y, 0, boundsHeight)

  return {
    x,
    y,
    width: clamp(rect.width, 0, boundsWidth - x),
    height: clamp(rect.height, 0, boundsHeight - y),
  }
}

export function moveRectWithinBounds(
  rect: EditorRect,
  deltaX: number,
  deltaY: number,
  boundsWidth: number,
  boundsHeight: number,
): EditorRect {
  return {
    ...rect,
    x: clamp(rect.x + deltaX, 0, boundsWidth - rect.width),
    y: clamp(rect.y + deltaY, 0, boundsHeight - rect.height),
  }
}

export function fitDimensionsToLimit(
  width: number,
  height: number,
  limit = MAX_IMAGE_DIMENSION,
) {
  if (Math.max(width, height) <= limit) {
    return { width, height, scaled: false }
  }

  const ratio = limit / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  }
}

export function appendHistoryEntry<T>(
  entries: T[],
  index: number,
  entry: T,
  limit: number,
) {
  const nextEntries = [...entries.slice(0, index + 1), entry].slice(-limit)
  return { entries: nextEntries, index: nextEntries.length - 1 }
}

export function copyCanvasContents(
  sourceCanvas: HTMLCanvasElement,
  targetCanvas: HTMLCanvasElement,
) {
  if (
    targetCanvas.width !== sourceCanvas.width ||
    targetCanvas.height !== sourceCanvas.height
  ) {
    targetCanvas.width = sourceCanvas.width
    targetCanvas.height = sourceCanvas.height
  }

  const targetContext = targetCanvas.getContext('2d')

  if (!targetContext) {
    throw new Error('Target canvas context unavailable')
  }

  targetContext.clearRect(0, 0, targetCanvas.width, targetCanvas.height)
  targetContext.drawImage(sourceCanvas, 0, 0)
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = 'image/png',
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
        return
      }

      reject(new Error('Canvas export failed'))
    }, type)
  })
}

export function hitCropHandle(
  x: number,
  y: number,
  rect: EditorRect,
  hitSize: number,
): CropHandle | null {
  const half = hitSize / 2
  const handlePoints: Array<{ handle: CropHandle; x: number; y: number }> = [
    { handle: 'nw', x: rect.x, y: rect.y },
    { handle: 'n', x: rect.x + rect.width / 2, y: rect.y },
    { handle: 'ne', x: rect.x + rect.width, y: rect.y },
    { handle: 'e', x: rect.x + rect.width, y: rect.y + rect.height / 2 },
    {
      handle: 'se',
      x: rect.x + rect.width,
      y: rect.y + rect.height,
    },
    { handle: 's', x: rect.x + rect.width / 2, y: rect.y + rect.height },
    { handle: 'sw', x: rect.x, y: rect.y + rect.height },
    { handle: 'w', x: rect.x, y: rect.y + rect.height / 2 },
  ]

  for (const handlePoint of handlePoints) {
    if (
      Math.abs(x - handlePoint.x) <= half &&
      Math.abs(y - handlePoint.y) <= half
    ) {
      return handlePoint.handle
    }
  }

  if (pointInRect(x, y, rect)) {
    return 'move'
  }

  return null
}

export function updateCropRect(
  mode: CropHandle,
  startRect: EditorRect,
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  boundsWidth: number,
  boundsHeight: number,
  allowOutside = false,
): EditorRect {
  const minWidth = Math.min(MIN_CROP_SIZE, boundsWidth)
  const minHeight = Math.min(MIN_CROP_SIZE, boundsHeight)

  if (allowOutside) {
    if (mode === 'new') {
      const rect = normalizeRect(startX, startY, currentX, currentY)
      return {
        ...rect,
        width: clamp(rect.width, minWidth, MAX_IMAGE_DIMENSION),
        height: clamp(rect.height, minHeight, MAX_IMAGE_DIMENSION),
      }
    }

    if (mode === 'move') {
      return {
        ...startRect,
        x: startRect.x + (currentX - startX),
        y: startRect.y + (currentY - startY),
      }
    }

    let left = startRect.x
    let top = startRect.y
    let right = startRect.x + startRect.width
    let bottom = startRect.y + startRect.height

    if (mode.includes('w')) {
      left = clamp(
        startRect.x + (currentX - startX),
        right - MAX_IMAGE_DIMENSION,
        right - minWidth,
      )
    }

    if (mode.includes('e')) {
      right = clamp(
        startRect.x + startRect.width + (currentX - startX),
        left + minWidth,
        left + MAX_IMAGE_DIMENSION,
      )
    }

    if (mode.includes('n')) {
      top = clamp(
        startRect.y + (currentY - startY),
        bottom - MAX_IMAGE_DIMENSION,
        bottom - minHeight,
      )
    }

    if (mode.includes('s')) {
      bottom = clamp(
        startRect.y + startRect.height + (currentY - startY),
        top + minHeight,
        top + MAX_IMAGE_DIMENSION,
      )
    }

    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  if (mode === 'new') {
    return sanitizeRect(
      normalizeRect(startX, startY, currentX, currentY),
      boundsWidth,
      boundsHeight,
    )
  }

  if (mode === 'move') {
    return {
      ...startRect,
      x: clamp(startRect.x + (currentX - startX), 0, boundsWidth - startRect.width),
      y: clamp(
        startRect.y + (currentY - startY),
        0,
        boundsHeight - startRect.height,
      ),
    }
  }

  let left = startRect.x
  let top = startRect.y
  let right = startRect.x + startRect.width
  let bottom = startRect.y + startRect.height

  if (mode.includes('w')) {
    left = clamp(startRect.x + (currentX - startX), 0, right - minWidth)
  }

  if (mode.includes('e')) {
    right = clamp(
      startRect.x + startRect.width + (currentX - startX),
      left + minWidth,
      boundsWidth,
    )
  }

  if (mode.includes('n')) {
    top = clamp(startRect.y + (currentY - startY), 0, bottom - minHeight)
  }

  if (mode.includes('s')) {
    bottom = clamp(
      startRect.y + startRect.height + (currentY - startY),
      top + minHeight,
      boundsHeight,
    )
  }

  return sanitizeRect(
    {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    },
    boundsWidth,
    boundsHeight,
  )
}

export function paintStroke(context: CanvasRenderingContext2D, options: StrokeOptions) {
  if (options.mode === 'mosaic') {
    paintMosaicStroke(context, options)
    return
  }

  context.save()
  context.globalCompositeOperation =
    options.mode === 'erase' ? 'destination-out' : 'source-over'
  context.strokeStyle = options.mode === 'erase' ? '#000000' : options.color
  context.fillStyle = options.mode === 'erase' ? '#000000' : options.color
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = options.size

  if (options.from.x === options.to.x && options.from.y === options.to.y) {
    context.beginPath()
    context.arc(options.from.x, options.from.y, options.size / 2, 0, Math.PI * 2)
    context.fill()
  } else {
    context.beginPath()
    context.moveTo(options.from.x, options.from.y)
    context.lineTo(options.to.x, options.to.y)
    context.stroke()
  }

  context.restore()
}

function paintMosaicStroke(
  context: CanvasRenderingContext2D,
  options: StrokeOptions,
) {
  const blockSize = Math.max(
    2,
    Math.round(options.mosaicPixelSize ?? options.size / 6),
  )
  const radius = options.size / 2
  const left = Math.max(
    0,
    Math.floor((Math.min(options.from.x, options.to.x) - radius) / blockSize) *
      blockSize,
  )
  const top = Math.max(
    0,
    Math.floor((Math.min(options.from.y, options.to.y) - radius) / blockSize) *
      blockSize,
  )
  const right = Math.min(
    context.canvas.width,
    Math.ceil((Math.max(options.from.x, options.to.x) + radius) / blockSize) *
      blockSize,
  )
  const bottom = Math.min(
    context.canvas.height,
    Math.ceil((Math.max(options.from.y, options.to.y) + radius) / blockSize) *
      blockSize,
  )

  if (right <= left || bottom <= top) {
    return
  }

  const imageData = context.getImageData(left, top, right - left, bottom - top)
  const source = new Uint8ClampedArray(
    (options.mosaicSourceContext ?? context).getImageData(
      left,
      top,
      right - left,
      bottom - top,
    ).data,
  )
  const segmentX = options.to.x - options.from.x
  const segmentY = options.to.y - options.from.y
  const segmentLengthSquared = segmentX ** 2 + segmentY ** 2
  const radiusSquared = radius ** 2

  for (let blockY = top; blockY < bottom; blockY += blockSize) {
    for (let blockX = left; blockX < right; blockX += blockSize) {
      const blockRight = Math.min(blockX + blockSize, right)
      const blockBottom = Math.min(blockY + blockSize, bottom)
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      let pixelCount = 0

      for (let y = blockY; y < blockBottom; y += 1) {
        for (let x = blockX; x < blockRight; x += 1) {
          const index = ((y - top) * imageData.width + x - left) * 4
          const pixelAlpha = source[index + 3]
          red += source[index] * pixelAlpha
          green += source[index + 1] * pixelAlpha
          blue += source[index + 2] * pixelAlpha
          alpha += pixelAlpha
          pixelCount += 1
        }
      }

      const averageRed = alpha ? Math.round(red / alpha) : 0
      const averageGreen = alpha ? Math.round(green / alpha) : 0
      const averageBlue = alpha ? Math.round(blue / alpha) : 0
      const averageAlpha = Math.round(alpha / pixelCount)

      for (let y = blockY; y < blockBottom; y += 1) {
        for (let x = blockX; x < blockRight; x += 1) {
          const pointX = x + 0.5
          const pointY = y + 0.5
          const progress = segmentLengthSquared
            ? clamp(
                ((pointX - options.from.x) * segmentX +
                  (pointY - options.from.y) * segmentY) /
                  segmentLengthSquared,
                0,
                1,
              )
            : 0
          const nearestX = options.from.x + segmentX * progress
          const nearestY = options.from.y + segmentY * progress

          if ((pointX - nearestX) ** 2 + (pointY - nearestY) ** 2 > radiusSquared) {
            continue
          }

          const index = ((y - top) * imageData.width + x - left) * 4
          imageData.data[index] = averageRed
          imageData.data[index + 1] = averageGreen
          imageData.data[index + 2] = averageBlue
          imageData.data[index + 3] = averageAlpha
        }
      }
    }
  }

  context.putImageData(imageData, left, top)
}

export function paintRect(
  context: CanvasRenderingContext2D,
  rect: EditorRect,
  mode: PaintMode,
  color: string,
) {
  context.save()

  if (mode === 'erase') {
    context.clearRect(rect.x, rect.y, rect.width, rect.height)
  } else {
    context.fillStyle = color
    context.fillRect(rect.x, rect.y, rect.width, rect.height)
  }

  context.restore()
}

export function drawMarqueeSelection(
  context: CanvasRenderingContext2D,
  rect: EditorRect,
  phase: number,
  uiScale = 1,
) {
  const lineWidth = Math.max(1.35 * uiScale, 1)
  const dashLength = 8 * uiScale
  const inset = lineWidth / 2
  const width = Math.max(rect.width - lineWidth, 0)
  const height = Math.max(rect.height - lineWidth, 0)

  context.save()
  context.fillStyle = 'rgba(103, 232, 249, 0.08)'
  context.fillRect(rect.x, rect.y, rect.width, rect.height)
  context.setLineDash([dashLength, dashLength])
  context.lineWidth = lineWidth
  context.lineDashOffset = -phase * uiScale * 2
  context.strokeStyle = 'rgba(255, 255, 255, 0.96)'
  context.strokeRect(rect.x + inset, rect.y + inset, width, height)
  context.lineDashOffset = -(phase * uiScale * 2 + dashLength)
  context.strokeStyle = 'rgba(7, 10, 17, 0.96)'
  context.strokeRect(rect.x + inset, rect.y + inset, width, height)
  context.restore()
}

export function drawBrushPreview(
  context: CanvasRenderingContext2D,
  options: BrushPreviewOptions,
  uiScale = 1,
) {
  const radius = Math.max(options.size / 2, 2)
  const lineWidth = Math.max(1.3 * uiScale, 1)
  const previewColor = options.mode === 'mosaic' ? '#67e8f9' : options.color

  context.save()
  context.beginPath()
  context.arc(options.point.x, options.point.y, radius, 0, Math.PI * 2)
  context.fillStyle =
    options.mode === 'erase'
      ? 'rgba(255, 255, 255, 0.06)'
      : toAlpha(previewColor, 0.16)
  context.fill()

  context.lineWidth = lineWidth
  context.strokeStyle = 'rgba(255, 255, 255, 0.98)'
  context.stroke()

  context.beginPath()
  context.arc(options.point.x, options.point.y, Math.max(radius - lineWidth * 1.8, 1), 0, Math.PI * 2)
  context.strokeStyle =
    options.mode === 'erase' ? 'rgba(7, 10, 17, 0.92)' : toAlpha(previewColor, 0.92)
  context.stroke()
  context.restore()
}

export function drawCropOverlay(
  context: CanvasRenderingContext2D,
  rect: EditorRect,
  canvasWidth: number,
  canvasHeight: number,
  uiScale = 1,
) {
  const borderWidth = Math.max(1.75 * uiScale, 1)
  const guideWidth = Math.max(uiScale, 1)
  const handleWidth = Math.max(2.75 * uiScale, 2)
  const cornerLength = Math.max(22 * uiScale, 14)
  const edgeLength = Math.max(16 * uiScale, 10)

  context.save()
  context.fillStyle = 'rgba(4, 8, 14, 0.62)'
  context.beginPath()
  context.rect(0, 0, canvasWidth, canvasHeight)
  context.rect(rect.x, rect.y, rect.width, rect.height)
  context.fill('evenodd')

  context.lineWidth = borderWidth
  context.strokeStyle = 'rgba(255, 255, 255, 0.96)'
  context.strokeRect(rect.x, rect.y, rect.width, rect.height)

  context.strokeStyle = 'rgba(255, 255, 255, 0.28)'
  context.lineWidth = guideWidth
  context.setLineDash([])

  for (let index = 1; index <= 2; index += 1) {
    const verticalX = rect.x + (rect.width / 3) * index
    const horizontalY = rect.y + (rect.height / 3) * index

    context.beginPath()
    context.moveTo(verticalX, rect.y)
    context.lineTo(verticalX, rect.y + rect.height)
    context.stroke()

    context.beginPath()
    context.moveTo(rect.x, horizontalY)
    context.lineTo(rect.x + rect.width, horizontalY)
    context.stroke()
  }

  context.strokeStyle = '#8be9fd'
  context.lineWidth = handleWidth
  context.lineCap = 'square'

  drawCornerHandle(context, rect.x, rect.y, cornerLength, 'nw')
  drawCornerHandle(context, rect.x + rect.width, rect.y, cornerLength, 'ne')
  drawCornerHandle(
    context,
    rect.x + rect.width,
    rect.y + rect.height,
    cornerLength,
    'se',
  )
  drawCornerHandle(context, rect.x, rect.y + rect.height, cornerLength, 'sw')

  const topMidX = rect.x + rect.width / 2
  const leftMidY = rect.y + rect.height / 2

  context.beginPath()
  context.moveTo(topMidX - edgeLength / 2, rect.y)
  context.lineTo(topMidX + edgeLength / 2, rect.y)
  context.stroke()

  context.beginPath()
  context.moveTo(topMidX - edgeLength / 2, rect.y + rect.height)
  context.lineTo(topMidX + edgeLength / 2, rect.y + rect.height)
  context.stroke()

  context.beginPath()
  context.moveTo(rect.x, leftMidY - edgeLength / 2)
  context.lineTo(rect.x, leftMidY + edgeLength / 2)
  context.stroke()

  context.beginPath()
  context.moveTo(rect.x + rect.width, leftMidY - edgeLength / 2)
  context.lineTo(rect.x + rect.width, leftMidY + edgeLength / 2)
  context.stroke()

  context.restore()
}

function drawCornerHandle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  length: number,
  corner: 'nw' | 'ne' | 'se' | 'sw',
) {
  context.beginPath()

  if (corner === 'nw') {
    context.moveTo(x, y + length)
    context.lineTo(x, y)
    context.lineTo(x + length, y)
  }

  if (corner === 'ne') {
    context.moveTo(x - length, y)
    context.lineTo(x, y)
    context.lineTo(x, y + length)
  }

  if (corner === 'se') {
    context.moveTo(x, y - length)
    context.lineTo(x, y)
    context.lineTo(x - length, y)
  }

  if (corner === 'sw') {
    context.moveTo(x + length, y)
    context.lineTo(x, y)
    context.lineTo(x, y - length)
  }

  context.stroke()
}

function toAlpha(color: string, alpha: number) {
  const hex = color.replace('#', '')

  if (hex.length !== 3 && hex.length !== 6) {
    return `rgba(103, 232, 249, ${alpha})`
  }

  const safeHex =
    hex.length === 3
      ? hex
          .split('')
          .map((character) => `${character}${character}`)
          .join('')
      : hex

  const red = Number.parseInt(safeHex.slice(0, 2), 16)
  const green = Number.parseInt(safeHex.slice(2, 4), 16)
  const blue = Number.parseInt(safeHex.slice(4, 6), 16)

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}
