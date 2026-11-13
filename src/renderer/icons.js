/* ============================================================
   icons.js — 运行时创建的图标（唯一来源）
   只放 JS 动态注入的 SVG；index.html 里静态的顶栏图标留在原地，
   避免脚本注入带来的首帧空白。
   统一约定：viewBox 0 0 24 24、currentColor、aria-hidden。
   ============================================================ */

const ICON = {
  /* 拖拽手柄：两列三点 */
  grip: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
    '<circle cx="9" cy="7" r="1.4" fill="currentColor"/><circle cx="15" cy="7" r="1.4" fill="currentColor"/>' +
    '<circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/>' +
    '<circle cx="9" cy="17" r="1.4" fill="currentColor"/><circle cx="15" cy="17" r="1.4" fill="currentColor"/></svg>',

  /* 更多操作 */
  more: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
    '<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>' +
    '<circle cx="18" cy="12" r="1.6" fill="currentColor"/></svg>',

  /* 折叠指示：朝向由 .cat-toggle[aria-expanded] 的 rotate 决定 */
  chevron: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
    '<path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>'
}
