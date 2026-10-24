import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/native/macos/Preview.swift', import.meta.url), 'utf8')

test('programmatic native preview opening does not take the key window from another chat', () => {
  assert.ok(source.includes('window.center(); view.load(URLRequest(url: navigation.initial)); window.orderFront(nil)'))
  assert.equal(source.includes('window.makeKeyAndOrderFront(nil)'), false)
})

test('user can still activate native preview controls and keyboard input with the first click', () => {
  assert.ok(source.includes('.nonactivatingPanel]'))
  assert.ok(source.includes('override var canBecomeKey: Bool { true }'))
  assert.ok(source.includes('override var canBecomeMain: Bool { false }'))
  assert.ok(source.includes('override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }'))
  assert.equal(source.includes('ignoresMouseEvents = true'), false)
})
