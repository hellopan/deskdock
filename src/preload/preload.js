'use strict'
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const EVENTS = ['state:changed', 'settings:changed', 'dock:visibility', 'dock:layout', 'settings:tab', 'ui:open-settings', 'ui:rename-item', 'ui:rename-cat', 'ui:color-cat', 'ui:toast']

contextBridge.exposeInMainWorld('dock', {
  /* 状态 */
  getState: () => ipcRenderer.invoke('app:state'),
  getIcon: (id) => ipcRenderer.invoke('icon:get', id),

  /* 条目 */
  openItem: (id) => ipcRenderer.invoke('item:open', id),
  revealItem: (id) => ipcRenderer.invoke('item:reveal', id),
  removeItem: (id, restore) => ipcRenderer.invoke('item:remove', id, restore),
  moveItem: (id, categoryId, index) => ipcRenderer.invoke('item:move', id, categoryId, index),
  renameItem: (id, name) => ipcRenderer.invoke('item:rename', id, name),
  addFiles: (paths, categoryId) => ipcRenderer.invoke('item:add-files', paths, categoryId),

  /* 分类 */
  addCategory: (name, color) => ipcRenderer.invoke('cat:add', name, color),
  renameCategory: (id, name) => ipcRenderer.invoke('cat:rename', id, name),
  deleteCategory: (id) => ipcRenderer.invoke('cat:delete', id),
  reorderCategories: (ids) => ipcRenderer.invoke('cat:reorder', ids),
  collapseCategory: (id, collapsed) => ipcRenderer.invoke('cat:collapse', id, collapsed),
  setCategoryColor: (id, color) => ipcRenderer.invoke('cat:color', id, color),

  /* 设置 */
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  setLogin: (enabled) => ipcRenderer.invoke('settings:login', enabled),
  loginState: () => ipcRenderer.invoke('settings:login-state'),
  openSettings: (tab) => ipcRenderer.invoke('settings:open', tab),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  setChrome: (theme) => ipcRenderer.invoke('settings:chrome', theme),

  /* 桌面导入 */
  scanDesktop: () => ipcRenderer.invoke('desktop:scan'),
  importFromDesktop: (paths, categoryId, move, keepOriginal) => ipcRenderer.invoke('desktop:import', paths, categoryId, move, keepOriginal),
  restoreAll: () => ipcRenderer.invoke('desktop:restore-all', 'yes'),

  /* 菜单 */
  itemMenu: (id) => ipcRenderer.invoke('menu:item', id),
  categoryMenu: (id) => ipcRenderer.invoke('menu:category', id),

  /* 窗口 */
  hide: () => ipcRenderer.invoke('sys:hide'),
  pin: (v) => ipcRenderer.invoke('sys:pin', v),
  quit: () => ipcRenderer.invoke('sys:quit'),
  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),
  closeWindow: () => ipcRenderer.invoke('win:close'),
  openDataDir: () => ipcRenderer.invoke('sys:open-data-dir'),
  openShortcutsDir: () => ipcRenderer.invoke('sys:open-shortcuts-dir'),
  openBackupDir: () => ipcRenderer.invoke('sys:open-backup-dir'),

  /* 数据安全 */
  backupData: () => ipcRenderer.invoke('data:backup'),
  listBackups: () => ipcRenderer.invoke('data:backups'),
  restoreBackup: (file) => ipcRenderer.invoke('data:restore', file),
  repairMissing: () => ipcRenderer.invoke('data:repair'),

  /* 沿边拖动 */
  dragStart: () => ipcRenderer.send('panel:drag-start'),
  dragMove: () => ipcRenderer.send('panel:drag-move'),
  dragEnd: () => ipcRenderer.send('panel:drag-end'),

  /* 从资源管理器拖入文件时取真实路径 */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },

  /* 事件订阅 */
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {}
    const fn = (_e, payload) => cb(payload)
    ipcRenderer.on(channel, fn)
    return () => ipcRenderer.removeListener(channel, fn)
  }
})
