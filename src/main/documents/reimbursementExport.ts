import path from 'node:path'
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
const CSV_HEADER = '类别,人员,期间,单据模板,文件名,金额,金额存疑,手动指定'

const csvCell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
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

  const writeGroup = async (
    categoryName: string,
    group: ReimbursementTreeResult['unassigned'][number]
  ) => {
    const personDirName = group.person ?? UNKNOWN_PERSON
    for (const bucket of group.buckets) {
      const periodDirName = bucket.period ?? UNKNOWN_PERIOD
      const targetDir = path.join(packageDir, categoryName, personDirName, periodDirName)
      await deps.mkdir(targetDir, { recursive: true })
      for (const entry of bucket.documents) {
        const files = filesById.get(entry.id) ?? []
        for (let index = 0; index < entry.fileNames.length; index += 1) {
          const source = files[index]
          const originalName = entry.fileNames[index]
          if (!source) {
            issues.push(`缺失:${originalName}`)
            rows.push([
              categoryName,
              personDirName,
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
              personDirName,
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
              personDirName,
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
    for (const group of node.groups) {
      await writeGroup(node.category.name, group)
    }
  }
  for (const group of result.unassigned) {
    await writeGroup('未分类', group)
  }

  const summaryPath = path.join(packageDir, '汇总.csv')
  const csv = `\uFEFF${CSV_HEADER}\n${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
  await deps.writeFile(summaryPath, csv, 'utf-8')

  return { path: packageDir, exportedFiles, summaryPath, issues }
}
