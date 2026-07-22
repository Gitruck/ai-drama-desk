// 裁剪画布的纯数学层：全部以「原图自然像素」为坐标系，UI 层只做显示换算。
// 保持零依赖、无 DOM，供 bun test 直测。

export type Rect = { x: number; y: number; width: number; height: number };
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** 选框最小边长（自然像素） */
export const MIN_CROP_SIZE = 8;

/** 取整并钳制到图内：x/y ≥ 0、宽高 ≥ MIN（不超图幅）、右下缘不越界。 */
export function clampRect(rect: Rect, imageWidth: number, imageHeight: number): Rect {
  const minW = Math.min(MIN_CROP_SIZE, imageWidth);
  const minH = Math.min(MIN_CROP_SIZE, imageHeight);
  let width = Math.round(Math.min(Math.max(rect.width, minW), imageWidth));
  let height = Math.round(Math.min(Math.max(rect.height, minH), imageHeight));
  let x = Math.round(Math.min(Math.max(rect.x, 0), imageWidth - width));
  let y = Math.round(Math.min(Math.max(rect.y, 0), imageHeight - height));
  return { x, y, width, height };
}

/** 横向三等分预设（i = 0/1/2 → 左/中/右），全高。 */
export function thirdPreset(imageWidth: number, imageHeight: number, i: 0 | 1 | 2): Rect {
  const width = Math.round(imageWidth / 3);
  return clampRect({ x: Math.round((imageWidth * i) / 3), y: 0, width, height: imageHeight }, imageWidth, imageHeight);
}

/** 打开裁剪器时的智能预置：横排多视图（宽高比 ≥ 2.5）默认中 1/3，否则整图。 */
export function smartInitialRect(imageWidth: number, imageHeight: number): Rect | null {
  if (imageHeight > 0 && imageWidth / imageHeight >= 2.5) return thirdPreset(imageWidth, imageHeight, 1);
  return null;
}

/** 平移选框（方向键 / 框内拖动），自动钳制。 */
export function moveRect(rect: Rect, dx: number, dy: number, imageWidth: number, imageHeight: number): Rect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, imageWidth, imageHeight);
}

/** 从锚点拖出新选框（空白处按下拖拽），支持比例锁。 */
export function drawRect(
  anchor: { x: number; y: number },
  current: { x: number; y: number },
  imageWidth: number,
  imageHeight: number,
  ratio?: number | null,
): Rect {
  let width = Math.abs(current.x - anchor.x);
  let height = Math.abs(current.y - anchor.y);
  if (ratio && ratio > 0) {
    // 以拖得更远的轴为主轴，另一轴按比例跟随
    if (width / ratio >= height) height = width / ratio;
    else width = height * ratio;
  }
  const x = current.x >= anchor.x ? anchor.x : anchor.x - width;
  const y = current.y >= anchor.y ? anchor.y : anchor.y - height;
  return clampRect({ x, y, width, height }, imageWidth, imageHeight);
}

/**
 * 八向手柄缩放：dx/dy 为指针位移（自然像素）。
 * 比例锁下 e/w（含角）以宽为主轴、n/s 以高为主轴，锚定对侧边缘。
 */
export function resizeRect(
  rect: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
  ratio?: number | null,
): Rect {
  let { x, y, width, height } = rect;
  const right = x + width;
  const bottom = y + height;

  if (handle.includes("e")) width = rect.width + dx;
  if (handle.includes("w")) { x = rect.x + dx; width = rect.width - dx; }
  if (handle.includes("s")) height = rect.height + dy;
  if (handle.includes("n")) { y = rect.y + dy; height = rect.height - dy; }

  // 负宽高（拖过对侧）时翻转锚定
  if (width < 0) { x = x + width; width = -width; }
  if (height < 0) { y = y + height; height = -height; }

  if (ratio && ratio > 0) {
    // 角柄与 e/w 边柄以宽为主轴；纯 n/s 边柄以高为主轴
    const widthPrimary = handle.includes("e") || handle.includes("w");
    if (widthPrimary) {
      const nextHeight = width / ratio;
      if (handle.includes("n")) y = bottom - nextHeight;
      height = nextHeight;
    } else {
      const nextWidth = height * ratio;
      if (handle.includes("w")) x = right - nextWidth;
      width = nextWidth;
    }
  }
  return clampRect({ x, y, width, height }, imageWidth, imageHeight);
}

/** 自然像素矩形 → 百分比（用于覆盖层定位与数字联动显示） */
export function rectToPercent(rect: Rect, imageWidth: number, imageHeight: number): Rect {
  return {
    x: (rect.x / imageWidth) * 100,
    y: (rect.y / imageHeight) * 100,
    width: (rect.width / imageWidth) * 100,
    height: (rect.height / imageHeight) * 100,
  };
}

/** 显示坐标 → 自然像素坐标（scale = natural / rendered） */
export function displayToNatural(point: { x: number; y: number }, scaleX: number, scaleY: number): { x: number; y: number } {
  return { x: point.x * scaleX, y: point.y * scaleY };
}
