import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'
import type { ChangeEvent, DragEvent, PointerEvent } from 'react'
import './App.css'
import {
  DEFAULT_PALETTE,
  INITIAL_USER_PALETTE,
  MAX_IMAGE_DIMENSION,
  appendHistoryEntry,
  canvasToBlob,
  constrainRectToBounds,
  copyCanvasContents,
  drawBrushPreview,
  drawCropOverlay,
  drawMarqueeSelection,
  fitDimensionsToLimit,
  hitCropHandle,
  moveRectWithinBounds,
  normalizeRect,
  paintRect,
  paintStroke,
  pointInRect,
  updateCropRect,
} from './lib/editor'
import type { CropHandle, EditorRect, PaintMode, Tool } from './lib/editor'
import {
  extractMetadataFields,
  writeMetadataToPng,
} from './lib/metadata'
import type { MetadataField } from './lib/metadata'

type StatusTone = 'info' | 'success' | 'error'

type StatusState = {
  tone: StatusTone
  message: string
}

type ImageMeta = {
  name: string
  width: number
  height: number
  originalWidth: number
  originalHeight: number
  source: string
  scaledDown: boolean
}

type RectSelectionMode = 'new' | 'move'

type InteractionState =
  | { kind: 'idle' }
  | { kind: 'brush'; pointerId: number; lastX: number; lastY: number }
  | {
      kind: 'rect'
      pointerId: number
      mode: RectSelectionMode
      startX: number
      startY: number
      startRect: EditorRect
    }
  | {
      kind: 'crop'
      pointerId: number
      mode: CropHandle
      startX: number
      startY: number
      startRect: EditorRect
    }

type DecodedImage = ImageBitmap | HTMLImageElement
type SidebarTab = 'edit' | 'history' | 'metadata'

type EditableMetadataField = {
  id: string
  key: string
  value: string
}

type BrushPreviewPoint = {
  x: number
  y: number
}

type Theme = 'light' | 'dark'

type EditorLayer = {
  id: string
  name: string
  visible: boolean
  canvas: HTMLCanvasElement
}

type LayerInfo = Omit<EditorLayer, 'canvas'>

type HistoryEntry = {
  id: string
  label: string
  layers: EditorLayer[]
  imageMeta: ImageMeta
  activeLayerId: string
}

type HistoryItem = Pick<HistoryEntry, 'id' | 'label'>

const IDLE_INTERACTION: InteractionState = { kind: 'idle' }
const HISTORY_LIMIT = 20

function App() {
  const [activeTab, setActiveTab] = useState<SidebarTab>('edit')
  const [tool, setTool] = useState<Tool>('brush')
  const [paintMode, setPaintMode] = useState<PaintMode>('fill')
  const [brushSize, setBrushSize] = useState(22)
  const [mosaicPixelSize, setMosaicPixelSize] = useState(12)
  const [activeColor, setActiveColor] = useState('#0f172a')
  const [userPalette, setUserPalette] = useState(INITIAL_USER_PALETTE)
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null)
  const [status, setStatus] = useState<StatusState | null>({
    tone: 'info',
    message: '이미지를 붙여넣고 바로 가린 뒤 복사하세요.',
  })
  const [selectionRect, setSelectionRect] = useState<EditorRect | null>(null)
  const [cropDraft, setCropDraft] = useState<EditorRect | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [layers, setLayers] = useState<LayerInfo[]>([])
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [sourceMetadataFields, setSourceMetadataFields] = useState<
    EditableMetadataField[]
  >([])
  const [metadataFields, setMetadataFields] = useState<EditableMetadataField[]>([])
  const [supportsClipboardRead, setSupportsClipboardRead] = useState(false)
  const [supportsClipboardWrite, setSupportsClipboardWrite] = useState(false)
  const [modifierLabel, setModifierLabel] = useState('Ctrl')

  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const originalCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const interactionRef = useRef<InteractionState>(IDLE_INTERACTION)
  const brushPreviewRef = useRef<BrushPreviewPoint | null>(null)
  const layersRef = useRef<EditorLayer[]>([])
  const activeLayerIdRef = useRef<string | null>(null)
  const historyRef = useRef<HistoryEntry[]>([])
  const historyIndexRef = useRef(-1)
  const marqueePhaseRef = useRef(0)
  const drawFrameRef = useRef<number | null>(null)
  const compositeDirtyRef = useRef(true)

  const getOffscreenCanvas = (ref: typeof workCanvasRef) => {
    if (!ref.current) {
      ref.current = document.createElement('canvas')
    }

    return ref.current
  }

  const getUiScale = (canvas: HTMLCanvasElement) => {
    const bounds = canvas.getBoundingClientRect()

    if (!bounds.width) {
      return 1
    }

    return canvas.width / bounds.width
  }

  const setNotice = (tone: StatusTone, message: string) => {
    setStatus({ tone, message })
  }

  const syncLayers = (
    nextLayers: EditorLayer[],
    nextActiveLayerId = activeLayerIdRef.current,
  ) => {
    const resolvedActiveLayerId = nextLayers.some(
      (layer) => layer.id === nextActiveLayerId,
    )
      ? nextActiveLayerId
      : (nextLayers.at(-1)?.id ?? null)

    layersRef.current = nextLayers
    compositeDirtyRef.current = true
    activeLayerIdRef.current = resolvedActiveLayerId
    setLayers(
      nextLayers.map(({ id, name, visible }) => ({ id, name, visible })),
    )
    setActiveLayerId(resolvedActiveLayerId)
  }

  const getActiveLayer = () =>
    layersRef.current.find((layer) => layer.id === activeLayerIdRef.current) ?? null

  const prepareActiveLayerForEdit = () => {
    syncLayers(
      layersRef.current.map((layer) => {
        if (layer.id !== activeLayerIdRef.current) {
          return layer
        }

        const canvas = createCanvas(layer.canvas.width, layer.canvas.height)
        copyCanvasContents(layer.canvas, canvas)
        return { ...layer, canvas }
      }),
    )
  }

  const renderComposite = () => {
    const editorLayers = layersRef.current

    if (!editorLayers.length) {
      return null
    }

    const workCanvas = getOffscreenCanvas(workCanvasRef)
    const { width, height } = editorLayers[0].canvas

    if (
      !compositeDirtyRef.current &&
      workCanvas.width === width &&
      workCanvas.height === height
    ) {
      return workCanvas
    }

    if (workCanvas.width !== width || workCanvas.height !== height) {
      workCanvas.width = width
      workCanvas.height = height
    }

    const context = workCanvas.getContext('2d')

    if (!context) {
      return null
    }

    context.clearRect(0, 0, width, height)
    editorLayers.forEach((layer) => {
      if (layer.visible) {
        context.drawImage(layer.canvas, 0, 0)
      }
    })

    compositeDirtyRef.current = false

    return workCanvas
  }

  const redrawCanvas = () => {
    const displayCanvas = displayCanvasRef.current
    const workCanvas = renderComposite()

    if (!displayCanvas) {
      return
    }

    const context = displayCanvas.getContext('2d')

    if (!context) {
      return
    }

    if (!workCanvas) {
      displayCanvas.width = 1
      displayCanvas.height = 1
      context.clearRect(0, 0, displayCanvas.width, displayCanvas.height)
      return
    }

    const cropPadding =
      tool === 'crop'
        ? getCropPreviewPadding(workCanvas.width, workCanvas.height)
        : { x: 0, y: 0 }
    const displayWidth = workCanvas.width + cropPadding.x * 2
    const displayHeight = workCanvas.height + cropPadding.y * 2

    if (
      displayCanvas.width !== displayWidth ||
      displayCanvas.height !== displayHeight
    ) {
      displayCanvas.width = displayWidth
      displayCanvas.height = displayHeight
    }

    context.clearRect(0, 0, displayCanvas.width, displayCanvas.height)
    context.drawImage(workCanvas, cropPadding.x, cropPadding.y)

    const uiScale = getUiScale(displayCanvas)

    if (tool === 'brush' && brushPreviewRef.current) {
      drawBrushPreview(
        context,
        {
          mode: paintMode,
          color: activeColor,
          size: brushSize,
          point: brushPreviewRef.current,
        },
        uiScale,
      )
    }

    if (tool === 'rect' && selectionRect) {
      drawMarqueeSelection(
        context,
        selectionRect,
        marqueePhaseRef.current,
        uiScale,
      )
    }

    if (tool === 'crop' && cropDraft) {
      drawCropOverlay(
        context,
        {
          ...cropDraft,
          x: cropDraft.x + cropPadding.x,
          y: cropDraft.y + cropPadding.y,
        },
        displayCanvas.width,
        displayCanvas.height,
        uiScale,
      )
    }
  }

  const getEditorPoint = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = getCanvasPoint(event)

    if (tool !== 'crop' || !imageMeta) {
      return point
    }

    const padding = getCropPreviewPadding(imageMeta.width, imageMeta.height)
    return { x: point.x - padding.x, y: point.y - padding.y }
  }

  const requestCanvasRedraw = () => {
    if (drawFrameRef.current !== null) {
      return
    }

    drawFrameRef.current = window.requestAnimationFrame(() => {
      drawFrameRef.current = null
      redrawCanvas()
    })
  }

  const paintBrushSegment = (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ) => {
    const activeLayer = getActiveLayer()
    const context = activeLayer?.canvas.getContext('2d')

    if (!activeLayer || !context) {
      return
    }

    paintStroke(context, {
      mode: paintMode,
      color: activeColor,
      size: brushSize,
      mosaicPixelSize,
      mosaicSourceContext:
        paintMode === 'mosaic'
          ? workCanvasRef.current?.getContext('2d') ?? undefined
          : undefined,
      from: { x: fromX, y: fromY },
      to: { x: toX, y: toY },
    })
    compositeDirtyRef.current = true
  }

  const syncHistory = (entries: HistoryEntry[], index: number) => {
    historyRef.current = entries
    historyIndexRef.current = index
    setHistoryItems(entries.map(({ id, label }) => ({ id, label })))
    setHistoryIndex(index)
  }

  const captureHistoryEntry = (
    label: string,
    nextImageMeta = imageMeta,
  ): HistoryEntry | null => {
    if (!nextImageMeta || !activeLayerIdRef.current || !layersRef.current.length) {
      return null
    }

    return {
      id: createHistoryId(),
      label,
      layers: layersRef.current.map((layer) => ({ ...layer })),
      imageMeta: { ...nextImageMeta },
      activeLayerId: activeLayerIdRef.current,
    }
  }

  const resetHistory = (label: string, nextImageMeta: ImageMeta) => {
    const historyEntry = captureHistoryEntry(label, nextImageMeta)

    if (!historyEntry) {
      return
    }

    syncHistory([historyEntry], 0)
  }

  const commitHistory = (label: string, nextImageMeta = imageMeta) => {
    const historyEntry = captureHistoryEntry(label, nextImageMeta)

    if (!historyEntry) {
      return
    }

    const nextHistory = appendHistoryEntry(
      historyRef.current,
      historyIndexRef.current,
      historyEntry,
      HISTORY_LIMIT,
    )
    syncHistory(nextHistory.entries, nextHistory.index)
  }

  const restoreHistoryEntry = (historyEntry: HistoryEntry) => {
    syncLayers(
      historyEntry.layers.map((layer) => ({ ...layer })),
      historyEntry.activeLayerId,
    )
    interactionRef.current = IDLE_INTERACTION
    brushPreviewRef.current = null
    setSelectionRect(null)
    startTransition(() => {
      setImageMeta(historyEntry.imageMeta)
      setCropDraft(
        tool === 'crop'
          ? {
              x: 0,
              y: 0,
              width: historyEntry.imageMeta.width,
              height: historyEntry.imageMeta.height,
            }
          : null,
      )
    })
    redrawCanvas()
  }

  const jumpToHistory = (index: number, message?: string) => {
    const historyEntry = historyRef.current[index]

    if (!historyEntry || index === historyIndexRef.current) {
      return
    }

    historyIndexRef.current = index
    setHistoryIndex(index)
    restoreHistoryEntry(historyEntry)
    setNotice('success', message ?? `'${historyEntry.label}' 시점으로 이동했어요.`)
  }

  const undoLastChange = () => {
    jumpToHistory(historyIndexRef.current - 1, '이전 편집으로 되돌렸어요.')
  }

  const redoLastChange = () => {
    jumpToHistory(historyIndexRef.current + 1, '다시 실행했어요.')
  }

  const setBrushPreview = (point: BrushPreviewPoint | null) => {
    brushPreviewRef.current = point
    requestCanvasRedraw()
  }

  const applySelectionAction = (mode: PaintMode) => {
    prepareActiveLayerForEdit()
    const activeLayer = getActiveLayer()
    const context = activeLayer?.canvas.getContext('2d')

    if (!activeLayer || !context || !selectionRect) {
      return
    }

    paintRect(context, selectionRect, mode, activeColor)
    compositeDirtyRef.current = true
    redrawCanvas()
    commitHistory(
      mode === 'erase' ? '선택 영역 지우기' : '선택 영역 채우기',
    )
    setNotice(
      'success',
      mode === 'erase' ? '선택 영역을 지웠어요.' : '선택 영역을 채웠어요.',
    )
  }

  const clearSelection = () => {
    setSelectionRect(null)
    setNotice('info', '선택 영역을 해제했어요.')
  }

  const selectLayer = (id: string) => {
    activeLayerIdRef.current = id
    setActiveLayerId(id)
  }

  const addLayer = () => {
    if (!imageMeta) {
      return
    }

    const layer: EditorLayer = {
      id: createLayerId(),
      name: `편집 ${layersRef.current.length}`,
      visible: true,
      canvas: createCanvas(imageMeta.width, imageMeta.height),
    }
    syncLayers([...layersRef.current, layer], layer.id)
    redrawCanvas()
    commitHistory('레이어 추가')
    setNotice('success', '새 레이어를 추가했어요.')
  }

  const toggleLayerVisibility = (id: string) => {
    const currentLayer = layersRef.current.find((layer) => layer.id === id)

    if (!currentLayer) {
      return
    }

    syncLayers(
      layersRef.current.map((layer) =>
        layer.id === id ? { ...layer, visible: !layer.visible } : layer,
      ),
    )
    redrawCanvas()
    commitHistory(
      `${currentLayer.name} ${currentLayer.visible ? '숨기기' : '표시하기'}`,
    )
  }

  const moveLayer = (id: string, offset: -1 | 1) => {
    const currentIndex = layersRef.current.findIndex((layer) => layer.id === id)
    const nextIndex = currentIndex + offset

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= layersRef.current.length) {
      return
    }

    const nextLayers = [...layersRef.current]
    ;[nextLayers[currentIndex], nextLayers[nextIndex]] = [
      nextLayers[nextIndex],
      nextLayers[currentIndex],
    ]
    syncLayers(nextLayers)
    redrawCanvas()
    commitHistory('레이어 순서 변경')
  }

  const removeLayer = (id: string) => {
    if (layersRef.current.length <= 1) {
      return
    }

    const layerName =
      layersRef.current.find((layer) => layer.id === id)?.name ?? '레이어'
    syncLayers(layersRef.current.filter((layer) => layer.id !== id))
    redrawCanvas()
    commitHistory(`${layerName} 삭제`)
    setNotice('info', '레이어를 삭제했어요.')
  }

  const exportableMetadata = metadataFields
    .map((field) => ({
      key: field.key.trim(),
      value: field.value.trim(),
    }))
    .filter((field) => field.key)

  const exportEditedBlob = async () => {
    const workCanvas = renderComposite()

    if (!workCanvas) {
      throw new Error('No image loaded')
    }

    const pngBlob = await canvasToBlob(workCanvas)

    if (!exportableMetadata.length) {
      return pngBlob
    }

    return writeMetadataToPng(pngBlob, exportableMetadata)
  }

  const buildDownloadName = () => {
    const stamp = new Date()
      .toISOString()
      .replaceAll(':', '-')
      .replace(/\..+$/, '')

    return `simple-edit-${stamp}.png`
  }

  const triggerDownload = async (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = buildDownloadName()
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1200)
  }

  const copyEditedImage = async (origin: 'button' | 'shortcut') => {
    if (!imageMeta) {
      return
    }

    try {
      const blob = await exportEditedBlob()

      if (
        typeof navigator.clipboard?.write === 'function' &&
        typeof ClipboardItem !== 'undefined'
      ) {
        await navigator.clipboard.write([
          new ClipboardItem({
            [blob.type]: blob,
          }),
        ])

        setNotice('success', '편집 결과를 클립보드에 복사했어요.')
        return
      }

      if (origin === 'button') {
        await triggerDownload(blob)
        setNotice(
          'info',
          '이 브라우저는 이미지 클립보드 복사를 막아서 다운로드로 대신했어요.',
        )
        return
      }

      setNotice(
        'error',
        '이 브라우저는 단축키 이미지 복사를 막고 있어요. 복사 버튼이나 다운로드를 사용해 주세요.',
      )
    } catch (error) {
      console.error(error)
      setNotice('error', '이미지를 복사하지 못했어요.')
    }
  }

  const downloadEditedImage = async () => {
    if (!imageMeta) {
      return
    }

    try {
      const blob = await exportEditedBlob()
      await triggerDownload(blob)
      setNotice('success', 'PNG 파일을 저장했어요.')
    } catch (error) {
      console.error(error)
      setNotice('error', '다운로드 파일을 만들지 못했어요.')
    }
  }

  const applyCanvasRect = (rect: EditorRect, message: string) => {
    if (!imageMeta) {
      return
    }

    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    const offsetX = -Math.round(rect.x)
    const offsetY = -Math.round(rect.y)

    if (
      width < 1 ||
      height < 1 ||
      width > MAX_IMAGE_DIMENSION ||
      height > MAX_IMAGE_DIMENSION
    ) {
      setNotice(
        'error',
        `결과 크기는 각 변이 1~${MAX_IMAGE_DIMENSION}px 사이여야 해요.`,
      )
      return
    }

    const nextLayers = layersRef.current.map((layer) => {
      const canvas = createCanvas(width, height)
      const context = canvas.getContext('2d')

      if (!context) {
        throw new Error('Layer canvas context unavailable')
      }

      context.drawImage(layer.canvas, offsetX, offsetY)
      return { ...layer, canvas }
    })

    syncLayers(nextLayers)
    const nextImageMeta = { ...imageMeta, width, height }
    startTransition(() => {
      setImageMeta(nextImageMeta)
      setCropDraft({ x: 0, y: 0, width, height })
    })
    redrawCanvas()
    commitHistory('크롭', nextImageMeta)
    setNotice('success', message)
  }

  const applyCrop = () => {
    if (!cropDraft || !imageMeta) {
      return
    }

    applyCanvasRect(cropDraft, '크롭을 적용했어요.')
  }

  const cancelCrop = () => {
    setTool('brush')
    setCropDraft(null)
    setNotice('info', '크롭을 닫았어요.')
  }

  const resetEditor = () => {
    const originalCanvas = originalCanvasRef.current

    if (!originalCanvas || !imageMeta) {
      return
    }

    const initialLayers = createInitialLayers(originalCanvas)
    syncLayers(initialLayers.layers, initialLayers.activeLayerId)
    const nextImageMeta = {
      ...imageMeta,
      width: originalCanvas.width,
      height: originalCanvas.height,
    }

    startTransition(() => {
      setImageMeta(nextImageMeta)
      setSelectionRect(null)
      setCropDraft(
        tool === 'crop'
          ? {
              x: 0,
              y: 0,
              width: originalCanvas.width,
              height: originalCanvas.height,
            }
          : null,
      )
    })

    interactionRef.current = IDLE_INTERACTION
    redrawCanvas()
    commitHistory('처음 상태로 복원', nextImageMeta)
    setNotice('info', '처음 상태로 되돌렸어요.')
  }

  const openFilePicker = () => {
    fileInputRef.current?.click()
  }

  const addMetadataField = () => {
    setMetadataFields((currentFields) => [...currentFields, createMetadataField()])
  }

  const updateMetadataField = (
    id: string,
    fieldName: 'key' | 'value',
    nextValue: string,
  ) => {
    setMetadataFields((currentFields) =>
      currentFields.map((field) =>
        field.id === id ? { ...field, [fieldName]: nextValue } : field,
      ),
    )
  }

  const removeMetadataField = (id: string) => {
    setMetadataFields((currentFields) =>
      currentFields.filter((field) => field.id !== id),
    )
  }

  const clearMetadataFields = () => {
    setMetadataFields([])
    setNotice('info', '출력 메타데이터를 모두 비웠어요.')
  }

  const restoreMetadataFields = () => {
    setMetadataFields(cloneMetadataFields(sourceMetadataFields))
    setNotice('info', '원본 메타데이터로 되돌렸어요.')
  }

  const readClipboardImage = async () => {
    if (typeof navigator.clipboard?.read !== 'function') {
      return null
    }

    const items = await navigator.clipboard.read()

    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'))

      if (imageType) {
        return item.getType(imageType)
      }
    }

    return null
  }

  const handlePasteButton = async () => {
    try {
      const blob = await readClipboardImage()

      if (blob) {
        await loadIncomingImage(blob, '클립보드')
        return
      }

      openFilePicker()
      setNotice('info', '클립보드 이미지를 찾지 못해서 파일 열기로 전환했어요.')
    } catch (error) {
      console.error(error)
      openFilePicker()
      setNotice('info', '이 브라우저에서는 버튼 붙여넣기가 막혀 있어요. 파일로 열어주세요.')
    }
  }

  const extractImageFile = (fileList: FileList | File[]) =>
    Array.from(fileList).find((file) => file.type.startsWith('image/')) ?? null

  const isEditableTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))

  const loadIncomingImage = async (blob: Blob, sourceLabel: string) => {
    if (!blob.type.startsWith('image/')) {
      setNotice('error', '이미지 파일만 열 수 있어요.')
      return
    }

    let decodedImage: DecodedImage | null = null

    try {
      const extractedMetadata = await extractMetadataFields(blob)
      decodedImage = await decodeImageBlob(blob)
      const { width: naturalWidth, height: naturalHeight } =
        getDecodedImageSize(decodedImage)
      const { width, height, scaled } = fitDimensionsToLimit(
        naturalWidth,
        naturalHeight,
      )

      const originalCanvas = getOffscreenCanvas(originalCanvasRef)
      const originalContext = originalCanvas.getContext('2d')

      if (!originalContext) {
        throw new Error('Original canvas context unavailable')
      }

      originalCanvas.width = width
      originalCanvas.height = height
      originalContext.clearRect(0, 0, width, height)
      originalContext.imageSmoothingEnabled = true
      originalContext.imageSmoothingQuality = 'high'
      originalContext.drawImage(decodedImage, 0, 0, width, height)

      const initialLayers = createInitialLayers(originalCanvas)
      syncLayers(initialLayers.layers, initialLayers.activeLayerId)
      const editableMetadata = toEditableMetadataFields(extractedMetadata)
      const nextImageMeta: ImageMeta = {
        name: blob instanceof File && blob.name ? blob.name : sourceLabel,
        source: sourceLabel,
        width,
        height,
        originalWidth: naturalWidth,
        originalHeight: naturalHeight,
        scaledDown: scaled,
      }
      brushPreviewRef.current = null
      resetHistory('이미지 열기', nextImageMeta)

      startTransition(() => {
        setTool('brush')
        setPaintMode('fill')
        setSelectionRect(null)
        setCropDraft(null)
        setSourceMetadataFields(editableMetadata)
        setMetadataFields(cloneMetadataFields(editableMetadata))
        setImageMeta(nextImageMeta)
      })

      redrawCanvas()
      setNotice(
        'success',
        scaled
          ? `이미지를 불러왔어요. ${MAX_IMAGE_DIMENSION}px 이하로 최적화했습니다.`
          : '이미지를 불러왔어요.',
      )
    } catch (error) {
      console.error(error)
      setNotice(
        'error',
        '이미지를 열지 못했어요. PNG, JPG, WEBP 같은 일반 이미지로 다시 시도해 주세요.',
      )
    } finally {
      disposeDecodedImage(decodedImage)
    }
  }

  useEffect(() => {
    const platform = navigator.platform || navigator.userAgent

    setModifierLabel(/Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘' : 'Ctrl')
    setSupportsClipboardRead(typeof navigator.clipboard?.read === 'function')
    setSupportsClipboardWrite(
      typeof navigator.clipboard?.write === 'function' &&
        typeof ClipboardItem !== 'undefined',
    )
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('simple-edit-theme', theme)
  }, [theme])

  useEffect(
    () => () => {
      if (drawFrameRef.current !== null) {
        window.cancelAnimationFrame(drawFrameRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (!status) {
      return
    }

    const timeout = window.setTimeout(() => setStatus(null), 3200)
    return () => window.clearTimeout(timeout)
  }, [status])

  const drawLatestCanvas = useEffectEvent(() => {
    redrawCanvas()
  })

  useEffect(() => {
    drawLatestCanvas()
  }, [
    activeColor,
    cropDraft,
    imageMeta,
    paintMode,
    selectionRect,
    tool,
  ])

  const onWindowResize = useEffectEvent(() => {
    redrawCanvas()
  })

  useEffect(() => {
    const handleResize = () => onWindowResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (displayCanvasRef.current) {
      displayCanvasRef.current.style.cursor = ''
    }

    if (!imageMeta) {
      setSelectionRect(null)
      setCropDraft(null)
      brushPreviewRef.current = null
      return
    }

    if (tool === 'crop') {
      setCropDraft({
        x: 0,
        y: 0,
        width: imageMeta.width,
        height: imageMeta.height,
      })
    } else {
      setCropDraft(null)
    }

    if (tool !== 'rect') {
      setSelectionRect(null)
    }

    if (tool !== 'brush') {
      brushPreviewRef.current = null
    }
  }, [imageMeta, tool])

  const animateSelectionCanvas = useEffectEvent((time: number) => {
    marqueePhaseRef.current = (time / 55) % 16
    redrawCanvas()
  })

  useEffect(() => {
    if (tool !== 'rect' || !selectionRect) {
      marqueePhaseRef.current = 0
      return
    }

    let frame = 0
    const animate = (time: number) => {
      animateSelectionCanvas(time)
      frame = window.requestAnimationFrame(animate)
    }
    frame = window.requestAnimationFrame(animate)

    return () => window.cancelAnimationFrame(frame)
  }, [selectionRect, tool])

  const onGlobalPaste = useEffectEvent((event: ClipboardEvent) => {
    if (isEditableTarget(event.target)) {
      return
    }

    const clipboardData = event.clipboardData

    if (!clipboardData) {
      return
    }

    const imageFile =
      Array.from(clipboardData.items)
        .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
        ?.getAsFile() ?? null

    if (!imageFile) {
      return
    }

    event.preventDefault()
    void loadIncomingImage(imageFile, '클립보드')
  })

  const onGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (isEditableTarget(event.target)) {
      return
    }

    const key = event.key.toLowerCase()
    const hasTextSelection = Boolean(window.getSelection()?.toString())

    if (
      (event.metaKey || event.ctrlKey) &&
      key === 'c' &&
      imageMeta &&
      !hasTextSelection
    ) {
      event.preventDefault()
      void copyEditedImage('shortcut')
      return
    }

    if (
      (event.metaKey || event.ctrlKey) &&
      imageMeta &&
      (key === 'y' || (key === 'z' && event.shiftKey))
    ) {
      event.preventDefault()
      redoLastChange()
      return
    }

    if (
      (event.metaKey || event.ctrlKey) &&
      key === 'z' &&
      !event.shiftKey &&
      imageMeta
    ) {
      event.preventDefault()
      undoLastChange()
      return
    }

    if (tool === 'crop' && cropDraft) {
      if (event.key === 'Enter') {
        event.preventDefault()
        applyCrop()
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        cancelCrop()
        return
      }
    }

    if (tool === 'rect' && selectionRect) {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        applySelectionAction('erase')
      }

      if ((event.metaKey || event.ctrlKey) && key === 'd') {
        event.preventDefault()
        clearSelection()
      }
    }
  })

  useEffect(() => {
    const pasteListener = (event: ClipboardEvent) => onGlobalPaste(event)
    const keyListener = (event: KeyboardEvent) => onGlobalKeyDown(event)

    window.addEventListener('paste', pasteListener)
    window.addEventListener('keydown', keyListener)

    return () => {
      window.removeEventListener('paste', pasteListener)
      window.removeEventListener('keydown', keyListener)
    }
  }, [])

  const rememberColor = () => {
    setUserPalette((currentPalette) => {
      const normalized = activeColor.toLowerCase()
      return [
        normalized,
        ...currentPalette.filter((entry) => entry.toLowerCase() !== normalized),
      ].slice(0, 8)
    })
    setNotice('success', '현재 색을 팔레트에 저장했어요.')
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]

    if (file) {
      void loadIncomingImage(file, '파일')
    }

    event.target.value = ''
  }

  const handleCanvasPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!imageMeta) {
      return
    }

    event.preventDefault()
    const point = getEditorPoint(event)
    event.currentTarget.setPointerCapture(event.pointerId)

    if (tool === 'brush') {
      prepareActiveLayerForEdit()
      setBrushPreview(point)
      paintBrushSegment(point.x, point.y, point.x, point.y)
      interactionRef.current = {
        kind: 'brush',
        pointerId: event.pointerId,
        lastX: point.x,
        lastY: point.y,
      }
      requestCanvasRedraw()
      return
    }

    if (tool === 'rect') {
      const currentSelection = selectionRect
      const mode: RectSelectionMode =
        currentSelection && pointInRect(point.x, point.y, currentSelection)
          ? 'move'
          : 'new'
      const startRect: EditorRect =
        mode === 'move' && currentSelection
          ? currentSelection
          : constrainRectToBounds(
              normalizeRect(point.x, point.y, point.x + 1, point.y + 1),
              imageMeta.width,
              imageMeta.height,
            )

      interactionRef.current = {
        kind: 'rect',
        pointerId: event.pointerId,
        mode,
        startX: point.x,
        startY: point.y,
        startRect,
      }

      setSelectionRect(startRect)
      return
    }

    const currentCrop =
      cropDraft ??
      ({
        x: 0,
        y: 0,
        width: imageMeta.width,
        height: imageMeta.height,
      } satisfies EditorRect)
    const uiScale = getUiScale(event.currentTarget)
    const mode = hitCropHandle(point.x, point.y, currentCrop, 28 * uiScale) ?? 'new'
    event.currentTarget.style.cursor = getCropCursor(mode)
    const startRect =
      mode === 'new'
        ? { x: point.x, y: point.y, width: 1, height: 1 }
        : currentCrop

    interactionRef.current = {
      kind: 'crop',
      pointerId: event.pointerId,
      mode,
      startX: point.x,
      startY: point.y,
      startRect,
    }

    if (mode === 'new') {
      setCropDraft(startRect)
    }
  }

  const handleCanvasPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = getEditorPoint(event)

    if (tool === 'brush') {
      brushPreviewRef.current = point
    }

    const activeInteraction = interactionRef.current

    if (tool === 'crop' && cropDraft && activeInteraction.kind === 'idle') {
      const uiScale = getUiScale(event.currentTarget)
      event.currentTarget.style.cursor = getCropCursor(
        hitCropHandle(point.x, point.y, cropDraft, 28 * uiScale),
      )
    }

    if (
      activeInteraction.kind === 'idle' ||
      activeInteraction.pointerId !== event.pointerId
    ) {
      if (tool === 'brush') {
        requestCanvasRedraw()
      }
      return
    }

    event.preventDefault()

    if (activeInteraction.kind === 'brush') {
      let lastX = activeInteraction.lastX
      let lastY = activeInteraction.lastY
      const pointerEvents = event.nativeEvent.getCoalescedEvents?.() ?? [
        event.nativeEvent,
      ]

      pointerEvents.forEach((pointerEvent) => {
        const nextPoint = getCanvasPointFromClient(
          event.currentTarget,
          pointerEvent.clientX,
          pointerEvent.clientY,
        )
        paintBrushSegment(lastX, lastY, nextPoint.x, nextPoint.y)
        lastX = nextPoint.x
        lastY = nextPoint.y
      })
      interactionRef.current = {
        ...activeInteraction,
        lastX,
        lastY,
      }
      requestCanvasRedraw()
      return
    }

    if (activeInteraction.kind === 'rect' && imageMeta) {
      if (activeInteraction.mode === 'move') {
        setSelectionRect(
          moveRectWithinBounds(
            activeInteraction.startRect,
            point.x - activeInteraction.startX,
            point.y - activeInteraction.startY,
            imageMeta.width,
            imageMeta.height,
          ),
        )
        return
      }

      setSelectionRect(
        constrainRectToBounds(
          normalizeRect(
            activeInteraction.startX,
            activeInteraction.startY,
            point.x,
            point.y,
          ),
          imageMeta.width,
          imageMeta.height,
        ),
      )
      return
    }

    if (activeInteraction.kind === 'crop' && imageMeta) {
      setCropDraft(
        updateCropRect(
          activeInteraction.mode,
          activeInteraction.startRect,
          activeInteraction.startX,
          activeInteraction.startY,
          point.x,
          point.y,
          imageMeta.width,
          imageMeta.height,
          true,
        ),
      )
    }
  }

  const finishPointerInteraction = (event: PointerEvent<HTMLCanvasElement>) => {
    const activeInteraction = interactionRef.current

    if (
      activeInteraction.kind === 'idle' ||
      activeInteraction.pointerId !== event.pointerId
    ) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const point = getEditorPoint(event)

    if (activeInteraction.kind === 'brush') {
      paintBrushSegment(
        activeInteraction.lastX,
        activeInteraction.lastY,
        point.x,
        point.y,
      )
      brushPreviewRef.current = point
      requestCanvasRedraw()
      commitHistory(
        paintMode === 'mosaic'
          ? '모자이크'
          : paintMode === 'erase'
            ? '지우기'
            : '칠하기',
      )
    }

    if (activeInteraction.kind === 'rect' && imageMeta) {
      const nextSelection =
        activeInteraction.mode === 'move'
          ? moveRectWithinBounds(
              activeInteraction.startRect,
              point.x - activeInteraction.startX,
              point.y - activeInteraction.startY,
              imageMeta.width,
              imageMeta.height,
            )
          : constrainRectToBounds(
              normalizeRect(
                activeInteraction.startX,
                activeInteraction.startY,
                point.x,
                point.y,
              ),
              imageMeta.width,
              imageMeta.height,
            )

      if (nextSelection.width < 1 || nextSelection.height < 1) {
        setSelectionRect(null)
      } else {
        setSelectionRect(nextSelection)
      }
    }

    if (activeInteraction.kind === 'crop' && imageMeta) {
      setCropDraft(
        updateCropRect(
          activeInteraction.mode,
          activeInteraction.startRect,
          activeInteraction.startX,
          activeInteraction.startY,
          point.x,
          point.y,
          imageMeta.width,
          imageMeta.height,
          true,
        ),
      )
    }

    interactionRef.current = IDLE_INTERACTION
  }

  const cancelPointerInteraction = (event: PointerEvent<HTMLCanvasElement>) => {
    const activeInteraction = interactionRef.current

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    interactionRef.current = IDLE_INTERACTION
    if (activeInteraction.kind === 'brush') {
      commitHistory(
        paintMode === 'mosaic'
          ? '모자이크'
          : paintMode === 'erase'
            ? '지우기'
            : '칠하기',
      )
    }
    requestCanvasRedraw()
  }

  const handleCanvasPointerLeave = () => {
    if (interactionRef.current.kind === 'idle') {
      brushPreviewRef.current = null
      requestCanvasRedraw()
    }
  }

  const handleStageDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDropActive(false)

    const imageFile = extractImageFile(event.dataTransfer.files)

    if (!imageFile) {
      setNotice('error', '이미지 파일을 찾지 못했어요.')
      return
    }

    void loadIncomingImage(imageFile, '드롭')
  }

  const handleStageDragOver = (event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const handleStageDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return
    }

    setDropActive(false)
  }

  const toolHint =
    tool === 'crop'
      ? '핸들을 이미지 밖으로 끌어 캔버스를 늘릴 수 있어요.'
      : tool === 'rect'
        ? '드래그로 선택한 뒤 채우거나 지우세요.'
        : paintMode === 'mosaic'
          ? '브러시로 필요한 부분만 모자이크할 수 있어요.'
        : paintMode === 'erase'
          ? '브러시로 바로 지울 수 있어요.'
          : '브러시로 바로 칠할 수 있어요.'

  const undoCount = Math.max(historyIndex, 0)
  const redoCount = Math.max(historyItems.length - historyIndex - 1, 0)

  return (
    <div className="app-shell">
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
        onChange={handleFileChange}
      />

      <main className="workspace">
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="sidebar-head__main">
              <div>
                <p className="brand-label">Simple Edit</p>
                <h1>빠르게 가리고 복사</h1>
              </div>
              <div className="head-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={theme === 'dark' ? '라이트 모드 켜기' : '다크 모드 켜기'}
                  title={theme === 'dark' ? '라이트 모드' : '다크 모드'}
                  onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d={
                        theme === 'dark'
                          ? 'M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42M7.06 16.94l-1.42 1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'
                          : 'M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z'
                      }
                    />
                  </svg>
                </button>
                <a
                  className="icon-button"
                  href="https://github.com/Craft374/simple_edit"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="GitHub 저장소 열기"
                  title="GitHub"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="currentColor"
                      stroke="none"
                      d="M12 1.25a10.75 10.75 0 0 0-3.4 20.95c.54.1.73-.23.73-.52 0-.25-.01-1.08-.02-1.96-2.98.65-3.6-1.26-3.6-1.26-.48-1.22-1.18-1.54-1.18-1.54-.97-.66.08-.65.08-.65 1.07.08 1.63 1.1 1.63 1.1.96 1.63 2.5 1.16 3.11.89.1-.69.38-1.17.68-1.44-2.38-.27-4.88-1.19-4.88-5.29 0-1.17.42-2.12 1.1-2.87-.11-.27-.48-1.37.11-2.86 0 0 .9-.29 2.95 1.1A10.2 10.2 0 0 1 12 6.42c.91 0 1.82.12 2.68.35 2.05-1.39 2.95-1.1 2.95-1.1.59 1.49.22 2.59.11 2.86.68.75 1.1 1.7 1.1 2.87 0 4.11-2.5 5.01-4.89 5.28.39.34.73 1 .73 2.03 0 1.47-.01 2.66-.01 3.02 0 .29.19.63.74.52A10.75 10.75 0 0 0 12 1.25Z"
                    />
                  </svg>
                </a>
              </div>
            </div>
            <p className="meta-line">
              {imageMeta
                ? `${imageMeta.width} x ${imageMeta.height}px`
                : 'Clipboard / File / Drop'}
            </p>
          </div>

          <section className="panel action-panel">
            <div className="action-grid">
              <button
                  type="button"
                  className="action-button primary"
                  onClick={handlePasteButton}
              >
                붙여넣기
              </button>
              <button type="button" className="action-button" onClick={openFilePicker}>
                파일 열기
              </button>
              <button
                type="button"
                className="action-button"
                onClick={() => void copyEditedImage('button')}
                disabled={!imageMeta}
              >
                복사
              </button>
              <button
                type="button"
                className="action-button"
                onClick={undoLastChange}
                disabled={!undoCount}
              >
                실행 취소{undoCount ? ` ${undoCount}` : ''}
              </button>
              <button
                type="button"
                className="action-button"
                onClick={redoLastChange}
                disabled={!redoCount}
              >
                다시 실행{redoCount ? ` ${redoCount}` : ''}
              </button>
              <button
                type="button"
                className="action-button"
                onClick={() => void downloadEditedImage()}
                disabled={!imageMeta}
              >
                다운로드
              </button>
            </div>
          </section>

          <div className="tab-row">
            <button
              type="button"
              className={activeTab === 'edit' ? 'tab-button active' : 'tab-button'}
              onClick={() => setActiveTab('edit')}
            >
              편집
            </button>
            <button
              type="button"
              className={
                activeTab === 'history' ? 'tab-button active' : 'tab-button'
              }
              onClick={() => setActiveTab('history')}
            >
              히스토리
            </button>
            <button
              type="button"
              className={activeTab === 'metadata' ? 'tab-button active' : 'tab-button'}
              onClick={() => setActiveTab('metadata')}
            >
              메타데이터
            </button>
          </div>

          {activeTab === 'edit' ? (
            <>
              <section className="panel">
                <div className="panel-head">
                  <p className="panel-title">도구</p>
                  <span>{toolHint}</span>
                </div>

                <div className="tool-grid">
                  <button
                    type="button"
                    className={tool === 'brush' ? 'tool-chip active' : 'tool-chip'}
                    onClick={() => setTool('brush')}
                  >
                    펜
                  </button>
                  <button
                    type="button"
                    className={tool === 'rect' ? 'tool-chip active' : 'tool-chip'}
                    onClick={() => setTool('rect')}
                  >
                    사각형 선택
                  </button>
                  <button
                    type="button"
                    className={tool === 'crop' ? 'tool-chip active' : 'tool-chip'}
                    onClick={() => setTool('crop')}
                  >
                    크롭
                  </button>
                </div>

                {tool === 'brush' && (
                  <div className="stack">
                    <div className="mode-toggle mode-toggle--brush">
                      <button
                        type="button"
                        className={
                          paintMode === 'fill' ? 'mode-button active' : 'mode-button'
                        }
                        onClick={() => setPaintMode('fill')}
                      >
                        칠하기
                      </button>
                      <button
                        type="button"
                        className={
                          paintMode === 'erase' ? 'mode-button active' : 'mode-button'
                        }
                        onClick={() => setPaintMode('erase')}
                      >
                        지우기
                      </button>
                      <button
                        type="button"
                        className={
                          paintMode === 'mosaic' ? 'mode-button active' : 'mode-button'
                        }
                        onClick={() => setPaintMode('mosaic')}
                      >
                        모자이크
                      </button>
                    </div>

                    <label className="slider-row">
                      <span>브러시</span>
                      <strong>{brushSize}px</strong>
                    </label>
                    <input
                      className="slider"
                      type="range"
                      min="4"
                      max="120"
                      step="1"
                      value={brushSize}
                      onChange={(event) => setBrushSize(Number(event.target.value))}
                    />

                    {paintMode === 'mosaic' && (
                      <>
                        <label className="slider-row">
                          <span>픽셀 크기</span>
                          <strong>{mosaicPixelSize}px</strong>
                        </label>
                        <input
                          className="slider"
                          type="range"
                          min="2"
                          max="64"
                          step="1"
                          value={mosaicPixelSize}
                          onChange={(event) =>
                            setMosaicPixelSize(Number(event.target.value))
                          }
                        />
                      </>
                    )}
                  </div>
                )}

                {tool === 'rect' && (
                  <div className="stack">
                    <div className="selection-grid">
                      <button
                        type="button"
                        className="mode-button"
                        onClick={() => applySelectionAction('fill')}
                        disabled={!selectionRect}
                      >
                        선택 채우기
                      </button>
                      <button
                        type="button"
                        className="mode-button"
                        onClick={() => applySelectionAction('erase')}
                        disabled={!selectionRect}
                      >
                        선택 지우기
                      </button>
                      <button
                        type="button"
                        className="mode-button"
                        onClick={clearSelection}
                        disabled={!selectionRect}
                      >
                        선택 해제
                      </button>
                    </div>

                    <p className="helper-line">
                      포토샵 사각형 선택처럼 드래그해서 영역을 잡고, 안쪽을 다시
                      드래그하면 선택을 옮길 수 있어요.
                    </p>
                  </div>
                )}

                {tool === 'crop' && imageMeta && (
                  <div className="stack">
                    <div className="mode-toggle mode-toggle--large">
                      <button
                        type="button"
                        className="mode-button mode-button--large active"
                        onClick={applyCrop}
                      >
                        크롭 적용
                      </button>
                      <button
                        type="button"
                        className="mode-button mode-button--large"
                        onClick={cancelCrop}
                      >
                        취소
                      </button>
                    </div>
                    <p className="helper-line">
                      포토샵처럼 핸들을 이미지 밖으로 끌면 투명 영역이 늘어납니다.
                      {' '}<strong>Enter</strong>로 적용할 수 있어요.
                    </p>
                  </div>
                )}
              </section>

              <section className="panel">
                <div className="panel-head">
                  <p className="panel-title">레이어</p>
                  <button
                    type="button"
                    className="text-button text-button--accent"
                    onClick={addLayer}
                    disabled={!imageMeta}
                  >
                    + 추가
                  </button>
                </div>

                {layers.length ? (
                  <div className="layer-list">
                    {[...layers].reverse().map((layer) => {
                      const layerIndex = layers.findIndex(
                        (entry) => entry.id === layer.id,
                      )

                      return (
                        <div
                          key={layer.id}
                          className={
                            activeLayerId === layer.id
                              ? 'layer-row active'
                              : 'layer-row'
                          }
                        >
                          <button
                            type="button"
                            className="layer-visibility"
                            aria-label={
                              layer.visible
                                ? `${layer.name} 숨기기`
                                : `${layer.name} 표시하기`
                            }
                            title={layer.visible ? '숨기기' : '표시하기'}
                            onClick={() => toggleLayerVisibility(layer.id)}
                          >
                            {layer.visible ? '●' : '○'}
                          </button>
                          <button
                            type="button"
                            className="layer-name"
                            onClick={() => selectLayer(layer.id)}
                          >
                            {layer.name}
                          </button>
                          <div className="layer-actions">
                            <button
                              type="button"
                              aria-label={`${layer.name} 위로 이동`}
                              title="위로"
                              onClick={() => moveLayer(layer.id, 1)}
                              disabled={layerIndex === layers.length - 1}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              aria-label={`${layer.name} 아래로 이동`}
                              title="아래로"
                              onClick={() => moveLayer(layer.id, -1)}
                              disabled={layerIndex === 0}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              aria-label={`${layer.name} 삭제`}
                              title="삭제"
                              onClick={() => removeLayer(layer.id)}
                              disabled={layers.length <= 1}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="helper-line">이미지를 열면 레이어가 표시됩니다.</p>
                )}
              </section>

              <section className="panel">
                <div className="panel-head">
                  <p className="panel-title">색상</p>
                  <span>{activeColor.toUpperCase()}</span>
                </div>

                <div className="palette-group">
                  <p className="palette-label">기본</p>
                  <div className="swatch-row">
                    {DEFAULT_PALETTE.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={`${color} 선택`}
                        className={
                          activeColor.toLowerCase() === color.toLowerCase()
                            ? 'swatch active'
                            : 'swatch'
                        }
                        style={{ backgroundColor: color }}
                        onClick={() => setActiveColor(color)}
                      />
                    ))}
                  </div>
                </div>

                <div className="palette-group">
                  <p className="palette-label">내 팔레트</p>
                  <div className="swatch-row">
                    {userPalette.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={`${color} 선택`}
                        className={
                          activeColor.toLowerCase() === color.toLowerCase()
                            ? 'swatch active'
                            : 'swatch'
                        }
                        style={{ backgroundColor: color }}
                        onClick={() => setActiveColor(color)}
                      />
                    ))}
                  </div>
                </div>

                <div className="color-editor">
                  <label className="color-picker">
                    <span>직접 선택</span>
                    <input
                      type="color"
                      value={activeColor}
                      onChange={(event) => setActiveColor(event.target.value)}
                    />
                  </label>
                  <button type="button" className="mode-button" onClick={rememberColor}>
                    저장
                  </button>
                </div>
              </section>

              <section className="panel panel--muted">
                <p>{modifierLabel}+V 붙여넣기</p>
                <p>{modifierLabel}+C 결과 복사</p>
                <p>{modifierLabel}+Z 되돌리기</p>
                <p>{modifierLabel}+Shift+Z 다시 실행</p>
                <p>Delete 선택 지우기</p>
                <p>
                  {supportsClipboardRead && supportsClipboardWrite
                    ? '클립보드 직접 연동 가능'
                    : '일부 환경에서는 파일 열기/다운로드로 자동 전환'}
                </p>
                <button
                  type="button"
                  className="text-button"
                  onClick={resetEditor}
                  disabled={!imageMeta}
                >
                  처음 상태로 되돌리기
                </button>
              </section>
            </>
          ) : activeTab === 'history' ? (
            <>
              <section className="panel">
                <div className="panel-head">
                  <p className="panel-title">히스토리</p>
                  <span>
                    {historyItems.length ? `${historyIndex + 1}/${historyItems.length}` : '기록 없음'}
                  </span>
                </div>

                {historyItems.length ? (
                  <div className="history-list">
                    {historyItems.map((item, index) => (
                      <button
                        key={item.id}
                        type="button"
                        className={
                          index === historyIndex
                            ? 'history-item active'
                            : index > historyIndex
                              ? 'history-item future'
                              : 'history-item'
                        }
                        onClick={() => jumpToHistory(index)}
                      >
                        <span className="history-step">{index + 1}</span>
                        <span className="history-label">{item.label}</span>
                        {index === historyIndex && (
                          <span className="history-current">현재</span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="metadata-empty">
                    이미지를 열고 편집하면 작업 기록이 여기에 쌓입니다.
                  </div>
                )}
              </section>

              <section className="panel panel--muted">
                <p>항목을 누르면 해당 작업 시점으로 바로 이동합니다.</p>
                <p>과거 시점에서 새로 편집하면 이후 기록은 교체됩니다.</p>
              </section>
            </>
          ) : (
            <>
              <section className="panel">
                <div className="panel-head">
                  <p className="panel-title">메타데이터</p>
                  <span>
                    {metadataFields.length
                      ? `${metadataFields.length}개 필드`
                      : '감지된 항목 없음'}
                  </span>
                </div>

                <div className="stack">
                  <div className="selection-grid metadata-actions">
                    <button
                      type="button"
                      className="mode-button mode-button--large"
                      onClick={addMetadataField}
                    >
                      필드 추가
                    </button>
                    <button
                      type="button"
                      className="mode-button mode-button--large"
                      onClick={restoreMetadataFields}
                      disabled={!sourceMetadataFields.length}
                    >
                      원본 복원
                    </button>
                    <button
                      type="button"
                      className="mode-button mode-button--large"
                      onClick={clearMetadataFields}
                      disabled={!metadataFields.length}
                    >
                      모두 삭제
                    </button>
                  </div>

                  <p className="helper-line">
                    출력은 PNG 기준으로 저장되며, 여기를 비워두면 메타데이터 없이
                    복사/다운로드됩니다.
                  </p>

                  {metadataFields.length ? (
                    <div className="metadata-list">
                      {metadataFields.map((field) => (
                        <div key={field.id} className="metadata-item">
                          <input
                            className="metadata-input metadata-input--key"
                            type="text"
                            value={field.key}
                            onChange={(event) =>
                              updateMetadataField(field.id, 'key', event.target.value)
                            }
                            placeholder="키 예: Software"
                          />
                          <textarea
                            className="metadata-input metadata-input--value"
                            value={field.value}
                            onChange={(event) =>
                              updateMetadataField(field.id, 'value', event.target.value)
                            }
                            rows={3}
                            placeholder="값"
                          />
                          <button
                            type="button"
                            className="text-button metadata-remove"
                            onClick={() => removeMetadataField(field.id)}
                          >
                            삭제
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="metadata-empty">
                      감지된 메타데이터가 없습니다. 직접 필드를 추가하거나, 이 상태로
                      출력하면 메타데이터 없이 나갑니다.
                    </div>
                  )}
                </div>
              </section>

              <section className="panel panel--muted">
                <p>원본에 PNG 텍스트/일부 JPEG EXIF가 있으면 읽어서 표시합니다.</p>
                <p>수정한 항목은 복사/다운로드 시 출력 PNG에 반영됩니다.</p>
                <p>모두 삭제하면 메타데이터 없는 결과물로 내보냅니다.</p>
              </section>
            </>
          )}
        </aside>

        <section className="stage-column">
          <div
            className={dropActive ? 'canvas-shell canvas-shell--drop' : 'canvas-shell'}
            onDragOver={handleStageDragOver}
            onDragLeave={handleStageDragLeave}
            onDrop={handleStageDrop}
          >
            {imageMeta ? (
              <>
                <canvas
                  ref={displayCanvasRef}
                  className="editor-canvas"
                  data-tool={tool}
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={finishPointerInteraction}
                  onPointerCancel={cancelPointerInteraction}
                  onPointerLeave={handleCanvasPointerLeave}
                />

                <div className="canvas-hud canvas-hud--top">
                  <span>{tool === 'rect' ? '사각형 선택' : tool === 'crop' ? '크롭' : '브러시'}</span>
                  <span>
                    {layers.find((layer) => layer.id === activeLayerId)?.name ??
                      '레이어 없음'}
                  </span>
                  {tool === 'rect' && selectionRect && (
                    <span>
                      {Math.round(selectionRect.width)} x {Math.round(selectionRect.height)}
                    </span>
                  )}
                  {tool === 'crop' && cropDraft && (
                    <span>
                      {Math.round(cropDraft.width)} x {Math.round(cropDraft.height)}
                    </span>
                  )}
                  {imageMeta.scaledDown && <span>최적화됨</span>}
                </div>

                <div className="canvas-hud canvas-hud--bottom">
                  <span>{toolHint}</span>
                </div>
              </>
            ) : (
              <div className="empty-state">
                <p className="empty-state__eyebrow">Simple Edit</p>
                <h2>붙여넣고 바로 가리기</h2>
                <p>
                  복잡한 설명 없이 클립보드 이미지나 파일을 넣고 바로 손보는 용도로
                  맞췄어요.
                </p>
                <div className="empty-actions">
                  <button
                    type="button"
                    className="action-button primary"
                    onClick={handlePasteButton}
                  >
                    붙여넣기
                  </button>
                  <button type="button" className="action-button" onClick={openFilePicker}>
                    파일 열기
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>

      {status && (
        <div className={`notice-banner notice-banner--${status.tone}`} role="status">
          {status.message}
        </div>
      )}
    </div>
  )
}

function getCanvasPoint(event: PointerEvent<HTMLCanvasElement>) {
  return getCanvasPointFromClient(
    event.currentTarget,
    event.clientX,
    event.clientY,
  )
}

function getCanvasPointFromClient(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
) {
  const bounds = canvas.getBoundingClientRect()
  const scaleX = canvas.width / bounds.width
  const scaleY = canvas.height / bounds.height

  return {
    x: clamp((clientX - bounds.left) * scaleX, 0, canvas.width),
    y: clamp((clientY - bounds.top) * scaleY, 0, canvas.height),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getCropPreviewPadding(width: number, height: number) {
  const getPadding = (dimension: number) =>
    Math.round(
      Math.min(
        420,
        Math.max(72, dimension * 0.22),
        Math.max(0, MAX_IMAGE_DIMENSION - dimension),
      ),
    )

  return { x: getPadding(width), y: getPadding(height) }
}

function getCropCursor(handle: CropHandle | null) {
  if (handle === 'n' || handle === 's') return 'ns-resize'
  if (handle === 'e' || handle === 'w') return 'ew-resize'
  if (handle === 'ne' || handle === 'sw') return 'nesw-resize'
  if (handle === 'nw' || handle === 'se') return 'nwse-resize'
  return handle === 'move' ? 'move' : 'crosshair'
}

async function decodeImageBlob(blob: Blob): Promise<DecodedImage> {
  if ('createImageBitmap' in window) {
    return createImageBitmap(blob)
  }

  const objectUrl = URL.createObjectURL(blob)

  try {
    const image = new Image()
    image.src = objectUrl

    if (typeof image.decode === 'function') {
      await image.decode()
    } else {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('Image decode failed'))
      })
    }

    return image
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function getDecodedImageSize(image: DecodedImage) {
  if (image instanceof HTMLImageElement) {
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
    }
  }

  return {
    width: image.width,
    height: image.height,
  }
}

function disposeDecodedImage(image: DecodedImage | null) {
  if (image && 'close' in image) {
    image.close()
  }
}

function createMetadataField(
  key = '',
  value = '',
): EditableMetadataField {
  return {
    id: createMetadataId(),
    key,
    value,
  }
}

function createMetadataId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `metadata-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toEditableMetadataFields(fields: MetadataField[]) {
  return fields.map((field) => createMetadataField(field.key, field.value))
}

function cloneMetadataFields(fields: EditableMetadataField[]) {
  return fields.map((field) => createMetadataField(field.key, field.value))
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function createInitialLayers(sourceCanvas: HTMLCanvasElement) {
  const originalLayer: EditorLayer = {
    id: createLayerId(),
    name: '원본',
    visible: true,
    canvas: createCanvas(sourceCanvas.width, sourceCanvas.height),
  }
  copyCanvasContents(sourceCanvas, originalLayer.canvas)

  const editLayer: EditorLayer = {
    id: createLayerId(),
    name: '편집 1',
    visible: true,
    canvas: createCanvas(sourceCanvas.width, sourceCanvas.height),
  }

  return {
    layers: [originalLayer, editLayer],
    activeLayerId: editLayer.id,
  }
}

function createLayerId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `layer-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createHistoryId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `history-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getInitialTheme(): Theme {
  const savedTheme = window.localStorage.getItem('simple-edit-theme')

  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export default App
