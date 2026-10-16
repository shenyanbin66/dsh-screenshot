/**
 * dsh-screenshot — 浏览器半（bundle client，side-effect 脚本）
 *
 * 与 dsh-pet 同构：脚本本身调用 window.__ModuleLoader__.load({id, factory})，
 * factory = (require) => module，module.exports = {name, inject, apply}。
 * factory 闭包持有 React（经 require('react') 取平台种子模块）。
 *
 * 职责：locale 字典 → input.left 截图按钮（fetch /screenshot/api/capture →
 * 合成 DragEvent drop 插入当前会话 composer）→ /screenshot/api/watch 长轮询
 * 常驻收**全局热键**结果（helper 已把图写进系统剪贴板，这里补插输入框）。
 *
 * 注：不再注册 ctx.shortcuts —— 全局热键由 helper 的 OS 级 globalShortcut
 * 接管（DSH 输入闸门拦不到它，设置面板开着也能触发），客户端再注册会双触发。
 */
(function () {
  'use strict'
  var NS = 'dsh-screenshot'
  var MODULE_ID = 'dsh-screenshot'
  var CAPTURE_PATH = '/screenshot/api/capture'
  var WATCH_PATH = '/screenshot/api/watch'

  var DICT = {
    zh: {
      buttonTitle: '截图（选择屏幕区域）',
      captureBusy: '截图进行中…',
      captureFailed: '截图失败',
      insertFailed: '图片已复制到剪贴板，但未能插入输入框',
    },
    en: {
      buttonTitle: 'Screenshot (pick a screen region)',
      captureBusy: 'Capture in progress…',
      captureFailed: 'Screenshot failed',
      insertFailed: 'Image copied to clipboard, but could not be inserted into the input box',
    },
  }

  if (typeof window === 'undefined' || !window.__ModuleLoader__ || typeof window.__ModuleLoader__.load !== 'function') {
    if (typeof console !== 'undefined') console.warn('[dsh-screenshot] __ModuleLoader__ unavailable; client half not loaded')
    return
  }

  function factory(require_) {
    var module_ = { exports: {} }
    var React = require_('react')

    var name = NS
    var inject = ['slots', 'locale']

    // -----------------------------------------------------------------------
    // 截图：fetch → JSON {ok,value} → drop 插入
    // -----------------------------------------------------------------------
    var state = { capturing: false }

    function decodeDataUrl(dataUrl) {
      var comma = dataUrl.indexOf(',')
      var header = dataUrl.slice(0, comma)
      var mimeMatch = /data:(.*?);/.exec(header)
      var mime = mimeMatch ? mimeMatch[1] : 'image/png'
      var binary = atob(dataUrl.slice(comma + 1))
      var bytes = new Uint8Array(binary.length)
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new File([bytes], 'screenshot-' + Date.now() + '.png', { type: mime })
    }

    function findComposerTarget() {
      var selectors = ['textarea', '[contenteditable="true"]', '[role="textbox"]']
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i])
        if (el) return el
      }
      return null
    }

    function insertIntoComposer(pngDataUrl) {
      var file
      try {
        file = decodeDataUrl(pngDataUrl)
      } catch (error) {
        console.warn('[dsh-screenshot] decode failed:', error)
        return false
      }
      var dt
      try {
        dt = new DataTransfer()
        dt.items.add(file)
      } catch (error) {
        console.warn('[dsh-screenshot] DataTransfer failed:', error)
        return false
      }
      var target = findComposerTarget()
      if (!target) return false
      // 先 dragenter/dragover 再 drop，模仿真实拖放的事件序列
      var eventInit = { bubbles: true, cancelable: true, dataTransfer: dt }
      try {
        target.dispatchEvent(new DragEvent('dragenter', eventInit))
        target.dispatchEvent(new DragEvent('dragover', eventInit))
        var drop = new DragEvent('drop', eventInit)
        target.dispatchEvent(drop)
        return drop.defaultPrevented || document.body.contains(target)
      } catch (error) {
        console.warn('[dsh-screenshot] drop dispatch failed:', error)
        return false
      }
    }

    function startCapture(t) {
      if (state.capturing) {
        console.info('[dsh-screenshot] ' + t('captureBusy'))
        return
      }
      state.capturing = true
      fetch(CAPTURE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
        .then(function (response) {
          return response.json().catch(function () { return null })
        })
        .then(function (body) {
          if (!body || body.ok !== true) {
            var message = body && body.error && body.error.message
            console.warn('[dsh-screenshot] ' + t('captureFailed'), message || body)
            return
          }
          var value = body.value || {}
          if (value.cancelled === true) return
          if (typeof value.png !== 'string') return
          // helper 已写入系统剪贴板；这里只负责插入输入框
          if (!insertIntoComposer(value.png)) {
            console.warn('[dsh-screenshot] ' + t('insertFailed'))
          }
        })
        .catch(function (error) {
          console.warn('[dsh-screenshot] ' + t('captureFailed'), error)
        })
        .finally(function () {
          state.capturing = false
        })
    }

    // -----------------------------------------------------------------------
    // 热键结果长轮询：helper 经宿主推送热键截图 → 这里持续挂 watch 收图 →
    // 插入当前会话输入框（helper 侧已写剪贴板）。值 null=长轮询到点续挂；
    // 有图/取消立即续挂（缓冲可能还有积压）；路由错误 3s 慢速重试。
    // -----------------------------------------------------------------------
    function startWatchLoop(t) {
      var poll = function () {
        fetch(WATCH_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then(function (response) {
            return response.json().catch(function () { return null })
          })
          .then(function (body) {
            if (body && body.ok === true && body.value) {
              var value = body.value
              if (value.cancelled !== true && typeof value.png === 'string') {
                if (!insertIntoComposer(value.png)) {
                  console.warn('[dsh-screenshot] ' + t('insertFailed'))
                }
              }
              setTimeout(poll, 0)
            } else if (body && body.ok === true) {
              poll()
            } else {
              setTimeout(poll, 3000)
            }
          })
          .catch(function () {
            setTimeout(poll, 3000)
          })
      }
      poll()
    }

    // -----------------------------------------------------------------------
    // apply：locale → 按钮插槽 → 热键结果 watch 长轮询
    // -----------------------------------------------------------------------
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, DICT)
      }, 'dsh-screenshot: dictionaries')
      var t = ctx.locale.bind(NS)

      function ShotButton() {
        return React.createElement(
          'button',
          {
            type: 'button',
            title: t('buttonTitle'),
            'aria-label': t('buttonTitle'),
            onClick: function () { startCapture(t) },
            style: {
              width: '26px',
              height: '26px',
              borderRadius: '6px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: '15px',
              lineHeight: '26px',
              padding: '0',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            },
          },
          '📷'
        )
      }

      ctx.effect(function () {
        return ctx.slots.inject('conversation.input.left', function () {
          return ctx.slots.register({
            name: 'conversation.input.left',
            id: 'dsh-screenshot',
            order: 200,
            label: function () { return t('buttonTitle') },
          }, function () { return React.createElement(ShotButton, null) })
        })
      }, 'dsh-screenshot: input.left button')

      // 热键结果长轮询（全局 Ctrl+Alt+X 在 helper 侧，客户端不再注册 shortcuts）
      startWatchLoop(t)

      console.info('[dsh-screenshot] client loaded')
    }

    module_.exports = { name: name, inject: inject, apply: apply }
    return module_.exports
  }

  window.__ModuleLoader__.load({ id: MODULE_ID, factory: factory })
})()
