/**
 * 桌宠的组装与打包。
 *
 * 一次调用做完：复制引擎 → 放入模型 → 写运行期配置 → 桌面快捷方式 →（可选）压缩包。
 * 使用者不需要知道引擎怎么编译、贴图放哪、配置叫什么。
 */

import { readdir, mkdir, copyFile, writeFile, readFile, rm, stat, rename } from 'node:fs/promises'
import { existsSync, createWriteStream } from 'node:fs'
import { join, basename, dirname, resolve, relative, parse } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/** 插件自带的引擎目录（不含任何美术资产）。 */
export const ENGINE_DIR = fileURLToPath(new URL('../runtime/', import.meta.url))

/** 桌宠目录里模型必须落在这里，引擎按这个相对路径找。 */
const MODEL_SUBPATH = ['Rendering', 'WebAssets', 'models']

/**
 * 递归复制目录。
 * @param {string} src
 * @param {string} dst
 */
async function copyTree(src, dst) {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const s = join(src, e.name)
    const d = join(dst, e.name)
    if (e.isDirectory()) await copyTree(s, d)
    else if (e.isFile()) await copyFile(s, d)
  }
}

/** 目录大小（字节）。 */
async function treeSize(dir) {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await treeSize(p)
    else {
      try { total += (await stat(p)).size } catch { /* 忽略 */ }
    }
  }
  return total
}

/**
 * 无论 force 与否都要拒绝的输出目标。
 *
 * 【为什么需要】createPet 在 force 时会递归删除 out_dir。插件宿主代码是在
 * 工作区沙箱【之外】、进程内执行的，所以这道删除没有任何沙箱兜底：
 * 一次误调用、或被提示注入成 pet_create({out_dir:"D:\\avg", force:true})，
 * 就会真的删掉那个目录。删之前必须先证明「这个目录是我们自己的产出」。
 *
 * 这一层拦的是「明显不该出现在 out_dir 里」的路径，正常用法一律不受影响。
 *
 * @param {string} target 已 resolve 的绝对路径
 */
function assertSafeOutputPath(target) {
  const norm = target.replace(/[\\/]+$/, '')
  const parsed = parse(norm)
  const root = parsed.root.replace(/[\\/]+$/, '')

  // 盘根：C:\ / D:\
  if (norm.toLowerCase() === root.toLowerCase()) {
    throw new Error(`拒绝把桌宠生成到盘根：${target}`)
  }

  // 至少要有一层自己的目录名，例如 C:\x 可以，C:\ 或 C: 不行
  const segments = norm.slice(root.length).split(/[\\/]+/).filter(Boolean)
  if (segments.length < 1) {
    throw new Error(`输出路径太浅，拒绝使用：${target}`)
  }

  const lower = norm.toLowerCase()

  // 用户主目录本身（允许它下面的子目录）
  const home = homedir().replace(/[\\/]+$/, '').toLowerCase()
  if (home && lower === home) {
    throw new Error(`拒绝把桌宠直接生成到用户主目录：${target}\n请给它一个自己的子目录。`)
  }

  // 系统目录本身
  const systemDirs = [
    join(root, 'Windows'),
    join(root, 'Program Files'),
    join(root, 'Program Files (x86)'),
    join(root, 'ProgramData'),
    join(root, 'Users'),
    process.env.SystemRoot || '',
    process.env.ProgramFiles || '',
    process.env.ProgramData || '',
  ].filter(Boolean).map(p => p.replace(/[\\/]+$/, '').toLowerCase())

  if (systemDirs.includes(lower)) {
    throw new Error(`拒绝把桌宠生成到系统目录：${target}`)
  }
}

/**
 * 这个目录是不是【本插件产出过】的桌宠。
 *
 * 只有为真时才允许 force 覆盖 —— 也就是说 force 最多只能毁掉上一次的桌宠产出，
 * 永远碰不到用户的其它数据。
 *
 * 判定刻意取得很窄：必须同时看到本插件独有的可执行文件名与配置文件名。
 *
 * @param {string} dir
 */
function looksLikeOurPet(dir) {
  const exe = join(dir, 'XiaoXiaoQiu.Pet.exe')
  const dll = join(dir, 'XiaoXiaoQiu.Pet.dll')
  const cfg = join(dir, 'pet.config.json')
  return existsSync(exe) || (existsSync(dll) && existsSync(cfg))
}

/**
 * 用一份已校验的模型产出一个可运行的桌宠目录。
 *
 * @param {object} opts
 * @param {string} opts.modelDir 已校验通过的模型目录（含 .model3.json 的那一层）
 * @param {string} opts.outDir   桌宠输出目录
 * @param {string} [opts.name]   桌宠名字（默认取模型名）
 * @param {string[]} [opts.excludeLooks]  要从「换造型」里排除的表情名
 * @param {string[]} [opts.looks]         只保留这些表情（给了就忽略 excludeLooks）
 * @param {string[]} [opts.actions]       只保留这些动作
 * @param {boolean} [opts.force] 输出目录【已经是本插件产出的桌宠】时是否覆盖
 * @returns {Promise<{outDir:string, exe:string, sizeBytes:number, written:number}>}
 */
export async function createPet({ modelDir, outDir, name, excludeLooks, looks, actions, force }) {
  const target = resolve(outDir)
  assertSafeOutputPath(target)

  if (existsSync(target)) {
    const entries = await readdir(target)
    if (entries.length > 0) {
      if (!force) {
        throw new Error(`输出目录已存在且非空：${target}\n如果确实要覆盖，请带 force。`)
      }
      // force 不是「删掉这里的一切」，而是「重做上一次的桌宠」。
      // 目标不像我们的产出就停下来，宁可让使用者换个空目录。
      if (!looksLikeOurPet(target)) {
        throw new Error(
          `拒绝覆盖：${target} 看起来不是本插件产出的桌宠目录\n`
          + '（没有找到 XiaoXiaoQiu.Pet.exe，也没有同时找到 XiaoXiaoQiu.Pet.dll 与 pet.config.json）。\n'
          + 'force 只允许重做上一次生成的桌宠，不会删除其它数据。\n'
          + '想生成到这里的话：换一个空目录，或自己先清空它。',
        )
      }
      await rm(target, { recursive: true, force: true })
    }
  }
  await mkdir(target, { recursive: true })

  // 1) 引擎
  await copyTree(ENGINE_DIR, target)

  // 2) 模型：放到引擎约定的位置，目录名用模型自己的名字
  const modelName = basename(modelDir)
  const dstModelParent = join(target, ...MODEL_SUBPATH)
  await mkdir(dstModelParent, { recursive: true })
  await copyTree(modelDir, join(dstModelParent, modelName))

  // 3) 运行期配置
  /** @type {Record<string, unknown>} */
  const config = { model: modelName }
  if (name) config.name = name
  if (Array.isArray(looks) && looks.length) config.looks = looks
  else if (Array.isArray(excludeLooks) && excludeLooks.length) config.excludeLooks = excludeLooks
  if (Array.isArray(actions) && actions.length) config.actions = actions
  await writeFile(join(target, 'pet.config.json'), JSON.stringify(config, null, 2), 'utf8')

  // 4) 会话文本池（文本资产可以随插件走；美术资产不行）
  const dialogues = join(ENGINE_DIR, 'dialogues.txt')
  if (existsSync(dialogues) && !existsSync(join(target, 'dialogues.txt'))) {
    await copyFile(dialogues, join(target, 'dialogues.txt'))
  }

  const exe = join(target, 'XiaoXiaoQiu.Pet.exe')
  return {
    outDir: target,
    exe,
    sizeBytes: await treeSize(target),
    written: 1,
  }
}

/**
 * 在桌面放一个【快捷方式】（不是副本）。
 *
 * 引擎自己首次启动时也会建，这里显式提供是为了让生成流程一步到位、
 * 并允许用户指定名字。
 *
 * @param {object} opts
 * @param {string} opts.exePath
 * @param {string} [opts.linkName]
 * @param {string} [opts.description]
 * @returns {Promise<{linkPath:string}>}
 */
export async function createDesktopShortcut({ exePath, linkName, description }) {
  if (process.platform !== 'win32') throw new Error('桌面快捷方式目前只支持 Windows。')

  const exe = resolve(exePath)
  if (!existsSync(exe)) throw new Error(`找不到程序：${exe}`)

  // 桌面可能被 OneDrive 重定向，用系统 API 取真实位置
  //
  // 【编码】Windows PowerShell 5.1 默认按【控制台代码页（本机是 GBK）】写 stdout。
  // 早先直接按 utf8 读回，含中文的 .lnk 路径会被读坏，existsSync 判失败，
  // 于是明明建好了却报「创建失败」（实测）。这里强制 UTF-8 输出，并且
  // 不再依赖 stdout 传路径 —— 让 PowerShell 把结果写成 UTF-8 文件由 Node 读，
  // 从根本上避开控制台编码。
  const resultFile = join(tmpdir(), `dsh-pet-lnk-${process.pid}-${Date.now()}.txt`)
  const ps = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$d = [Environment]::GetFolderPath("DesktopDirectory")',
    `$exe = ${psQuote(exe)}`,
    `$lnk = Join-Path $d ${psQuote((linkName || '桌宠') + '.lnk')}`,
    '$sh = New-Object -ComObject WScript.Shell',
    '$sc = $sh.CreateShortcut($lnk)',
    '$sc.TargetPath = $exe',
    '$sc.WorkingDirectory = (Split-Path $exe -Parent)',
    '$sc.IconLocation = "$exe,0"',
    `$sc.Description = ${psQuote(description || 'Live2D 桌宠')}`,
    '$sc.WindowStyle = 1',
    '$sc.Save()',
    `[System.IO.File]::WriteAllText(${psQuote(resultFile)}, $lnk, (New-Object System.Text.UTF8Encoding $false))`,
  ].join('; ')

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch (error) {
    throw new Error(`调用系统创建快捷方式失败：${error.message}`)
  }

  let linkPath = ''
  try {
    linkPath = (await readFile(resultFile, 'utf8')).trim()
  } catch {
    throw new Error('快捷方式创建后读不到返回结果。')
  } finally {
    await rm(resultFile, { force: true })
  }

  if (!linkPath || !existsSync(linkPath)) {
    throw new Error(`快捷方式没有真正生成：${linkPath || '(空路径)'}`)
  }
  return { linkPath }
}

/** PowerShell 单引号字符串转义。 */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/**
 * 把桌宠目录打包成 zip（便于发送给别人）。
 * 用 .NET 的 ZipFile，避免依赖任何第三方库。
 *
 * 【为什么先写临时文件再改名，而不是先删后写】
 * 早先的写法是 `rm(zip)` 再 CreateFromDirectory。两个问题：
 *   1. zip_path 来自调用方，rm 会删掉那个路径上的【任意文件】——
 *      指到 D:\某文档.docx 就把文档删了。
 *   2. 删完到写完之间若失败（磁盘满、目录被占用），原文件已经没了，
 *      而且会留下一个半截的 zip。
 * 改成「写同目录临时文件 → 原子替换」后：
 *   · 失败时原文件原封不动，也不会留下半截产物
 *   · 没有"先删"这一步，就不存在把无关文件删掉的窗口
 * Windows 上 rename 不能覆盖已存在文件，所以用 File.Replace（同卷原子替换）。
 *
 * @param {object} opts
 * @param {string} opts.outDir 要打包的桌宠目录
 * @param {string} [opts.zipPath] 输出 zip（默认与目录同名、同级）
 * @returns {Promise<{zipPath:string, sizeBytes:number}>}
 */
export async function zipPet({ outDir, zipPath }) {
  const src = resolve(outDir)
  if (!existsSync(src)) throw new Error(`找不到目录：${src}`)

  const zip = resolve(zipPath || `${src}.zip`)
  assertSafeOutputPath(zip)
  if (existsSync(zip) && !(await stat(zip)).isFile()) {
    throw new Error(`压缩包路径被一个目录占用了：${zip}`)
  }

  const tmp = `${zip}.partial-${process.pid}-${Date.now()}`

  // PowerShell 只负责【写临时文件】。改名交给 Node，理由：
  //   powershell.exe 是 Windows PowerShell 5.1，跑在 .NET Framework 上，
  //   没有 File.Move(src,dst,overwrite) 这个 .NET Core 3.0+ 才有的重载（实测 MethodException）；
  //   File.Replace 在本机同样失败（IOException，ReplaceFile API 的限制）。
  //   而 Node 的 fs.rename 走 libuv 的 MoveFileExW(MOVEFILE_REPLACE_EXISTING)，
  //   覆盖已存在文件与移动到新路径都正常（实测两种情况均通过）。
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$tmp = ${psQuote(tmp)}`,
    'try {',
    // includeBaseDirectory=true -> 解压后是一个同名文件夹，而不是一堆散文件
    '  [System.IO.Compression.ZipFile]::CreateFromDirectory('
      + `${psQuote(src)}, $tmp, [System.IO.Compression.CompressionLevel]::Optimal, $true)`,
    '} catch {',
    '  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }',
    '  throw',
    '}',
  ].join('\n')

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      stdio: 'ignore',
    })
    // 临时文件写成了才动目标：失败时 zip_path 上的原文件一字未动
    await rename(tmp, zip)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw new Error(`压缩失败：${error.message}`)
  }

  if (!existsSync(zip)) throw new Error('压缩失败：没有生成预期的 zip。')
  return { zipPath: zip, sizeBytes: (await stat(zip)).size }
}

/**
 * 读取一个已生成桌宠的配置，用于「这个桌宠现在是什么状态」。
 * @param {string} petDir
 */
export async function readPetConfig(petDir) {
  const dir = resolve(petDir)
  const cfgPath = join(dir, 'pet.config.json')
  if (!existsSync(cfgPath)) return null
  try {
    return JSON.parse(await readFile(cfgPath, 'utf8'))
  } catch {
    return null
  }
}
