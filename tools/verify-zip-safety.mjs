/**
 * zipPet 的「临时文件 + 原子替换」验证。
 *
 * 要点是证明：
 *   A. zip_path 指向的【已存在文件】在打包失败时不会被毁掉（旧写法会先删它）
 *   B. 正常打包能生成 zip，重复打包能覆盖
 *   C. 不会留下 .partial- 临时文件
 *
 * 用法: node tools/verify-zip-safety.mjs <一个已生成的桌宠目录>
 */

import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipPet } from '../lib/pet.js'

const PET = process.argv[2]
if (!PET) {
  console.error('用法: node tools/verify-zip-safety.mjs <桌宠目录>')
  process.exit(2)
}

let failed = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failed++
}

const SANDBOX = join(tmpdir(), 'dsh-pet-zip-test')
await rm(SANDBOX, { recursive: true, force: true })
await mkdir(SANDBOX, { recursive: true })

console.log('=== A. 打包【失败】时，zip_path 上的已有文件必须原封不动 ===')
const victim = join(SANDBOX, 'important.docx')
await writeFile(victim, 'PRECIOUS USER DATA', 'utf8')

let threw = false
try {
  // src 指向一个不存在的目录 -> CreateFromDirectory 必然失败
  await zipPet({ outDir: join(SANDBOX, 'no-such-dir'), zipPath: victim })
} catch {
  threw = true
}

ok(threw, '打包确实失败并抛错')
ok(existsSync(victim), '目标文件仍然存在（旧写法会先 rm 掉它）')
if (existsSync(victim)) {
  ok((await readFile(victim, 'utf8')) === 'PRECIOUS USER DATA', '目标文件内容未变')
}
const leftovers = (await readdir(SANDBOX)).filter(n => n.includes('.partial-'))
ok(leftovers.length === 0, `没有残留 .partial- 临时文件（实际 ${leftovers.length} 个）`)

console.log()
console.log('=== B. 正常打包能成功，重复打包能覆盖 ===')
const zipA = join(SANDBOX, 'out.zip')
const r1 = await zipPet({ outDir: PET, zipPath: zipA })
ok(existsSync(zipA), `首次打包生成 ${zipA}`)
ok(r1.sizeBytes > 0, `zip 非空（${(r1.sizeBytes / 1048576).toFixed(1)} MB）`)

// 用哈希判断"是否真的重写了"。早先用"体积变大"判断，被压缩吸收掉了
// （1 字节的标记文件不改变 zip 大小）—— 是断言不准，不是功能有问题。
const hashOf = async p => (await import('node:crypto')).createHash('sha256')
  .update(await readFile(p)).digest('hex')
const h1 = await hashOf(zipA)

await writeFile(join(PET, 'marker-for-zip-test.tmp'), 'x'.repeat(4096), 'utf8')
const r2 = await zipPet({ outDir: PET, zipPath: zipA })
ok(existsSync(zipA), '再次打包成功')
const h2 = await hashOf(zipA)
ok(h1 !== h2, '覆盖后 zip 内容确实变了（哈希不同）')
ok(r2.sizeBytes >= r1.sizeBytes, `覆盖后体积未缩小（${(r1.sizeBytes / 1048576).toFixed(1)} → ${(r2.sizeBytes / 1048576).toFixed(1)} MB）`)
await rm(join(PET, 'marker-for-zip-test.tmp'), { force: true })

console.log()
console.log('=== C. 覆盖后没有临时残留 ===')
const left2 = (await readdir(SANDBOX)).filter(n => n.includes('.partial-'))
ok(left2.length === 0, `无 .partial- 残留（实际 ${left2.length} 个）`)

console.log()
console.log('=== 清理 ===')
await rm(SANDBOX, { recursive: true, force: true })
console.log('  已清理', SANDBOX)

console.log()
console.log(failed ? `== ${failed} 项失败 ==` : '== 全部通过 ==')
process.exit(failed ? 1 : 0)
