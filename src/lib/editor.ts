export type Tool = 'brush' | 'rect' | 'crop'
export type PaintMode = 'fill' | 'erase'

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
  from: { x: number; y: number }
  to: { x: number; y: number }
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
): EditorRect {
  const minWidth = Math.min(MIN_CROP_SIZE, boundsWidth)
  const minHeight = Math.min(MIN_CROP_SIZE, boundsHeight)

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
