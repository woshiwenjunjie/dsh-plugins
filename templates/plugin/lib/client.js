/**
 * 骨架的浏览器半侧：往 shell.overlay 里放一个只读小徽标，验证「装上了、能渲染」。
 * 约束：普通副作用脚本，不能有顶层 import / export；模块由 factory 返回。
 */
;(function () {
  'use strict'

  // 三处身份必须是同一个字符串，而且**等于 package.json 的 name**（含 scope）：
  // 下面的 loader id、模块导出的 name、失败兜底模块的 name。
  // 改名时漏改这里，浏览器半侧会静默不加载——面板整个不出现，控制台也没有报错。
  var PKG_NAME = 'dsh-my-plugin'

  var LOADER = window.__ModuleLoader__
  if (!LOADER || typeof LOADER.load !== 'function') {
    console.error('[dsh-my-plugin] 页面没有注入 __ModuleLoader__')
    return
  }

  LOADER.load({
    id: PKG_NAME,
    factory: function (require) {
      var React
      try {
        React = require('react')
      } catch (error) {
        console.error('[dsh-my-plugin] react 不可用：', error)
      }
      if (!React || typeof React.createElement !== 'function') {
        return { name: 'dsh-my-plugin', inject: [], apply: function () {} }
      }

      var h = React.createElement
      var CSS = [
        '.dmp-badge{position:fixed;right:16px;bottom:16px;padding:6px 10px;border-radius:999px;',
        'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));',
        'background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);',
        'font:inherit;font-size:12px;pointer-events:auto}',
      ].join('')

      function Badge() {
        return h('div', { className: 'dmp-badge' }, 'dsh-my-plugin 已加载')
      }

      var name = 'dsh-my-plugin'
      var inject = ['slots']

      function apply(ctx) {
        ctx.effect(function () {
          var style = document.createElement('style')
          style.setAttribute('data-dsh-my-plugin', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return function () {
            style.remove()
          }
        }, 'dsh-my-plugin: styles')

        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({ name: 'shell.overlay', id: 'my-plugin-badge', order: 900 }, function () {
            return h(Badge, null)
          })
        })
      }

      return { name: name, inject: inject, apply: apply }
    },
  })
})()
