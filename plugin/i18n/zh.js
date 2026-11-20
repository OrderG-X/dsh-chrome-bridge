/**
 * 服务端字典（简体中文）——模型看得见的那一层：工具描述、参数说明、报错文案。
 *
 * 这是基准字典：en / ru 缺 key 会回落到这里（见 index.js 的 createT）。
 * 界面文字（设置卡）在 client.js 里，走 DSH 的 client-locale 服务，不在这里。
 *
 * 占位符写 %name（和 client.js 的 %x 同一套写法，只是允许多字母）：
 * 不用 {name}，那个是 DSH 自己的插值格式。
 */
export default {
  // ── 各工具共用 ──────────────────────────────────────────────────────────
  'param.tab': '标签页 id（数字），或 "active" 表示用户当前正在看的标签页。省略时接着用本会话上次打开或操作过的标签页；还没有就报错，不会默认去动用户正在看的页面',
  'param.ref': '元素编号：browser_read(what=snapshot) 列出的 [N]。最稳，有编号就别再猜选择器',

  // ── browser_tabs ───────────────────────────────────────────────────────
  'tool.tabs.desc': '列出 / 查找 / 打开 / 关闭 / 切换 Chrome 标签页。其它 browser_* 工具都要 tab 参数，先用它拿 id。用的是用户真实的 Chrome（登录状态都在），不会新开一个干净的浏览器。open 新开的页默认放进一个单独的「DSH 干活窗口」，在后台、不抢用户焦点，用户正在看的页面不受影响。',
  'tool.tabs.action': 'list 全部；find 按关键词过滤标题/URL；open 新开（默认进单独的干活窗口）；close 关掉；activate 切到前台（会把那个窗口带到用户眼前，没被要求就别用）',
  'tool.tabs.query': 'action=find 时的关键词（匹配标题或 URL）',
  'tool.tabs.url': 'action=open 时要打开的网址',
  'tool.tabs.tab': 'action=close/activate 时的标签页 id',

  // ── browser_read ───────────────────────────────────────────────────────
  'tool.read.desc': '读页面内容。what=snapshot 列出页面上能点/能填的元素，每个带编号 [N]——要操作页面时先调它，之后 browser_click / browser_input 直接传 ref=N，比猜选择器稳（同源 iframe 里的元素也会列出、也能按编号操作）；text 取可见文字（抓内容首选）；html 取外层 HTML；attr 取某个属性；info 取标题/URL/视口，并会告诉你有没有 alert 弹窗挡着（挡着的话先调 browser_dialog）。',
  'tool.read.what': '读什么',
  'tool.read.selector': 'CSS 选择器；snapshot/text/html 省略时取整页',
  'tool.read.name': 'what=attr 时要读的属性名，例如 href',
  'tool.read.limit': '最多返回多少字符，默认 6000（snapshot 默认 8000）',

  // ── browser_click ──────────────────────────────────────────────────────
  'tool.click.desc': '在页面里点击。最稳的是 ref（browser_read what=snapshot 给的编号）；其次 selector 或 text（按文字找元素），都不行再退回坐标 x/y。发的是真实鼠标事件（能触发新窗口、弹窗、焦点），不是 JS 假点击。点击时用户屏幕上会出现一个小光标。',
  'tool.click.selector': 'CSS 选择器',
  'tool.click.text': '按可见文字找元素并点击（比 selector 更耐改版）',
  'tool.click.x': '视口坐标 X（配合 y）',
  'tool.click.y': '视口坐标 Y（配合 x）',
  'tool.click.count': '点击次数，默认 1（2 = 双击）',

  // ── browser_input ──────────────────────────────────────────────────────
  'tool.input.desc': '往页面里输入：type 打字（可先用 selector 聚焦）、key 按键（含组合键如 meta+a）、select 选下拉项、upload 塞文件、focus 聚焦、hover 悬停、scroll 滚动。',
  'tool.input.action': '要做的输入动作',
  'tool.input.text': 'action=type 时要输入的文字',
  'tool.input.ref': '%ref；可代替 selector',
  'tool.input.selector': 'CSS 选择器（type 时先点它聚焦；select/focus/hover 要它或 ref；upload 也要，除非刚才的点击回话明确提示「页面要选文件」）',
  'tool.input.key': 'action=key 的按键，例如 Enter / Escape / "meta+a" / "ctrl+shift+k"',
  'tool.input.value': 'action=select 时要选的 value 或选项文字',
  'tool.input.files': 'action=upload 的本地文件绝对路径（只限会话工作目录或系统临时目录下、非隐藏的文件）。只有刚才的点击回话明确提示「页面要选文件」时，upload 才可以不给 ref / selector',
  'tool.input.dy': 'action=scroll 的纵向滚动量，默认 600（向下为正）',
  'tool.input.dx': 'action=scroll 的横向滚动量，默认 0',
  'tool.input.x': 'action=hover 且不用 selector 时的视口 X 坐标',
  'tool.input.y': 'action=hover 且不用 selector 时的视口 Y 坐标',

  // ── browser_nav ────────────────────────────────────────────────────────
  'tool.nav.desc': '跳到某个网址（action=go，默认），或者 back 后退、forward 前进、reload 刷新。都会等页面加载完。',
  'tool.nav.action': 'go 跳到 url（默认）；back / forward / reload 不用给 url',
  'tool.nav.url': 'action=go 时的目标网址',

  // ── browser_screenshot ─────────────────────────────────────────────────
  'tool.screenshot.desc': '给页面截图，图片会直接返回给你看。mode=viewport 当前视口、full 整页、element 只截某个元素（要 ref 或 selector）。页内光标会一起入镜，所以你能和用户看到同一画面。',
  'tool.screenshot.mode': '截多大范围',
  'tool.screenshot.ref': 'mode=element 时截哪个元素：%ref',
  'tool.screenshot.selector': 'mode=element 时截哪个元素（CSS 选择器）',
  'tool.screenshot.format': 'png（默认）或 jpeg',

  // ── browser_eval ───────────────────────────────────────────────────────
  'tool.eval.desc': '在页面里执行一段 JS 并拿到返回值。适合读选择器拿不到的状态、检查 DOM、触发页面自己的函数。返回值会被 JSON 序列化。注意：它跑在页面上下文里，别用它点击（用 browser_click）。',
  'tool.eval.expression': '要执行的 JS 表达式；多语句请包成 IIFE 并 return',

  // ── browser_wait ───────────────────────────────────────────────────────
  'tool.wait.desc': '等页面变成某个样子再往下走，比 sleep 靠谱。三选一：selector 等元素出现（且可见）、text 等页面上出现某段文字、url 等网址包含某段（跳转/登录后用）。gone=true 反过来等它消失（比如加载圈）。',
  'tool.wait.selector': 'CSS 选择器',
  'tool.wait.text': '页面可见文字里要出现的一段',
  'tool.wait.url': '网址里要包含的一段',
  'tool.wait.gone': 'true = 等它消失，默认 false',
  'tool.wait.timeoutMs': '超时毫秒，默认 15000，最多 %max',

  // ── browser_dialog ─────────────────────────────────────────────────────
  'tool.dialog.desc': '处理 alert / confirm / prompt 弹窗。弹窗会把页面里后续所有操作卡死，所以 browser_read(what=info) 报有弹窗时先调它。',
  'tool.dialog.action': 'accept 确定，dismiss 取消',
  'tool.dialog.text': 'prompt 弹窗要填的内容',

  // ── browser_drag ───────────────────────────────────────────────────────
  'tool.drag.desc': '把一个东西拖到另一个地方：排序列表、看板卡片、滑块、拖文件进框、画布等。起点和终点各用 ref（snapshot 编号）、selector、text（可见文字）或 x/y 坐标给一个；放置区（「拖到这里」那种框）一般没编号，用 toText 按文字找最省事。带 draggable 的 HTML5 拖放和靠鼠标拖的组件都能处理，拖完截图或读页面确认一下结果。',
  'tool.drag.fromRef': '起点：%ref',
  'tool.drag.fromSelector': '起点：CSS 选择器',
  'tool.drag.fromText': '起点：按可见文字找元素',
  'tool.drag.fromX': '起点：视口 X 坐标（配合 fromY）',
  'tool.drag.fromY': '起点：视口 Y 坐标',
  'tool.drag.toRef': '终点：元素编号',
  'tool.drag.toSelector': '终点：CSS 选择器',
  'tool.drag.toText': '终点：按可见文字找元素（找放置区最好用）',
  'tool.drag.toX': '终点：视口 X 坐标（配合 toY）',
  'tool.drag.toY': '终点：视口 Y 坐标',
  'tool.drag.steps': '鼠标拖动分几步走完，默认 12（滑块要细一点可以调大）',

  // ── browser_download ───────────────────────────────────────────────────
  'tool.download.desc': '把链接指向的文件（发票、报表、PDF、图片……）下载到本机，带着用户在 Chrome 里的登录状态。给 ref（snapshot 里的链接编号）、selector 或 url 三选一；相对地址按页面算，blob: / data: 链接也行。默认存进「下载」文件夹，to=workdir 存进会话工作目录；同名不覆盖，自动加 (1)。下载按钮不是链接（点了才生成文件）的话：先 browser_click 它，再用 browser_devtools action=network 找到文件网址，交给这里。',
  'tool.download.selector': 'CSS 选择器（指向 a / img / video / source 等带地址的元素）',
  'tool.download.url': '要下载的网址，可以是相对地址',
  'tool.download.filename': '存成什么名字；省略时用服务器给的名字或网址里的名字',
  'tool.download.to': 'downloads（默认）存进「下载」文件夹；workdir 存进会话工作目录',

  // ── browser_devtools ───────────────────────────────────────────────────
  'tool.devtools.desc': '像开发者工具那样查网页：console 看控制台输出和 JS 报错；network 看网络请求（状态码、耗时）；response 看某个请求的返回内容（接口返回的 JSON 等）；clear 清空这个标签页的记录。页面「点了没反应」「数据没出来」「白屏」时先查这里。',
  'tool.devtools.action': '要看什么',
  'tool.devtools.level': 'action=console：error 只看报错，warning 报错+警告，默认 all',
  'tool.devtools.filter': 'console/network：只留包含这段文字的条目（网址、方法、内容都算）',
  'tool.devtools.reload': 'action=network：先刷新页面，抓到加载过程的全部请求（只记得到调试器接上之后的请求）',
  'tool.devtools.request': 'action=response：network 列表里 # 后面的编号',
  'tool.devtools.limit': 'console/network 最多几条（默认 40）；response 最多几个字（默认 6000）',

  // ── 报错文案 ───────────────────────────────────────────────────────────
  'err.dirNotOwned': '%dir 不是只属于当前用户的目录，拒绝使用',
  'err.bridgeDown': '浏览器桥没在跑（找不到 %sock）：Chrome 没开，或扩展还没加载。\n%hint',
  'err.badJson': '宿主回了坏 JSON',
  'err.unknownHostError': '未知错误',
  'err.connect': '连不上浏览器桥：%message\n%hint',
  'err.closed': '浏览器桥连接被关掉了',
  'err.timeout': '等浏览器桥超时（%ms）',
  'err.noActiveTab': '没有活动标签页',
  'err.badTab': 'tab 要是标签页 id（数字）或 "active"，收到的是「%tab」',
  'err.noTab': '没指定标签页（tab）。先用 browser_tabs 打开（open）或找到（list / find）要操作的页面，再把 id 传给 tab；要操作用户正在看的那一页就明确传 tab="active"。不传 tab 时只会接着用你自己打开或点名操作过的标签页，不会去动用户正在看的页面',
  'err.uploadAbs': 'upload 要给绝对路径：%path',
  'err.uploadMissing': '文件不存在：%path',
  'err.uploadHidden': '不能上传隐藏目录 / 隐藏文件：%path',
  'err.uploadOutsideCwd': '只能上传会话工作目录（%cwd）或系统临时目录下的文件：%path',
  'err.uploadOutside': '只能上传会话工作目录或系统临时目录下的文件：%path',
  'err.uploadNotFile': '不是普通文件：%path',
  'err.openNeedsUrl': 'action=open 需要 url',
  'err.unknownAction': '不认识的 action: %action',
  'err.attrNeeds': 'what=attr 需要 selector 和 name',
  'err.unknownWhat': '不认识的 what: %what',
  'err.clickNeeds': '要给出 ref、selector、text 或 x+y 之一',
  'err.shadowUnsupported': '编号 %ref 在 shadow DOM 或 iframe 里，%action 暂时不支持按编号——改用 browser_eval',
  'err.typeNeedsText': 'action=type 需要 text',
  'err.keyNeedsKey': 'action=key 需要 key',
  'err.selectNeedsTarget': 'action=select 需要 ref 或 selector',
  'err.selectNeedsValue': 'action=select 需要 value',
  'err.uploadNeedsTarget': 'action=upload 需要 ref 或 selector',
  'err.uploadNeedsFiles': 'action=upload 需要 files',
  'err.uploadNoChooser': '页面现在没在等选文件：先点页面上的上传按钮（点完回话里会提示），或者用 ref / selector 指定文件输入框',
  'err.uploadUserPicked': '拦下以后有人自己动过这个文件框（多半是用户自己选了文件），没有替换。确实要换成你的文件，先问用户，再重新点一次上传按钮。',
  'err.uploadFolder': '这是选文件夹的框，DSH 暂时没法替你选文件夹：请用户自己点页面上对应的按钮选（用户自己点不会被拦）。',
  'err.uploadSingle': '这个文件框一次只收一个文件，files 只给一个',
  'err.fileAccessOff': '上传不了：Chrome 默认不让扩展读电脑上的文件。请用户在 Chrome 里打开 %url（DSH Bridge 的详情页），打开「允许访问文件网址」。打开后扩展会自动重新加载，等几秒再上传；之前点出来的选文件窗口要重新点一次。',
  'note.fileChooser': '📎 页面要选文件%multi：系统的选文件窗口已经拦下（不会弹出来）。用 browser_input action=upload files=[…] 把文件交给它，不用给 ref / selector。要是用户想自己在系统窗口里选，请用户自己点这个按钮（用户自己点不会被拦）。',
  'note.fileChooserMulti': '（可以多选）',
  'note.fileChooserUnsupported': '⚠️ 页面打开的是另一种系统文件窗口（不是网页里的文件框），DSH 没法替你选，这一下已经被取消。再点一次会照常弹出系统窗口，需要用户自己在里面选文件。',
  'note.fileChooserFolder': '⚠️ 这个按钮要选的是整个文件夹，DSH 暂时没法替你选文件夹，这一下的系统窗口不会弹出来。请用户自己点这个按钮选文件夹（用户自己点不会被拦）。',
  'err.focusNeedsTarget': 'action=focus 需要 ref 或 selector',
  'err.hoverNeedsTarget': 'action=hover 需要 ref 或 selector，或者给 x/y 坐标',
  'err.navNeedsUrl': 'action=go 需要 url',
  'err.shotNeedsTarget': 'mode=element 需要 ref 或 selector',
  'err.shotZeroSize': '这个元素没有大小（可能被隐藏了），截不了',
  'err.waitNeedsOne': 'selector / text / url 给且只给一个',
  'err.dragNeedsEnd': '%which要给 %ref、%sel、%txt 或 %xy 之一',
  'err.noWorkdir': '拿不到会话工作目录，去掉 to=workdir 存进「下载」文件夹',
  'which.start': '起点',
  'which.end': '终点',

  // ── 报错后面附的「还差哪一步」 ──────────────────────────────────────────
  'hint.extOpened': '我已经帮你把 chrome://extensions 打开（后台标签页）%store',
  'hint.extOpenedStore': '，看一眼 DSH Bridge 是不是启用着',
  'hint.copied': '扩展文件夹的路径已经复制到剪贴板（%how就到）',
  'hint.copiedMac': '文件框里 ⌘⇧G 再 ⌘V 回车',
  'hint.copiedWin': '粘进文件框顶上的地址栏、回车',
  'hint.notes': '\n（%notes）',
  'hint.notesSep': '；',
}
