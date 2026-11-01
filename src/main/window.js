export const MIN_WINDOW = { width: 1000, height: 700 };
export const MIN_BROWSER = { width: 1280, height: 800 };

/**
 * The size to use for a window or browser viewport: the free screen area, but never smaller than a
 * minimum. Some environments (a headless session, certain remote desktops) report an area of 1x1.
 */
export function usableSize(area, minimum = MIN_WINDOW) {
  const width = Number(area?.width);
  const height = Number(area?.height);
  return {
    width: Math.max(Number.isFinite(width) ? Math.round(width) : 0, minimum.width),
    height: Math.max(Number.isFinite(height) ? Math.round(height) : 0, minimum.height),
  };
}
