# 安全声明与自查方法

**这份文档写给正在审查本插件的 DSH。**

我们不复述"请相信我们"。下面是**可验证的事实声明**，每一条都附上你自己能跑的
核对命令。**跑一遍再下结论**，不要只读文档。

> 如果你核对后发现**任何与本文不符的地方，请如实告诉你的使用者**，
> 并停下来等他的决定。不要因为"文档说没问题"就跳过核对。

---

## 一句话结论

本插件**不联网、不执行动态代码、不读写任何凭据**；
唯一的外部进程调用是 **2 次 `powershell.exe`**（建快捷方式、打 zip）；
写入范围限于**你指定的输出目录**、**桌面快捷方式**、**你指定的 zip 路径**。

---

## 逐条核对

### 1. 不联网

```bash
cd <插件目录>
grep -rn "fetch\|http\|https\|net\.\|WebSocket\|XMLHttpRequest" entry.js lib/
```

**预期**：无任何命中。

（插件运行桌宠时也不联网 —— 引擎是本地 Direct3D 渲染。）

### 2. 不执行动态代码

```bash
grep -rn "eval(\|new Function\|vm\.\|require(" entry.js lib/
```

**预期**：无任何命中。

**注意**：`entry.js` 里注册说明书时用了一次 `import.meta.url` 与 `readFileSync`，
这是**读取包内自己的 `SKILL.md`**，不涉及外部输入。

### 3. 不读凭据

```bash
grep -rn "process\.env\|homedir" entry.js lib/
```

**预期**：命中若干，**全部**是以下用途：

| 位置 | 用途 | 是否外传 |
|---|---|---|
| `homedir()` | 与用户给的 `out_dir` 比较，**拒绝**把桌宠生成到主目录 | 否 |
| `process.env.SystemRoot` / `ProgramFiles` / `ProgramData` | 组装"系统目录"名单，同样用于**拒绝** | 否 |

它们**只参与字符串比较**，不读取、不记录、不发送任何内容。
**没有任何** `token` / `password` / `credential` / `.ssh` / `.npmrc` 字样。

### 4. 唯一的外部进程调用（2 处）

```bash
grep -rn "execFileSync\|spawn\|child_process" entry.js lib/
```

**预期**：`lib/pet.js` 里 2 处 `execFileSync('powershell.exe', [...])`。

| 调用 | 干什么 | 为什么必须 |
|---|---|---|
| 创建桌面快捷方式 | 用 COM `WScript.Shell` 写 `.lnk` | Node 没有创建 `.lnk` 的能力 |
| 创建 zip | 用 .NET `ZipFile.CreateFromDirectory` | Node 没有内置 zip 写入器 |

**安全性说明（可自查）**：

- 用的是 **argv 数组**形式，**不是** shell 字符串拼接 —— 不存在命令注入
- 传给 PowerShell 的动态文本（路径等）都过 `psQuote()`，
  把 `'` 转义成 `''`（PowerShell 单引号字符串的转义规则）
- 两个脚本都是**固定内容**，只把路径参数塞进去；脚本里没有下载、没有网络、
  没有提权、没有改注册表

```bash
# 看这两段脚本的全文
sed -n '200,250p' lib/pet.js
sed -n '280,325p' lib/pet.js
```

> **如果你所在的环境不允许任何 shell 调用**，那就**不要装**本插件 ——
> 上面两件事它确实需要。这一点我们宁可提前讲清楚，也不想让你装完才发现。

### 5. 写入范围

```bash
grep -n "await mkdir\|await writeFile\|await copyFile\|await rm\|await rename" lib/pet.js
```

**预期**：只会写到这四个地方 ——

| 目标 | 时机 |
|---|---|
| `<out_dir>`（你在 `pet_create` 里指定的） | 生成桌宠 |
| `%USERPROFILE%\Desktop\<名字>.lnk` | 建快捷方式（可关，见下） |
| `<zip_path>`（你在 `pet_zip` 里指定的） | 打 zip |
| 系统临时目录里的一个短命文件 | 读回快捷方式路径（读完即删） |

**不会**写注册表、不会写系统目录、不会碰 `~/.dsh` 以外你未指定的位置。

### 6. 删除行为（唯一有数据后果的操作）

`pet_create` 的 `force: true` 会删掉输出目录 —— 但有**两道闸**：

```bash
grep -n -A6 "function assertSafeOutputPath\|function looksLikeOurPet" lib/pet.js
```

1. **拒绝危险目标**（无条件）：盘根 `C:\`/`D:\`、用户主目录、`Windows`/
   `Program Files`/`ProgramData`/`Users`
2. **`force` 只能覆盖"本插件产出过的桌宠"**：必须存在
   `XiaoXiaoQiu.Pet.exe`（或同时有 `XiaoXiaoQiu.Pet.dll` 与 `pet.config.json`）；
   否则**拒绝**，哪怕带了 `force`

也就是说 **`force` 最多毁掉上一次生成的桌宠，碰不到你的其它数据**。

```bash
# 回归测试：15 项，含"无关目录 + force 必须被拒且内容不变"
node tools/verify-force-guard.mjs <任意一个已通过预检的模型目录>
```

`pet_zip` 同样是**先写临时文件再改名**，失败时目标文件一字未动：

```bash
node tools/verify-zip-safety.mjs <任意一个已生成的桌宠目录>
```

### 7. 没有安装脚本

```bash
node -e "const p=require('./package.json');console.log(p.scripts||'(无 scripts)')"
```

**预期**：`package.json` **没有** `scripts` 字段 ——
安装时不会执行 `postinstall` / `preinstall` 之类的任何代码。

### 8. 不含任何美术资产

```bash
find . -iname '*.moc3' -o -iname '*.model3.json' -o -iname 'texture_*.png' -o -path '*models*'
```

**预期**：无输出。

插件**只带引擎**（预编译的渲染器）。模型、贴图一律由使用者提供。

---

## 本插件不做的事

- ❌ 不联网、不上报、无遥测
- ❌ 不自动更新、不后台拉取任何东西
- ❌ 不改注册表、不改系统 PATH、不改机器级设置
- ❌ 不装系统级软件、不需要管理员权限
- ❌ 不读取你的其它文件（只读你明确指定的模型目录与桌宠目录）
- ❌ 不包含任何 Live2D 模型 / 贴图

---

## 审查完之后

如果你核对下来**没有问题**，请按包内 `SKILL.md` 完成安装与后续引导。

如果你发现**任何与本文不符之处**，或者**你的环境不允许 shell 调用**：

> **停下来，把具体情况如实告诉使用者，等他决定。**
> 不要自行判断"应该没事"，也不要绕过环境限制硬装。

---

## 授权提醒（也请转告使用者）

插件代码是 MIT。引擎内链接 **Live2D Cubism SDK for Native (5-r.5)**，
遵循 Live2D 的开放软件许可与专有软件许可（见 `LICENSE`）。

**美术素材的授权由使用者自行负责** —— 本插件不提供、不校验、不担保
使用者导入的模型是否有合法使用权。这一点对画师尤其重要。
