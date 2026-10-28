import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHubRoute } from '../hub.js'
test('route disposal is idempotent and preserves newer registrations', () => {
 const routes=[]; const old=()=>true; const fresh=()=>true
 const dispose=registerHubRoute(routes,'/api/yuan/',old)
 const disposeFresh=registerHubRoute(routes,'/api/yuan/',fresh)
 dispose(); dispose()
 assert.equal(routes.length,1); assert.equal(routes[0].handler,fresh)
 disposeFresh(); assert.deepEqual(routes,[])
})
