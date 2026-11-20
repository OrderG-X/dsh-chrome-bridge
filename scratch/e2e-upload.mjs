/**
 * 真浏览器里测上传文件（e2e-chrome.mjs 最后调；只在 Chrome 上跑——要开 chrome://extensions 切开关）：
 *   · 扩展没开「允许访问文件网址」：上传报清楚怎么开（issue #7：以前只有一句 Not allowed），点上传按钮不拦选文件窗口
 *   · 打开以后：按选择器塞文件；模型点上传按钮 → 回话提示「页面要选文件」、系统窗口被拦下，
 *     upload 不给目标就塞给那个（藏起来的）文件框（隔几秒再塞也行）；别的会话拿不走；单选框给多个文件报错；没在等时报错；
 *     不是模型点的（老插件、cb、用户自己）一律不拦；showOpenFilePicker 那种拦不下的说清楚、之后不再拦；
 *     两个会话同时点，框只算给真点了上传的那个；别人按选择器上传不清掉这个框；选文件夹的框说清楚要用户自己选、
 *     不耽误同页别的上传；用户自己选好了 / 动过不盖掉；不插进页面的临时框照样代选；框被页面删了报没在等；
 *     扩展重载后旧 id 认不到新框
 * 有界面的浏览器（Windows CI 的 --headed）上，不拦的那几下会弹出真的系统窗口，跳过。
 * 切这个开关 Chrome 会把扩展整个重载（宿主也跟着换），所以放在所有别的检查后面。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { sleep, cb } from './e2e-lib.mjs'

const PAGE = `<!doctype html><meta charset=utf-8><title>上传测试</title>
<input type=file id=f aria-label="看得见的文件框">
<input id=t aria-label="文件名">
<input type=file id=h multiple style="display:none">
<button id=b onclick="document.getElementById('h').click()">选几个文件</button>
<input type=file id=one style="display:none">
<button id=b1 onclick="document.getElementById('one').click()">选一个文件</button>
<input type=file id=d webkitdirectory style="display:none">
<button id=bd onclick="document.getElementById('d').click()">选一个文件夹</button>
<button id=bx onclick="const i = document.createElement('input'); i.type = 'file'; i.onchange = () => { document.getElementById('o').textContent += 'x:' + [...i.files].map((f) => f.name).join(',') + ';' }; i.click()">临时文件框</button>
<button id=bx2 onclick="(() => { const i = document.createElement('input'); i.type = 'file'; i.addEventListener('change', function () { document.getElementById('o').textContent += 'x2:' + [...this.files].map((f) => f.name).join(',') + ';' }); i.click() })()">临时文件框（不留引用）</button>
<button id=p onclick="document.getElementById('o').textContent += 'p;'">普通按钮</button>
<button id=fs onclick="showOpenFilePicker().then(() => { document.getElementById('o').textContent += 'fs:ok;' }, (e) => { document.getElementById('o').textContent += 'fs:' + e.name + ';' })">打开文件（新接口）</button>
<p id=o></p>
<script>
for (const id of ['f', 'h', 'one', 'd']) {
  const el = document.getElementById(id)
  el.addEventListener('change', () => { document.getElementById('o').textContent += id + ':' + [...el.files].map((x) => x.name).join(',') + ';' })
  el.addEventListener('cancel', () => { document.getElementById('o').textContent += id + ':cancel;' })
}
</script>`

export async function uploadChecks({ check, tools, browserCdp, extId, cbFile, headed = false }) {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/`
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-up-')))
  const fa = path.join(dir, 'a.txt')
  const fb = path.join(dir, 'b.txt')
  fs.writeFileSync(fa, 'A'); fs.writeFileSync(fb, 'B')
  const run = async (name, args, session = 'up-a') => {
    try { return String((await tools.get(name).execute(args, { agent: { sessionId: session } })).text) } catch (e) { return `ERR ${e.message}` }
  }
  try {
    // chrome://extensions：开发者模式先打开（不开的话「已解压」的扩展一重载就被停用），再切文件访问
    const { targetId } = await browserCdp('Target.createTarget', { url: 'chrome://extensions/' })
    const { sessionId } = await browserCdp('Target.attachToTarget', { targetId, flatten: true })
    const ev = async (expr) => {
      for (let i = 0; i < 20; i++) {
        const r = await browserCdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)
        if (!r.exceptionDetails) return r.result.value
        if (!/developerPrivate|undefined/.test(JSON.stringify(r.exceptionDetails))) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
        await sleep(300)   // 页面还没加载完，chrome.developerPrivate 还没有
      }
      throw new Error('chrome://extensions 没加载出来')
    }
    await ev(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }).then(() => 1)`)
    const setAccess = async (on) => reloadBy(`chrome.developerPrivate.updateExtensionConfiguration({ extensionId: '${extId}', fileAccess: ${on} }).then(() => 1)`)
    const reloadBy = async (expr, strict = false) => {
      // 严格时（显式重载那条）一定要先拿到旧宿主 pid，才能确认重载后换成了新宿主
      let before = null
      for (let i = 0; i < (strict ? 10 : 1) && !before; i++) {
        before = await cb(cbFile, 'status').catch(() => null)
        if (!before) await sleep(300)
      }
      await ev(expr)
      const now = await ev(`chrome.developerPrivate.getExtensionInfo('${extId}').then((i) => i.fileAccess.isActive)`)
      // 切开关 / 重载 → Chrome 重载扩展 → 旧宿主断开、新扩展拉起新宿主
      await sleep(1500)
      let st = null
      for (let i = 0; i < 40; i++) {
        try { st = await cb(cbFile, 'status') } catch { st = null }
        if (st && st.extConnected && ((before && st.pid !== before.pid) || (!strict && (!before || i > 20)))) break
        await sleep(500)
      }
      return { now, connected: !!(st && st.extConnected), newHost: !!(st && before && st.pid !== before.pid) }
    }

    const off = await setAccess(false)
    check('关掉「允许访问文件网址」（扩展重载后重新连上）', off.now === false && off.connected, JSON.stringify(off))
    const opened = await run('browser_tabs', { action: 'open', url })
    const tab = (/标签页 (\d+)/.exec(opened) || [])[1]
    if (!check('打开上传测试页', tab, opened)) return
    // 干活窗口刚开出来的页先是空白页：等它真加载出来再动手
    for (let i = 0; i < 20 && !(await run('browser_read', { tab, what: 'info' })).includes('上传测试'); i++) await sleep(300)
    const e1 = await run('browser_input', { tab, action: 'upload', selector: '#f', files: [fa] })
    check('没开文件访问：上传报清楚怎么开（不是一句 Not allowed）', e1.startsWith('ERR') && e1.includes('允许访问文件网址') && e1.includes(`chrome://extensions/?id=${extId}`), e1)
    if (!headed) {
      const c0 = await run('browser_click', { tab, selector: '#b' })
      check('没开文件访问：点上传按钮不拦选文件窗口', !c0.startsWith('ERR') && !c0.includes('页面要选文件'), c0)
    }

    const on = await setAccess(true)
    check('打开「允许访问文件网址」（扩展重载后重新连上）', on.now === true && on.connected, JSON.stringify(on))
    const out = async () => String((await cb(cbFile, 'eval', tab, "document.getElementById('o').textContent")).value)
    await run('browser_nav', { tab, action: 'reload' })
    await run('browser_wait', { tab, selector: '#b' })
    const u0 = await run('browser_input', { tab, action: 'upload', selector: '#f', files: [fa, fb] })
    check('按选择器往单选框塞两个文件：报一次只收一个（不说都交了）', u0.startsWith('ERR') && u0.includes('只收一个'), u0)
    const ut = await run('browser_input', { tab, action: 'upload', selector: '#t', files: [fa, fb] })
    check('选择器选中的不是文件框：不误报「只收一个」', ut.startsWith('ERR') && !ut.includes('只收一个'), ut)
    const u1 = await run('browser_input', { tab, action: 'upload', selector: '#f', files: [fa] })
    await sleep(300)
    const o1 = await out()
    check('按选择器塞文件', !u1.startsWith('ERR') && o1.includes('f:a.txt;'), `${u1} | ${o1}`)

    const c1 = await run('browser_click', { tab, selector: '#b' })
    check('点上传按钮：回话提示页面要选文件（可多选），系统窗口拦下', c1.includes('页面要选文件') && c1.includes('可以多选'), c1)
    const ub = await run('browser_input', { tab, action: 'upload', files: [fa] }, 'up-b')
    check('别的会话不给目标：拿不走这个框', ub.startsWith('ERR') && ub.includes('没在等选文件'), ub)
    await sleep(3500)   // 模型往往过一会儿才上传：拦截早关了，框还在
    const u2 = await run('browser_input', { tab, action: 'upload', files: [fa, fb] })
    await sleep(300)
    const o2 = await out()
    check('隔几秒不给目标：文件交给刚才的（藏起来的）文件框', u2.includes('选文件框') && o2.includes('h:a.txt,b.txt;'), `${u2} | ${o2}`)
    const u3 = await run('browser_input', { tab, action: 'upload', files: [fa] })
    check('交过一次就不再等：再不给目标报「没在等选文件」', u3.startsWith('ERR') && u3.includes('没在等选文件'), u3)

    const c2 = await run('browser_click', { tab, text: '选一个文件' })
    check('单选的文件框：点完也提示（不说可以多选）', c2.includes('页面要选文件') && !c2.includes('可以多选'), c2)
    const u4 = await run('browser_input', { tab, action: 'upload', files: [fa, fb] })
    check('单选的文件框给两个文件：报一次只收一个', u4.startsWith('ERR') && u4.includes('只收一个'), u4)
    const u5 = await run('browser_input', { tab, action: 'upload', files: [fb] })
    await sleep(300)
    const o5 = await out()
    check('单选的文件框给一个文件：收下', !u5.startsWith('ERR') && o5.includes('one:b.txt;'), `${u5} | ${o5}`)

    // 两个会话同时点同一个标签页：一个点普通按钮、一个点上传按钮。框只算给点上传的那个
    const [pa, pb] = await Promise.all([
      run('browser_click', { tab, selector: '#p' }, 'up-a'),
      run('browser_click', { tab, selector: '#b' }, 'up-b'),
    ])
    check('两个会话同时点：只有点上传的那个收到提示', !pa.startsWith('ERR') && !pa.includes('页面要选文件') && pb.includes('页面要选文件'), `${pa} | ${pb}`)
    const ua = await run('browser_input', { tab, action: 'upload', files: [fa] }, 'up-a')
    const ub2 = await run('browser_input', { tab, action: 'upload', files: [fb] }, 'up-b')
    await sleep(300)
    const oa = await out()
    check('同时点完：点普通按钮的拿不走，点上传的收下', ua.includes('没在等选文件') && !ub2.startsWith('ERR') && oa.includes('h:b.txt;'), `${ua} | ${ub2} | ${oa}`)
    // B 点开了框还没传，A 按选择器往另一个框传：不能把 B 等着的框清掉
    const sb = await run('browser_click', { tab, selector: '#b' }, 'up-b')
    const sa = await run('browser_input', { tab, action: 'upload', selector: '#f', files: [fb] }, 'up-a')
    const sb2 = await run('browser_input', { tab, action: 'upload', files: [fa] }, 'up-b')
    await sleep(300)
    const os2 = await out()
    check('别人按选择器往别的框传：不清掉这个会话等着的框', sb.includes('页面要选文件') && !sa.startsWith('ERR') && !sb2.startsWith('ERR') && os2.includes('f:b.txt;') && os2.endsWith('h:a.txt;'), `${sb} | ${sa} | ${sb2} | ${os2}`)

    if (!headed) {
      // 不是插件要求的点击（老插件、cb 命令行）不拦：无头 Chrome 里系统窗口弹出即取消，页面收到 cancel
      await cb(cbFile, 'click-el', tab, '#b1')
      let o6 = ''
      for (let i = 0; i < 10 && !o6.includes('one:cancel;'); i++) { await sleep(200); o6 = await out() }
      check('不是插件要求的点击不拦（系统窗口照常弹出）', o6.includes('one:cancel;'), o6)
    }

    if (!headed) {
      // 拦下以后模型没传文件、用户自己再点同一个按钮：照常弹出系统窗口（无头里弹出即取消，页面收到 cancel）
      const c9 = await run('browser_click', { tab, selector: '#b' })
      await cb(cbFile, 'click-el', tab, '#b')
      let o9 = ''
      for (let i = 0; i < 10 && !o9.includes('h:cancel;'); i++) { await sleep(200); o9 = await out() }
      check('拦下后没传文件，再由别人点同一个按钮：照常弹出', c9.includes('页面要选文件') && o9.includes('h:cancel;'), `${c9} | ${o9}`)
    }

    // showOpenFilePicker：拦下来只会被取消、也塞不进去 → 说清楚，这个标签页之后不再拦
    const c7 = await run('browser_click', { tab, selector: '#fs' })
    check('新接口的文件窗口：回话说清楚没法代选', c7.includes('没法替你选') || c7.includes('DSH 没法'), c7)
    if (!headed) {
      const c8 = await run('browser_click', { tab, selector: '#b' })
      check('之后这个标签页不再拦（让用户自己选）', !c8.startsWith('ERR') && !c8.includes('页面要选文件'), c8)
    }

    // 选文件夹的框（webkitdirectory）：塞文件不对，说清楚要用户自己选；不耽误同页别的上传。换页清掉上面的「不再拦」
    await run('browser_nav', { tab, action: 'reload' })
    await run('browser_wait', { tab, selector: '#bd' })
    const d1 = await run('browser_click', { tab, selector: '#bd' })
    check('选文件夹的框：回话说清楚要用户自己选（换页后又会拦了）', d1.includes('没法替你选文件夹') && !d1.includes('页面要选文件'), d1)
    const d2 = await run('browser_input', { tab, action: 'upload', files: [fa] })
    check('选文件夹的框：不给目标上传报没在等（不假装成功）', d2.startsWith('ERR') && d2.includes('没在等选文件'), d2)
    const d3 = await run('browser_input', { tab, action: 'upload', selector: '#d', files: [fa] })
    check('按选择器往选文件夹的框塞文件：报要用户自己选（不假装成功）', d3.startsWith('ERR') && d3.includes('文件夹'), d3)
    const d4 = await run('browser_click', { tab, selector: '#b' })
    const d5 = await run('browser_input', { tab, action: 'upload', files: [fa] })
    await sleep(300)
    const o10 = await out()
    check('点过选文件夹的，同页普通上传照样代选', d4.includes('页面要选文件') && !d5.startsWith('ERR') && o10.includes('h:a.txt;'), `${d4} | ${d5} | ${o10}`)

    // 拦下以后用户自己选好了（这里用页面脚本换掉框里的文件来模拟）：模型再传不盖掉
    const k1 = await run('browser_click', { tab, selector: '#b1' })
    await cb(cbFile, 'eval', tab, "(() => { const dt = new DataTransfer(); dt.items.add(new File(['u'], 'user.txt')); document.getElementById('one').files = dt.files; return 1 })()")
    const k2 = await run('browser_input', { tab, action: 'upload', files: [fa] })
    const k3 = String((await cb(cbFile, 'eval', tab, "[...document.getElementById('one').files].map((f) => f.name).join()")).value)
    check('用户自己选好了：模型不给目标上传不盖掉', k1.includes('页面要选文件') && k2.startsWith('ERR') && k2.includes('自己选了') && k3 === 'user.txt', `${k1} | ${k2} | ${k3}`)
    // 用户自己选过、网页读完又把框清空了（文件对得上，但动过）：也不盖掉
    const k4 = await run('browser_click', { tab, selector: '#b1' })
    await cb(cbFile, 'eval', tab, "(() => { document.getElementById('one').dispatchEvent(new Event('change')); return 1 })()")
    const k5 = await run('browser_input', { tab, action: 'upload', files: [fa] })
    check('用户选过、网页又清空了框：也不盖掉', k4.includes('页面要选文件') && k5.startsWith('ERR') && k5.includes('自己选了'), `${k4} | ${k5}`)

    // 脚本现造一个文件框、不插进页面直接 click（很多网站这样）：照样代选
    const x1 = await run('browser_click', { tab, selector: '#bx' })
    const x2 = await run('browser_input', { tab, action: 'upload', files: [fa] })
    await sleep(300)
    const ox = await out()
    check('不插进页面的临时文件框：照样代选', x1.includes('页面要选文件') && !x2.startsWith('ERR') && ox.includes('x:a.txt;'), `${x1} | ${x2} | ${ox}`)
    // 页面连引用都不留（点击函数里造完就扔）：模型想文件的工夫浏览器回收了垃圾，也得能塞
    const y1 = await run('browser_click', { tab, selector: '#bx2' })
    // 扩展的调试接口不给 HeapProfiler：从浏览器那头接上测试页，强制回收两次
    const { targetInfos } = await browserCdp('Target.getTargets')
    const pageT = targetInfos.find((x) => x.type === 'page' && x.url === url)
    if (pageT) {
      const { sessionId: ps } = await browserCdp('Target.attachToTarget', { targetId: pageT.targetId, flatten: true })
      for (let i = 0; i < 2; i++) { await browserCdp('HeapProfiler.collectGarbage', {}, ps); await sleep(200) }
      await browserCdp('Target.detachFromTarget', { sessionId: ps }).catch(() => {})
    }
    check('找到测试页、强制回收了垃圾', !!pageT, JSON.stringify(targetInfos.map((x) => x.type + ' ' + x.url)))
    const y2 = await run('browser_input', { tab, action: 'upload', files: [fa] })
    await sleep(300)
    const oy = await out()
    check('不留引用的临时文件框：回收过垃圾也照样代选', y1.includes('页面要选文件') && !y2.startsWith('ERR') && oy.includes('x2:a.txt;'), `${y1} | ${y2} | ${oy}`)

    // 拦下以后页面把那个框删了（弹层关掉之类）：报没在等，不塞给脱离页面的旧节点
    const g1 = await run('browser_click', { tab, selector: '#b' })
    await cb(cbFile, 'eval', tab, "(() => { document.getElementById('h').remove(); return 1 })()")
    const g2 = await run('browser_input', { tab, action: 'upload', files: [fa] })
    check('框被页面删了：报没在等（不假装成功）', g1.includes('页面要选文件') && g2.startsWith('ERR') && g2.includes('没在等选文件'), `${g1} | ${g2}`)
    console.log(`  （页面事件：${await out()}）`)

    // 扩展重载后：A 手里的旧 id 认不到 B 新点开的框
    await run('browser_nav', { tab, action: 'reload' })
    await run('browser_wait', { tab, selector: '#b' })
    const r1 = await run('browser_click', { tab, selector: '#b' }, 'up-a')
    const rl = await reloadBy(`chrome.developerPrivate.reload('${extId}', { failQuietly: true }).then(() => 1)`, true)
    await run('browser_nav', { tab, action: 'reload' })
    await run('browser_wait', { tab, selector: '#b' })
    const r2 = await run('browser_click', { tab, selector: '#b' }, 'up-b')
    const r3 = await run('browser_input', { tab, action: 'upload', files: [fa] }, 'up-a')
    const r4 = await run('browser_input', { tab, action: 'upload', files: [fb] }, 'up-b')
    await sleep(300)
    const o11 = await out()
    check('扩展重载后：旧 id 拿不走新框，新点的那个能塞', rl.connected && rl.newHost && r1.includes('页面要选文件') && r2.includes('页面要选文件')
      && r3.includes('没在等选文件') && !r4.startsWith('ERR') && o11.includes('h:b.txt;') && !o11.includes('h:a.txt'), `${JSON.stringify(rl)} | ${r3} | ${r4} | ${o11}`)
    await run('browser_tabs', { action: 'close', tab })
  } catch (e) {
    check('上传检查没有异常', false, e && e.stack || e)
  } finally {
    server.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}
