/**
 * browser_download 的起名规则（不用浏览器）：Content-Disposition 解析、非法字符、补扩展名、重名加 (1)。
 *   node scratch/test-download.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dispositionName, safeName, pickName, uniquePath, humanSize } from '../plugin/download.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`✓ ${name}`) }

t('filename* 优先（UTF-8 中文）', () => {
  assert.equal(dispositionName(`attachment; filename="a.pdf"; filename*=UTF-8''%E5%8F%91%E7%A5%A8%202026.pdf`), '发票 2026.pdf')
})
t('只有 filename=，带引号和转义', () => {
  assert.equal(dispositionName('attachment; filename="say \\"hi\\".txt"'), 'say "hi".txt')
  assert.equal(dispositionName('attachment; filename=plain.csv'), 'plain.csv')
  assert.equal(dispositionName('inline'), '')
  assert.equal(dispositionName(''), '')
})
t('坏的 filename* 退回 filename', () => {
  assert.equal(dispositionName(`attachment; filename*=UTF-8''%E5%ZZ; filename="ok.txt"`), 'ok.txt')
})
t('非法字符、路径分隔符、开头的点都去掉', () => {
  assert.equal(safeName('../../etc/passwd'), '_.._etc_passwd')
  assert.equal(safeName('..\\win\\x?.txt'), '_win_x_.txt')
  assert.equal(safeName('.bashrc'), 'bashrc')
  assert.equal(safeName('a\u0000b:c*d.txt'), 'a_b_c_d.txt')
  assert.equal(safeName('   '), '')
})
t('太长截断但保住扩展名', () => {
  const s = safeName('长'.repeat(300) + '.xlsx')
  assert.equal(s.length, 180)
  assert.ok(s.endsWith('.xlsx'))
})
t('起名顺序：给的 > 服务器 > download 属性 > 网址', () => {
  const base = { disposition: 'attachment; filename="srv.pdf"', suggested: 'attr.pdf', url: 'https://x.com/p/url.pdf', type: 'application/pdf' }
  assert.equal(pickName({ ...base, filename: 'mine.pdf' }), 'mine.pdf')
  assert.equal(pickName(base), 'srv.pdf')
  assert.equal(pickName({ ...base, disposition: '' }), 'attr.pdf')
  assert.equal(pickName({ ...base, disposition: '', suggested: '' }), 'url.pdf')
  assert.equal(pickName({ url: 'https://x.com/%E6%8A%A5%E8%A1%A8.csv' }), '报表.csv')
})
t('没扩展名按类型补；blob/data 网址不拿来当名字', () => {
  assert.equal(pickName({ url: 'https://x.com/export', type: 'text/csv; charset=utf-8' }), 'export.csv')
  assert.equal(pickName({ url: 'https://x.com/', type: 'application/pdf' }), 'download.pdf')
  assert.equal(pickName({ url: 'blob:https://x.com/1234-5678', type: 'image/png' }), 'download.png')
  assert.equal(pickName({ url: 'data:text/plain,hi', type: 'text/plain' }), 'download.txt')
  assert.equal(pickName({ url: 'https://x.com/a.tar.gz', type: 'application/gzip' }), 'a.tar.gz')
})
t('重名加 (1)、(2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dl-test-'))
  try {
    assert.equal(uniquePath(dir, 'a.csv'), path.join(dir, 'a.csv'))
    fs.writeFileSync(path.join(dir, 'a.csv'), '')
    assert.equal(uniquePath(dir, 'a.csv'), path.join(dir, 'a (1).csv'))
    fs.writeFileSync(path.join(dir, 'a (1).csv'), '')
    assert.equal(uniquePath(dir, 'a.csv'), path.join(dir, 'a (2).csv'))
    assert.equal(uniquePath(dir, 'noext'), path.join(dir, 'noext'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
t('大小好读', () => {
  assert.equal(humanSize(512), '512 B')
  assert.equal(humanSize(2048), '2.0 KB')
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB')
})
console.log(`\n✅ ${n} 项通过`)
