// 发票 JSON -> 飞书审批表单字段映射
// 按审批定义的 form 字段类型（text/amount/date 等）做最小映射

// 按字段名关键词推断映射规则（飞书审批表单字段自定义，无法完全静态匹配）
const FIELD_RULES = [
  { match: ['发票', '号码', 'number'], pick: (inv) => inv.invoiceNumber },
  { match: ['发票', '代码', 'code'], pick: (inv) => inv.invoiceCode },
  { match: ['日期', 'date'], pick: (inv) => inv.issueDate },
  { match: ['金额', 'amount', '价税'], pick: (inv) => formatAmount(inv.totalAmount) },
  { match: ['税额', 'tax'], pick: (inv) => formatAmount(inv.tax) },
  { match: ['购买方', 'buyer', '抬头'], pick: (inv) => inv.buyer?.name },
  { match: ['销售方', 'seller', '开票'], pick: (inv) => inv.seller?.name },
  { match: ['类型', 'type', '科目'], pick: (inv) => inv.invoiceType },
  { match: ['事由', '说明', '备注', 'reason'], pick: (inv) => buildReason(inv) }
]

function formatAmount(value) {
  if (value == null) return ''
  return typeof value === 'number' ? value.toFixed(2) : String(value)
}

function buildReason(invoice) {
  const seller = invoice.seller?.name ?? ''
  const type = invoice.invoiceType ?? '发票'
  return `${type} ${seller}`.trim()
}

// formDefinition: 审批定义的 form 数组（getApprovalDefinition 返回的 form 字段，
// 每项含 field_name / type 等）；invoices: 发票 JSON 数组；extra: 用户提供的补充字段
export function fillApprovalForm({ formDefinition, invoices, extra = {} }) {
  const merged = {}
  const single = invoices.length === 1 ? invoices[0] : null

  // 汇总字段（多张发票时取总和）
  const summary = {
    totalAmount: invoices.reduce((sum, inv) => sum + (Number(inv.totalAmount) || 0), 0),
    tax: invoices.reduce((sum, inv) => sum + (Number(inv.tax) || 0), 0),
    invoiceNumbers: invoices
      .map((inv) => inv.invoiceNumber)
      .filter(Boolean)
      .join('、')
  }

  const fields = Array.isArray(formDefinition) ? formDefinition : []

  for (const field of fields) {
    const fieldName = field.field_name ?? field.name ?? ''
    if (!fieldName) continue

    // extra（用户提供）优先
    if (fieldName in extra) {
      merged[fieldName] = extra[fieldName]
      continue
    }

    const lowerName = fieldName.toLowerCase()

    // 汇总金额类字段
    if (lowerName.includes('合计') || lowerName.includes('总额')) {
      merged[fieldName] = formatAmount(summary.totalAmount)
      continue
    }
    if (invoices.length > 1 && lowerName.includes('发票') && lowerName.includes('号码')) {
      merged[fieldName] = summary.invoiceNumbers
      continue
    }

    // 单张发票按规则映射
    if (single) {
      for (const rule of FIELD_RULES) {
        const hit = rule.match.some((kw) => lowerName.includes(kw.toLowerCase()))
        if (hit) {
          const value = rule.pick(single)
          if (value != null && value !== '') {
            merged[fieldName] = String(value)
          }
          break
        }
      }
    }
  }

  return merged
}
