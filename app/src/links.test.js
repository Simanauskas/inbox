import { test as it, describe } from 'node:test'
import assert from 'node:assert/strict'
import { urlsIn, attachedPreview, usefulPreview, hostOf } from './links.js'

describe('link previews', () => {
  it('finds links without trailing punctuation', () => {
    assert.deepEqual(urlsIn('see https://example.lt/a). and http://x.com/b?c=1!'), ['https://example.lt/a', 'http://x.com/b?c=1'])
    assert.deepEqual(urlsIn('no links'), [])
  })
  it('uses the preview the bridge attached', () => {
    const c = { 'com.beeper.linkpreviews': [{ matched_url: 'https://a.lt/', 'og:title': 'A' }, { matched_url: 'https://b.lt/', 'og:title': 'B' }] }
    assert.equal(attachedPreview(c, 'https://b.lt/')['og:title'], 'B')
    assert.equal(attachedPreview(c, 'https://c.lt/'), null)
    assert.equal(attachedPreview({ 'com.beeper.linkpreviews': [{ 'og:title': 'Only' }] }, 'https://z.lt')['og:title'], 'Only')
  })
  it('skips previews that only repeat the domain', () => {
    assert.equal(usefulPreview({ 'og:title': 'files.example.com', 'og:description': '' }, 'https://files.example.com/x'), false)
    assert.equal(usefulPreview({ 'og:title': 'Shop', 'og:image': 'mxc://s/i' }, 'https://www.shop.lt'), true)
    assert.equal(usefulPreview(null, 'https://a.lt'), false)
    assert.equal(hostOf('https://www.shop.lt/p'), 'shop.lt')
  })
})
