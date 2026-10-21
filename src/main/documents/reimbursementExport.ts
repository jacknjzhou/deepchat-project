import path from 'node:path'
import { escapeCsvCell } from './csv'
import type { ReimbursementTreeResult } from './reimbursement'

export interface ReimbursementExportDeps {
  copyFile: (src: string, dest: string) => Promise<void>
  mkdir: (dir: string, options: { recursive: true }) => Promise<string | undefined>
  writeFile: (file: string, data: string, encoding: 'utf-8') => Promise<void>
  exists: (target: string) => Promise<boolean>
}

export interface ReimbursementExportInput {
  rootDir: string
  result: ReimbursementTreeResult
  filesById: Map<string, string[]>
  deps: ReimbursementExportDeps
  now?: Date
}

export interface ReimbursementExportOutput {
  path: string
  exportedFiles: number
  summaryPath: string
  /** 汇总行：原件缺失记录 */
  issues: string[]
}

const UNKNOWN_PERSON = '未知人员'
const UNKNOWN_PERIOD = '未知期间'
const CSV_HEADER = '类别,分组,人员,期间,单据模板,文件名,金额,金额存疑,手动指定'

// eslint-disable-next-line no-control-regex
const DIR_NAME_UNSAFE_RE = /[\\/:*?"<>|\u0000-\u001f]/g

// Windows 目录段消毒：非法字符与 C0 控制字符替换为 '_'，再去尾随点/空格（Windows 限制）
// 并限长 80。空名、'.'、'..' 与纯空白经尾随剥离后均为空串，统一回落 '_'（防路径穿越）。
const sanitizeDirName = (name: string): string => {
  const stripped = name.replace(DIR_NAME_UNSAFE_RE, '_').replace(/[.\s]+$/g, '')
  const truncated = stripped.slice(0, 80).replace(/[.\s]+$/g, '')
  return truncated === '' ? '_' : truncated
}

// 引号规则直接复用 ./csv 的 escapeCsvCell，避免两处分叉；额外对以 = + - @ \t \r 开头的
// 单元格前置单引号，避免 Excel/WPS 按公式求值（CSV 公式注入）。
const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/

const csvCell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value)
  return escapeCsvCell(FORMULA_PREFIX_RE.test(text) ? `'${text}` : text)
}

async function uniqueDir(base: string, deps: ReimbursementExportDeps): Promise<string> {
  let candidate = base
  for (let index = 1; (await deps.exists(candidate)) && index < 100; index += 1) {
    candidate = `${base}-${index}`
  }
  return candidate
}

async function uniqueFileName(
  dir: string,
  fileName: string,
  deps: ReimbursementExportDeps
): Promise<string> {
  let candidate = fileName
  const extension = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)
  for (let index = 1; (await deps.exists(path.join(dir, candidate))) && index < 1000; index += 1) {
    candidate = `${stem}-${index}${extension}`
  }
  return candidate
}

export async function exportReimbursementPackage(
  input: ReimbursementExportInput
): Promise<ReimbursementExportOutput> {
  const { rootDir, result, filesById, deps, now = new Date() } = input
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0')
  ].join('')
  const packageDir = await uniqueDir(path.join(rootDir, `报销整理-${stamp}`), deps)
  await deps.mkdir(packageDir, { recursive: true })

  const rows: Array<Array<string | number>> = []
  const issues: string[] = []
  let exportedFiles = 0

  // 普通 人员→年月 与自定义 分组→年月 共用同一写入路径：
  // 子目录名决定目录层级，groupName 写入 CSV 第 2 列（普通分组为空串），
  // 人员列取条目自身人员（自定义分组桶内可跨人员）。
  const writeEntries = async (
    categoryName: string,
    subDirName: string,
    buckets: ReimbursementTreeResult['tree'][number]['customGroups'][number]['buckets'],
    groupName: string
  ) => {
    for (const bucket of buckets) {
      const periodDirName = sanitizeDirName(bucket.period ?? UNKNOWN_PERIOD)
      const targetDir = path.join(packageDir, categoryName, subDirName, periodDirName)
      await deps.mkdir(targetDir, { recursive: true })
      for (const entry of bucket.documents) {
        const personCell = entry.person ?? UNKNOWN_PERSON
        const files = filesById.get(entry.id) ?? []
        for (let index = 0; index < entry.fileNames.length; index += 1) {
          const source = files[index]
          const originalName = entry.fileNames[index]
          if (!source) {
            issues.push(`缺失:${originalName}`)
            rows.push([
              categoryName,
              groupName,
              personCell,
              periodDirName,
              entry.templateName,
              `缺失:${originalName}`,
              entry.amount ?? '',
              entry.amountUncertain ? '是' : '否',
              entry.isOverride ? '是' : '否'
            ])
            continue
          }
          const fileName = await uniqueFileName(targetDir, originalName, deps)
          try {
            await deps.copyFile(source, path.join(targetDir, fileName))
            exportedFiles += 1
            rows.push([
              categoryName,
              groupName,
              personCell,
              periodDirName,
              entry.templateName,
              fileName,
              entry.amount ?? '',
              entry.amountUncertain ? '是' : '否',
              entry.isOverride ? '是' : '否'
            ])
          } catch {
            issues.push(`复制失败:${originalName}`)
            rows.push([
              categoryName,
              groupName,
              personCell,
              periodDirName,
              entry.templateName,
              `缺失:${originalName}`,
              entry.amount ?? '',
              entry.amountUncertain ? '是' : '否',
              entry.isOverride ? '是' : '否'
            ])
          }
        }
      }
    }
  }

  for (const node of result.tree) {
    const categoryName = sanitizeDirName(node.category.name)
    // 与视图顺序一致：先普通 人员→年月 列表，后自定义分组
    for (const group of node.groups) {
      await writeEntries(
        categoryName,
        sanitizeDirName(group.person ?? UNKNOWN_PERSON),
        group.buckets,
        ''
      )
    }
    for (const customGroup of node.customGroups) {
      await writeEntries(
        categoryName,
        sanitizeDirName(customGroup.group.name),
        customGroup.buckets,
        customGroup.group.name
      )
    }
  }
  for (const group of result.unassigned) {
    await writeEntries(
      sanitizeDirName('未分类'),
      sanitizeDirName(group.person ?? UNKNOWN_PERSON),
      group.buckets,
      ''
    )
  }

  const summaryPath = path.join(packageDir, '汇总.csv')
  const csv = `\uFEFF${CSV_HEADER}\n${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
  await deps.writeFile(summaryPath, csv, 'utf-8')

  return { path: packageDir, exportedFiles, summaryPath, issues }
}
