import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendHistoryEntry,
  paintStroke,
  updateCropRect,
} from '../src/lib/editor.ts'

test('모자이크 브러시는 같은 블록의 색을 평균값으로 맞춘다', () => {
  const imageData = {
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      100, 0, 0, 255,
      200, 0, 0, 255,
      255, 0, 0, 255,
    ]),
    width: 4,
    height: 1,
  } as ImageData
  const context = {
    canvas: { width: 4, height: 1 },
    getImageData: () => imageData,
    putImageData: () => undefined,
  } as unknown as CanvasRenderingContext2D

  paintStroke(context, {
    mode: 'mosaic',
    color: '#000000',
    size: 4,
    mosaicPixelSize: 2,
    from: { x: 0, y: 0.5 },
    to: { x: 4, y: 0.5 },
  })

  assert.deepEqual(
    Array.from(imageData.data),
    [50, 0, 0, 255, 50, 0, 0, 255, 228, 0, 0, 255, 228, 0, 0, 255],
  )
})

test('크롭 핸들은 이미지 경계 밖으로 확장된다', () => {
  assert.deepEqual(
    updateCropRect(
      'se',
      { x: 0, y: 0, width: 100, height: 80 },
      100,
      80,
      140,
      110,
      100,
      80,
      true,
    ),
    { x: 0, y: 0, width: 140, height: 110 },
  )
})

test('과거 시점에서 편집하면 이후 히스토리를 교체한다', () => {
  assert.deepEqual(appendHistoryEntry(['열기', '칠하기', '크롭'], 0, '지우기', 30), {
    entries: ['열기', '지우기'],
    index: 1,
  })
})
