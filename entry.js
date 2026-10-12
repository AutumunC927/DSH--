/**
 * dsh-live2d-pet — Host half.
 *
 * 目标：把一份 Live2D 素材变成一个能跑的桌宠，过程中使用者不需要做任何
 * 环境准备，也不应该看到任何与美术资源无关的报错。
 *
 * 因此这个插件做三件事：
 *
 *   1. `pet_check_assets` —— 预检。这是【唯一】会向使用者报错的地方，
 *      每条都指明改哪张图/哪个文件。引擎侧问题在这里被消化掉。
 *   2. `pet_create` —— 用插件自带的、与模型无关的引擎，把素材组装成桌宠。
 *      引擎是预编译的（自包含 .NET + VC 运行库随包），使用者机器上
 *      不需要编译器、不需要装运行时。
 *   3. `pet_shortcut` / `pet_zip` —— 收尾：桌面快捷方式与可直接发送的压缩包。
 *
 * 插件【不携带任何美术资产】：runtime/ 里只有引擎。模型由使用者提供。
 * 文本资产（会话台词）可以随引擎走。
 *
 * 关于「拓展动作/表情」：那属于使用者自己的需求，交给他们的 DSH 会话去做，
 * 不在本插件职责内。插件只保证「导入素材 → 出一个能跑的桌宠」这条路。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectModelDir, renderReport } from './lib/assets.js'
import { createPet, createDesktopShortcut, zipPet, readPetConfig, ENGINE_DIR } from './lib/pet.js'

export const name = 'dsh-live2d-pet'

/** 引擎是否随插件就位。缺了说明插件装坏了，属于插件自身问题。 */
function engineReady() {
  return existsSync(ENGINE_DIR) && existsSync(`${ENGINE_DIR}/XiaoXiaoQiu.Pet.exe`)
}

/** 统一的工具输出格式。 */
function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * 拒绝未声明的参数。
 *
 * schema 里虽然写了 additionalProperties:false，但宿主不会替我们拦 ——
 * 实测传一个不存在的字段（filter_note）会被静默忽略，使用者以为生效了。
 * 「减少使用者思考」的一部分就是不接受含糊输入：宁可报错，也不要假装收下。
 *
 * @param {Record<string, unknown>} args
 * @param {string[]} allowed
 * @param {string} toolName
 */
function assertKnownArguments(args, allowed, toolName) {
  if (args === null || typeof args !== 'object') return
  const unknown = Object.keys(args).filter(k => !allowed.includes(k))
  if (unknown.length) {
    throw new Error(
      `${toolName}：不认识的参数 ${unknown.join('、')}。可用参数：${allowed.join('、')}。`,
    )
  }
}

const CHECK_PARAMS = {
  type: 'object',
  properties: {
    model_dir: {
      type: 'string',
      description: '包含 .model3.json 的文件夹路径（给它的父目录也可以）。',
    },
  },
  required: ['model_dir'],
  additionalProperties: false,
}

const CREATE_PARAMS = {
  type: 'object',
  properties: {
    model_dir: { type: 'string', description: 'Live2D 模型文件夹路径。' },
    out_dir: { type: 'string', description: '桌宠输出目录。' },
    name: { type: 'string', description: '桌宠名字（用于快捷方式与标题）；默认取模型名。' },
    exclude_looks: {
      type: 'array', items: { type: 'string' },
      description: '要从「换造型」里排除的表情名（就是 .exp3.json 的文件名，不带扩展名）。',
    },
    looks: {
      type: 'array', items: { type: 'string' },
      description: '只保留这些表情；给了它就忽略 exclude_looks。',
    },
    actions: {
      type: 'array', items: { type: 'string' },
      description: '只保留这些动作（.motion3.json 的文件名，不带扩展名）。',
    },
    force: { type: 'boolean', description: '输出目录非空时是否覆盖。' },
    desktop_shortcut: { type: 'boolean', description: '是否在桌面放快捷方式（默认 true）。' },
    zip: { type: 'boolean', description: '是否顺带打一个 zip（默认 false）。' },
  },
  required: ['model_dir', 'out_dir'],
  additionalProperties: false,
}

/**
 * @param {any} root cordis 根 context
 * @param {any} _config
 */
export function apply(root, _config) {
  root.inject(['tools'], ctx => {
    const disposers = []

    // ---------------- 资产预检 ----------------
    disposers.push(ctx.tools.register({
      name: 'pet_check_assets',
      description:
        '检查一份 Live2D 素材能不能做成桌宠。这是唯一会报错的地方，'
        + '报出来的每一条都指明要改哪个文件；没有问题时给出模型规模概览。'
        + '做桌宠之前先跑这个。',
      parameters: CHECK_PARAMS,
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, report: { type: 'string' } } },
        render: (_a, v) => text(v.report),
      },
      async execute(args) {
        assertKnownArguments(args, ["model_dir"], "pet_check_assets")
        const r = await inspectModelDir(resolve(String(args.model_dir)))
        return { ok: r.ok, report: renderReport(r, r.ok ? '素材检查通过' : '素材有问题，需要你先修一下') }
      },
    }))

    // ---------------- 一键产出桌宠 ----------------
    disposers.push(ctx.tools.register({
      name: 'pet_create',
      description:
        '用一份 Live2D 素材一键产出一个可运行的桌宠（自带引擎，使用者机器不需要编译器或运行时）。'
        + '会先自动做资产预检：只有素材本身有问题时才会失败。'
        + '默认同时在桌面放一个【快捷方式】。',
      parameters: CREATE_PARAMS,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            out_dir: { type: 'string' },
            exe: { type: 'string' },
            link: { type: 'string' },
            zip: { type: 'string' },
            report: { type: 'string' },
          },
        },
        render: (_a, v) => text(v.report),
      },
      async execute(args) {
        assertKnownArguments(args, ["model_dir","out_dir","name","exclude_looks","looks","actions","force","desktop_shortcut","zip"], "pet_create")
        // 引擎自身缺了属于插件安装问题，不是使用者的问题 —— 直接说清楚
        if (!engineReady()) {
          return {
            ok: false,
            report: `插件自带的引擎不完整（缺少 ${ENGINE_DIR}\\XiaoXiaoQiu.Pet.exe）。\n`
              + '这是插件安装问题，不是你的素材问题：请重新安装 dsh-live2d-pet。',
          }
        }

        const modelDir = resolve(String(args.model_dir))
        const check = await inspectModelDir(modelDir)
        if (!check.ok) {
          return {
            ok: false,
            report: renderReport(check, '素材有问题，先修好再生成'),
          }
        }

        const outDir = resolve(String(args.out_dir))
        const pet = await createPet({
          modelDir: check.modelDir,
          outDir,
          name: args.name,
          looks: args.looks,
          excludeLooks: args.exclude_looks,
          actions: args.actions,
          force: args.force === true,
        })

        const lines = [renderReport(check, '素材检查通过'), '', `桌宠已生成：${pet.outDir}`]
        lines.push(`主程序：${pet.exe}`)

        let link = ''
        if (args.desktop_shortcut !== false) {
          try {
            const s = await createDesktopShortcut({
              exePath: pet.exe,
              linkName: args.name || check.modelName,
              description: `${args.name || check.modelName} · Live2D 桌宠`,
            })
            link = s.linkPath
            lines.push(`桌面快捷方式：${link}`)
          } catch (error) {
            lines.push(`（桌面快捷方式没建成：${error.message}。程序本身可用，直接双击主程序即可。）`)
          }
        }

        let zip = ''
        if (args.zip === true) {
          try {
            const z = await zipPet({ outDir: pet.outDir })
            zip = z.zipPath
            lines.push(`压缩包：${zip}（${(z.sizeBytes / 1048576).toFixed(1)} MB）`)
          } catch (error) {
            lines.push(`（打包没成功：${error.message}）`)
          }
        }

        lines.push('')
        lines.push('双击主程序即可使用；首次启动后桌面也会自动出现快捷方式。')
        lines.push('托盘图标提供显示/隐藏与退出；控制条按钮：锁定 / 玩偶 / 坐下 / 造型 / 睡觉 / 动作 / 退出。')
        if (check.warnings.length) {
          lines.push('')
          lines.push(`素材提示：${check.warnings.map(w => w.message).join('；')}`)
        }

        return { ok: true, out_dir: pet.outDir, exe: pet.exe, link, zip, report: lines.join('\n') }
      },
    }))

    // ---------------- 快捷方式 ----------------
    disposers.push(ctx.tools.register({
      name: 'pet_shortcut',
      description: '给一个已生成的桌宠在桌面放一个【快捷方式】（不是副本）。',
      parameters: {
        type: 'object',
        properties: {
          exe_path: { type: 'string', description: '桌宠的 XiaoXiaoQiu.Pet.exe 路径。' },
          link_name: { type: 'string', description: '快捷方式显示名。' },
        },
        required: ['exe_path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, report: { type: 'string' } } },
        render: (_a, v) => text(v.report),
      },
      async execute(args) {
        assertKnownArguments(args, ["exe_path","link_name"], "pet_shortcut")
        try {
          const s = await createDesktopShortcut({
            exePath: String(args.exe_path),
            linkName: args.link_name,
          })
          return { ok: true, report: `快捷方式已创建：${s.linkPath}` }
        } catch (error) {
          return { ok: false, report: `创建快捷方式失败：${error.message}` }
        }
      },
    }))

    // ---------------- 打包 ----------------
    disposers.push(ctx.tools.register({
      name: 'pet_zip',
      description: '把一个已生成的桌宠目录打成 zip，便于发给别人（对方解压后双击即可用）。',
      parameters: {
        type: 'object',
        properties: {
          pet_dir: { type: 'string', description: '桌宠目录。' },
          zip_path: { type: 'string', description: '输出 zip 路径；默认与目录同名同级。' },
        },
        required: ['pet_dir'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, report: { type: 'string' } } },
        render: (_a, v) => text(v.report),
      },
      async execute(args) {
        assertKnownArguments(args, ["pet_dir","zip_path"], "pet_zip")
        try {
          const z = await zipPet({ outDir: String(args.pet_dir), zipPath: args.zip_path })
          return { ok: true, report: `已打包：${z.zipPath}（${(z.sizeBytes / 1048576).toFixed(1)} MB）` }
        } catch (error) {
          return { ok: false, report: `打包失败：${error.message}` }
        }
      },
    }))

    // ---------------- 查看现状 ----------------
    disposers.push(ctx.tools.register({
      name: 'pet_info',
      description: '查看一个已生成桌宠的配置（用的哪个模型、裁剪了哪些造型/动作）。',
      parameters: {
        type: 'object',
        properties: { pet_dir: { type: 'string', description: '桌宠目录。' } },
        required: ['pet_dir'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, report: { type: 'string' } } },
        render: (_a, v) => text(v.report),
      },
      async execute(args) {
        assertKnownArguments(args, ["pet_dir"], "pet_info")
        const dir = resolve(String(args.pet_dir))
        const cfg = await readPetConfig(dir)
        if (!cfg) return { ok: false, report: `这个目录不是本插件生成的桌宠（没有 pet.config.json）：${dir}` }
        return { ok: true, report: `桌宠配置：\n${JSON.stringify(cfg, null, 2)}` }
      },
    }))

    ctx.effect(() => () => { for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } } },
      'dsh-live2d-pet: tools')
  })

  // ---------------- 自带使用说明 ----------------
  //
  // 说明书以 DSH 的 skill 格式随包分发（包根 SKILL.md），并在装载时【注册进
  // 技能目录】。这样使用者的 DSH 装完插件，技能列表里就直接出现
  // `live2d-desktop-pet`，读到说明后能主动引导用户，而不是等人问。
  //
  // 只用文件系统发现（把 SKILL.md 丢在那儿）是不够的：那要求使用者自己把
  // 文件放到 ~/.dsh/skills/ 下。注册进注册表才是"装完即生效"。
  registerManual(root)
}

/**
 * 把包根的 SKILL.md 注册成 DSH 技能。
 *
 * 解析 frontmatter 拿 name/description（这两个是 DSH 校验的必需字段：
 * name 必须匹配 ^[a-z0-9]+(?:-[a-z0-9]+)*$，description 不能为空）。
 *
 * 任何一步失败都【不能影响工具注册】—— 说明读不到是遗憾，不是故障，
 * 所以全程吞掉异常并只记一条日志。
 *
 * @param {any} root
 */
function registerManual(root) {
  let manifest = null
  try {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const file = resolve(here, 'SKILL.md')
    if (!existsSync(file)) return
    const raw = readFileSync(file, 'utf8')

    // --- frontmatter ---
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
    if (!m) return
    const meta = {}
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
      if (!kv) continue
      meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
    const skillName = meta.name
    const description = meta.description
    const content = raw.slice(m[0].length).trim()
    if (!skillName || !description || !content) return
    manifest = { name: skillName, description, content }
  } catch {
    return
  }

  root.inject(['skills'], ctx => {
    try {
      // 已经装过同名技能（例如使用者手放到 ~/.dsh/skills/）时，注册表会记
      // 一条警告并返回空 disposer，不会抛错，也不会顶掉已有条目。
      return ctx.skills.register({
        name: manifest.name,
        description: manifest.description,
        content: manifest.content,
        invocation: { modelInvocable: true, userInvocable: true },
      })
    } catch {
      return undefined
    }
  })
}

/** 供 `node --test` 或本地探针使用。 */
export const internals = { inspectModelDir, createPet, createDesktopShortcut, zipPet }
