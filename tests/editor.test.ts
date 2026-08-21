import assert from 'node:assert/strict'
import test from 'node:test'
import { paintStroke } from '../src/lib/editor.ts'

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
    from: { x: 0, y: 0.5 },
    to: { x: 4, y: 0.5 },
  })

  assert.deepEqual(
    Array.from(imageData.data),
    [139, 0, 0, 255, 139, 0, 0, 255, 139, 0, 0, 255, 139, 0, 0, 255],
  )
})
