import test from 'node:test'
import assert from 'node:assert/strict'
import { recordingErrorMessage } from '../src/recording-errors.js'

test('microphone rejection provides actionable guidance without treating it as a save conflict', () => {
  const message = recordingErrorMessage({ name: 'NotAllowedError', message: 'Permission denied' })
  assert.match(message, /麦克风访问被拒绝/)
  assert.match(message, /系统设置/)
  assert.match(message, /上传音频/)
  assert.doesNotMatch(message, /另存副本|重新载入/)
})
test('missing and busy microphone have distinct guidance', () => {
  assert.match(recordingErrorMessage({ name: 'NotFoundError' }), /没有找到/)
  assert.match(recordingErrorMessage({ name: 'NotReadableError' }), /占用/)
})
