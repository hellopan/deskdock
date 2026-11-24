'use strict'

/* Interruptible animations never own application state. */
window.glassUI = (() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const pending = new WeakMap()
  function cancel(node) {
    const old = pending.get(node)
    if (old) { pending.delete(node); old.cancel() }
  }
  function animate(node, frames, options, done) {
    cancel(node)
    if (reduced.matches) { if (done) done(); return }
    const animation = node.animate(frames, options)
    pending.set(node, animation)
    animation.finished.then(() => {
      if (pending.get(node) !== animation) return
      pending.delete(node)
      if (done) done()
    }).catch(() => {})
  }
  function closeDialog(mask, modal, done) {
    if (mask.hidden || pending.has(mask)) return
    animate(mask, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' }, done)
    animate(modal, [{ transform: 'none' }, { transform: 'translateY(8px) scale(.97)' }], { duration: 160, easing: 'ease-out' })
  }
  function openDialog(mask, modal) { cancel(mask); cancel(modal) }
  function reveal(node, direction = 1) {
    animate(node, [{ opacity: 0, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' })
  }
  function capsule(container, selector) {
    const selected = container.querySelector(selector)
    if (!selected) return
    container.style.setProperty('--selection-x', `${selected.offsetLeft}px`)
    container.style.setProperty('--selection-w', `${selected.offsetWidth}px`)
    container.style.setProperty('--selection-y', `${selected.offsetTop}px`)
    container.style.setProperty('--selection-h', `${selected.offsetHeight}px`)
    container.classList.add('has-selection')
  }
  return { closeDialog, openDialog, reveal, capsule, animate, cancel }
})()
