/**
 * 相机偏移的收敛规则（纯函数，可单测）。
 *
 * 单独成模块的原因：它要能被单测直接导入 —— `boardApp.ts` 一被 import 就会拉起 PixiJS，
 * 在 node 环境里没有 `document`，跑不起来。相机行为里**唯一有分支逻辑**的就是这里，
 * 把它拎出来，就能在不碰渲染器的前提下把边界条件钉死。
 */

/**
 * 把一个轴的相机偏移收敛到"内容刚好铺满视口"的范围内。
 *
 * 为什么要收敛：`focusTiles` 的本意是"把目标区域摆到正中"。但目标区域经常**贴着地图边缘**
 * （部署区就在地图最上/最下那条），这时"居中"意味着镜头越过地图边界 ——
 * 结果是一大片空白 + 另一半地图被推出屏幕（实测：上方空 316px、底部超出 371px）。
 *
 * 规则：
 *  - 内容比视口**大** ⇒ 偏移量夹在 `[view - content, 0]`：贴边、不留空；
 *  - 内容比视口**小** ⇒ 居中（此时本来就没有"边缘"问题）；
 *  - 参数退化（非正数）⇒ 原样返回，绝不产生 NaN（渲染层拿到 NaN 会整块消失）。
 *
 * @param offset  目标偏移（未收敛）
 * @param view    视口尺寸（px）
 * @param content 内容缩放后的尺寸（px）
 */
export function clampCameraOffset(offset: number, view: number, content: number): number {
  if (!(view > 0) || !(content > 0) || !Number.isFinite(offset)) return offset
  if (content <= view) return (view - content) / 2
  return Math.min(0, Math.max(view - content, offset))
}
