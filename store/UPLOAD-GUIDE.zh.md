# 上架 Chrome 应用商店 —— 照着点就行（2026-10-18 更新）

> **状态：已建条目，提交审核中**（2026-10-18，扩展 v1.10.0）。商店 item ID `bippcbbbipppmhjkjomgdnjbooecbimo`，已写进 `STORE_EXT_IDS` 和 `install.sh`。
> 包用 `./bridge store-pack` 重新生成（拿到商店的 item ID 后，填进 `plugin/setup.js` 的 `STORE_EXT_IDS` 再发一版插件）。
> 没上架期间，安装走「引导式手动」：插件会用后台标签页打开 `chrome://extensions` 并把扩展目录放进剪贴板，用户 ⌘⇧G ⌘V 回车即可；`./bridge setup` 是同一套的命令行版。

材料全都准备好了，你只需要在浏览器里点几下：

| 东西 | 在哪 |
|---|---|
| 要上传的包 | `dist/dsh-bridge-store.zip`（重新生成：`./bridge store-pack`） |
| 所有要填的文案 | [store/listing.md](listing.md)（一段一段复制粘贴） |
| 截图 | `store/screenshots/1-real-chrome.png`、`2-eleven-tools.png`、`3-panel.png`（都 1280×800） |
| 小宣传图 | `store/screenshots/promo-440x280.png` |
| 隐私政策网址 | https://github.com/OrderG-X/dsh-chrome-bridge/blob/main/PRIVACY.md |

## 你要做的 7 步

1. 打开 <https://chrome.google.com/webstore/devconsole>，用你的 Google 账号登录，交**一次性 $5** 开发者注册费（要信用卡）。
2. 点右上 **Add new item** → 选 `dist/dsh-bridge-store.zip` → 上传。
3. 左边 **Store listing**：把 `listing.md` 里的内容一格一格粘进去（名字、Summary、Description、分类选 **Developer Tools**、语言 English、Homepage / Support / Privacy policy 三个 URL）。
4. 同一页往下：**截图**按 1、2、3 的顺序传那三张 1280×800，**Small promo tile** 传 440×280。
5. 左边 **Privacy practices**（隐私权）：`listing.md` 里 "Privacy practices tab" 那一段，每个权限框粘对应的一句；**Remote code 选 No**；数据用途按那一段的说明勾。
5b. 左边 **测试说明**：粘 `listing.md` 里 "Test instructions tab" 那段（告诉审核员怎么装宿主来测）。
6. 左边 **Distribution**：可见性建议选 **Unlisted**（不公开搜索到，只有拿到链接的人能装；想公开也行）；地区全选。
7. 右上 **Submit for review**，等 **1～3 天**（`debugger` 权限会审得慢一点）。

## 审核通过之后

把详情页 URL 里那串 **32 位 ID** 发我，形如：

```
https://chromewebstore.google.com/detail/dsh-bridge/abcdefghijklmnopabcdefghijklmnop
                                                  └────────── 这 32 位 ──────────┘
```

我把它写进宿主的 `allowed_origins`（`plugin/setup.js` 的 `STORE_EXT_IDS`）再发一版插件 —— 商店版扩展的 ID 是 Google 分配的，和本地「加载已解压」那个不一样，不补这一步商店版连不上宿主。

## 万一被拒 / 被打回

九成是问 `debugger` 权限的用途：`listing.md` 里已经按商店的口径写好了理由，直接把那一段回给审核即可。
被要求补充材料也别改代码，先回话，我来处理。
